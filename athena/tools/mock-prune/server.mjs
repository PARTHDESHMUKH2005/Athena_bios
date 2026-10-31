// `npm run mock` starts the fake Prune on http://127.0.0.1:8788/v1 for local `wrangler dev`.
import { startMock } from './mock.mjs';

const m = await startMock({ port: Number(process.env.MOCK_PORT ?? 8788) });
console.log(`mock Prune listening on ${m.url}`);
console.log('add [[mock:429]], [[mock:500]], [[mock:drop]], [[mock:429_spend_cap]] ... to a question to inject failures');
