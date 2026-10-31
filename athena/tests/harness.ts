// Shared API harness: the real Hono app over the FakeD1/FakeR2 test doubles and a mock Prune.
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { fakeExec, makeEnv, noSleep } from './helpers.ts';
import type { Mock } from './helpers.ts';

export const PAGES = [
  'TERMS AND CONDITIONS\nThis agreement is between the supplier and the customer.\nPayment is due within 30 days of the invoice date. Late fees apply after 45 days.',
  'DELIVERY\nGoods are delivered within 10 business days of the order. Risk passes on delivery.',
  'TERMINATION\nEither party may terminate with 60 days written notice. Fees already paid are not refunded.',
];

export async function makeHarness(mock: Mock, over: Record<string, string> = {}) {
  const env = await makeEnv(mock, over);
  const exec = fakeExec();
  const app = createApp({ llm: { sleep: noSleep } });
  type R = { status: number; json: any; text: string; res: Response };
  const call = async (method: string, path: string, token: string | null, body?: unknown): Promise<R> => {
    const res = await app.request(
      path,
      { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) },
      env,
      exec as never,
    );
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: res.status, json, text, res };
  };
  const session = async () => {
    const r = await call('POST', '/api/session', null, {});
    assert.equal(r.status, 200);
    return r.json.token as string;
  };
  const upload = async (token: string, pack: 'general' | 'invoice' = 'general', pages = PAGES) => {
    const d = await call('POST', '/api/documents', token, { filename: 'contract.pdf', size_bytes: 1234, page_count: pages.length, pack });
    assert.equal(d.status, 200, d.text);
    const id = d.json.document_id as string;
    assert.equal((await call('PUT', `/api/documents/${id}/file`, token, '%PDF-1.4 fake')).status, 200);
    // Like a real client: at most 25 pages per request.
    for (let i = 0; i < pages.length; i += 25) {
      const batch = pages.slice(i, i + 25).map((text, j) => ({ page_no: i + j + 1, text }));
      const p = await call('POST', `/api/documents/${id}/pages`, token, { pages: batch });
      assert.equal(p.status, 200, p.text);
    }
    const f = await call('POST', `/api/documents/${id}/finalize`, token, { ocr: 'skip', auto_summary: false });
    assert.equal(f.status, 200, f.text);
    return { id, status: f.json.status as string, sections: f.json.sections as number };
  };
  const newChat = async (token: string, docId: string) => (await call('POST', '/api/chats', token, { document_ids: [docId] })).json.chat_id as string;
  const askQ = (token: string, chat: string, content: string, id = Math.random().toString(36).slice(2), extra: object = {}) =>
    call('POST', `/api/chats/${chat}/messages`, token, { client_msg_id: id, content, mode: 'answer', output: 'normal', ...extra });
  return { env, exec, app, call, session, upload, newChat, askQ };
}
