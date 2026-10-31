import { InvoiceSchema, checkInvoiceTotal, parseJsonLoose } from './packs/index.ts';
import type { Invoice } from './packs/index.ts';

export interface SectionRef {
  id: number;
  document_id: string;
  page_start: number;
  page_end: number;
}
export interface Citation {
  document_id: string;
  page_start: number;
  page_end: number;
  section_id: number;
}

const NOT_FOUND = /couldn['’]t find that in the document/i;
const CITE = /\[p\.\s*(\d+)(?:\s*[-–]\s*(\d+))?\]/g;

/**
 * Valid = every cited page lies inside a retrieved section, and there is at least one citation
 * (or the model honestly said the answer is not in the text). Multi-document chats cite by page only,
 * so the first retrieved section covering the page supplies the document id.
 */
export function validateAnswer(text: string, sections: SectionRef[]): { ok: boolean; citations: Citation[]; reason: string } {
  const citations: Citation[] = [];
  const seen = new Set<string>();
  let invalid = 0;
  for (const m of text.matchAll(CITE)) {
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    const sec = sections.find((s) => a >= s.page_start && b <= s.page_end) ?? sections.find((s) => a >= s.page_start && a <= s.page_end);
    if (!sec) {
      invalid++;
      continue;
    }
    const key = `${sec.document_id}:${a}:${b}`;
    if (!seen.has(key)) {
      seen.add(key);
      citations.push({ document_id: sec.document_id, page_start: a, page_end: b, section_id: sec.id });
    }
  }
  if (NOT_FOUND.test(text)) return { ok: true, citations, reason: 'answer says it is not in the document' };
  if (invalid > 0) return { ok: false, citations, reason: 'cites a page that was not provided' };
  if (!citations.length) return { ok: false, citations, reason: 'no citation' };
  return { ok: true, citations, reason: 'citations valid' };
}

export function validateExtraction(text: string): { ok: true; invoice: Invoice; check: { ok: boolean; message: string } } | { ok: false; reason: string } {
  try {
    const parsed = InvoiceSchema.safeParse(parseJsonLoose(text));
    if (!parsed.success) return { ok: false, reason: 'JSON does not match the invoice format' };
    return { ok: true, invoice: parsed.data, check: checkInvoiceTotal(parsed.data) };
  } catch {
    return { ok: false, reason: 'not valid JSON' };
  }
}
