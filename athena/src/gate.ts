// The no-AI citation and number check. Pure functions: no network, no model, no database. The caller
// loads page text from D1 and passes it in, so nothing the model says can supply the evidence for itself.
//
// What it checks: the quoted text and the figures in an answer really appear on the pages cited, and the
// cited pages are pages we actually sent. What it does NOT prove: that the model relied on those pages,
// or that the answer is correct. Its measured error rate comes from bench/gate_eval, not from this file.
import { z } from 'zod';

/* ------------------------------ model output format ------------------------------ */

export const GateOutputSchema = z.object({
  answer: z.string(),
  citations: z
    .array(z.object({ page: z.number().int().min(1), quote: z.string().min(1).max(2000), document_id: z.string().optional() }))
    .max(20),
});
export type GateOutput = z.infer<typeof GateOutputSchema>;

/** Parse the model's JSON answer (tolerates a markdown fence). `ok: false` means one repair retry is due. */
export function parseGateJson(text: string): { ok: true; value: GateOutput } | { ok: false; error: string } {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let raw: unknown;
  try {
    raw = JSON.parse(t);
  } catch {
    return { ok: false, error: 'not valid JSON' };
  }
  const r = GateOutputSchema.safeParse(raw);
  return r.success ? { ok: true, value: r.data } : { ok: false, error: r.error.issues.slice(0, 2).map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') };
}

/* ---------------------------------- normalizing ---------------------------------- */

/** Lowercase, collapse whitespace, unify quotes and hyphens, strip zero-width and soft-hyphen characters. */
export function normalizeText(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[​-‏‪-‮⁠-⁤⁦-⁩﻿­]/g, '')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function quoteInPage(pageText: string, quote: string): boolean {
  const q = normalizeText(quote);
  return q.length > 0 && normalizeText(pageText).includes(q);
}

/* ------------------------------- numbers and dates ------------------------------- */

export type FactKind = 'number' | 'percent' | 'date';
export interface Fact {
  kind: FactKind;
  /** The text as written. */
  raw: string;
  /** Canonical keys; a fact matches a page if ANY of its keys is among the page's keys. */
  keys: string[];
}

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7,
  august: 8, aug: 8, september: 9, sept: 9, sep: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};
const MON = '(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)';
const pad = (n: number) => String(n).padStart(2, '0');
const year4 = (y: string) => (y.length === 4 ? Number(y) : Number(y) < 70 ? 2000 + Number(y) : 1900 + Number(y));
const validDay = (m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && d <= 31;

/**
 * Keys for one calendar date. An answer carries only the full date, so "4 April 2026" cannot be satisfied by a page that
 * merely mentions April 2026. A page also carries the month-day and the month, so an answer that leaves the year (or the
 * day) out still finds a page that gives the full date.
 */
function dateKeys(y: number, m: number, d: number, side: 'answer' | 'page'): string[] {
  const full = `d:${y}-${pad(m)}-${pad(d)}`;
  return side === 'page' ? [full, `d:--${pad(m)}-${pad(d)}`, `m:${y}-${pad(m)}`] : [full];
}

const stripZeros = (s: string) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);

/**
 * Canonical readings of one written number. `primary` is the English reading (dot is the decimal mark,
 * a comma followed by exactly three digits is a thousands mark). `all` adds the other reading where the
 * text is ambiguous ("1.000" is 1 in English and 1000 in German), used on the page side only.
 */
