// Text is read in the user's browser (athena.md decision 3), so the Worker never does heavy PDF work.
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { LIMITS } from './limits';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export { LIMITS };

export class PdfError extends Error {}

interface TextItemLike {
  str: string;
  transform: number[];
  hasEOL?: boolean;
}

/** Extract text page by page. Lines are rebuilt from item positions, so tables and headings keep their line breaks. */
export async function extractPdf(data: ArrayBuffer, onPage?: (page: number, total: number) => void): Promise<string[]> {
  let doc;
  try {
    doc = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
  } catch {
    throw new PdfError("This file couldn't be read as a PDF.");
  }
  if (doc.numPages > LIMITS.maxPages) throw new PdfError(`This PDF has ${doc.numPages} pages. The limit is ${LIMITS.maxPages}.`);
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let out = '';
    let lastY: number | null = null;
    for (const raw of content.items) {
      const item = raw as TextItemLike;
      if (typeof item.str !== 'string') continue;
      const y = item.transform?.[5] ?? 0;
      // One newline per visual line: a position change or an end-of-line marker, never both.
      if (lastY !== null && Math.abs(y - lastY) > 2) {
        if (out && !out.endsWith('\n')) out += '\n';
      } else if (out && !out.endsWith('\n') && !out.endsWith(' ') && !item.str.startsWith(' ')) out += ' ';
      out += item.str;
      if (item.hasEOL && !out.endsWith('\n')) out += '\n';
      lastY = y;
    }
    pages.push(out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim());
    onPage?.(i, doc.numPages);
  }
  return pages;
}
