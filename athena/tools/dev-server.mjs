// One command for the whole backend locally: the real Athena API over in-memory SQLite + R2, talking to the
// mock Prune. `npm run dev:stack`, then `npm --prefix web run dev` (Vite proxies /api here).
// In-memory: restarting wipes workspaces. This is for development and demos, not production.
import { createServer } from 'node:http';
import { createApp } from '../src/app.ts';
import { runJanitor } from '../src/janitor.ts';
import { makeEnv } from '../tests/helpers.ts';
import { startMock } from './mock-prune/mock.mjs';

const PORT = Number(process.env.PORT ?? 8787);
const mock = await startMock({ port: Number(process.env.MOCK_PORT ?? 8788) });
const env = await makeEnv(mock, {
  PRUNE_API_KEY: 'dev-key',
  DEFAULT_BUDGET_USD: '0.25',
  MAX_WORKSPACE_BUDGET_USD: '1.00',
  MSG_LIMIT_PER_MIN: '1000',
  DOC_LIMIT_PER_MIN: '1000',
  SESSION_LIMIT_PER_HOUR: '1000',
});
const app = createApp();
const exec = { waitUntil: (p) => void p.catch(() => undefined), passThroughOnException() {} };
setInterval(() => runJanitor(env).catch(() => undefined), 5 * 60 * 1000).unref();

const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const init = { method: req.method, headers: req.headers };
    if (!['GET', 'HEAD'].includes(req.method ?? 'GET') && body.length) init.body = body;
    const response = await app.fetch(new Request(`http://${req.headers.host}${req.url}`, init), env, exec);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'internal', message: 'dev server error', retryable: false, request_id: 'dev' } }));
  }
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Athena API   http://127.0.0.1:${PORT}   (in-memory database)`);
  console.log(`Mock Prune   ${mock.url}   (add [[mock:429]], [[mock:drop]] ... to a question to inject failures)`);
});
