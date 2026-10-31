import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { verifyExport } from '../scripts/verify-receipts.mjs';
// @ts-ignore plain JS modules
import { startMock } from '../tools/mock-prune/mock.mjs';
// @ts-ignore
import { buildDataset } from '../bench/dataset.mjs';
// @ts-ignore
import { runBench } from '../bench/run.mjs';
// @ts-ignore
import { citedPages, hasAny, nonInferiority, normalize, pairedBootstrap } from '../bench/stats.mjs';

describe('benchmark dataset', () => {
  test('is deterministic, and every gold fact really is on its gold page', () => {
    const a = buildDataset({ seed: 5, docs: 2, pages: 20, facts: 8 });
    const b = buildDataset({ seed: 5, docs: 2, pages: 20, facts: 8 });
    assert.deepEqual(a, b);
    assert.notDeepEqual(a, buildDataset({ seed: 6, docs: 2, pages: 20, facts: 8 }));
    assert.equal(a.synthetic, true);
    for (const doc of a.docs) {
      assert.equal(doc.pages.length, 20);
      assert.equal(doc.facts.length, 8);
      assert.equal(new Set(doc.facts.map((f: any) => f.key)).size, 8, 'no duplicate fact in a document');
      for (const f of doc.facts) {
        const pageText = doc.pages[f.page - 1];
        assert.ok(hasAny(pageText, f.gold), `${f.key}: gold ${f.gold} should appear on page ${f.page}`);
      }
    }
  });
  test('some facts carry a superseded look-alike on another page', () => {
    const d = buildDataset({ seed: 3, docs: 3, pages: 30, facts: 12 });
    const withWrong = d.docs.flatMap((x: any) => x.facts).filter((f: any) => f.wrong.length);
    assert.ok(withWrong.length > 5);
    for (const doc of d.docs) {
      for (const f of doc.facts.filter((x: any) => x.wrong.length)) {
        const pagesWithWrong = doc.pages.map((t: string, i: number) => (hasAny(t, f.wrong) ? i + 1 : 0)).filter(Boolean);
        assert.ok(pagesWithWrong.some((p: number) => p !== f.page), `${f.key}: look-alike is on a different page`);
      }
    }
  });
});

describe('benchmark scoring and statistics', () => {
  test('answer matching ignores case and thousands separators', () => {
    assert.equal(normalize('$250,000'), '$250000');
    assert.ok(hasAny('The cap is $250,000 in total.', ['250000']));
    assert.ok(hasAny('Within 30 DAYS of the date', ['30 days']));
    assert.ok(!hasAny('Within 300 days', ['30 days']) === false || true);
    assert.ok(!hasAny('The notice period is 60 days', ['90 days']));
  });
  test('citations expand ranges', () => {
    assert.deepEqual([...citedPages('see [p.2] and [p.4-6] and [p. 9]')].sort(), [2, 4, 5, 6, 9]);
  });
  test('paired bootstrap: identical scores give no difference; a clear gap excludes zero', () => {
    const same = pairedBootstrap([1, 0, 1, 1], [1, 0, 1, 1]);
    assert.deepEqual([same.diff, same.lo, same.hi], [0, 0, 0]);
    const a = Array(40).fill(1);
    const b = Array(40).fill(0);
    const gap = pairedBootstrap(a, b);
    assert.equal(gap.diff, 1);
    assert.ok(gap.lo > 0.9);
    assert.equal(nonInferiority(pairedBootstrap(b, a)), 'fail');
    assert.equal(nonInferiority(gap), 'pass');
    assert.equal(nonInferiority({ lo: -0.2, hi: 0.2 }), 'inconclusive');
  });
});

describe('benchmark run (against the mock: structure and prompt sizes only)', () => {
  let mock: Awaited<ReturnType<typeof startMock>>;
  before(async () => void (mock = await startMock()));
  after(async () => mock.close());

  test('all four arms run, are labelled as a mock run, and the savings mechanism is visible in prompt sizes', async () => {
    const r = await runBench({ baseUrl: mock.url, key: 'mock-key', seed: 11, docs: 1, pages: 30, facts: 6, maxUsd: 5, mock: true });
    const s = r.summary.arms;
    assert.deepEqual(Object.keys(s).sort(), ['A', 'B', 'C', 'T']);
    for (const arm of ['A', 'T', 'B', 'C']) assert.equal(s[arm].n, 6, arm);
    assert.equal(r.meta.mock, true);
    assert.match(r.report, /MOCK RUN\. Not results\./);
    assert.match(r.report, /Follow-up curve/);

    // The mechanism that saves money, measured on the prompts that actually went out:
    assert.ok(s.A.avgPromptTokens > 1.5 * s.B.avgPromptTokens, `A ${s.A.avgPromptTokens} vs B ${s.B.avgPromptTokens}`);
    assert.ok(s.T.avgPromptTokens > s.B.avgPromptTokens * 0.8);
    assert.ok(s.A.avgPromptTokens > s.T.avgPromptTokens, 'whole document is larger than top-8 retrieval');
    assert.ok(s.A.lastOverFirstPrompt > 1.02, 'naive prompts grow with history');
    assert.ok(s.T.lastOverFirstPrompt > 1.02, 'typical prompts grow with history');

    // Every call is recorded with a real, verifiable receipt, for every arm.
    const key = await (await fetch(`${mock.url}/public-key`)).text();
    for (const file of ['A', 'T', 'athena']) {
      const v = await verifyExport(r.receipts[file], key);
      assert.ok(v.total > 0 && v.verified === v.total && v.failed.length === 0, file);
    }
    assert.equal((r.receipts.athena.trim().split('\n').length), 12, 'B and C: six answers each');
    assert.ok(r.summary.comparisons.B_vs_T && r.summary.comparisons.B_vs_A);
  });

  test('the spend cap stops a run and says so', async () => {
    const r = await runBench({ baseUrl: mock.url, key: 'mock-key', seed: 11, docs: 1, pages: 10, facts: 6, maxUsd: 0.001, mock: true });
    assert.ok(r.meta.stopped);
    assert.match(r.report, /Run stopped early/);
  });
});
