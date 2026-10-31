import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { BASELINE_TOOLTIP } from '../src/baseline.ts';
import { verifyReceiptDetailed } from '../src/receipts.ts';
import { makeHarness } from './harness.ts';
import { rowOf } from './helpers.ts';
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
  mock.state.breakSignature = false;
});

async function oneAnswer(over: Record<string, string> = {}) {
  const h = await makeHarness(mock, over);
  const tok = await h.session();
  const chat = await h.newChat(tok, (await h.upload(tok)).id);
  const a = await h.askQ(tok, chat, 'What are the payment terms?');
  assert.equal(a.status, 200, a.text);
  const callId = a.json.usage.call_id as string;
  const rec = await h.call('GET', `/api/receipts/${callId}`, tok);
  return { h, tok, chat, a, callId, rec, raw: rec.json.receipt_json as string };
}
const verifyOverride = (x: Awaited<ReturnType<typeof oneAnswer>>, raw: string) =>
  x.h.call('POST', `/api/receipts/${x.callId}/verify`, x.tok, { receipt_override_raw: raw });

describe('Point 1: three cost numbers, always labelled', () => {
  test('every answer and its receipt carry actual cost, cost without Prune, and the naive baseline', async () => {
    const x = await oneAnswer();
    assert.equal(x.a.json.usage.cost_usd, 0.000412);
    assert.equal(x.a.json.usage.cost_without_prune_usd, 0.0012);
    assert.ok(x.a.json.usage.naive_baseline_usd > 0);
    const c = x.rec.json.cost;
    assert.deepEqual(c.labels, { actual: 'Actual cost', without_prune: 'Without Prune’s savings', naive_baseline: 'Naive baseline (Athena estimate)' });
    assert.equal(c.actual_usd, 0.000412);
    assert.equal(c.without_prune_usd, 0.0012);
    assert.equal(c.naive_baseline_usd, x.a.json.usage.naive_baseline_usd);
  });

  test('the baseline is recomputable from the stored inputs, and says plainly it is not signed', async () => {
    const x = await oneAnswer();
    const b = x.rec.json.baseline;
    const i = b.inputs;
    assert.equal(b.formula_version, 'v1');
    assert.equal(b.naive_input_tokens, i.full_document_tokens + i.full_chat_history_tokens + i.question_tokens + i.system_tokens);
    assert.equal(Math.ceil(b.naive_input_tokens * i.in_per_m + i.output_tokens * i.out_per_m) / 1e6, x.rec.json.cost.naive_baseline_usd);
    assert.ok(i.full_document_tokens > 0 && i.system_tokens > 0);
    assert.match(b.inputs_note, /not signed/);
    assert.equal(b.inputs_signed, false);
    assert.equal(b.tooltip, BASELINE_TOOLTIP);
    assert.match(b.tooltip, /The signature proves what Prune charged\. The naive baseline is Athena.s own calculation\./);
    assert.match(b.savings_note, /separate from Athena.s retrieval savings/);
    const row = await rowOf<{ naive_formula_version: string; naive_cost_micro: number }>(x.h.env, 'SELECT naive_formula_version, naive_cost_micro FROM llm_calls WHERE id = ?', x.callId);
    assert.equal(row!.naive_formula_version, 'v1');
  });
});

