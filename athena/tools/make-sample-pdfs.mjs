// Generates two small, valid, SYNTHETIC text PDFs for demos: a contract and an invoice.
// Output: web/public/samples/. Run: node tools/make-sample-pdfs.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildDataset } from '../bench/dataset.mjs';

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
const wrap = (text, width) => {
  const out = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const w of para.split(' ')) {
      if ((line + ' ' + w).trim().length > width) {
        out.push(line);
        line = w;
      } else line = (line + ' ' + w).trim();
    }
    out.push(line);
  }
  return out;
};

/** pages: string[] of plain text. Returns a Buffer holding a valid PDF. */
function makePdf(pages) {
  const objs = [];
  const add = (body) => objs.push(body) && objs.length;
  const fontId = 3 + pages.length * 2 + 0; // assigned below
  const catalog = add('<< /Type /Catalog /Pages 2 0 R >>');
  const pagesObj = add(''); // filled after we know the kids
  const kids = [];
  const contentIds = [];
  // object numbering: 1 catalog, 2 pages, then for each page: page obj, content obj; then font
  const fontObjNumber = 3 + pages.length * 2;
  for (let i = 0; i < pages.length; i++) {
    const pageNum = 3 + i * 2;
    const contentNum = pageNum + 1;
    kids.push(`${pageNum} 0 R`);
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObjNumber} 0 R >> >> /Contents ${contentNum} 0 R >>`);
    const lines = wrap(pages[i], 86);
    let y = 740;
    let stream = 'BT\n/F1 10 Tf\n13 TL\n';
    stream += `54 ${y} Td\n`;
    for (const l of lines) {
      stream += `(${esc(l)}) Tj T*\n`;
    }
    stream += 'ET';
    objs.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    contentIds.push(contentNum);
  }
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  objs[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`;
  void catalog; void pagesObj; void fontId;

  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, idx) => {
    offsets.push(Buffer.byteLength(out));
    out += `${idx + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'binary');
}

const dir = new URL('../web/public/samples/', import.meta.url);
mkdirSync(dir, { recursive: true });

// Contract: seeded synthetic agreement, 6 pages, with a few known clauses.
const ds = buildDataset({ seed: 21, docs: 1, pages: 6, facts: 8 });
writeFileSync(new URL('sample-agreement.pdf', dir), makePdf(ds.docs[0].pages));
writeFileSync(new URL('sample-agreement.questions.json', dir), JSON.stringify(ds.docs[0].facts.map((f) => ({ q: f.q, answer: f.gold[0], page: f.page })), null, 2));

// Invoice: values match the mock's extraction output (Acme Ltd, INV-1, 2 x 50, tax 10, total 110).
const invoice = [
  [
    'INVOICE INV-1',
    'Acme Ltd',
    '12 Example Street, Springfield',
    '',
    'Invoice date: 2026-01-01',
    'Due date: 2026-01-31',
    'Currency: USD',
    '',
    'Description        Quantity        Unit price        Amount',
    'Widget             2               50                100',
    '',
    'Subtotal 100',
    'Tax 10',
    'Total 110',
    '',
    'Payment is due within 30 days of the invoice date. This is a synthetic sample invoice for demonstration only.',
  ].join('\n'),
];
writeFileSync(new URL('sample-invoice.pdf', dir), makePdf(invoice));
console.log('wrote web/public/samples/sample-agreement.pdf, sample-invoice.pdf and sample-agreement.questions.json');
