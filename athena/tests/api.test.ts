import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { runJanitor } from '../src/janitor.ts';
import { AskResultSchema, ErrorEnvelopeSchema } from '../src/schemas.ts';
import { rowOf, rowsOf } from './helpers.ts';
import { makeHarness } from './harness.ts';
// @ts-ignore plain JS module
import { startMock } from '../tools/mock-prune/mock.mjs';

let mock: Awaited<ReturnType<typeof startMock>>;
before(async () => void (mock = await startMock()));
after(async () => mock.close());
beforeEach(() => {
  mock.state.calls.length = 0;
  mock.state.queue.length = 0;
});

const harness = (over: Record<string, string> = {}) => makeHarness(mock, over);

describe('happy path', () => {
  test('upload, index, ask: cited answer, cost, verified receipt, trace, export, summary, usage', async () => {
    const h = await harness();
    const tok = await h.session();
    assert.equal((await h.call('GET', '/api/health', null)).json.mock_prune, true);
    assert.equal((await h.call('GET', '/api/config', tok)).json.packs.length, 2);

    const doc = await h.upload(tok);
    assert.equal(doc.status, 'ready');
    assert.ok(doc.sections >= 1, 'a short document is correctly a single section');
    const dres = await h.call('GET', `/api/documents/${doc.id}`, tok);
    assert.equal(dres.json.document.status, 'ready');
    assert.equal((await h.call('GET', `/api/documents/${doc.id}/pages/2`, tok)).json.page_no, 2);
    assert.equal((await h.call('GET', `/api/documents/${doc.id}/file`, tok)).text, '%PDF-1.4 fake');

    const chat = await h.newChat(tok, doc.id);
    const a = await h.askQ(tok, chat, 'What are the payment terms?');
    assert.equal(a.status, 200, a.text);
    assert.ok(AskResultSchema.safeParse(a.json).success, 'response matches its schema');
    assert.equal(a.json.message.status, 'done');
    assert.match(a.json.message.content, /\[p\.1\]/);
    assert.deepEqual(a.json.message.citations.map((c: any) => c.page_start), [1]);
    assert.equal(a.json.usage.cost_usd, 0.000412);
    assert.equal(a.json.usage.verify_status, 'verified');
    assert.equal(a.json.usage.tier, 'economy');
    assert.equal(a.json.usage.model_used, 'mock-gpt-routed');
    assert.deepEqual(a.json.message.trace.map((s: any) => s.step), ['context', 'tier', 'reserve', 'call', 'verify', 'done']);
    assert.ok(a.json.message.trace.every((s: any) => s.label && typeof s.ms === 'number'));
    assert.ok(!JSON.stringify(a.json.message.trace).includes('Payment is due'), 'trace never holds document text');

    // The prompt that reached Prune fences the document and never contains the API key.
    const sent = JSON.stringify(mock.calls[0].body);
    assert.match(sent, /untrusted_document/);
    assert.ok(!sent.includes('test-prune-key'));

    const chatView = await h.call('GET', `/api/chats/${chat}`, tok);
    assert.equal(chatView.json.messages.length, 2);
    assert.equal(chatView.json.messages[1].trace.length, 6);
    assert.equal(chatView.json.messages[1].usage.cost_usd, 0.000412, 'a reloaded chat still knows what each answer cost');
    assert.equal(chatView.json.messages[0].usage, null);

    const rec = await h.call('GET', `/api/receipts/${a.json.usage.call_id}`, tok);
    assert.equal(rec.json.verify_status, 'verified');
    assert.equal(JSON.parse(rec.json.receipt_json).cost_with_prune_usd, 0.000412);
    assert.equal(rec.json.call.cost_without_prune_usd, 0.0012);
    assert.equal((await h.call('POST', `/api/receipts/${a.json.usage.call_id}/verify`, tok, {})).json.verify_status, 'verified');

    const exp = await h.call('GET', '/api/export/receipts.jsonl', tok);
    const all = exp.text.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(all[0].type, 'meta', 'the first line of the proof file is a meta line');
    const lines = all.filter((l) => l.type !== 'meta');
    assert.equal(lines.length, 1);
    assert.equal(lines[0].receipt_raw, rec.json.receipt_json, 'export keeps the exact receipt bytes');

    const usage = await h.call('GET', '/api/usage', tok);
    assert.deepEqual(
      { spent: usage.json.totals.spent_usd, answers: usage.json.totals.answers, verified: usage.json.totals.receipts_verified },
      { spent: 0.000412, answers: 1, verified: 1 },
    );

    const md = await h.call('GET', `/api/chats/${chat}/summary`, tok);
    assert.match(md.res.headers.get('content-disposition') ?? '', /attachment/);
    assert.match(md.text, /Question 1/);
    assert.match(md.text, /Cost: \$0\.000412/);
    assert.match(md.text, /Receipt: verified/);
    assert.equal(mock.calls.length, 1, 'the summary export made no model call');

    const b = await h.call('GET', '/api/budget', tok);
    assert.equal(b.json.spent_usd, 0.000412);
    assert.equal(b.json.reserved_usd, 0);
  });

  test('the same client_msg_id twice makes one paid call and returns the same message', async () => {
    const h = await harness();
    const tok = await h.session();
    const chat = await h.newChat(tok, (await h.upload(tok)).id);
    const a = await h.askQ(tok, chat, 'What are the payment terms?', 'dup-1');
    const b = await h.askQ(tok, chat, 'What are the payment terms?', 'dup-1');
    assert.equal(a.json.message.id, b.json.message.id);
    assert.equal(b.json.usage.call_id, a.json.usage.call_id);
    assert.equal(mock.calls.length, 1);
    assert.equal((await rowsOf(h.env, 'SELECT id FROM llm_calls')).length, 1);
  });

  test('hostile questions and a clean second tier do not break search', async () => {
    const h = await harness();
    const tok = await h.session();
    const chat = await h.newChat(tok, (await h.upload(tok)).id);
    for (const q of ['"; DROP TABLE sections; --', 'NEAR( * OR AND', '((((']) assert.equal((await h.askQ(tok, chat, q)).status, 200, q);
  });
});

