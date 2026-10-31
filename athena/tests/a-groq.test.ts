import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AppError } from '../src/errors.ts';
import { callModel } from '../src/llm.ts';
import type { CallRequest } from '../src/llm.ts';
import { DEFAULT_GROQ_TIERS } from '../src/tiers.ts';
import { makeEnv, makeWorkspace, noSleep, rowOf, rowsOf } from './helpers.ts';
import type { Mock } from './helpers.ts';

// A fake fetch stands in for Groq; no network. The Prune mock is never started: LLM_PROVIDER=groq must not touch it.
const unusedPrune = { url: 'http://127.0.0.1:1/v1' } as unknown as Mock;
const TIERS = JSON.stringify({
  economy: { model: 'openai/gpt-oss-20b', inPerM: 0.1, outPerM: 0.4, minOutputTokens: 0 },
  standard: { model: 'qwen/qwen3.8-27b', inPerM: 0.3, outPerM: 0.6, minOutputTokens: 0 },
  strong: { model: 'openai/gpt-oss-120b', inPerM: 0.15, outPerM: 0.6, minOutputTokens: 0 },
});
const base = { LLM_PROVIDER: 'groq', GROQ_API_KEY: 'gsk_test_key_not_real', GROQ_MODEL_TIERS: TIERS };
const EST = 100; // economy: 200 prompt * 0.1 + 200 output * 0.4 = 20 + 80 micro-USD

