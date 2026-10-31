import { estTokens } from './util.ts';

export interface PageIn {
  page_no: number;
  text: string;
}
export interface SectionOut {
  ordinal: number;
  title: string;
  text: string;
  page_start: number;
  page_end: number;
  token_est: number;
}

const TARGET = 400;
const MIN = 80;
const OVERLAP = Math.round(TARGET * 0.15);
const MAX_LINE_CHARS = 1200;

interface Unit {
  text: string;
  page: number;
  tokens: number;
  heading: boolean;
}

export function isHeading(line: string): boolean {
  const t = line.trim();
  if (t.length < 3 || t.length > 80 || /[.;,]$/.test(t)) return false;
  if (/^\d+(\.\d+)*[.)]?\s+\S/.test(t) && t.length <= 60) return true;
  const letters = t.replace(/[^A-Za-z]/g, '');
  return letters.length >= 3 && t === t.toUpperCase();
}

function splitLong(line: string): string[] {
  if (line.length <= MAX_LINE_CHARS) return [line];
  const out: string[] = [];
  let rest = line;
  while (rest.length > MAX_LINE_CHARS) {
    let cut = rest.lastIndexOf(' ', MAX_LINE_CHARS);
    if (cut < MAX_LINE_CHARS / 2) cut = MAX_LINE_CHARS;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Deterministic sectioning, no model call. Splits on headings, otherwise windows of about 400 tokens
 * with 15 percent overlap, and keeps the page range of every section for citations.
 */
export function sectionPages(pages: PageIn[]): SectionOut[] {
  const units: Unit[] = [];
  for (const p of [...pages].sort((a, b) => a.page_no - b.page_no)) {
    for (const rawLine of p.text.split(/\r?\n/)) {
      const t = rawLine.trim();
      if (!t) continue;
      for (const piece of splitLong(t)) {
        units.push({ text: piece, page: p.page_no, tokens: estTokens(piece) + 1, heading: isHeading(piece) });
      }
    }
  }

  const out: SectionOut[] = [];
  let cur: Unit[] = [];
  let curTokens = 0;
  let title = '';

  const flush = (keepOverlap: boolean) => {
    if (!cur.length) return;
    out.push({
      ordinal: out.length,
      title,
      text: cur.map((u) => u.text).join('\n'),
      page_start: cur[0]!.page,
      page_end: cur[cur.length - 1]!.page,
      token_est: curTokens,
    });
    if (keepOverlap) {
      const carry: Unit[] = [];
      let acc = 0;
      for (let i = cur.length - 1; i > 0 && acc < OVERLAP; i--) {
        carry.unshift(cur[i]!);
        acc += cur[i]!.tokens;
      }
      cur = carry;
      curTokens = acc;
    } else {
      cur = [];
      curTokens = 0;
    }
  };

  for (const u of units) {
    if (u.heading && curTokens >= MIN) {
      flush(false);
      title = u.text;
    } else if (u.heading && !cur.length) {
      title = u.text;
    }
    if (curTokens + u.tokens > TARGET && curTokens >= MIN) flush(true);
    cur.push(u);
    curTokens += u.tokens;
  }
  flush(false);
  return out;
}
