import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { after, before, beforeEach, describe, test } from 'node:test';
import { reserve } from '../src/budget.ts';
import { makeHarness } from './harness.ts';
import { makeEnv, makeWorkspace, rowOf, rowsOf } from './helpers.ts';
// @ts-ignore plain JS module
import { startMock } from '../tools/mock-prune/mock.mjs';

let mock: Awaited<ReturnType<typeof startMock>>;
before(async () => void (mock = await startMock()));
after(async () => mock.close());
beforeEach(() => {
  mock.state.calls.length = 0;
  mock.state.queue.length = 0;
});

describe('Point 4: budget pause', () => {
  test('two parallel requests that fit only once make one call and one pause', async () => {
    // Calibrate: how much does one economy answer reserve in this setup?
    const cal = await makeHarness(mock);
    const ctok = await cal.session();
    await cal.askQ(ctok, await cal.newChat(ctok, (await cal.upload(ctok)).id), 'What are the payment terms?');
    const est = (await rowOf<{ est_micro: number }>(cal.env, 'SELECT est_micro FROM llm_calls'))!.est_micro;
    mock.calls.length = 0;

    const h = await makeHarness(mock);
    const tok = await h.session();
    const chat = await h.newChat(tok, (await h.upload(tok)).id);
    // Room for exactly one full reservation, and not enough left for even the smallest shrunk retry (about 165).
    await h.env.DB.prepare('UPDATE budgets SET limit_micro = ?').bind(est + 20).run();
    mock.queue.push('slow'); // keep the first call in flight while the second one tries to reserve
    const [a, b] = await Promise.all([h.askQ(tok, chat, 'What are the payment terms?', 'one'), h.askQ(tok, chat, 'What are the payment terms?', 'two')]);
    const statuses = [a.json.message.status, b.json.message.status].sort();
    assert.deepEqual(statuses, ['done', 'paused']);
    assert.equal(mock.calls.length, 1, 'only one model call was made');
    const paused = [a, b].find((r) => r.json.message.status === 'paused')!;
    assert.deepEqual(paused.json.message.pause.options, ['shorter', 'raise_budget', 'cancel']);
    assert.equal(paused.json.usage, null);
    const bu = (await h.call('GET', '/api/budget', tok)).json;
    assert.equal(bu.reserved_usd, 0, 'nothing is left reserved');
  });

  test('the reservation itself is atomic: concurrent reserves never both win', async () => {
    const env = await makeEnv(mock);
    const ws = await makeWorkspace(env, { limitMicro: 150, perCallMicro: 150 });
    const wins = await Promise.all(Array.from({ length: 8 }, () => reserve(env.DB, ws.id, 100)));
    assert.equal(wins.filter(Boolean).length, 1);
    assert.equal((await rowOf<{ reserved_micro: number }>(env, 'SELECT reserved_micro FROM budgets WHERE workspace_id = ?', ws.id))!.reserved_micro, 100);
  });

  test('nothing resumes on its own: a paused message stays paused until the user picks an option', async () => {
    const h = await makeHarness(mock);
    const tok = await h.session();
    const chat = await h.newChat(tok, (await h.upload(tok)).id);
    await h.env.DB.prepare('UPDATE budgets SET limit_micro = 100').run();
    const a = await h.askQ(tok, chat, 'What are the payment terms?');
    await h.call('PUT', '/api/budget', tok, { limit_usd: 0.5 }); // raising the budget alone does not resume it
    const view = await h.call('GET', `/api/chats/${chat}`, tok);
    assert.equal(view.json.messages[1].status, 'paused');
    assert.equal(mock.calls.length, 0);
    assert.equal(a.json.message.pause.reason, 'insufficient_allowance');
  });
});

describe('Point 4: billing uncertain', () => {
  test('after a timeout the estimate is charged, nothing retries by itself, and a manual retry works once', async () => {
    const h = await makeHarness(mock);
    const tok = await h.session();
    const chat = await h.newChat(tok, (await h.upload(tok)).id);
    mock.queue.push('drop');
    const a = await h.askQ(tok, chat, 'What are the payment terms?');
    assert.equal(a.json.error.code, 'billing_uncertain');
    assert.equal(mock.calls.length, 1);
    const callId = a.json.error.call_id;
    const row = await rowOf<{ status: string; error_class: string; receipt_json: string | null }>(h.env, 'SELECT status, error_class, receipt_json FROM llm_calls WHERE id = ?', callId);
    assert.deepEqual({ s: row!.status, c: row!.error_class, r: row!.receipt_json }, { s: 'unknown_cost', c: 'billing_uncertain', r: null });
    assert.ok((await h.call('GET', '/api/budget', tok)).json.spent_usd > 0, 'the estimate was charged as a precaution');
    assert.equal((await h.call('POST', `/api/calls/${callId}/retry`, tok, {})).status, 200);
    assert.equal((await h.call('POST', `/api/calls/${callId}/retry`, tok, {})).status, 409);
  });

  test('a failure before anything was sent is not "billing uncertain" and costs nothing', async () => {
    // A port nobody listens on: the connection is refused before a single byte of the request is sent.
    const closedPort = await new Promise<number>((resolve) => {
      const srv = createServer();
      srv.listen(0, '127.0.0.1', () => {
        const port = (srv.address() as { port: number }).port;
        srv.close(() => resolve(port));
      });
    });
    const h = await makeHarness(mock, { PRUNE_BASE_URL: `http://127.0.0.1:${closedPort}/v1` });
    const tok = await h.session();
    const chat = await h.newChat(tok, (await h.upload(tok)).id);
    const a = await h.askQ(tok, chat, 'What are the payment terms?');
    assert.equal(a.json.error.code, 'provider_unavailable');
    assert.equal((await h.call('GET', '/api/budget', tok)).json.spent_usd, 0);
  });

  test('a bad key, an exhausted budget and a Shield block are never retried', async () => {
    for (const [mode, code] of [['401', 'provider_auth_failed'], ['429_spend_cap', null], ['shield', 'shield_blocked'], ['402', null]] as const) {
      const h = await makeHarness(mock);
      const tok = await h.session();
      const chat = await h.newChat(tok, (await h.upload(tok)).id);
      mock.calls.length = 0;
      mock.queue.push(mode, mode, mode);
      const a = await h.askQ(tok, chat, 'What are the payment terms?');
      assert.equal(mock.calls.length, 1, `${mode}: exactly one attempt`);
      if (code) assert.equal(a.json.error.code, code, mode);
      mock.queue.length = 0;
      const calls = await rowsOf<{ status: string }>(h.env, 'SELECT status FROM llm_calls');
      assert.ok(calls.every((c) => c.status !== 'ok'), mode);
    }
  });
});