export function numberReadings(tok: string): { primary: string; all: string[] } {
  const t = tok.replace(/[  ]/g, '');
  const hasC = t.includes(',');
  const hasD = t.includes('.');
  let primary: string;
  const extra: string[] = [];
  if (hasC && hasD) {
    const decSep = t.lastIndexOf(',') > t.lastIndexOf('.') ? ',' : '.';
    const thouSep = decSep === ',' ? '.' : ',';
    primary = t.split(thouSep).join('').replace(decSep, '.');
  } else if (hasC) {
    const g = t.split(',');
    if (g.length > 2 || (g[1]!.length === 3 && g[0]!.length <= 3)) {
      primary = g.join('');
      if (g.length === 2) extra.push(`${g[0]}.${g[1]}`);
    } else {
      primary = `${g[0]}.${g[1]}`;
    }
  } else if (hasD) {
    const g = t.split('.');
    if (g.length > 2) primary = g.join('');
    else {
      primary = t;
      if (g[1]!.length === 3 && g[0]!.length <= 3 && g[0] !== '0') extra.push(g.join(''));
    }
  } else {
    primary = t;
  }
  const p = stripZeros(primary);
  return { primary: p, all: [p, ...extra.map(stripZeros)] };
}

type Span = [number, number];
const overlaps = (spans: Span[], s: number, e: number) => spans.some(([a, b]) => s < b && e > a);

/**
 * Pull every number, currency amount, percentage and date out of `text`. `side: 'page'` also emits the
 * other reading of ambiguous separators and the day, month and year parts of each date, so an answer that
 * says "3 April" or "2026" still finds its evidence on a page that says "3 April 2026".
 */
export function extractFacts(text: string, side: 'answer' | 'page' = 'answer'): Fact[] {
  // A no-break or narrow no-break space between digit groups is a thousands mark: join it before NFKC turns it into a plain space.
  const src = text
    .replace(/(?<=\d)[\u00a0\u202f](?=\d{3}(?!\d))/g, '')
    .normalize('NFKC')
    .replace(/[\u200b-\u200f\u2060\ufeff\u00ad]/g, '');
  const facts: Fact[] = [];
  const used: Span[] = [];
  const take = (m: RegExpMatchArray, kind: FactKind, keys: string[]) => {
    const s = m.index ?? 0;
    const e = s + m[0].length;
    if (overlaps(used, s, e)) return false;
    used.push([s, e]);
    facts.push({ kind, raw: m[0], keys });
    return true;
  };
  const addPageParts = (y: number | null, m: number, d: number | null) => {
    if (side !== 'page') return [] as string[];
    return [d != null ? `n:${d}` : '', y != null ? `n:${y}` : ''].filter(Boolean);
  };

  // Dates, most specific first. Each date is consumed so its digits are not also read as plain numbers.
  for (const m of src.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (validDay(mo, d)) take(m, 'date', [...dateKeys(y, mo, d, side), ...addPageParts(y, mo, d)]);
  }
  for (const m of src.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MON}\\.?,?\\s+(\\d{4})\\b`, 'gi'))) {
    const [d, mo, y] = [Number(m[1]), MONTHS[m[2]!.toLowerCase()]!, Number(m[3])];
    if (validDay(mo, d)) take(m, 'date', [...dateKeys(y, mo, d, side), ...addPageParts(y, mo, d)]);
  }
  for (const m of src.matchAll(new RegExp(`\\b${MON}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi'))) {
    const [mo, d, y] = [MONTHS[m[1]!.toLowerCase()]!, Number(m[2]), Number(m[3])];
    if (validDay(mo, d)) take(m, 'date', [...dateKeys(y, mo, d, side), ...addPageParts(y, mo, d)]);
  }
  for (const m of src.matchAll(/(?<![\d./-])(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?![\d])/g)) {
    // 03/04/2026 can be 3 April or March 4: accept either reading.
    const [a, b, y] = [Number(m[1]), Number(m[2]), year4(m[3]!)];
    const keys: string[] = [];
    if (validDay(b, a)) keys.push(...dateKeys(y, b, a, side)); // day first
    if (validDay(a, b)) keys.push(...dateKeys(y, a, b, side)); // month first
    if (keys.length) take(m, 'date', [...new Set([...keys, ...addPageParts(y, 0, null)])]);
  }
  for (const m of src.matchAll(new RegExp(`\\b${MON}\\.?,?\\s+(\\d{4})\\b`, 'gi'))) {
    take(m, 'date', [`m:${Number(m[2])}-${pad(MONTHS[m[1]!.toLowerCase()]!)}`, ...addPageParts(Number(m[2]), 0, null)]);
  }
  for (const m of src.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MON}\\b`, 'gi'))) {
    const [d, mo] = [Number(m[1]), MONTHS[m[2]!.toLowerCase()]!];
    if (validDay(mo, d)) take(m, 'date', [`d:--${pad(mo)}-${pad(d)}`, ...addPageParts(null, mo, d)]);
  }
  for (const m of src.matchAll(new RegExp(`\\b${MON}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'gi'))) {
    const [mo, d] = [MONTHS[m[1]!.toLowerCase()]!, Number(m[2])];
    if (validDay(mo, d)) take(m, 'date', [`d:--${pad(mo)}-${pad(d)}`, ...addPageParts(null, mo, d)]);
  }

  // Percentages.
  for (const m of src.matchAll(/(\d+(?:[.,]\d+)?)\s?(?:%|percent\b|per cent\b)/gi)) {
    const r = numberReadings(m[1]!);
    take(m, 'percent', (side === 'page' ? r.all : [r.primary]).map((x) => `p:${x}`));
  }

  // Plain numbers and currency amounts.
  const NUM = /(?<![\p{L}\p{N}])(?<!\d[.,])(?:[$€£₹]\s?|(?:USD|EUR|GBP|INR|Rs\.?)\s?)?(\d{1,3}(?:[,.  ]\d{3})+(?:[.,]\d{1,2})?|\d+(?:\.\d+|,\d{1,2}(?!\d))?)(?![\p{N}])/gu;
  for (const m of src.matchAll(NUM)) {
    const r = numberReadings(m[1]!);
    take(m, 'number', (side === 'page' ? r.all : [r.primary]).map((x) => `n:${x}`));
  }
  return facts;
}

