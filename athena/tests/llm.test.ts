import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { AppError } from '../src/errors.ts';
import { callModel } from '../src/llm.ts';
import type { CallRequest } from '../src/llm.ts';
import { canonicalForSigning, extractReceipt, parseLossless, verifyLocal, verifyReceipt } from '../src/receipts.ts';
import { makeEnv, makeWorkspace, noSleep, rowOf, rowsOf } from './helpers.ts';
// @ts-ignore plain JS module
import { startMock } from '../tools/mock-prune/mock.mjs';

let mock: Awaited<ReturnType<typeof startMock>>;
before(async () => void (mock = await startMock()));
after(async () => mock.close());
beforeEach(() => {
  mock.state.calls.length = 0;
  mock.state.queue.length = 0;
  mock.state.breakSignature = false;
});

const EST = 150; // economy: 200 prompt tokens * 0.15 + 200 output tokens * 0.6
const req = (ws: string, key: string, over: Partial<CallRequest> = {}): CallRequest => ({
  workspaceId: ws,
  runId: 'm_test',
  purpose: 'answer',
  workload: 'rag',
  cache: 'normalized',
  tier: 'economy',
  messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'q <p pages="1-1">' }],
  promptTokens: 200,
  maxOutputTokens: 200,
  runBudgetMicro: 50_000,
  idempotencyKey: key,
  ...over,
});
const budgetOf = async (env: Awaited<ReturnType<typeof makeEnv>>, ws: string) =>
  rowOf<{ spent_micro: number; reserved_micro: number }>(env, 'SELECT * FROM budgets WHERE workspace_id = ?', ws);
const expectError = async (p: Promise<unknown>, code: string) => {
  await assert.rejects(p, (e: unknown) => e instanceof AppError && e.code === code, `expected ${code}`);
};

