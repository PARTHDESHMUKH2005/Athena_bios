import type { D1Database } from '@cloudflare/workers-types';
import { AppError } from './errors.ts';
import { nowSec } from './util.ts';

/**
 * Fixed-window counter in D1. `key` is a workspace id, or `ip:<hash>` for the session bucket
 * (a new visitor has no workspace yet, so the per-workspace limit alone would not stop session floods).
 */
export async function hit(db: D1Database, key: string, bucket: string, windowSec: number, limit: number): Promise<void> {
  const windowStart = Math.floor(nowSec() / windowSec) * windowSec;
  const row = await db
    .prepare(
      `INSERT INTO rate_limits(workspace_id, bucket, window_start, count) VALUES (?, ?, ?, 1)
       ON CONFLICT(workspace_id, bucket, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(key, bucket, windowStart)
    .first<{ count: number }>();
  if ((row?.count ?? 0) > limit) {
    throw new AppError('rate_limited', undefined, { retryable: true, detail: { bucket } });
  }
}