describe('Point 1: the Verify button', () => {
  test('a genuine receipt verifies, and Prune\'s own verify endpoint agrees', async () => {
    const x = await oneAnswer();
    const v = await x.h.call('POST', `/api/receipts/${x.callId}/verify`, x.tok, {});
    assert.equal(v.json.verify_status, 'verified');
    assert.equal(v.json.saved, true);
    assert.equal(v.json.override, false);
    const hosted = await (await fetch(`${mock.url}/receipts/verify`, { method: 'POST', body: `{"receipt":${x.raw}}` })).json();
    assert.equal(hosted.valid, true);
    const row = await rowOf<{ verify_status: string; verified_at: number; verify_reason: string | null }>(x.h.env, 'SELECT verify_status, verified_at, verify_reason FROM llm_calls WHERE id = ?', x.callId);
    assert.equal(row!.verify_status, 'verified');
    assert.ok(row!.verified_at > 0);
    assert.equal(row!.verify_reason, null);
    assert.ok(await rowOf(x.h.env, "SELECT 1 AS ok FROM events WHERE type = 'receipt_verified' AND ref_id = ?", x.callId), 'an events row is written');
  });

  test('changing one digit makes verification fail, in the app and offline, and Prune agrees', async () => {
    const x = await oneAnswer();
    const edited = x.raw.replace('0.000412', '0.000413');
    assert.notEqual(edited, x.raw);
    const v = await verifyOverride(x, edited);
    assert.equal(v.json.verify_status, 'failed');
    assert.equal(v.json.reason, 'signature_mismatch');
    assert.equal(v.json.reason_text, 'Signature does not match');
    const hosted = await (await fetch(`${mock.url}/receipts/verify`, { method: 'POST', body: `{"receipt":${edited}}` })).json();
    assert.equal(hosted.valid, false);
    // offline
    const key = await (await fetch(`${mock.url}/public-key`)).text();
    const line = (r: string) => JSON.stringify({ call_id: x.callId, cost_micro: 412, receipt_raw: r }) + '\n';
    assert.equal((await verifyExport(line(x.raw), key)).verified, 1);
    assert.equal((await verifyExport(line(edited), key)).verified, 0);
  });

  test('changing the signature, the key id or the cost field fails', async () => {
    const x = await oneAnswer();
    await x.h.call('POST', `/api/receipts/${x.callId}/verify`, x.tok, {}); // genuine check first: remembers the key id
    const sig = /"receipt_signature": "([^"]+)"/.exec(x.raw)![1]!;
    const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
    assert.equal((await verifyOverride(x, x.raw.replace(sig, flipped))).json.reason, 'signature_mismatch');
    const kid = await verifyOverride(x, x.raw.replace('mock-key-1', 'someone-elses-key'));
    assert.equal(kid.json.verify_status, 'failed');
    assert.equal(kid.json.reason, 'unknown_key');
    assert.equal((await verifyOverride(x, x.raw.replace('0.000412', '0.000001'))).json.verify_status, 'failed');
    // The recorded cost no longer equals the signed cost: a mismatch, even though the signature is intact.
    await x.h.env.DB.prepare('UPDATE llm_calls SET cost_micro = 1 WHERE id = ?').bind(x.callId).run();
    const m = await x.h.call('POST', `/api/receipts/${x.callId}/verify`, x.tok, {});
    assert.equal(m.json.verify_status, 'failed');
    assert.equal(m.json.reason, 'cost_mismatch');
    assert.equal((await x.h.call('GET', `/api/receipts/${x.callId}`, x.tok)).json.verify.reason_text, 'Cost mismatch');
  });

  test('receipt_override never changes stored data', async () => {
    const x = await oneAnswer();
    const snap = () => rowOf<Record<string, unknown>>(x.h.env, 'SELECT * FROM llm_calls WHERE id = ?', x.callId);
    const before = await snap();
    const nEvents = (await rowOf<{ n: number }>(x.h.env, 'SELECT COUNT(*) AS n FROM events'))!.n;
    const edited = x.raw.replace('0.000412', '0.000413');
    const v1 = await verifyOverride(x, edited);
    const v2 = await x.h.call('POST', `/api/receipts/${x.callId}/verify`, x.tok, { receipt_override: JSON.parse(edited) });
    for (const v of [v1, v2]) {
      assert.equal(v.json.verify_status, 'failed');
      assert.equal(v.json.override, true);
      assert.equal(v.json.saved, false);
    }
    assert.deepEqual(await snap(), before, 'the llm_calls row is byte-identical');
    assert.equal((await rowOf<{ n: number }>(x.h.env, 'SELECT COUNT(*) AS n FROM events'))!.n, nEvents, 'no event row either');
    assert.equal((await x.h.call('POST', `/api/receipts/${x.callId}/verify`, x.tok, { receipt_override: 'not an object' })).status, 400);
  });

  test('a missing receipt shows missing and is not counted as a success', async () => {
    const h = await makeHarness(mock);
    const tok = await h.session();
    const chat = await h.newChat(tok, (await h.upload(tok)).id);
    mock.queue.push('no_receipt');
    const a = await h.askQ(tok, chat, 'What are the payment terms?');
    assert.equal(a.status, 502);
    assert.equal(a.json.error.code, 'receipt_missing');
    const rec = await h.call('GET', `/api/receipts/${a.json.error.call_id}`, tok);
    assert.equal(rec.json.verify.status, 'missing');
    assert.equal(rec.json.receipt_json, null);
    const u = await h.call('GET', '/api/usage', tok);
    assert.equal(u.json.cpga.good_answers, 0);
    assert.equal(u.json.totals.calls, 0, 'not counted among successful calls');
    assert.equal((await verifyReceiptDetailed(h.env, null)).status, 'missing');
  });

  test('where Ed25519 is unavailable the answer is unverified with the promised wording, never verified', async () => {
    const x = await oneAnswer();
    const noEd = {
      importKey: async () => {
        throw Object.assign(new Error('Unrecognized algorithm name'), { name: 'NotSupportedError' });
      },
    } as unknown as SubtleCrypto;
    const v = await verifyReceiptDetailed(x.h.env, x.raw, fetch, { subtle: noEd });
    assert.equal(v.status, 'unverified');
    assert.equal(v.reason, 'ed25519_unavailable');
    const { VERIFY_REASON_TEXT } = await import('../src/receipts.ts');
    assert.equal(VERIFY_REASON_TEXT.ed25519_unavailable, 'Could not verify in the browser worker. Verify offline.');
  });

  test('an unreadable receipt fails closed', async () => {
    const x = await oneAnswer();
    assert.equal((await verifyReceiptDetailed(x.h.env, 'not json')).reason, 'unreadable_receipt');
    assert.equal((await verifyReceiptDetailed(x.h.env, '{"cost_with_prune_usd":1}')).status, 'failed');
  });
});