describe('callModel', () => {
  test('success: cost comes from the receipt, receipt is stored raw and verified, Prune headers are sent', async () => {
    const env = await makeEnv(mock);
    const ws = await makeWorkspace(env);
    const r = await callModel(env, req(ws.id, 'k1'), { sleep: noSleep });
    assert.equal(r.costMicro, 412);
    assert.equal(r.costSource, 'receipt');
    assert.equal(r.verifyStatus, 'verified');
    assert.equal(r.modelUsed, 'mock-gpt-routed');
    assert.equal(r.attempts, 1);
    const row = await rowOf<{ status: string; receipt_json: string; cost_without_prune_micro: number }>(env, 'SELECT * FROM llm_calls WHERE id = ?', r.callId);
    assert.equal(row!.status, 'ok');
    assert.equal(row!.receipt_json, r.receiptRaw);
    assert.equal(row!.cost_without_prune_micro, 1200);
    const b = await budgetOf(env, ws.id);
    assert.deepEqual({ s: b!.spent_micro, r: b!.reserved_micro }, { s: 412, r: 0 });
    const h = mock.calls[0].headers;
    assert.equal(h.authorization, 'Bearer test-prune-key');
    assert.equal(h['x-prune-workload'], 'rag');
    assert.equal(h['x-prune-cache'], 'normalized');
    assert.equal(h['x-prune-run-id'], 'm_test');
    assert.equal(h['x-prune-run-budget-usd'], '0.050000');
    assert.equal(h['x-prune-max-steps'], '3');
    assert.equal(h['x-prune-customer-id'], ws.id);
    assert.equal(h['x-prune-feature-id'], 'answer');
    assert.match(h['idempotency-key'], /^[0-9a-f]{64}$/);
  });

  test('the other auth header style works too', async () => {
    const env = await makeEnv(mock, { PRUNE_AUTH: 'x-prune-key' });
    const ws = await makeWorkspace(env);
    await callModel(env, req(ws.id, 'k1'), { sleep: noSleep });
    assert.equal(mock.calls[0].headers['x-prune-key'], 'test-prune-key');
    assert.equal(mock.calls[0].headers.authorization, undefined);
  });

  test('429 then success: two attempts, one llm_calls row, one charge', async () => {
    const env = await makeEnv(mock);
    const ws = await makeWorkspace(env);
    mock.queue.push('429');
    const r = await callModel(env, req(ws.id, 'k1'), { sleep: noSleep });
    assert.equal(r.attempts, 2);
    assert.equal(mock.calls.length, 2);
    assert.equal((await rowsOf(env, 'SELECT id FROM llm_calls')).length, 1);
    assert.equal((await budgetOf(env, ws.id))!.spent_micro, 412);
    assert.equal(mock.calls[0].headers['idempotency-key'], mock.calls[1].headers['idempotency-key']);
  });

  test('429 with a spend-cap shield code: exactly one attempt, budget_exhausted, nothing charged', async () => {
    for (const mode of ['429_spend_cap', '429_run_budget']) {
      mock.state.calls.length = 0;
      const env = await makeEnv(mock);
      const ws = await makeWorkspace(env);
      mock.queue.push(mode);
      await expectError(callModel(env, req(ws.id, 'k1'), { sleep: noSleep }), 'budget_exhausted');
      assert.equal(mock.calls.length, 1, mode);
      const b = await budgetOf(env, ws.id);
      assert.deepEqual({ s: b!.spent_micro, r: b!.reserved_micro }, { s: 0, r: 0 });
      assert.equal((await rowOf<{ status: string }>(env, 'SELECT status FROM llm_calls'))!.status, 'budget_stopped');
    }
  });

  test('500 three times: stops after two retries, released, provider_unavailable', async () => {
    const env = await makeEnv(mock);
    const ws = await makeWorkspace(env);
    mock.queue.push('500', '500', '500');
    await expectError(callModel(env, req(ws.id, 'k1'), { sleep: noSleep }), 'provider_unavailable');
    assert.equal(mock.calls.length, 3);
    const b = await budgetOf(env, ws.id);
    assert.deepEqual({ s: b!.spent_micro, r: b!.reserved_micro }, { s: 0, r: 0 });
    const row = await rowOf<{ status: string; attempt: number }>(env, 'SELECT * FROM llm_calls');
    assert.deepEqual({ st: row!.status, at: row!.attempt }, { st: 'failed', at: 3 });
  });

  test('Shield unavailable (503) is temporary: retried with the same idempotency key, then succeeds', async () => {
    const env = await makeEnv(mock);
    const ws = await makeWorkspace(env);
    mock.queue.push('shield_unavailable');
    const r = await callModel(env, req(ws.id, 'k1'), { sleep: noSleep });
    assert.equal(r.attempts, 2);
    assert.equal(mock.calls.length, 2);
    assert.equal((await budgetOf(env, ws.id))!.spent_micro, 412);
  });

  test('a loop stop (agent_loop) is final: one attempt, no retry', async () => {
    const env = await makeEnv(mock);
    const ws = await makeWorkspace(env);
    mock.queue.push('agent_loop');
    await expectError(callModel(env, req(ws.id, 'k1'), { sleep: noSleep }), 'shield_blocked');
    assert.equal(mock.calls.length, 1);
    assert.equal((await budgetOf(env, ws.id))!.spent_micro, 0);
  });

  test('connection lost after sending: billing_uncertain, no blind retry, estimate charged', async () => {
    const env = await makeEnv(mock);
    const ws = await makeWorkspace(env);
    mock.queue.push('drop');
    await assert.rejects(callModel(env, req(ws.id, 'k1'), { sleep: noSleep }), (e: unknown) => e instanceof AppError && e.code === 'billing_uncertain' && typeof e.detail['callId'] === 'string');
    assert.equal(mock.calls.length, 1);
    const b = await budgetOf(env, ws.id);
    assert.deepEqual({ s: b!.spent_micro, r: b!.reserved_micro }, { s: EST, r: 0 });
    assert.equal((await rowOf<{ status: string }>(env, 'SELECT status FROM llm_calls'))!.status, 'unknown_cost');
  });

  test('bad key: no retry. Shield block: no retry. 402: no retry', async () => {
    for (const [mode, code] of [['401', 'provider_auth_failed'], ['shield', 'shield_blocked'], ['402', 'budget_exhausted']] as const) {
      mock.state.calls.length = 0;
      const env = await makeEnv(mock);
      const ws = await makeWorkspace(env);
      mock.queue.push(mode);
      await expectError(callModel(env, req(ws.id, 'k1'), { sleep: noSleep }), code);
      assert.equal(mock.calls.length, 1, mode);
      assert.equal((await budgetOf(env, ws.id))!.spent_micro, 0);
    }
  });

  test('200 without a receipt is never a success: estimate charged, receipt_missing', async () => {
    const env = await makeEnv(mock);
    const ws = await makeWorkspace(env);
    mock.queue.push('no_receipt');
    await expectError(callModel(env, req(ws.id, 'k1'), { sleep: noSleep }), 'receipt_missing');
    assert.equal(mock.calls.length, 1);
    assert.equal((await budgetOf(env, ws.id))!.spent_micro, EST);
  });

  test('allowance too small: nothing is sent and no row is created', async () => {
    const env = await makeEnv(mock);
    const ws = await makeWorkspace(env, { limitMicro: 100 });
    await assert.rejects(callModel(env, req(ws.id, 'k1'), { sleep: noSleep }), (e: unknown) => e instanceof AppError && e.code === 'budget_exhausted' && e.detail['local'] === true);
    assert.equal(mock.calls.length, 0);
    assert.equal((await rowsOf(env, 'SELECT id FROM llm_calls')).length, 0);
  });

  test('a repeated idempotency key is refused without a second call', async () => {
    const env = await makeEnv(mock);
    const ws = await makeWorkspace(env);
    await callModel(env, req(ws.id, 'k1'), { sleep: noSleep });
    await expectError(callModel(env, req(ws.id, 'k1'), { sleep: noSleep }), 'conflict');
    assert.equal(mock.calls.length, 1);
    const b = await budgetOf(env, ws.id);
    assert.deepEqual({ s: b!.spent_micro, r: b!.reserved_micro }, { s: 412, r: 0 });
  });

  test('kill switch stops the call before anything is reserved', async () => {
    const env = await makeEnv(mock, { KILL_SWITCH: '1' });
    const ws = await makeWorkspace(env);
    await expectError(callModel(env, req(ws.id, 'k1'), { sleep: noSleep }), 'kill_switch_on');
    assert.equal(mock.calls.length, 0);
    assert.equal((await budgetOf(env, ws.id))!.reserved_micro, 0);
  });

  test('cache hit is free and flagged', async () => {
    const env = await makeEnv(mock);
    const ws = await makeWorkspace(env);
    mock.queue.push('cache_hit');
    const r = await callModel(env, req(ws.id, 'k1'), { sleep: noSleep });
    assert.deepEqual({ hit: r.cacheHit, cost: r.costMicro }, { hit: true, cost: 0 });
  });
});

