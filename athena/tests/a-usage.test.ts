import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { makeHarness } from './harness.ts';
import { rowOf, rowsOf } from './helpers.ts';
// @ts-ignore plain JS module
import { startMock } from '../tools/mock-prune/mock.mjs';

let mock: Awaited<ReturnType<typeof startMock>>;
before(async () => void (mock = await startMock()));
after(async () => mock.close());
beforeEach(() => {
  mock.state.calls.length = 0;
  mock.state.queue.length = 0;
});

describe('Point 2: cost per good answer', () => {
  test('a ten-question run matches the hand calculation, retries and escalations included', async () => {
    const h = await makeHarness(mock);
    const tok = await h.session();
    const chat = await h.newChat(tok, (await h.upload(tok)).id);
    // Each ordinary call costs $0.000412 (from the signed mock receipt); a cache hit costs 0.
    //  Q1-Q6: ok                            -> 6 calls, 6 good
    //  Q7:    no citation, then ok          -> 2 calls, 1 good (the escalation fixed it)
    //  Q8:    no citation, then no citation -> 2 calls, 0 good (still shown, but the check fails)
    //  Q9:    cache hit                     -> 1 call at $0, 1 good
    //  Q10:   ok                            -> 1 call, 1 good
    mock.queue.push('ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'nocite', 'ok', 'nocite', 'nocite', 'cache_hit', 'ok');
    for (let i = 1; i <= 10; i++) {
      const r = await h.askQ(tok, chat, `What are the payment terms? (${i})`);
      assert.equal(r.status, 200, r.text);
    }
    assert.equal(mock.calls.length, 12, 'twelve model calls in all');
    const u = (await h.call('GET', '/api/usage', tok)).json;
    // 11 paid calls * $0.000412 = $0.004532; 9 good answers; 10 attempted.
    assert.equal(u.cpga.spend_usd, 0.004532);
    assert.equal(u.cpga.good_answers, 9);
    assert.equal(u.cpga.attempted, 10);
    assert.equal(u.cpga.cpga_usd, 0.000504); // round(4532 / 9) = 504 micro-USD
    assert.equal(u.cpga.cost_per_request_usd, 0.000453); // round(4532 / 10)
    assert.equal(u.success_rate, 0.9);
    assert.equal(u.cpga.cpga_excluding_checker_usd, u.cpga.cpga_including_judge_usd, 'the gate is code, there is no judge cost');
    // Cross-check against the database, not the endpoint.
    const sum = (await rowOf<{ s: number }>(h.env, "SELECT SUM(cost_micro) AS s FROM llm_calls WHERE status = 'ok'"))!.s;
    assert.equal(sum, 4532);
    const chatRow = u.by_chat.find((c: { chat_id: string }) => c.chat_id === chat);
    assert.equal(chatRow.cpga_usd, 0.000504);
    // attempts per answer: the escalated answers list both attempts.
    const two = u.attempts_by_answer.filter((a: { attempts: unknown[] }) => a.attempts.length === 2);
    assert.equal(two.length, 2);
    assert.deepEqual(two[0].attempts.map((a: { rung: string }) => a.rung), ['first', 'escalation']);
    // Existing fields are intact.
    assert.equal(u.totals.answers, 10);
    assert.equal(u.series.length, 10);
  });

  test('every finished answer carries its gate result', async () => {
    const h = await makeHarness(mock);
    const tok = await h.session();
    const chat = await h.newChat(tok, (await h.upload(tok)).id);
    const r = await h.askQ(tok, chat, 'What are the payment terms?');
    assert.equal(r.json.message.gate.pass, true);
    assert.equal(r.json.message.gate.summary, 'Citation check passed');
    const view = await h.call('GET', `/api/chats/${chat}`, tok);
    assert.equal(view.json.messages[1].gate.pass, true, 'a reloaded chat still has it');
    mock.queue.push('leak');
    const bad = await h.askQ(tok, chat, 'What is the grace period?');
    assert.ok('gate' in bad.json.message);
  });
});

describe('Point 2: the checker\'s own error rate is shown, or marked as not measured', () => {
  test('before any evaluation: not measured. After: the rates and N come from the labelled set', async () => {
    const h = await makeHarness(mock);
    const tok = await h.session();
    const none = (await h.call('GET', '/api/usage', tok)).json.gate;
    assert.deepEqual({ m: none.measured, n: none.n, fp: none.false_pass_rate }, { m: false, n: 0, fp: null });
    await h.env.DB.prepare('INSERT INTO gate_eval (n, false_pass, false_fail, precision, recall, thresholds_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(48, 2, 3, 0.93, 0.88, '{"abstain_min_score":null}', 1_700_000_000)
      .run();
    const g = (await h.call('GET', '/api/usage', tok)).json.gate;
    assert.equal(g.measured, true);
    assert.equal(g.n, 48);
    assert.equal(g.false_pass_rate, 0.041667);
    assert.equal(g.false_fail_rate, 0.0625);
    assert.equal(g.last_run, 1_700_000_000);
  });
});

describe('Point 3: the gate inside the pipeline', () => {
  test('a fabricated number is flagged but recorded only; with GATE_ENFORCE it uses the one escalation', async () => {
    // 'odd_numbers' style answers do not exist for text, so inject a number the page lacks by editing the stored page.
    const h = await makeHarness(mock);
    const tok = await h.session();
    const doc = await h.upload(tok);
    const chat = await h.newChat(tok, doc.id);
    await h.env.DB.prepare("UPDATE pages SET text = replace(text, '30 days', 'thirty days') WHERE document_id = ?").bind(doc.id).run();
    await h.env.DB.prepare("UPDATE sections SET text = replace(text, '30 days', '99 days')").run();
    const r = await h.askQ(tok, chat, 'When is payment due within days of the invoice date?');
    assert.equal(r.json.message.status, 'done');
    assert.equal(r.json.message.gate.pass, false);
    assert.match(r.json.message.gate.summary, /^Citation check failed: number 99 not found on page 1/);
    assert.equal(mock.calls.length, 1, 'recording a failed gate does not change the pipeline');

    const h2 = await makeHarness(mock, { GATE_ENFORCE: '1' });
    const tok2 = await h2.session();
    const doc2 = await h2.upload(tok2);
    const chat2 = await h2.newChat(tok2, doc2.id);
    await h2.env.DB.prepare("UPDATE pages SET text = replace(text, '30 days', 'thirty days') WHERE document_id = ?").bind(doc2.id).run();
    await h2.env.DB.prepare("UPDATE sections SET text = replace(text, '30 days', '99 days')").run();
    const before = mock.calls.length;
    const r2 = await h2.askQ(tok2, chat2, 'When is payment due within days of the invoice date?');
    assert.equal(mock.calls.length - before, 2, 'exactly one escalation, never more');
    assert.equal(r2.json.message.status, 'done');
    const kinds = (await rowsOf<{ purpose: string }>(h2.env, 'SELECT purpose FROM llm_calls ORDER BY created_at, rowid')).map((x) => x.purpose);
    assert.deepEqual(kinds, ['answer', 'repair']);
  });

  test('weak retrieval abstains with zero model calls (only when ABSTAIN_MIN_SCORE is set)', async () => {
    const h = await makeHarness(mock, { ABSTAIN_MIN_SCORE: '0.000001' });
    const tok = await h.session();
    const chat = await h.newChat(tok, (await h.upload(tok)).id);
    const r = await h.askQ(tok, chat, 'What is the airspeed velocity of an unladen swallow?');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.message.status, 'done');
    assert.equal(r.json.message.content, 'This does not appear to be in the document.');
    assert.equal(r.json.usage, null);
    assert.equal(mock.calls.length, 0, 'no model was called');
    assert.equal(r.json.message.gate.abstained, true);
    const b = (await h.call('GET', '/api/budget', tok)).json;
    assert.equal(b.spent_usd, 0);
    // A question the document can answer still goes to the model.
    // (bm25 values are tiny on a three-page document, so the test threshold is tiny too. Real thresholds are set from bench/gate_eval.)
    const ok = await h.askQ(tok, chat, 'What are the payment terms and late fees?');
    assert.equal(ok.json.message.status, 'done');
    assert.equal(mock.calls.length, 1);
  });

  test('with the flags unset nothing changes: a weak question still reaches the model', async () => {
    const h = await makeHarness(mock);
    const tok = await h.session();
    const chat = await h.newChat(tok, (await h.upload(tok)).id);
    await h.askQ(tok, chat, 'What is the airspeed velocity of an unladen swallow?');
    assert.equal(mock.calls.length, 1);
  });
});
