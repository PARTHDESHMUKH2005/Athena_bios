import type { Hono } from 'hono';
import type { Env } from '../env.ts';
import { nowSec } from '../util.ts';

export type Vars = { ws: string; reqId: string };
export type AppT = Hono<{ Bindings: Env; Variables: Vars }>;

export async function logEvent(env: Env, ws: string | null, type: string, ref: string | null, detail: unknown = {}): Promise<void> {
  await env.DB.prepare('INSERT INTO events (workspace_id, type, ref_id, detail_json, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(ws, type, ref, JSON.stringify(detail), nowSec())
    .run();
}
