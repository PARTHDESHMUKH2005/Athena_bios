import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { SYSTEM_PROMPT_V1 } from '../src/context.ts';
import { scanOutput } from '../src/outputscan.ts';
import { makeHarness } from './harness.ts';
import { rowOf } from './helpers.ts';
// @ts-ignore plain JS modules
import { startMock } from '../tools/mock-prune/mock.mjs';
// @ts-ignore
import { INJECTIONS, LEGIT, MARKER, QUESTION, pageFor } from './fixtures/injections.mjs';

let mock: Awaited<ReturnType<typeof startMock>>;
before(async () => void (mock = await startMock()));
after(async () => mock.close());
beforeEach(() => {
  mock.state.calls.length = 0;
  mock.state.queue.length = 0;
});

describe('prompt injection: structural invariants (what the model is allowed to see and do)', () => {
  assert.ok(INJECTIONS.length >= 15);
  for (const inj of INJECTIONS) {
    test(inj.name, async () => {
      const h = await makeHarness(mock);
      const tok = await h.session();
      const doc = await h.upload(tok, 'general', [pageFor(inj)]);
      const chat = await h.newChat(tok, doc.id);
      const r = await h.askQ(tok, chat, QUESTION);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.message.status, 'done');

      // The injection cannot cause extra model calls, and the model has no tools to call.
      assert.equal(mock.calls.length, 1, 'exactly one model call');
      const body = mock.calls[0].body;
      assert.equal(body.tools, undefined);
      assert.equal(body.functions, undefined);

      // Rules come first and are static; the document only ever appears inside the user turn, inside fences.
      assert.equal(body.messages[0].role, 'system');
      assert.ok(body.messages[0].content.startsWith(SYSTEM_PROMPT_V1));
      assert.ok(!body.messages[0].content.includes(MARKER), 'no document text in the system prompt');
      const user = body.messages.at(-1).content as string;
      const opens = (user.match(/<untrusted_document /g) ?? []).length;
      const closes = (user.match(/<\/untrusted_document>/g) ?? []).length;
      assert.equal(opens, closes, 'every fence opened is closed exactly once, so the document cannot break out');
      assert.ok(opens >= 1);

      // Hidden-character tricks are stripped before indexing; no secret leaves the Worker.
      const sent = JSON.stringify(body);
      assert.ok(!/[​-‏‪-‮⁠-⁤⁦-⁩﻿]/.test(sent), 'zero-width and bidi characters removed');
      assert.ok(!sent.includes('test-prune-key'));

      // No side effects: the only cost is the one answer.
      const b = await rowOf<{ spent_micro: number; reserved_micro: number; limit_micro: number }>(h.env, 'SELECT * FROM budgets');
      assert.deepEqual({ s: b!.spent_micro, r: b!.reserved_micro, l: b!.limit_micro }, { s: 412, r: 0, l: 250_000 });
      assert.equal(r.json.message.content.includes(MARKER), false);
    });
  }

  test('the legitimate text next to the payload is still retrieved', async () => {
    const h = await makeHarness(mock);
    const tok = await h.session();
    const doc = await h.upload(tok, 'general', [pageFor(INJECTIONS[0])]);
    await h.askQ(tok, await h.newChat(tok, doc.id), QUESTION);
    assert.ok((mock.calls[0].body.messages.at(-1).content as string).includes(LEGIT));
  });
});

describe('output guardrail: a model that does obey a payload still cannot leak', () => {
  test('secrets, foreign links and shell one-liners are removed and flagged; links from the document are kept', async () => {
    const h = await makeHarness(mock);
    const tok = await h.session();
    const doc = await h.upload(tok, 'general', ['TERMS\nPayment is due in 30 days. See https://example.com/terms for details.']);
    const chat = await h.newChat(tok, doc.id);
    mock.queue.push('leak');
    const r = await h.askQ(tok, chat, 'What is the payment term?');
    assert.equal(r.status, 200, r.text);
    const c = r.json.message.content as string;
    assert.ok(!c.includes('test-prune-key'), 'the Prune key');
    assert.ok(!c.includes('sk-' + 'abcdefghijklmnopqrstuvwxyz'), 'a key-shaped string');
    assert.ok(!c.includes('evil.example'), 'a link the document never contained');
    assert.ok(!/curl .*\| *bash/.test(c), 'a download-and-run command');
    assert.ok(c.includes('https://example.com/terms'), 'a link that IS in the document is kept');
    assert.ok(c.includes('[p.1]'), 'the real answer and citation survive');
    const scan = r.json.message.trace.find((s: any) => s.step === 'scan');
    assert.ok(scan, 'the timeline records that something was removed');
    assert.ok(!scan.detail.includes('evil.example') && !scan.detail.includes('sk-'), 'the timeline never repeats what was removed');
    assert.match(scan.detail, /secret/);
    assert.match(scan.detail, /link/);
    assert.match(scan.detail, /shell/);
  });

  test('scanOutput is quiet on a clean answer', () => {
    const out = scanOutput('Due in 30 days [p.2]. Contact support@example.com.', { context: 'x', secrets: ['abc'] });
    assert.deepEqual(out.flags, []);
    assert.equal(out.text, 'Due in 30 days [p.2]. Contact support@example.com.');
  });

  test('scanOutput catches common credential shapes and the exact secrets we hold', () => {
    // Built at runtime so no credential-shaped literal sits in the source (and push protection has nothing to flag).
    const samples = ['AKIA' + 'ABCDEFGHIJKLMNOP', 'ghp_' + 'a'.repeat(36), 'sk-ant-' + 'b'.repeat(30), 'Bearer ' + 'c'.repeat(30), '-----BEGIN RSA PRIVATE ' + 'KEY-----\nMIIE\n-----END RSA PRIVATE ' + 'KEY-----'];
    for (const s of samples) {
      const out = scanOutput(`here: ${s} done`, { context: '' });
      assert.ok(out.flags.includes('secret') && !out.text.includes(s.slice(0, 20)), s.slice(0, 12));
    }
    assert.ok(scanOutput('the key is hunter2hunter2', { context: '', secrets: ['hunter2hunter2'] }).flags.includes('secret'));
  });
});