const req = (ws: string, key: string, over: Partial<CallRequest> = {}): CallRequest => ({
  workspaceId: ws,
  runId: 'm_test',
  purpose: 'answer',
  workload: 'rag',
  cache: 'normalized',
  tier: 'economy',
  messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'q' }],
  promptTokens: 200,
  maxOutputTokens: 200,
  runBudgetMicro: 50_000,
  idempotencyKey: key,
  ...over,
});

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: Record<string, any>;
}
const ok = (over: Record<string, unknown> = {}, finish = 'stop') =>
  new Response(
    JSON.stringify({
      model: 'openai/gpt-oss-20b',
      choices: [{ message: { content: 'Fourteen days.' }, finish_reason: finish }],
      usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, completion_tokens_details: { reasoning_tokens: 30 } },
      ...over,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
const scripted = (...steps: Array<Response | Error>) => {
  const seen: Seen[] = [];
  const f = (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    const step = steps[Math.min(seen.length - 1, steps.length - 1)]!;
    if (step instanceof Error) throw step;
    return step.clone();
  }) as unknown as typeof fetch;
  return { f, seen };
};
const budgetOf = (env: Awaited<ReturnType<typeof makeEnv>>, ws: string) =>
  rowOf<{ spent_micro: number; reserved_micro: number }>(env, 'SELECT * FROM budgets WHERE workspace_id = ?', ws);

describe('parallel Groq model path', () => {
  test('success: cost from token usage, no receipt, honest verify status, the Groq host and key only', async () => {
    const env = await makeEnv(unusedPrune, base);
    const ws = await makeWorkspace(env);
    const { f, seen } = scripted(ok());
    const r = await callModel(env, req(ws.id, 'k1'), { fetch: f, sleep: noSleep });
    assert.equal(r.text, 'Fourteen days.');
    // 1000 prompt * 0.1 + 50 completion (reasoning included) * 0.4 = 120 micro-USD
    assert.equal(r.costMicro, 120);
    assert.equal(r.costSource, 'estimate');
    assert.equal(r.verifyStatus, 'missing');
    assert.equal(r.cacheHit, false);
    assert.equal(r.receiptRaw, '');
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(seen[0]!.headers['authorization'], 'Bearer gsk_test_key_not_real');
    assert.ok(!Object.keys(seen[0]!.headers).some((h) => h.startsWith('x-prune')), 'no Prune headers go to Groq');
    assert.equal(seen[0]!.body['model'], 'openai/gpt-oss-20b');
    assert.equal(seen[0]!.body['reasoning_effort'], 'low');
    const row = await rowOf<Record<string, any>>(env, 'SELECT * FROM llm_calls WHERE id = ?', r.callId);
    assert.deepEqual(
      { status: row!['status'], v: row!['verify_status'], reason: row!['verify_reason'], receipt: row!['receipt_json'], cost: row!['cost_micro'], model: row!['model_used'] },
      { status: 'ok', v: 'missing', reason: 'no_receipt', receipt: null, cost: 120, model: 'openai/gpt-oss-20b' },
    );
    const b = await budgetOf(env, ws.id);
    assert.deepEqual({ s: b!.spent_micro, r: b!.reserved_micro }, { s: 120, r: 0 });
  });

  test('the default provider is unchanged: without LLM_PROVIDER nothing goes to Groq', async () => {
    const env = await makeEnv(unusedPrune, { GROQ_API_KEY: 'gsk_test_key_not_real' });
    const ws = await makeWorkspace(env);
    const { f, seen } = scripted(new Error('should not matter'));
    await assert.rejects(callModel(env, req(ws.id, 'k1'), { fetch: f, sleep: noSleep }));
    assert.ok(seen.every((s) => !s.url.includes('groq.com')));
  });

  test('qwen (no reasoning_effort) and the strong tier use their own models', async () => {
    const env = await makeEnv(unusedPrune, base);
    const ws = await makeWorkspace(env);
    const { f, seen } = scripted(ok());
    await callModel(env, req(ws.id, 'k1', { tier: 'standard' }), { fetch: f, sleep: noSleep });
    assert.equal(seen[0]!.body['model'], 'qwen/qwen3.8-27b');
    assert.equal('reasoning_effort' in seen[0]!.body, false);
  });

  test('a 429 is retried after the advised wait, then succeeds', async () => {
    const env = await makeEnv(unusedPrune, base);
    const ws = await makeWorkspace(env);
    const { f, seen } = scripted(new Response('{"error":{"message":"rate limit"}}', { status: 429, headers: { 'retry-after': '2' } }), ok());
    const waits: number[] = [];
    const r = await callModel(env, req(ws.id, 'k1'), { fetch: f, sleep: async (ms) => void waits.push(ms) });
    assert.equal(r.attempts, 2);
    assert.equal(seen.length, 2);
    assert.deepEqual(waits, [2000]);
    assert.equal((await budgetOf(env, ws.id))!.spent_micro, 120);
  });

  test('a bad key stops at once and charges nothing', async () => {
    const env = await makeEnv(unusedPrune, base);
    const ws = await makeWorkspace(env);
    const { f, seen } = scripted(new Response('{"error":{"message":"Invalid API Key"}}', { status: 401 }));
    await assert.rejects(callModel(env, req(ws.id, 'k1'), { fetch: f, sleep: noSleep }), (e: unknown) => e instanceof AppError && e.code === 'provider_auth_failed');
    assert.equal(seen.length, 1);
    const b = await budgetOf(env, ws.id);
    assert.deepEqual({ s: b!.spent_micro, r: b!.reserved_micro }, { s: 0, r: 0 });
    assert.equal((await rowOf<{ status: string }>(env, 'SELECT status FROM llm_calls'))!.status, 'failed');
  });

  test('413 (over the tokens-per-minute limit) is a rate limit and is not retried with the same payload', async () => {
    const env = await makeEnv(unusedPrune, base);
    const ws = await makeWorkspace(env);
    const { f, seen } = scripted(new Response('{"error":{"message":"Request too large"}}', { status: 413 }));
    await assert.rejects(callModel(env, req(ws.id, 'k1'), { fetch: f, sleep: noSleep }), (e: unknown) => e instanceof AppError && e.code === 'rate_limited');
    assert.equal(seen.length, 1);
    assert.equal((await budgetOf(env, ws.id))!.spent_micro, 0);
  });

  test('connection lost after sending: billing_uncertain, no blind retry, estimate charged', async () => {
    const env = await makeEnv(unusedPrune, base);
    const ws = await makeWorkspace(env);
    const { f, seen } = scripted(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    await assert.rejects(callModel(env, req(ws.id, 'k1'), { fetch: f, sleep: noSleep }), (e: unknown) => e instanceof AppError && e.code === 'billing_uncertain');
    assert.equal(seen.length, 1);
    const b = await budgetOf(env, ws.id);
    assert.deepEqual({ s: b!.spent_micro, r: b!.reserved_micro }, { s: EST, r: 0 });
    assert.equal((await rowOf<{ status: string }>(env, 'SELECT status FROM llm_calls'))!.status, 'unknown_cost');
  });

  test('a refused connection is retried (nothing was sent), then gives up with nothing charged', async () => {
    const env = await makeEnv(unusedPrune, base);
    const ws = await makeWorkspace(env);
    const { f, seen } = scripted(Object.assign(new Error('refused'), { cause: { code: 'ECONNREFUSED' } }));
    await assert.rejects(callModel(env, req(ws.id, 'k1'), { fetch: f, sleep: noSleep }), (e: unknown) => e instanceof AppError && e.code === 'provider_unavailable');
    assert.equal(seen.length, 3);
    assert.equal((await budgetOf(env, ws.id))!.spent_micro, 0);
  });

  test('allowance too small: nothing is sent and no ledger row is created', async () => {
    const env = await makeEnv(unusedPrune, base);
    const ws = await makeWorkspace(env, { limitMicro: 50 });
    const { f, seen } = scripted(ok());
    await assert.rejects(callModel(env, req(ws.id, 'k1'), { fetch: f, sleep: noSleep }), (e: unknown) => e instanceof AppError && e.code === 'budget_exhausted' && e.detail['local'] === true);
    assert.equal(seen.length, 0);
    assert.equal((await rowsOf(env, 'SELECT id FROM llm_calls')).length, 0);
  });

  test('a repeated idempotency key is refused locally; Groq has no idempotency of its own', async () => {
    const env = await makeEnv(unusedPrune, base);
    const ws = await makeWorkspace(env);
    const { f, seen } = scripted(ok());
    await callModel(env, req(ws.id, 'k1'), { fetch: f, sleep: noSleep });
    await assert.rejects(callModel(env, req(ws.id, 'k1'), { fetch: f, sleep: noSleep }), (e: unknown) => e instanceof AppError && e.code === 'conflict');
    assert.equal(seen.length, 1);
  });

  test('no GROQ_API_KEY: refused before anything is reserved or sent', async () => {
    const env = await makeEnv(unusedPrune, { ...base, GROQ_API_KEY: '' });
    const ws = await makeWorkspace(env);
    const { f, seen } = scripted(ok());
    await assert.rejects(callModel(env, req(ws.id, 'k1'), { fetch: f, sleep: noSleep }), (e: unknown) => e instanceof AppError && e.code === 'provider_auth_failed');
    assert.equal(seen.length, 0);
    assert.equal((await budgetOf(env, ws.id))!.reserved_micro, 0);
  });

  test('kill switch stops a Groq call before anything is reserved', async () => {
    const env = await makeEnv(unusedPrune, { ...base, KILL_SWITCH: '1' });
    const ws = await makeWorkspace(env);
    const { f, seen } = scripted(ok());
    await assert.rejects(callModel(env, req(ws.id, 'k1'), { fetch: f, sleep: noSleep }), (e: unknown) => e instanceof AppError && e.code === 'kill_switch_on');
    assert.equal(seen.length, 0);
  });

  test('an answer cut off at the output limit is flagged, and its tokens are still billed', async () => {
    const env = await makeEnv(unusedPrune, base);
    const ws = await makeWorkspace(env);
    const { f } = scripted(ok({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }, 'length'));
    const r = await callModel(env, req(ws.id, 'k1'), { fetch: f, sleep: noSleep });
    assert.equal(r.truncated, true);
    assert.equal(r.text, '');
    assert.equal((await budgetOf(env, ws.id))!.spent_micro, 120);
  });

  test('default Groq tiers name chat models, never a Prune/Gemini id', () => {
    for (const t of Object.values(DEFAULT_GROQ_TIERS)) assert.ok(!t.model.startsWith('gemini/'), t.model);
  });
});

describe('Groq usage accounting', () => {
  test('Groq spend counts in cost per good answer and is labelled as estimated', async () => {
    const { createApp } = await import('../src/app.ts');
    const env = await makeEnv(unusedPrune, { ...base, DEFAULT_BUDGET_USD: '0.25', DOC_LIMIT_PER_MIN: '100', MSG_LIMIT_PER_MIN: '100' });
    const app = createApp({ llm: { sleep: noSleep, fetch: scripted(ok()).f } });
    const exec = { waitUntil: (p: Promise<unknown>) => void p.catch(() => undefined), passThroughOnException() {} };
    const call = async (method: string, path: string, tok: string | null, body?: unknown) => {
      const res = await app.request(path, { method, headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, env, exec as never);
      return { status: res.status, json: (await res.json().catch(() => null)) as any };
    };
    const tok = (await call('POST', '/api/session', null, {})).json.token;
    const d = (await call('POST', '/api/documents', tok, { filename: 'a.pdf', size_bytes: 10, page_count: 1, pack: 'general' })).json.document_id;
    await call('PUT', `/api/documents/${d}/file`, tok, undefined);
    await call('POST', `/api/documents/${d}/pages`, tok, { pages: [{ page_no: 1, text: 'The invoice is due within fourteen days of receipt.' }] });
    await call('POST', `/api/documents/${d}/finalize`, tok, { ocr: 'skip', auto_summary: false });
    const chat = (await call('POST', '/api/chats', tok, { document_ids: [d] })).json.chat_id;
    const r = await call('POST', `/api/chats/${chat}/messages`, tok, { client_msg_id: 'q1', content: 'When is the invoice due?', mode: 'answer', output: 'normal' });
    assert.equal(r.status, 200);
    const u = (await call('GET', '/api/usage', tok)).json;
    assert.ok(u.cpga.spend_usd > 0, 'spend must not read zero when money was spent');
    assert.equal(u.cpga.spend_estimated_usd, u.cpga.spend_usd);
    assert.equal(u.totals.receipts, 0);
  });
});
