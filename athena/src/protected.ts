// Protected numbers: pruning may drop whole sentences, but it never changes a character of an amount,
// date, identifier, clause number, party name or table row. Pruning here is EXTRACTIVE only: a sentence
// is kept exactly as written or dropped. Nothing is rewritten, rounded, abbreviated, masked or paraphrased,
// and page ids stay attached by the caller.
//
// There is deliberately no identifier masking, schema distillation or DSL compression anywhere in this
// repo. In the SQL-generation study this design follows, masking identifiers cost about 30 points of
// semantic match and schema distillation about 44.5 points. Do not add them.
//
// Status: these are pure functions with tests (tests/a-protected.test.ts). They are not yet wired into
// context.ts, which today sends whole sections. Wiring them in is a separate, owner-reviewed change.

export type SpanKind = 'currency' | 'number' | 'percent' | 'date' | 'id' | 'clause' | 'party' | 'table_row';
export interface ProtectedSpan {
  start: number;
  end: number;
  kind: SpanKind;
  text: string;
}

const MON = '(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)';
const PATTERNS: [SpanKind, RegExp][] = [
  ['date', /\b\d{4}-\d{1,2}-\d{1,2}\b/g],
  ['date', new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MON}\\.?,?\\s+\\d{4}\\b`, 'gi')],
  ['date', new RegExp(`\\b${MON}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b`, 'gi')],
  ['date', /(?<![\d./-])\d{1,2}[/.-]\d{1,2}[/.-](?:\d{4}|\d{2})(?!\d)/g],
  ['clause', /(?:\b(?:section|clause|article|schedule|annex|paragraph)\s+|§\s*)\d+(?:\.\d+)*(?:\([a-z0-9]+\))*/gi],
  ['clause', /^\d+(?:\.\d+)+(?=\s)/gm],
  ['currency', /(?:[$€£₹]|\b(?:USD|EUR|GBP|INR|Rs\.?)\s?)\s?\d[\d,.  ]*\d|(?:[$€£₹]|\b(?:USD|EUR|GBP|INR|Rs\.?)\s?)\s?\d/g],
  ['currency', /\b\d[\d,.  ]*\d\s?(?:USD|EUR|GBP|INR)\b/g],
  ['percent', /\b\d+(?:[.,]\d+)?\s?(?:%|percent\b|per cent\b)/gi],
  ['id', /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g],
  ['id', /\b[A-Z]{2,}[-/#]?\d{2,}[A-Z0-9-]*\b/g],
  ['id', /\b(?=[A-Za-z0-9-]*\d)(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z0-9-]{8,}\b/g],
  ['party', /\b(?:[A-Z][A-Z&']+\s+){1,5}(?:LTD|LIMITED|LLC|INC|PLC|LLP|CORP|GMBH|CO)\b\.?/g],
  ['number', /\d+(?:[.,  ]\d+)*/g],
];

const NUMERIC_TOKEN = /\d+(?:[.,]\d+)*/g;
const NUMERIC_CELL = /^[\p{Sc}\s]*\d[\d.,%]*\s*$/u;
/**
 * A table row: cells split by tabs, pipes or runs of two spaces with at least three cells of which two or more
 * are numbers, or a line of at least three words that are mostly numbers. Prose that merely contains figures is not.
 */
const isTableRow = (line: string) => {
  const t = line.trim();
  if (!t) return false;
  const cells = t.split(/\t|\||\s{2,}/).map((c) => c.trim()).filter(Boolean);
  if (cells.length >= 3 && cells.filter((c) => NUMERIC_CELL.test(c)).length >= 2) return true;
  const words = t.split(/\s+/);
  return words.length >= 3 && words.filter((w) => NUMERIC_CELL.test(w)).length / words.length >= 0.7;
};

export function findProtectedSpans(text: string): ProtectedSpan[] {
  const raw: ProtectedSpan[] = [];
  for (const [kind, re] of PATTERNS) {
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      raw.push({ start, end: start + m[0].length, kind, text: m[0] });
    }
  }
  let off = 0;
  for (const line of text.split('\n')) {
    if (isTableRow(line)) raw.push({ start: off, end: off + line.length, kind: 'table_row', text: line });
    off += line.length + 1;
  }
  // Merge overlaps into the widest span so a boundary can never fall inside any of them.
  raw.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: ProtectedSpan[] = [];
  for (const s of raw) {
    const last = out[out.length - 1];
    if (last && s.start < last.end) {
      if (s.end > last.end) {
        last.end = s.end;
        last.text = text.slice(last.start, last.end);
      }
      if (s.kind === 'table_row') last.kind = 'table_row';
    } else out.push({ ...s });
  }
  return out;
}

/* -------------------------------- sentences -------------------------------- */

export interface Sentence {
  start: number;
  end: number;
  text: string;
  /** Starts a new line in the source (so the join keeps the original line break). */
  newLine: boolean;
}
const ABBREV = /(?:\b(?:Rs|No|Nos|Inc|Ltd|Co|Corp|vs|etc|Dr|Mr|Ms|Mrs|St|Art|Sec|Fig|approx)|\b[a-z]\.[a-z])\.$/;

/** Split into sentences without ever cutting inside a protected span or after a common abbreviation. */
export function splitSentences(text: string, spans: ProtectedSpan[] = findProtectedSpans(text)): Sentence[] {
  const out: Sentence[] = [];
  const insideSpan = (i: number) => spans.some((s) => i > s.start && i < s.end);
  let lineStart = 0;
  const lines = text.split('\n');
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    let from = 0;
    const re = /[.!?]["')\]]*\s+(?=["'(A-Z0-9])/g;
    let first = true;
    const push = (a: number, b: number) => {
      let s = a;
      let e = b;
      while (s < e && /\s/.test(line[s]!)) s++;
      while (e > s && /\s/.test(line[e - 1]!)) e--;
      if (e > s) {
        out.push({ start: lineStart + s, end: lineStart + e, text: line.slice(s, e), newLine: first });
        first = false;
      }
    };
    for (const m of line.matchAll(re)) {
      const cut = (m.index ?? 0) + m[0].length;
      const at = lineStart + (m.index ?? 0) + 1;
      if (insideSpan(at) || insideSpan(lineStart + cut - 1) || ABBREV.test(line.slice(0, (m.index ?? 0) + 1))) continue;
      push(from, cut);
      from = cut;
    }
    push(from, line.length);
    lineStart += line.length + 1;
  }
  return out;
}

/* --------------------------------- pruning --------------------------------- */

const STOP = new Set(['the', 'and', 'for', 'with', 'what', 'which', 'who', 'how', 'does', 'did', 'are', 'was', 'were', 'this', 'that', 'there', 'their', 'from', 'about', 'into', 'than', 'then', 'when', 'where', 'whose', 'have', 'has']);
const digitsOnly = (s: string) => s.replace(/[^\d]/g, '');
const squash = (s: string) => s.toLowerCase().replace(/[\s,]/g, '');

interface QueryTokens {
  terms: string[];
  numbers: Set<string>;
  lowered: string;
}
function queryTokens(question: string): QueryTokens {
  const lowered = question.toLowerCase();
  const terms = [...new Set(lowered.replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter((t) => t.length > 2 && !STOP.has(t)))];
  const numbers = new Set((question.match(NUMERIC_TOKEN) ?? []).map(digitsOnly).filter(Boolean));
  return { terms, numbers, lowered };
}

/** Does this protected span match a term or a number in the question? */
function spanMatchesQuestion(s: ProtectedSpan, q: QueryTokens): boolean {
  if (s.kind === 'table_row') return false; // judged by its cells below
  const t = s.text.toLowerCase();
  if (q.lowered.includes(t.trim()) || squash(q.lowered).includes(squash(t))) return true;
  const d = digitsOnly(s.text);
  if (d && q.numbers.has(d)) return true;
  return false;
}

export interface PruneResult {
  text: string;
  kept: number;
  dropped: number;
  /** Protected spans (offsets in the ORIGINAL text) that sit inside kept sentences. */
  keptSpans: ProtectedSpan[];
}

/**
 * Keep every sentence that mentions a question term or contains a protected span matching the question, in
 * its original order and exactly as written. If nothing qualifies the whole text is returned (fail safe).
 */
export function pruneExtractive(text: string, question: string): PruneResult {
  const spans = findProtectedSpans(text);
  const sentences = splitSentences(text, spans);
  const q = queryTokens(question);
  const keep: boolean[] = sentences.map((s) => {
    const inside = spans.filter((p) => p.start >= s.start && p.end <= s.end);
    if (inside.some((p) => spanMatchesQuestion(p, q))) return true;
    const low = s.text.toLowerCase();
    if (inside.some((p) => p.kind === 'table_row') && (q.terms.some((t) => low.includes(t)) || [...q.numbers].some((n) => digitsOnly(s.text).includes(n)))) return true;
    return q.terms.some((t) => low.includes(t));
  });
  if (!keep.some(Boolean)) return { text, kept: sentences.length, dropped: 0, keptSpans: spans };
  let out = '';
  const keptSpans: ProtectedSpan[] = [];
  sentences.forEach((s, i) => {
    if (!keep[i]) return;
    out += (out ? (s.newLine ? '\n' : ' ') : '') + s.text;
    keptSpans.push(...spans.filter((p) => p.start >= s.start && p.end <= s.end));
  });
  const kept = keep.filter(Boolean).length;
  return { text: out, kept, dropped: sentences.length - kept, keptSpans };
}

/** Rung 1: collapse spaces and blank lines, but only in the gaps between protected spans. */
export function tidyWhitespace(text: string): string {
  const spans = findProtectedSpans(text);
  let out = '';
  let pos = 0;
  const gap = (s: string) => s.replace(/[ \t]+/g, ' ');
  for (const s of spans) {
    out += gap(text.slice(pos, s.start)) + text.slice(s.start, s.end);
    pos = s.end;
  }
  out += gap(text.slice(pos));
  return out
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ------------------------------ profiling and policy ------------------------------ */

export type Rung = 0 | 1 | 2;
export interface PageProfile {
  /** 0 raw, 1 whitespace tidy only, 2 sentence selection. */
  max_rung: Rung;
  reasons: string[];
}

export function profilePage(text: string): PageProfile {
  const reasons: string[] = [];
  const spans = findProtectedSpans(text);
  if (/\b(invoice|bill to|amount due|subtotal|total due|vat|tax invoice|purchase order)\b/i.test(text)) reasons.push('invoice');
  if (/\b(signature|date of birth|applicant|please (?:print|sign))\b|_{4,}/i.test(text)) reasons.push('form');
  if (spans.filter((s) => s.kind === 'table_row').length >= 2) reasons.push('table');
  if (/\b(agreement|hereby|whereas|parties|governing law|indemnif\w*|clause)\b/i.test(text) || spans.some((s) => s.kind === 'clause')) reasons.push('contract');
  if (reasons.length) return { max_rung: 0, reasons };
  const words = Math.max(1, text.split(/\s+/).filter(Boolean).length);
  if (spans.length / words > 0.05) return { max_rung: 1, reasons: ['many figures'] };
  return { max_rung: 2, reasons: [] };
}

const COMPARE = /\b(compare|comparison|versus|vs\.?|differ\w*|difference|contrast|both|between)\b/i;

/** Pruning is off for comparison questions and for more than one document. */
export function pruningAllowed(input: { question: string; documentCount: number }): boolean {
  return input.documentCount <= 1 && !COMPARE.test(input.question);
}

/** Apply at most `min(requested, page max, 0 if not allowed)`. Rung 0 returns the text untouched. */
export function applyRung(text: string, requested: Rung, ctx: { question: string; documentCount: number }): { text: string; rung: Rung } {
  const profile = profilePage(text);
  let rung: Rung = pruningAllowed(ctx) ? (Math.min(requested, profile.max_rung) as Rung) : 0;
  if (rung === 0) return { text, rung };
  let t = tidyWhitespace(text);
  if (rung === 2) t = pruneExtractive(t, ctx.question).text;
  return { text: t, rung };
}