describe('Point 1: export and the offline checkers', () => {
  async function exported() {
    const x = await oneAnswer();
    mock.queue.push('odd_numbers');
    await x.h.askQ(x.tok, x.chat, 'When can either party terminate?');
    const text = (await x.h.call('GET', '/api/export/receipts.jsonl', x.tok)).text;
    const dir = mkdtempSync(join(tmpdir(), 'athena-'));
    const file = join(dir, 'receipts.jsonl');
    writeFileSync(file, text);
    return { x, text, file, dir };
  }

  test('the first line is a meta line with the public key, key id and canonicalization', async () => {
    const { text } = await exported();
    const lines = text.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].type, 'meta');
    assert.match(lines[0].public_key_pem, /BEGIN PUBLIC KEY/);
    assert.equal(lines[0].key_id, 'mock-key-1');
    assert.match(lines[0].canonicalization, /sorted|sort_keys/);
    assert.equal(lines.length, 3);
  });

  test('scripts/verify-receipts.mjs needs no key argument, passes clean files and fails after a one-digit edit', async () => {
    const { text, file, dir } = await exported();
    const run = (f: string) => spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/verify-receipts.mjs', f], { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
    const ok = run(file);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /ALL RECEIPTS VERIFIED/);
    const bad = join(dir, 'edited.jsonl');
    writeFileSync(bad, text.replace('0.000412', '0.000413'));
    assert.equal(run(bad).status, 1);
  });

  const py = spawnSync('python3', ['-c', 'import cryptography'], { encoding: 'utf8' });
  test('bench/verify.py prints PASS/FAIL per line, exits non-zero on a one-digit edit', { skip: py.status !== 0 && 'python3 with the cryptography package is not installed' }, async () => {
    const { text, file, dir } = await exported();
    const ok = spawnSync('python3', ['bench/verify.py', file], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.equal((ok.stdout.match(/PASS/g) ?? []).length >= 2, true);
    const bad = join(dir, 'edited.jsonl');
    writeFileSync(bad, text.replace('0.000412', '0.000413'));
    const r = spawnSync('python3', ['bench/verify.py', bad], { encoding: 'utf8' });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /FAIL/);
  });
});
