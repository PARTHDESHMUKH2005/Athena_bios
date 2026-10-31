// Tests pinned to behaviour seen on the REAL Prune on 2026-10-31 (see PHASE0-FINDINGS.md). The mock reproduces
// each shape; these tests make sure our code keeps handling them.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { parseCompletion } from '../src/completion.ts';
import { AppError, classifyHttp } from '../src/errors.ts';
import { callModel } from '../src/llm.ts';
import type { CallRequest } from '../src/llm.ts';
import { makeHarness } from './harness.ts';
import { makeEnv, makeWorkspace, noSleep, rowOf } from './helpers.ts';
// @ts-ignore plain JS module
import { startMock } from '../tools/mock-prune/mock.mjs';

let mock: Awaited<ReturnType<typeof startMock>>;
before(async () => void (mock = await startMock()));
after(async () => mock.close());
beforeEach(() => {
  mock.state.calls.length = 0;
  mock.state.queue.length = 0;
});

const req = (ws: string, key: string): CallRequest => ({
  workspaceId: ws, runId: 'm_test', purpose: 'answer', workload: 'rag', cache: 'normalized', tier: 'economy',
  messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'q <p pages="1-1">' }],
  promptTokens: 200, maxOutputTokens: 200, runBudgetMicro: 50_000, idempotencyKey: key,
});

