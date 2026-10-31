import type { Env } from './env.ts';
import { numEnv, nowSec } from './util.ts';
import { releaseStatement, settleStatement } from './budget.ts';

/**
 * Cron (every 5 minutes). Covers a Worker that died between reserve and commit:
 *  - 'reserved' older than 2 minutes: never sent, release the reservation, no charge.
 *  - 'sent' older than 5 minutes: outcome unknown, mark unknown_cost and charge the estimate as a precaution.
 * Also expires old rate-limit rows and removes workspaces past the retention period.
 */
export async function runJanitor(env: Env): Promise<{ released: number; unknown: number; deletedWorkspaces: number }> {
  const db = env.DB;
  const t = nowSec();

  const stuckReserved = (
    await db.prepare("SELECT id, workspace_id, est_micro FROM llm_calls WHERE status = 'reserved' AND created_at < ?").bind(t - 120).all<{ id: string; workspace_id: string; est_micro: number }>()
  ).results;
  for (const r of stuckReserved) {
    await db.batch([
      db.prepare("UPDATE llm_calls SET status = 'failed', error_class = 'janitor_released', finished_at = ? WHERE id = ? AND status = 'reserved'").bind(t, r.id),
      releaseStatement(db, r.workspace_id, r.est_micro),
    ]);
  }

  const stuckSent = (
    await db.prepare("SELECT id, workspace_id, est_micro FROM llm_calls WHERE status = 'sent' AND created_at < ?").bind(t - 300).all<{ id: string; workspace_id: string; est_micro: number }>()
  ).results;
  for (const r of stuckSent) {
    await db.batch([
      db.prepare("UPDATE llm_calls SET status = 'unknown_cost', error_class = 'billing_uncertain', finished_at = ? WHERE id = ? AND status = 'sent'").bind(t, r.id),
      settleStatement(db, r.workspace_id, r.est_micro, r.est_micro),
    ]);
  }

  await db.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(t - 7200).run();

  const days = numEnv(env.RETENTION_DAYS, 30);
  const old = await db.prepare('DELETE FROM workspaces WHERE created_at < ?').bind(t - days * 86400).run();

  return { released: stuckReserved.length, unknown: stuckSent.length, deletedWorkspaces: old.meta.changes ?? 0 };
}