/** Remove page references and list numbering from an answer so they are not demanded as evidence. */
export function stripReferences(answer: string): string {
  return answer
    .replace(/\[\s*p\.\s*\d+(?:\s*[-–]\s*\d+)?\s*\]/gi, ' ')
    .replace(/\bpages?\s+\d+(?:\s*[-–]\s*\d+)?/gi, ' ')
    .replace(/\bp{1,2}\.\s*\d+(?:\s*[-–]\s*\d+)?/gi, ' ')
    .replace(/^\s*\d+[.)]\s+/gm, ' ')
    .replace(/(?<=[.;:!?]\s)\d{1,2}[.)]\s+(?=["'(A-Z])/g, ' '); // inline "1. First point. 2. Second point."
}

/* ------------------------------------ the gate ------------------------------------ */

export interface GateCitation {
  page: number;
  /** Absent when the answer only carries [p.N] markers; then only the page and number checks run. */
  quote?: string;
  document_id?: string;
}
export interface GateFailure {
  type: 'quote' | 'number' | 'page';
  detail: string;
}
export interface GateResult {
  pass: boolean;
  failures: GateFailure[];
  checked: { quotes: number; numbers: number; pages: number };
  /** 'quotes' when quotes were available to check, else 'pages_only'. */
  mode: 'quotes' | 'pages_only';
  /** True when the answer honestly said it could not find the answer; nothing to check. */
  abstained: boolean;
}

export interface GateInput {
  answer: string;
  citations: GateCitation[];
  /** Page text as stored in D1 (never from the model). `undefined` when the page does not exist. */
  pageText: (documentId: string | undefined, page: number) => string | undefined;
  /** Was this page among the pages sent to the model for this answer? */
  wasSent: (documentId: string | undefined, page: number) => boolean;
}

const NOT_FOUND = /couldn['’]t find that in the document|does not appear to be in the document/i;

export function runGate(input: GateInput): GateResult {
  const failures: GateFailure[] = [];
  const answer = input.answer;
  const hasQuotes = input.citations.some((c) => !!c.quote);
  const base = { checked: { quotes: 0, numbers: 0, pages: 0 }, mode: (hasQuotes ? 'quotes' : 'pages_only') as GateResult['mode'] };

  if (NOT_FOUND.test(answer) && input.citations.length === 0) return { pass: true, failures, ...base, abstained: true };
  if (input.citations.length === 0) {
    failures.push({ type: 'page', detail: 'the answer cites no page' });
    return { pass: false, failures, ...base, abstained: false };
  }

  const goodPages: { doc: string | undefined; page: number; text: string }[] = [];
  for (const c of input.citations) {
    base.checked.pages++;
    if (!input.wasSent(c.document_id, c.page)) {
      failures.push({ type: 'page', detail: `page ${c.page} was not one of the pages sent to the model` });
      continue;
    }
    const text = input.pageText(c.document_id, c.page);
    if (text === undefined) {
      failures.push({ type: 'page', detail: `page ${c.page} text is not available` });
      continue;
    }
    if (!goodPages.some((g) => g.doc === c.document_id && g.page === c.page)) goodPages.push({ doc: c.document_id, page: c.page, text });
    if (c.quote) {
      base.checked.quotes++;
      if (!quoteInPage(text, c.quote)) failures.push({ type: 'quote', detail: `quote not found on page ${c.page}` });
    }
  }

  if (goodPages.length) {
    const evidence = new Set<string>();
    for (const g of goodPages) for (const f of extractFacts(g.text, 'page')) for (const k of f.keys) evidence.add(k);
    // Numbers inside a quote count as evidence too: the quote itself was verified against the page above.
    const where = goodPages.length === 1 ? `page ${goodPages[0]!.page}` : `pages ${[...new Set(goodPages.map((g) => g.page))].join(', ')}`;
    const seen = new Set<string>();
    for (const f of extractFacts(stripReferences(answer), 'answer')) {
      base.checked.numbers++;
      if (f.keys.some((k) => evidence.has(k))) continue;
      const tag = `${f.kind}:${f.raw.trim()}`;
      if (seen.has(tag)) continue;
      seen.add(tag);
      failures.push({ type: 'number', detail: `${f.kind === 'date' ? 'date' : f.kind === 'percent' ? 'percentage' : 'number'} ${f.raw.trim()} not found on ${where}` });
    }
  }
  return { pass: failures.length === 0, failures, ...base, abstained: false };
}

/** One line for the UI: "Citation check passed" or "Citation check failed: number 4,200 not found on page 3". */
export function gateSummary(g: Pick<GateResult, 'pass' | 'failures' | 'abstained'>): string {
  if (g.pass) return g.abstained ? 'Nothing to check: the answer says it is not in the document' : 'Citation check passed';
  return `Citation check failed: ${g.failures[0]?.detail ?? 'unknown reason'}`;
}

/* ------------------------------------ abstaining ------------------------------------ */

export interface AbstainConfig {
  /** FTS5 bm25() scores are negative and a more negative score is a better match; strength = -score. */
  minStrength: number;
  /** Smallest gap between the best and second-best strength. 0 disables the margin test. */
  minMargin: number;
}

/**
 * Decide, from retrieval scores alone, that the document probably does not contain the answer. No model is
 * called. `scores` are bm25 scores sorted best first; an empty list (nothing matched) always abstains.
 */
export function shouldAbstain(scores: number[], cfg: AbstainConfig): boolean {
  if (scores.length === 0) return true;
  const best = -scores[0]!;
  if (best < cfg.minStrength) return true;
  if (cfg.minMargin > 0 && scores.length > 1 && best - -scores[1]! < cfg.minMargin) return true;
  return false;
}

export const ABSTAIN_ANSWER = 'This does not appear to be in the document.';
