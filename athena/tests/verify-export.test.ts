import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { makeHarness } from './harness.ts';
// @ts-ignore plain JS modules
import { startMock } from '../tools/mock-prune/mock.mjs';
// @ts-ignore
import { verifyExport } from '../scripts/verify-receipts.mjs';

let mock: Awaited<ReturnType<typeof startMock>>;
before(async () => void (mock = await startMock()));
after(async () => mock.close());
beforeEach(() => {
  mock.state.calls.length = 0;
  mock.state.queue.length = 0;
});

describe('offline receipt verification of the exported proof file', () => {
  async function exported() {
    const h = await makeHarness(mock);
    const tok = await h.session();
    const chat = await h.newChat(tok, (await h.upload(tok)).id);
    mock.queue.push('ok', 'odd_numbers', 'cache_hit');
    for (let i = 0; i < 3; i++) assert.equal((await h.askQ(tok, chat, `What are the payment terms? ${i}`)).status, 200);
    const jsonl = (await h.call('GET', '/api/export/receipts.jsonl', tok)).text;
    const key = await (await fetch(`${mock.url}/public-key`)).text();
    return { jsonl, key };
  }

  test('a clean export verifies completely, including odd-number and cache-hit receipts', async () => {
    const { jsonl, key } = await exported();
    const r = await verifyExport(jsonl, key);
    assert.equal(r.total, 3);
    assert.equal(r.verified, 3);
    assert.deepEqual(r.failed, []);
    assert.deepEqual(r.costMismatch, []);
    assert.equal(r.cacheHits, 1);
    assert.ok(Math.abs(r.receiptCostUsd - r.recordedCostUsd) < 1e-9, 'cost re-read from receipts equals what we recorded');
  });

  test('editing the cost we recorded is caught as a mismatch', async () => {
    const { jsonl, key } = await exported();
    const doctored = jsonl.replace(/"cost_micro":412/, '"cost_micro":1');
    const r = await verifyExport(doctored, key);
    assert.equal(r.costMismatch.length, 1);
  });

  test('editing a receipt itself breaks its signature', async () => {
    const { jsonl, key } = await exported();
    const doctored = jsonl.replace('0.000412', '0.000001');
    const r = await verifyExport(doctored, key);
    assert.ok(r.failed.length >= 1);
    assert.ok(r.verified < r.total);
  });

  test('a receipt signed by a different key fails; junk lines are reported, not crashed on', async () => {
    const { jsonl } = await exported();
    const other = await startMock();
    try {
      const wrongKey = await (await fetch(`${other.url}/public-key`)).text();
      const r = await verifyExport(jsonl, wrongKey);
      assert.equal(r.verified, 0);
      assert.equal(r.failed.length, 3);
    } finally {
      await other.close();
    }
    const junk = await verifyExport('not json\n{"call_id":"k1"}\n', 'x');
    assert.equal(junk.verified, 0);
    assert.equal(junk.failed.length, 2);
  });
});