describe('lists and deletes', () => {
  test('list documents and chats; deleting removes pages, sections, search rows and the stored file', async () => {
    const h = await harness();
    const tok = await h.session();
    const doc = await h.upload(tok);
    const chat = await h.newChat(tok, doc.id);
    assert.equal((await h.call('GET', '/api/documents', tok)).json.documents.length, 1);
    assert.equal((await h.call('GET', '/api/chats', tok)).json.chats.length, 1);
    assert.ok((h.env.FILES as never as { store: Map<string, unknown> }).store.size === 1);

    assert.equal((await h.call('DELETE', `/api/chats/${chat}`, tok)).json.deleted, true);
    assert.equal((await h.call('GET', '/api/chats', tok)).json.chats.length, 0);
    assert.equal((await h.call('DELETE', `/api/chats/${chat}`, tok)).status, 404);

    assert.equal((await h.call('DELETE', `/api/documents/${doc.id}`, tok)).json.deleted, true);
    assert.equal((await h.call('GET', '/api/documents', tok)).json.documents.length, 0);
    assert.equal((await rowsOf(h.env, 'SELECT 1 FROM pages')).length, 0);
    assert.equal((await rowsOf(h.env, 'SELECT 1 FROM sections')).length, 0);
    assert.equal((await rowsOf(h.env, "SELECT 1 FROM sections_fts WHERE sections_fts MATCH 'payment'")).length, 0);
    assert.ok((h.env.FILES as never as { store: Map<string, unknown> }).store.size === 0);
  });
});

