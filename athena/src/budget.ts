import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { nowSec } from './util.ts';

export interface BudgetRow {
  limit_micro: number;
  spent_micro: number;
  reserved_micro: number;
  per_call_cap_micro: number;
}

export async function getBudget(db: D1Database, ws: string): Promise<BudgetRow | null> {
  return db
    .prepare('SELECT limit_micro, spent_micro, reserved_micro, per_call_cap_micro FROM budgets WHERE workspace_id = ?')
    .bind(ws)
    .first<BudgetRow>();
}

export const remainingMicro = (b: BudgetRow): number => b.limit_micro - b.spent_micro - b.reserved_micro;

/**
 * Atomic reservation. One conditional UPDATE, so two parallel requests can never both fit when
 * only one does: the loser sees changes = 0 and must not call the model.
 */
export async function reserve(db: D1Database, ws: string, estMicro: number): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE budgets SET reserved_micro = reserved_micro + ?, updated_at = ?
       WHERE workspace_id = ? AND ? <= per_call_cap_micro AND spent_micro + reserved_micro + ? <= limit_micro`,
    )
    .bind(estMicro, nowSec(), ws, estMicro, estMicro)
    .run();
  return (r.meta.changes ?? 0) === 1;
}

/** Statement that settles a reservation: release the estimate and charge the real amount. */
export function settleStatement(db: D1Database, ws: string, estMicro: number, chargeMicro: number): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE budgets SET reserved_micro = MAX(0, reserved_micro - ?), spent_micro = spent_micro + ?, updated_at = ?
       WHERE workspace_id = ?`,
    )
    .bind(estMicro, chargeMicro, nowSec(), ws);
}

/** Release a reservation without charging (the call was never sent or is known not to be billed). */
export const releaseStatement = (db: D1Database, ws: string, estMicro: number): D1PreparedStatement =>
  settleStatement(db, ws, estMicro, 0);

export async function setLimit(db: D1Database, ws: string, limitMicro: number): Promise<void> {
  await db
    .prepare('UPDATE budgets SET limit_micro = ?, updated_at = ? WHERE workspace_id = ?')
    .bind(limitMicro, nowSec(), ws)
    .run();
}
