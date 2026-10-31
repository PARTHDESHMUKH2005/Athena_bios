import { createApp } from './app.ts';
import type { Env } from './env.ts';
import { runJanitor } from './janitor.ts';

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) {
    ctx.waitUntil(runJanitor(env));
  },
};
