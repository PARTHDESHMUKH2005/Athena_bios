import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { extractFacts, normalizeText, numberReadings, parseGateJson, quoteInPage, runGate, shouldAbstain, stripReferences } from '../src/gate.ts';

const gate = (answer: string, pages: Record<number, string>, cites: { page: number; quote?: string }[], sent?: number[]) =>
  runGate({
    answer,
    citations: cites,
    pageText: (_d, p) => pages[p],
    wasSent: (_d, p) => (sent ?? Object.keys(pages).map(Number)).includes(p),
  });

describe('quote check', () => {
  const page = 'The Supplier shall deliver the goods within ten (10) business days.\nRisk passes on  delivery.';
  test('exact quote', () => assert.equal(quoteInPage(page, 'deliver the goods within ten (10) business days'), true));
  test('case and whitespace differences', () => assert.equal(quoteInPage(page, 'RISK PASSES   ON DELIVERY'), true));
  test('a quote spanning a line break', () => assert.equal(quoteInPage(page, 'business days. Risk passes on delivery'), true));
  test('curly quotes and dashes are unified', () => {
    assert.equal(quoteInPage('The “Customer” can’t cancel — ever.', 'the "customer" can\'t cancel - ever'), true);
  });
  test('zero-width characters and soft hyphens are ignored', () => {
    assert.equal(quoteInPage('pay​ment is due', 'payment is due'), true);
    assert.equal(quoteInPage('pay­ment is due', 'payment is due'), true);
  });
  test('a quote that is not on the page fails', () => assert.equal(quoteInPage(page, 'within five business days'), false));
  test('an empty quote never passes', () => assert.equal(quoteInPage(page, '   '), false));
  test('normalizeText is idempotent', () => assert.equal(normalizeText(normalizeText('  A  B ')), 'a b'));
});

describe('number and date formats', () => {
  const keys = (t: string, side: 'answer' | 'page' = 'answer') => extractFacts(t, side).flatMap((f) => f.keys);
  test('thousands separator', () => assert.deepEqual(keys('1,000'), ['n:1000']));
  test('plain integer', () => assert.deepEqual(keys('1000'), ['n:1000']));
  test('decimal with trailing zeros', () => assert.deepEqual(keys('4200.00'), ['n:4200']));
  test('currency symbol', () => assert.deepEqual(keys('$4,200.50'), ['n:4200.5']));
  test('currency code prefix', () => assert.deepEqual(keys('USD 4,200'), ['n:4200']));
  test('European format 1.234,56', () => assert.deepEqual(keys('1.234,56'), ['n:1234.56']));
  test('decimal comma 3,5', () => assert.deepEqual(keys('3,5'), ['n:3.5']));
  test('percent in both spellings', () => {
    assert.deepEqual(keys('12%'), ['p:12']);
    assert.deepEqual(keys('12 percent'), ['p:12']);
  });
  test('an ISO date on a page also yields month-day and month keys; in an answer only the full date', () => {
    assert.deepEqual(keys('2026-04-03'), ['d:2026-04-03']);
    const p = keys('2026-04-03', 'page');
    assert.ok(p.includes('d:2026-04-03') && p.includes('d:--04-03') && p.includes('m:2026-04'));
  });
  test('a no-break space between digit groups is a thousands mark', () => assert.deepEqual(keys('1\u00a0200 g'), ['n:1200']));
  test('"4 April 2026" is not satisfied by a page that only says "3 April 2026"', () => {
    const r = runGate({ answer: 'Dated 4 April 2026.', citations: [{ page: 1 }], pageText: () => 'Dated 3 April 2026.', wasSent: () => true });
    assert.equal(r.pass, false);
  });
  test('inline list numbering is not a figure', () => assert.deepEqual(extractFacts(stripReferences('Terms: 1. Payment is due. 2. Late fees apply.')), []));
  test('03/04/2026 can be 3 April or March 4', () => {
    const k = keys('03/04/2026');
    assert.ok(k.includes('d:2026-04-03') && k.includes('d:2026-03-04'));
  });
  test('13/04/2026 can only be 13 April', () => {
    const k = keys('13/04/2026');
    assert.ok(k.includes('d:2026-04-13') && !k.includes('d:2026-13-04'));
  });
  test('English month names, both orders', () => {
    assert.ok(keys('3 April 2026').includes('d:2026-04-03'));
    assert.ok(keys('April 3, 2026').includes('d:2026-04-03'));
    assert.ok(keys('3rd of Sept. 2026').includes('d:2026-09-03'));
  });
  test('page references and list numbers are not demanded as evidence', () => {
    assert.deepEqual(extractFacts(stripReferences('1. Payment is due [p.3]. See page 4.')), []);
  });
  test('ambiguous 1.000 gets both readings on the page side only', () => {
    assert.deepEqual(numberReadings('1.000').all.sort(), ['1', '1000']);
    assert.deepEqual(extractFacts('1.000', 'answer')[0]!.keys, ['n:1']);
  });
  test('digits inside words or ids with letters before them are not numbers', () => assert.deepEqual(keys('Q3 and v2.1'), []));
  test('a date is consumed once, its digits are not also numbers (answer side)', () => assert.equal(extractFacts('3 April 2026').length, 1));
});