describe('receipts', () => {
  async function fetchRaw(mode: string) {
    mock.queue.push(mode);
    const res = await fetch(`${mock.url}/chat/completions`, { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) });
    return res.text();
  }

  test('an ordinary receipt verifies locally from its raw bytes', async () => {
    const env = await makeEnv(mock);
    const rc = extractReceipt(await fetchRaw('ok'))!;
    assert.equal(await verifyReceipt(env, rc.raw), 'verified');
  });

  test('odd numbers and non-ASCII text verify only because raw bytes are kept', async () => {
    const env = await makeEnv(mock);
    const rc = extractReceipt(await fetchRaw('odd_numbers'))!;
    assert.match(rc.raw, /5e-05/);
    assert.equal(await verifyReceipt(env, rc.raw), 'verified');
    const key = (await rowOf<{ value: string }>(env, "SELECT value FROM settings WHERE key = 'prune_public_key'"))!.value;
    assert.equal(await verifyLocal(rc.raw, key), true);
    // The mistake this design avoids: parse and re-serialize, and the signature no longer matches.
    const reserialized = JSON.stringify(JSON.parse(rc.raw));
    assert.notEqual(canonicalForSigning(reserialized), canonicalForSigning(rc.raw));
    assert.equal(await verifyLocal(reserialized, key), false);
  });

  test('a tampered receipt fails', async () => {
    const env = await makeEnv(mock);
    const rc = extractReceipt(await fetchRaw('ok'))!;
    assert.equal(await verifyReceipt(env, rc.raw.replace('0.000412', '0.000001')), 'failed');
  });

  test('a bad signature fails; an unreachable service gives unverified, never verified', async () => {
    const env = await makeEnv(mock);
    mock.state.breakSignature = true;
    const bad = extractReceipt(await fetchRaw('ok'))!;
    assert.equal(await verifyReceipt(env, bad.raw), 'failed');
    const offline = await makeEnv(mock, { PRUNE_BASE_URL: 'http://127.0.0.1:1/v1' });
    mock.state.breakSignature = false;
    const good = extractReceipt(await fetchRaw('ok'))!;
    assert.equal(await verifyReceipt(offline, good.raw), 'unverified');
  });

  test('lossless parser keeps number tokens and rejects junk', () => {
    const n = parseLossless('{"a": 1.0, "b": [5e-05, "x\\u00e9"]}');
    assert.equal(n.t, 'o');
    assert.throws(() => parseLossless('{"a": }'));
    assert.equal(extractReceipt('{"no":"receipt"}'), null);
    assert.equal(extractReceipt('not json'), null);
  });
});
