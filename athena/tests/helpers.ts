// Test harness: a D1-compatible adapter over node:sqlite (real SQLite with FTS5), an in-memory R2,
// and the mock Prune. Tests therefore run the real Worker code, not stubs of it.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
// @ts-ignore plain JS module
import { startMock } from '../tools/mock-prune/mock.mjs';
import type { Env } from '../src/env.ts';
import { sha256Hex } from '../src/util.ts';

type Param = string | number | null | undefined | boolean;
const clean = (p: Param[]) => p.map((x) => (x === undefined ? null : typeof x === 'boolean' ? (x ? 1 : 0) : x));

class FakeStmt {
  private db: DatabaseSync;
  readonly sql: string;
  readonly params: Param[];
  constructor(db: DatabaseSync, sql: string, params: Param[] = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...p: Param[]) {
    return new FakeStmt(this.db, this.sql, p);
  }
  runSync() {
    const r = this.db.prepare(this.sql).run(...(clean(this.params) as never[]));
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) }, results: [] };
  }
  async run() {
    return this.runSync();
  }
  async first<T>(): Promise<T | null> {
    const r = this.db.prepare(this.sql).get(...(clean(this.params) as never[]));
    return r ? ({ ...r } as T) : null;
  }
  async all<T>() {
    const rows = this.db.prepare(this.sql).all(...(clean(this.params) as never[]));
    return { results: rows.map((r) => ({ ...r }) as T), success: true, meta: { changes: 0 } };
  }
}

export class FakeD1 {
  raw: DatabaseSync;
  constructor() {
    this.raw = new DatabaseSync(':memory:');
    this.raw.exec('PRAGMA foreign_keys = ON');
    // Every migration in order, the same way wrangler applies them.
    const dir = new URL('../migrations/', import.meta.url);
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) this.raw.exec(readFileSync(new URL(f, dir), 'utf8'));
  }
  prepare(sql: string) {
    return new FakeStmt(this.raw, sql);
  }
  async batch(stmts: FakeStmt[]) {
    this.raw.exec('BEGIN');
    try {
      const out = stmts.map((s) => s.runSync());
      this.raw.exec('COMMIT');
      return out;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    }
  }
}

export class FakeR2 {
  store = new Map<string, ArrayBuffer>();
  async put(key: string, value: ArrayBuffer) {
    this.store.set(key, value);
  }
  async get(key: string) {
    const v = this.store.get(key);
    return v ? { body: new Response(v).body } : null;
  }
  async delete(key: string) {
    this.store.delete(key);
  }
}

export type Mock = Awaited<ReturnType<typeof startMock>>;

export async function makeEnv(mock: Mock, over: Partial<Env> = {}): Promise<Env & { DB: FakeD1 & Env['DB']; FILES: FakeR2 & Env['FILES'] }> {
  return {
    DB: new FakeD1() as never,
    FILES: new FakeR2() as never,
    PRUNE_API_KEY: 'test-prune-key',
    PRUNE_BASE_URL: mock.url,
    PRUNE_AUTH: 'bearer',
    KILL_SWITCH: '0',
    DEFAULT_BUDGET_USD: '0.25',
    PER_CALL_CAP_USD: '0.05',
    MAX_WORKSPACE_BUDGET_USD: '1.00',
    SESSION_LIMIT_PER_HOUR: '5',
    ...over,
  } as never;
}

/** Create a workspace directly (bypasses E02) and return its id and bearer token. */
export async function makeWorkspace(env: Env, opts: { limitMicro?: number; perCallMicro?: number } = {}) {
  const id = 'w_' + Math.random().toString(36).slice(2, 10);
  const token = 'tok_' + Math.random().toString(36).slice(2);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO workspaces (id, token_hash, created_at) VALUES (?, ?, ?)').bind(id, await sha256Hex(token), 1),
    env.DB.prepare('INSERT INTO budgets (workspace_id, limit_micro, per_call_cap_micro, updated_at) VALUES (?, ?, ?, 1)').bind(id, opts.limitMicro ?? 250_000, opts.perCallMicro ?? 50_000),
  ]);
  return { id, token };
}

export const rowOf = async <T>(env: Env, sql: string, ...p: Param[]) => env.DB.prepare(sql).bind(...(p as never[])).first<T>();
export const rowsOf = async <T>(env: Env, sql: string, ...p: Param[]) => (await env.DB.prepare(sql).bind(...(p as never[])).all<T>()).results;
export const noSleep = async () => undefined;

export function fakeExec() {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil: (p: Promise<unknown>) => void pending.push(p.catch(() => undefined)),
    settle: async () => {
      while (pending.length) await pending.shift();
    },
  };
}