describe('the gate', () => {
  const p1 = 'Payment is due within 30 days of the invoice date. Late fees of 1.5% apply after 45 days.\nTotal due: $4,200.00 on 3 April 2026.';
  const p2 = 'Either party may terminate with 60 days written notice.';

  test('passes when quote, numbers and page all check out', () => {
    const r = gate('Payment is due within 30 days [p.1]. The total is $4200 due 03/04/2026.', { 1: p1 }, [{ page: 1, quote: 'Payment is due within 30 days of the invoice date' }]);
    assert.equal(r.pass, true, JSON.stringify(r.failures));
    assert.equal(r.mode, 'quotes');
  });
  test('fails on a number that is not on the cited page', () => {
    const r = gate('The total is $4,300.', { 1: p1 }, [{ page: 1 }]);
    assert.equal(r.pass, false);
    assert.equal(r.failures[0]!.type, 'number');
    assert.match(r.failures[0]!.detail, /4,300 not found on page 1/);
  });
  test('a number found only on a page that was not cited still fails', () => {
    const r = gate('Termination needs 60 days notice.', { 1: p1, 2: p2 }, [{ page: 1 }]);
    assert.equal(r.pass, false);
    assert.equal(r.failures[0]!.type, 'number');
  });
  test('a number found on any of several cited pages passes', () => {
    assert.equal(gate('Fees apply after 45 days and notice is 60 days.', { 1: p1, 2: p2 }, [{ page: 1 }, { page: 2 }]).pass, true);
  });
  test('wrong quote fails with the page named', () => {
    const r = gate('Fees apply.', { 1: p1 }, [{ page: 1, quote: 'fees are waived after 45 days' }]);
    assert.deepEqual(r.failures.map((f) => f.type), ['quote']);
    assert.match(r.failures[0]!.detail, /page 1/);
  });
  test('a page that was never sent fails the page check', () => {
    const r = gate('Fees apply after 45 days.', { 1: p1, 9: p1 }, [{ page: 9 }], [1]);
    assert.equal(r.failures[0]!.type, 'page');
  });
  test('a cited page with no stored text fails', () => {
    assert.equal(gate('Anything.', {}, [{ page: 3 }], [3]).failures[0]!.type, 'page');
  });
  test('no citation at all fails; an honest "not in the document" passes with nothing to check', () => {
    assert.equal(gate('It is 30 days.', { 1: p1 }, []).pass, false);
    const r = gate("I couldn't find that in the document.", { 1: p1 }, []);
    assert.equal(r.pass, true);
    assert.equal(r.abstained, true);
  });
  test('percentages must match as percentages', () => {
    assert.equal(gate('The late fee is 1.5 percent.', { 1: p1 }, [{ page: 1 }]).pass, true);
    assert.equal(gate('The late fee is 15%.', { 1: p1 }, [{ page: 1 }]).pass, false);
  });
  test('a partial date (no year) finds a full date on the page', () => {
    assert.equal(gate('It is due on 3 April.', { 1: p1 }, [{ page: 1 }]).pass, true);
    assert.equal(gate('It is due on 4 April.', { 1: p1 }, [{ page: 1 }]).pass, false);
  });
  test('a year in the answer is found inside a full date on the page', () => {
    assert.equal(gate('Dated 2026.', { 1: p1 }, [{ page: 1 }]).pass, true);
  });
  test('a known limit: an EU-formatted answer 1.000 is not matched with a page that says 1000', () => {
    assert.equal(gate('The fee is 1.000.', { 1: 'The fee is 1000 euros.' }, [{ page: 1 }]).pass, false);
  });
  test('the gate never touches the network or a model (it is synchronous and takes only data)', () => {
    const real = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => { calls++; throw new Error('network'); }) as never;
    try {
      gate('Payment is due within 30 days.', { 1: p1 }, [{ page: 1, quote: 'Payment is due' }]);
    } finally {
      globalThis.fetch = real;
    }
    assert.equal(calls, 0);
  });
});

describe('model JSON and abstaining', () => {
  test('valid JSON, fenced JSON and bad JSON', () => {
    assert.equal(parseGateJson('{"answer":"x","citations":[{"page":1,"quote":"q"}]}').ok, true);
    assert.equal(parseGateJson('```json\n{"answer":"x","citations":[]}\n```').ok, true);
    assert.equal(parseGateJson('sorry').ok, false);
    assert.equal(parseGateJson('{"answer":"x","citations":[{"page":0,"quote":"q"}]}').ok, false);
  });
  test('weak or missing retrieval abstains; strong retrieval does not', () => {
    assert.equal(shouldAbstain([], { minStrength: 1, minMargin: 0 }), true);
    assert.equal(shouldAbstain([-0.4], { minStrength: 1, minMargin: 0 }), true);
    assert.equal(shouldAbstain([-3.2, -1], { minStrength: 1, minMargin: 0 }), false);
    assert.equal(shouldAbstain([-3.2, -3.1], { minStrength: 1, minMargin: 0.5 }), true);
  });
});