describe('budget and pause', () => {
  test('too little allowance: nothing is sent, message pauses, raising the limit and resuming works', async () => {
    const h = await harness();
    const tok = await h.session();
    const chat = await h.newChat(tok, (await h.upload(tok)).id);
    await h.env.DB.prepare('UPDATE budgets SET limit_micro = 100').run();
    const a = await h.askQ(tok, chat, 'What are the payment terms?');
    assert.equal(a.status, 200);
    assert.equal(a.json.message.status, 'paused');
    assert.equal(a.json.usage, null);
    assert.deepEqual(a.json.message.pause.options, ['shorter', 'raise_budget', 'cancel']);
    assert.equal(a.json.message.pause.reason, 'insufficient_allowance');
    assert.ok(a.json.message.pause.est_usd > a.json.message.pause.remaining_usd);
    assert.equal(mock.calls.length, 0);

    assert.equal((await h.call('PUT', '/api/budget', tok, { limit_usd: 0.5 })).status, 200);
    const r = await h.call('POST', `/api/chats/${chat}/messages/${a.json.message.id}/resume`, tok, { action: 'full' });
    assert.equal(r.json.message.status, 'done', r.text);
    assert.equal(mock.calls.length, 1);
  });

  test('cancel closes a paused message; resuming a message that is not paused is a conflict', async () => {
    const h = await harness();
    const tok = await h.session();
    const chat = await h.newChat(tok, (await h.upload(tok)).id);
    await h.env.DB.prepare('UPDATE budgets SET limit_micro = 100').run();
    const a = await h.askQ(tok, chat, 'What are the payment terms?');
    const c = await h.call('POST', `/api/chats/${chat}/messages/${a.json.message.id}/resume`, tok, { action: 'cancel' });
    assert.equal(c.json.message.status, 'failed');
    const again = await h.call('POST', `/api/chats/${chat}/messages/${a.json.message.id}/resume`, tok, { action: 'full' });
    assert.equal(again.status, 409);
  });

  test('Prune answers 429 with a spend-cap shield code: paused, one attempt, never retried', async () => {
    const h = await harness();
    const tok = await h.session();
    const chat = await h.newChat(tok, (await h.upload(tok)).id);
    mock.queue.push('429_spend_cap');
    const a = await h.askQ(tok, chat, 'What are the payment terms?');
    assert.equal(a.json.message.status, 'paused');
    assert.equal(a.json.message.pause.reason, 'service_cap');
    assert.equal(mock.calls.length, 1);
    const b = await h.call('GET', '/api/budget', tok);
    assert.deepEqual({ s: b.json.spent_usd, r: b.json.reserved_usd }, { s: 0, r: 0 });
  });

  test('the workspace maximum is enforced', async () => {
    const h = await harness();
    const tok = await h.session();
    const r = await h.call('PUT', '/api/budget', tok, { limit_usd: 5 });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'validation_failed');
    assert.ok(ErrorEnvelopeSchema.safeParse(r.json).success);
  });
});

describe('failure and recovery', () => {
  test('connection lost: billing uncertain, estimate counted, manual retry works once', async () => {
    const h = await harness();
    const tok = await h.session();
    const chat = await h.newChat(tok, (await h.upload(tok)).id);
    mock.queue.push('drop');
    const a = await h.askQ(tok, chat, 'What are the payment terms?');
    assert.equal(a.status, 502);
    assert.equal(a.json.error.code, 'billing_uncertain');
    assert.ok(ErrorEnvelopeSchema.safeParse(a.json).success);
    const callId = a.json.error.call_id as string;
    assert.ok(callId);
    assert.equal(mock.calls.length, 1, 'no automatic retry');
    assert.ok((await h.call('GET', '/api/budget', tok)).json.spent_usd > 0, 'the estimate was charged');

    const view = await h.call('GET', `/api/chats/${chat}`, tok);
    assert.equal(view.json.messages[1].status, 'failed');
    assert.equal(view.json.messages[1].call_id, callId);

    const r = await h.call('POST', `/api/calls/${callId}/retry`, tok, {});
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.message.status, 'done');
    assert.equal(mock.calls.length, 2);
    assert.notEqual(mock.calls[0].headers['x-prune-run-id'], mock.calls[1].headers['x-prune-run-id'], 'each attempt is its own Prune run');
    assert.equal((await h.call('POST', `/api/calls/${callId}/retry`, tok, {})).status, 409, 'a second retry of the same call is refused');
  });

  test('a service outage retries twice then fails closed; an auth failure does not retry', async () => {
    const h = await harness();
    const tok = await h.session();
    const chat = await h.newChat(tok, (await h.upload(tok)).id);
    mock.queue.push('500', '500', '500');
    const a = await h.askQ(tok, chat, 'What are the payment terms?');
    assert.equal(a.json.error.code, 'provider_unavailable');
    assert.equal(mock.calls.length, 3);
    mock.state.calls.length = 0;
    mock.queue.push('401');
    const b = await h.askQ(tok, chat, 'What are the payment terms?');
    assert.equal(b.json.error.code, 'provider_auth_failed');
    assert.equal(mock.calls.length, 1);
    const budget = await h.call('GET', '/api/budget', tok);
    assert.deepEqual({ s: budget.json.spent_usd, r: budget.json.reserved_usd }, { s: 0, r: 0 });
  });

  test('kill switch: 503 and zero model calls', async () => {
    const h = await harness();
    const tok = await h.session();
    const chat = await h.newChat(tok, (await h.upload(tok)).id);
    h.env.KILL_SWITCH = '1';
    const a = await h.askQ(tok, chat, 'What are the payment terms?');
    assert.equal(a.status, 503);
    assert.equal(a.json.error.code, 'kill_switch_on');
    assert.equal(mock.calls.length, 0);
  });

  test('janitor releases stuck reservations and charges stuck sent calls', async () => {
    const h = await harness();
    const tok = await h.session();
    const ws = (await rowOf<{ id: string }>(h.env, 'SELECT id FROM workspaces'))!.id;
    await h.env.DB.batch([
      h.env.DB.prepare("INSERT INTO llm_calls (id, workspace_id, purpose, workload, tier, model_requested, status, est_micro, idempotency_key, created_at) VALUES ('k_a', ?, 'answer', 'rag', 'economy', 'm', 'reserved', 300, 'ka', 1)").bind(ws),
      h.env.DB.prepare("INSERT INTO llm_calls (id, workspace_id, purpose, workload, tier, model_requested, status, est_micro, idempotency_key, created_at) VALUES ('k_b', ?, 'answer', 'rag', 'economy', 'm', 'sent', 500, 'kb', 1)").bind(ws),
      h.env.DB.prepare('UPDATE budgets SET reserved_micro = 800 WHERE workspace_id = ?').bind(ws),
    ]);
    const out = await runJanitor(h.env);
    assert.deepEqual({ r: out.released, u: out.unknown }, { r: 1, u: 1 });
    const b = await rowOf<{ spent_micro: number; reserved_micro: number }>(h.env, 'SELECT * FROM budgets WHERE workspace_id = ?', ws);
    assert.deepEqual({ s: b!.spent_micro, r: b!.reserved_micro }, { s: 500, r: 0 });
    assert.equal((await rowOf<{ status: string }>(h.env, "SELECT status FROM llm_calls WHERE id = 'k_b'"))!.status, 'unknown_cost');
    void tok;
  });
});