describe('reading both response shapes', () => {
  test('OpenAI shape', () => {
    const p = parseCompletion({ model: 'gpt-4o-mini', choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
    assert.deepEqual({ t: p.text, pt: p.promptTokens, ct: p.completionTokens, trunc: p.truncated, shape: p.shape, m: p.model }, { t: 'hi', pt: 10, ct: 2, trunc: false, shape: 'openai', m: 'gpt-4o-mini' });
    assert.equal(parseCompletion({ choices: [{ message: { content: 'cut' }, finish_reason: 'length' }] }).truncated, true);
  });
  test('Gemini shape: text from parts, hidden thinking tokens counted, thought parts excluded', () => {
    const p = parseCompletion({
      candidates: [{ content: { parts: [{ text: 'internal', thought: true }, { text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 1, thoughtsTokenCount: 57 },
      modelVersion: 'gemini-3.5-flash',
    });
    assert.deepEqual({ t: p.text, pt: p.promptTokens, ct: p.completionTokens, shape: p.shape, m: p.model, trunc: p.truncated }, { t: 'ok', pt: 40, ct: 58, shape: 'gemini', m: 'gemini-3.5-flash', trunc: false });
  });
  test('Gemini that spent its whole limit thinking: empty text, truncated', () => {
    const p = parseCompletion({ candidates: [{ content: {}, finishReason: 'MAX_TOKENS' }], usageMetadata: { promptTokenCount: 39, thoughtsTokenCount: 16 } });
    assert.deepEqual({ t: p.text, trunc: p.truncated }, { t: '', trunc: true });
  });
  test('an unknown or broken body gives an empty answer and never throws', () => {
    for (const x of [null, undefined, 'text', 42, {}, { choices: [] }, { candidates: [] }]) assert.equal(parseCompletion(x).text, '');
  });
});

describe('error classification with real response bodies', () => {
  const missingKey = '{"error":"Missing openai api key. Store one in the Prune vault (Connect -> Providers) or pass user_api_key.","code":"http_error"}';
  test('setup problems are configuration errors that are never retried', () => {
    assert.deepEqual(classifyHttp(400, null, missingKey), { code: 'provider_auth_failed', retry: false });
    assert.deepEqual(classifyHttp(400, null, '{"error":"anthropic account has insufficient credits or quota","code":"provider_upstream_4xx"}'), { code: 'provider_auth_failed', retry: false });
    assert.deepEqual(classifyHttp(404, null, '{"error":"gemini rejected the request (404)","code":"not_found"}'), { code: 'provider_auth_failed', retry: false });
    assert.deepEqual(classifyHttp(401, null, '{"code":"provider_upstream_4xx","upstream_status":401}'), { code: 'provider_auth_failed', retry: false });
  });
  test('a genuinely bad request is still a validation error; transient provider errors still retry', () => {
    assert.deepEqual(classifyHttp(400, null, '{"error":"messages must not be empty"}'), { code: 'validation_failed', retry: false });
    assert.deepEqual(classifyHttp(400, null), { code: 'validation_failed', retry: false });
    assert.deepEqual(classifyHttp(429, null, '{"code":"provider_upstream_4xx","provider":"gemini"}'), { code: 'rate_limited', retry: true });
    assert.deepEqual(classifyHttp(503, null, '{"code":"provider_upstream_5xx","remediation":"Retry shortly or switch models."}'), { code: 'provider_unavailable', retry: true });
  });
  test('Shield blocking an injection phrase is a block, not a retry', () => {
    assert.deepEqual(classifyHttp(403, 'prompt_injection_signal'), { code: 'shield_blocked', retry: false });
    assert.deepEqual(classifyHttp(403, 'prompt_injection'), { code: 'shield_blocked', retry: false });
  });
});

describe('callModel against the real shapes', () => {
  test('Gemini-shaped answer: text, served model from the receipt, billed tokens and verified receipt', async () => {
    const env = await makeEnv(mock);
    const ws = await makeWorkspace(env);
    mock.queue.push('gemini');
    const r = await callModel(env, req(ws.id, 'k1'), { sleep: noSleep });
    assert.match(r.text, /According to the document|Mock answer/);
    assert.equal(r.modelUsed, 'gemini-3.5-flash');
    assert.equal(r.verifyStatus, 'verified');
    assert.equal(r.costMicro, 412);
    assert.ok(r.completionTokens > 57, 'billed completion tokens include the hidden thinking tokens');
    assert.equal(r.truncated, false);
    const row = await rowOf<{ model_used: string }>(env, 'SELECT model_used FROM llm_calls WHERE id = ?', r.callId);
    assert.equal(row!.model_used, 'gemini-3.5-flash');
  });
  test('a Gemini answer that used all its tokens thinking is flagged, not treated as an answer', async () => {
    const env = await makeEnv(mock);
    const ws = await makeWorkspace(env);
    mock.queue.push('gemini_empty');
    const r = await callModel(env, req(ws.id, 'k1'), { sleep: noSleep });
    assert.deepEqual({ text: r.text, truncated: r.truncated }, { text: '', truncated: true });
  });
  test('an output limit shortened by Prune is reported', async () => {
    const env = await makeEnv(mock);
    const ws = await makeWorkspace(env);
    mock.queue.push('truncated');
    const r = await callModel(env, req(ws.id, 'k1'), { sleep: noSleep });
    assert.deepEqual({ truncated: r.truncated, cap: r.outputCapApplied }, { truncated: true, cap: true });
    assert.equal((await callModel(env, req(ws.id, 'k2'), { sleep: noSleep })).outputCapApplied, false);
  });
  test('setup errors stop at once: one request, nothing charged, configuration error', async () => {
    for (const mode of ['missing_key', 'no_credits', 'model_404']) {
      mock.state.calls.length = 0;
      const env = await makeEnv(mock);
      const ws = await makeWorkspace(env);
      mock.queue.push(mode);
      await assert.rejects(callModel(env, req(ws.id, 'k1'), { sleep: noSleep }), (e: unknown) => e instanceof AppError && e.code === 'provider_auth_failed', mode);
      assert.equal(mock.calls.length, 1, mode);
      const b = await rowOf<{ spent_micro: number; reserved_micro: number }>(env, 'SELECT * FROM budgets WHERE workspace_id = ?', ws.id);
      assert.deepEqual({ s: b!.spent_micro, r: b!.reserved_micro }, { s: 0, r: 0 }, mode);
    }
  });
});

describe('through the whole app', () => {
  async function ask(over: Record<string, string> = {}) {
    const h = await makeHarness(mock, over);
    const tok = await h.session();
    const chat = await h.newChat(tok, (await h.upload(tok)).id);
    return { h, tok, chat };
  }

  test('a cut-off answer is never presented as complete', async () => {
    const { h, tok, chat } = await ask();
    mock.queue.push('truncated');
    const a = await h.askQ(tok, chat, 'What are the payment terms?');
    assert.equal(a.json.message.status, 'done');
    assert.match(a.json.message.content, /cut off because it reached the output limit/);
    const call = a.json.message.trace.find((s: any) => s.step === 'call');
    assert.match(call.detail, /cut off at the output limit/);
    assert.match(call.detail, /Prune shortened the output limit/);
  });

  test('Gemini answers flow through to the UI fields: text, citation, served model', async () => {
    const { h, tok, chat } = await ask();
    mock.queue.push('gemini');
    const a = await h.askQ(tok, chat, 'What are the payment terms?');
    assert.equal(a.json.message.status, 'done');
    assert.ok(a.json.message.citations.length >= 1);
    assert.equal(a.json.usage.model_used, 'gemini-3.5-flash');
    assert.equal(a.json.usage.verify_status, 'verified');
  });

  test('an empty thinking-only answer escalates once; if that is empty too the user gets a plain explanation', async () => {
    const { h, tok, chat } = await ask();
    mock.queue.push('gemini_empty', 'ok');
    const a = await h.askQ(tok, chat, 'What are the payment terms?');
    assert.ok(a.json.message.trace.some((s: any) => s.step === 'escalate'));
    assert.match(a.json.message.content, /\[p\.1\]/);
    mock.state.calls.length = 0;
    mock.queue.push('gemini_empty', 'gemini_empty');
    const b = await h.askQ(tok, chat, 'What is the delivery time?');
    assert.match(b.json.message.content, /used its whole output limit before writing an answer/);
    assert.equal(mock.calls.length, 2);
  });

  test('a per-tier output floor reaches the model request (for models that think)', async () => {
    const { h, tok, chat } = await ask({ MODEL_TIERS: JSON.stringify({ economy: { minOutputTokens: 3000 }, standard: { minOutputTokens: 3000 } }) });
    await h.askQ(tok, chat, 'What are the payment terms?');
    assert.ok(mock.calls[0].body.max_tokens >= 3000, `max_tokens was ${mock.calls[0].body.max_tokens}`);
  });

  test('a missing vault key is shown as a setup problem, with no retries and nothing charged', async () => {
    const { h, tok, chat } = await ask();
    mock.queue.push('missing_key');
    const a = await h.askQ(tok, chat, 'What are the payment terms?');
    assert.equal(a.status, 502);
    assert.equal(a.json.error.code, 'provider_auth_failed');
    assert.equal(mock.calls.length, 1);
    assert.equal((await h.call('GET', '/api/budget', tok)).json.spent_usd, 0);
  });
});
