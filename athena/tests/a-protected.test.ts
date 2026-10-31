import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, test } from 'node:test';
import { applyRung, findProtectedSpans, profilePage, pruneExtractive, pruningAllowed, splitSentences, tidyWhitespace } from '../src/protected.ts';

const INVOICE = [
  'INVOICE INV-2026-0042 from ACME TRADING LIMITED',
  'Issued 3 April 2026. Payment is due by 2026-05-03 to IBAN GB29NWBK60161331926819.',
  'Item     Qty   Unit    Amount',
  'Widget   2     50.00   100.00',
  'Gadget   10    1,250.50  12,505.00',
  'Late fees of 1.5% apply under Section 4.2(a) of the terms. Rs. 500 is waived for orders above $1,000.00.',
  'The office is closed on public holidays. Our cat is called Biscuit.',
].join('\n');

describe('protected spans', () => {
  const kinds = (t: string) => new Set(findProtectedSpans(t).map((s) => s.kind));
  test('finds amounts, dates, ids, clauses, parties and table rows', () => {
    const k = kinds(INVOICE);
    for (const want of ['currency', 'date', 'id', 'clause', 'party', 'table_row', 'percent']) assert.ok(k.has(want as never), want);
  });
  test('sentences are never cut inside a protected span or after Rs.', () => {
    const spans = findProtectedSpans(INVOICE);
    for (const s of splitSentences(INVOICE, spans)) {
      for (const p of spans) assert.ok(!(s.start > p.start && s.start < p.end) && !(s.end > p.start && s.end < p.end), `cut inside ${p.text}`);
    }
    assert.ok(splitSentences(INVOICE).some((s) => s.text.includes('Rs. 500 is waived')));
  });
});

describe('extractive pruning keeps protected text byte for byte', () => {
  test('every protected span in a kept sentence appears verbatim in the output', () => {
    for (const q of ['What is the late fee under Section 4.2(a)?', 'When is invoice INV-2026-0042 due?', 'What does the Gadget row total?', 'What is the IBAN?']) {
      const r = pruneExtractive(INVOICE, q);
      for (const s of r.keptSpans) assert.ok(r.text.includes(s.text), `${q}: lost "${s.text}"`);
      assert.ok(r.text.length <= INVOICE.length);
    }
  });
  test('a sentence whose protected span matches the question is kept in full', () => {
    const r = pruneExtractive(INVOICE, 'What is the amount 12,505.00?');
    assert.ok(r.text.includes('Gadget   10    1,250.50  12,505.00'), 'table row kept with its original spacing');
  });
  test('irrelevant sentences are dropped, relevant ones are not reworded', () => {
    const r = pruneExtractive(INVOICE, 'What are the late fees?');
    assert.ok(r.text.includes('Late fees of 1.5% apply under Section 4.2(a) of the terms.'));
    assert.ok(!r.text.includes('Biscuit'));
    assert.ok(r.dropped > 0);
  });
  test('output sentences are exact substrings of the source (nothing rewritten)', () => {
    const r = pruneExtractive(INVOICE, 'When is it due?');
    for (const line of r.text.split('\n')) for (const sent of splitSentences(line)) assert.ok(INVOICE.includes(sent.text));
  });
  test('when nothing matches the whole text is returned', () => assert.equal(pruneExtractive(INVOICE, 'zebra quantum').text, INVOICE));
});

describe('rungs, profiles and policy', () => {
  test('rung 1 only collapses spaces between protected spans', () => {
    const t = tidyWhitespace('Widget   2     50.00   100.00\nPlease   note   this   text.\n\n\n\nend');
    assert.ok(t.includes('Widget   2     50.00   100.00'));
    assert.ok(t.includes('Please note this text.'));
    assert.ok(!t.includes('\n\n\n'));
  });
  test('invoices, forms, tables and contracts stay raw', () => {
    assert.equal(profilePage(INVOICE).max_rung, 0);
    assert.equal(profilePage('Applicant name: ________ Signature: ________').max_rung, 0);
    assert.equal(profilePage('This agreement is between the parties. Governing law is English law.').max_rung, 0);
    assert.equal(profilePage('The weather was calm and the village was quiet in the early morning light.').max_rung, 2);
  });
  test('pruning is off for comparisons and for more than one document', () => {
    assert.equal(pruningAllowed({ question: 'Compare the two fees', documentCount: 1 }), false);
    assert.equal(pruningAllowed({ question: 'What is the fee?', documentCount: 2 }), false);
    assert.equal(pruningAllowed({ question: 'What is the fee?', documentCount: 1 }), true);
    const prose = 'The village was quiet. Birds sang in the trees. The baker opened early. A dog barked twice.';
    assert.equal(applyRung(prose, 2, { question: 'Compare the baker', documentCount: 1 }).text, prose);
    assert.equal(applyRung(INVOICE, 2, { question: 'What are the late fees?', documentCount: 1 }).text, INVOICE, 'an invoice is capped at rung 0');
  });
});

describe('no masking, distillation or DSL path exists', () => {
  test('the source tree has no such code', () => {
    const src = readdirSync(new URL('../src/', import.meta.url), { recursive: true }).filter((f) => String(f).endsWith('.ts'));
    for (const f of src) {
      const text = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
      assert.ok(!/\b(maskIdentifiers?|distillSchema|compressToDsl|identifierMask)\b/i.test(text), String(f));
    }
  });
});