describe('validation, escalation and extraction', () => {
  test('an answer with no valid citation escalates once; both calls are counted in the answer cost', async () => {
    const h = await harness();
    const tok = await h.session();
    const chat = await h.newChat(tok, (await h.upload(tok)).id);
    mock.queue.push('nocite', 'ok');
    const a = await h.askQ(tok, chat, 'What are the payment terms?');
    assert.equal(a.json.message.status, 'done');
    assert.equal(mock.calls.length, 2);
    assert.equal(mock.calls[1].headers['x-prune-cache'], 'off');
    assert.ok(a.json.message.trace.some((s: any) => s.step === 'escalate'));
    assert.ok(a.json.message.citations.length >= 1);
    assert.equal(a.json.usage.cost_usd, 0.000824);
    assert.equal(a.json.usage.tier, 'standard');
  });

  test('invoice extraction: structured fields and a code-checked total', async () => {
    const h = await harness();
    const tok = await h.session();
    const inv = await h.upload(tok, 'invoice', ['INVOICE INV-1\nAcme Ltd\nWidget x2 at 50 = 100\nSubtotal 100\nTax 10\nTotal 110']);
    const chat = await h.newChat(tok, inv.id);
    const a = await h.askQ(tok, chat, 'Extract the invoice fields', 'x1', { mode: 'extract' });
    assert.equal(a.json.message.status, 'done', a.text);
    assert.match(a.json.message.content, /"vendor": "Acme Ltd"/);
    assert.match(a.json.message.content, /Total check: Line items plus tax add up to the total \(110\)/);
    assert.equal(mock.calls[0].body.response_format.type, 'json_object');
    assert.equal(mock.calls[0].headers['x-prune-workload'], 'structured_extraction');

    mock.queue.push('badtotal');
    const bad = await h.askQ(tok, chat, 'Extract the invoice fields', 'x2', { mode: 'extract' });
    assert.match(bad.json.message.content, /Expected a total of 110/);
  });

  test('extract on a non-invoice document is refused before any call', async () => {
    const h = await harness();
    const tok = await h.session();
    const chat = await h.newChat(tok, (await h.upload(tok)).id);
    const a = await h.askQ(tok, chat, 'Extract', 'x1', { mode: 'extract' });
    assert.equal(a.status, 400);
    assert.equal(mock.calls.length, 0);
  });

  test('memory summary: after enough conversation an economy summary call is stored', async () => {
    const h = await harness();
    const tok = await h.session();
    const chat = await h.newChat(tok, (await h.upload(tok)).id);
    const long = 'lorem ipsum payment '.repeat(190);
    for (let i = 0; i < 4; i++) {
      const a = await h.askQ(tok, chat, `${long} question ${i}`);
      assert.equal(a.status, 200, a.text);
      await h.exec.settle();
    }
    const s = await rowsOf<{ text: string }>(h.env, 'SELECT text FROM summaries');
    assert.equal(s.length, 1);
    const call = await rowOf<{ purpose: string; tier: string }>(h.env, "SELECT purpose, tier FROM llm_calls WHERE purpose = 'memory_summary'");
    assert.deepEqual(call, { purpose: 'memory_summary', tier: 'economy' });
    const next = await h.askQ(tok, chat, 'And the delivery terms?');
    assert.match(JSON.stringify(mock.calls.at(-1).body), /Summary of earlier conversation/);
    assert.equal(next.status, 200);
  });
});

describe('access control and abuse caps', () => {
  test('no token and wrong token are 401; one workspace cannot see another', async () => {
    const h = await harness();
    const a = await h.session();
    const b = await h.session();
    assert.equal((await h.call('GET', '/api/budget', null)).status, 401);
    assert.equal((await h.call('GET', '/api/budget', 'nope')).status, 401);
    const doc = await h.upload(a);
    assert.equal((await h.call('GET', `/api/documents/${doc.id}`, b)).status, 404);
    assert.equal((await h.call('DELETE', `/api/documents/${doc.id}`, b)).status, 404);
    const chat = await h.newChat(a, doc.id);
    assert.equal((await h.askQ(b, chat, 'hello there')).status, 404);
    assert.equal((await h.call('POST', '/api/chats', b, { document_ids: [doc.id] })).status, 404);
  });

  test('session creation is limited per IP', async () => {
    const h = await harness({ SESSION_LIMIT_PER_HOUR: '2' });
    assert.equal((await h.call('POST', '/api/session', null, {})).status, 200);
    assert.equal((await h.call('POST', '/api/session', null, {})).status, 200);
    const third = await h.call('POST', '/api/session', null, {});
    assert.equal(third.status, 429);
    assert.equal(third.json.error.code, 'rate_limited');
  });

  test('upload limits and bad input are rejected with the error envelope', async () => {
    const h = await harness();
    const tok = await h.session();
    assert.equal((await h.call('POST', '/api/documents', tok, { filename: 'a.pdf', size_bytes: 30 * 1024 * 1024, page_count: 2, pack: 'general' })).status, 413);
    assert.equal((await h.call('POST', '/api/documents', tok, { filename: 'a.pdf', size_bytes: 10, page_count: 500, pack: 'general' })).status, 413);
    assert.equal((await h.call('POST', '/api/documents', tok, 'not json')).status, 400);
    assert.equal((await h.call('POST', '/api/documents', tok, { filename: '', size_bytes: 1, page_count: 1 })).status, 400);
    const d = (await h.call('POST', '/api/documents', tok, { filename: 'a.pdf', size_bytes: 10, page_count: 2, pack: 'general' })).json.document_id;
    assert.equal((await h.call('POST', `/api/documents/${d}/finalize`, tok, {})).status, 409, 'cannot finalize before every page arrives');
    assert.equal((await h.call('POST', `/api/documents/${d}/pages`, tok, { pages: [{ page_no: 9, text: 'x' }] })).status, 400);
    assert.equal((await h.call('POST', '/api/chats', tok, { document_ids: [d] })).status, 409, 'chat needs a ready document');
  });

  test('scanned pages are flagged, not read: the document is partial', async () => {
    const h = await harness();
    const tok = await h.session();
    const doc = await h.upload(tok, 'general', ['A real page with plenty of readable text on it.', '']);
    assert.equal(doc.status, 'partial');
    const d = await h.call('GET', `/api/documents/${doc.id}`, tok);
    assert.equal(d.json.document.scanned_pages, 1);
  });

  test('budget invariant: spent equals the sum of settled calls and nothing stays reserved', async () => {
    const h = await harness();
    const tok = await h.session();
    const chat = await h.newChat(tok, (await h.upload(tok)).id);
    mock.queue.push('ok', '429', 'ok', 'drop', 'ok', 'nocite', 'ok');
    for (let i = 0; i < 5; i++) await h.askQ(tok, chat, `What are the payment terms? ${i}`);
    await h.exec.settle();
    const b = await rowOf<{ spent_micro: number; reserved_micro: number }>(h.env, 'SELECT spent_micro, reserved_micro FROM budgets');
    const sum = await rowOf<{ s: number }>(h.env, "SELECT COALESCE(SUM(CASE WHEN status = 'ok' THEN cost_micro WHEN status = 'unknown_cost' THEN est_micro WHEN status = 'failed' AND error_class = 'receipt_missing' THEN est_micro ELSE 0 END), 0) AS s FROM llm_calls");
    assert.equal(b!.reserved_micro, 0);
    assert.equal(b!.spent_micro, sum!.s);
    const inFlight = await rowsOf(h.env, "SELECT id FROM llm_calls WHERE status IN ('reserved','sent')");
    assert.equal(inFlight.length, 0);
  });
});
