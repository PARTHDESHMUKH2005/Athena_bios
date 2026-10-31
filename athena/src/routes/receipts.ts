// E23 (read a receipt) and E24 (verify it). Prune-format details stay in receipts.ts; this file only shapes the API.
import { z } from 'zod';
import { BASELINE_TOOLTIP, NAIVE_FORMULA_TEXT, SAVINGS_NOTE, baselineInputsSigned, readInputs } from '../baseline.ts';
import { costCheck } from '../costcheck.ts';
import { AppError } from '../errors.ts';
import type { LlmDeps } from '../llm.ts';
import { VERIFY_REASON_TEXT, verifyReceiptDetailed } from '../receipts.ts';
import type { VerifyReason } from '../receipts.ts';
import { microToUsd, nowSec, parseJsonSafe } from '../util.ts';
import { logEvent } from './shared.ts';
import type { AppT } from './shared.ts';

/** The three cost labels, in this order, exactly as the UI shows them. */
export const COST_LABELS = {
  actual: 'Actual cost',
  without_prune: 'Without Prune’s savings',
  naive_baseline: 'Naive baseline (Athena estimate)',
} as const;

/**
 * `receipt_override` / `receipt_override_raw` let the receipt drawer check an edited copy (the tamper demo).
 * The override is only ever verified: nothing about it is stored. `receipt_override_raw` carries the exact text,
 * which matters because re-serializing a parsed object can change number spellings such as 5e-05.
 */
export const VerifyBody = z.object({
  receipt_override: z.record(z.string(), z.unknown()).optional(),
  receipt_override_raw: z.string().max(200_000).optional(),
});

const reasonText = (r: string | null) => (r && r in VERIFY_REASON_TEXT ? VERIFY_REASON_TEXT[r as VerifyReason] : null);

interface CallRow {
  id: string;
  purpose: string;
  tier: string;
  model_used: string | null;
  status: string;
  attempt: number;
  est_micro: number;
  cost_micro: number | null;
  cost_without_prune_micro: number | null;
  cache_hit: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  receipt_json: string | null;
  verify_status: string;
  verify_reason: string | null;
  verified_at: number | null;
  naive_input_tokens: number | null;
  naive_cost_micro: number | null;
  naive_formula_version: string | null;
  naive_inputs_json: string | null;
  created_at: number;
  finished_at: number | null;
}

export function registerReceiptRoutes(app: AppT, deps: { llm?: LlmDeps }): void {
  app.get('/api/receipts/:call_id', async (c) => {
    // E23
    const row = await c.env.DB.prepare(
      `SELECT id, purpose, tier, model_used, status, attempt, est_micro, cost_micro, cost_without_prune_micro, cache_hit, prompt_tokens,
         completion_tokens, receipt_json, verify_status, verify_reason, verified_at, naive_input_tokens, naive_cost_micro,
         naive_formula_version, naive_inputs_json, created_at, finished_at
       FROM llm_calls WHERE id = ? AND workspace_id = ?`,
    )
      .bind(c.req.param('call_id'), c.get('ws'))
      .first<CallRow>();
    if (!row) throw new AppError('not_found');
    const usd = (m: number | null) => (m == null ? null : microToUsd(m));
    const fields = parseJsonSafe<Record<string, unknown> | null>(row.receipt_json, null);
    const signed = baselineInputsSigned(fields);
    const inputs = readInputs(row.naive_inputs_json);
    return c.json({
      call: {
        id: row.id,
        purpose: row.purpose,
        tier: row.tier,
        model_used: row.model_used,
        status: row.status,
        attempt: row.attempt,
        /** What a retry may cost at most (the reservation). Shown when billing is uncertain. */
        est_usd: microToUsd(row.est_micro),
        cost_usd: usd(row.cost_micro),
        cost_without_prune_usd: usd(row.cost_without_prune_micro),
        cache_hit: row.cache_hit === 1,
        prompt_tokens: row.prompt_tokens,
        completion_tokens: row.completion_tokens,
        created_at: row.created_at,
        finished_at: row.finished_at,
      },
      receipt_json: row.receipt_json,
      verify_status: row.verify_status,
      verify: { status: row.verify_status, reason: row.verify_reason, reason_text: reasonText(row.verify_reason), verified_at: row.verified_at },
      cost: {
        labels: COST_LABELS,
        actual_usd: usd(row.cost_micro),
        without_prune_usd: usd(row.cost_without_prune_micro),
        naive_baseline_usd: usd(row.naive_cost_micro),
      },
      // How the cost was calculated, recomputed now from the stored token counts and the price table.
      cost_check: costCheck(c.env, row),
      baseline: inputs
        ? {
            formula_version: row.naive_formula_version,
            formula: NAIVE_FORMULA_TEXT,
            inputs,
            naive_input_tokens: row.naive_input_tokens,
            inputs_signed: signed,
            inputs_note: signed
              ? 'Baseline recomputed from signed token counts: yes'
              : 'Baseline uses Athena’s stored token counts, which are not signed',
            tooltip: BASELINE_TOOLTIP,
            savings_note: SAVINGS_NOTE,
          }
        : null,
    });
  });

  app.post('/api/receipts/:call_id/verify', async (c) => {
    // E24
    let bodyRaw: unknown = {};
    try {
      bodyRaw = await c.req.json();
    } catch {
      bodyRaw = {}; // an empty body is the ordinary "verify the stored receipt" request
    }
    const parsed = VerifyBody.safeParse(bodyRaw ?? {});
    if (!parsed.success) throw new AppError('validation_failed', 'receipt_override must be a JSON object.');
    const { receipt_override, receipt_override_raw } = parsed.data;
    const override = receipt_override_raw ?? (receipt_override ? JSON.stringify(receipt_override) : null);

    const row = await c.env.DB.prepare(
      `SELECT id, receipt_json, cost_micro, tier, model_used, prompt_tokens, completion_tokens, cache_hit, verify_reason
       FROM llm_calls WHERE id = ? AND workspace_id = ?`,
    )
      .bind(c.req.param('call_id'), c.get('ws'))
      .first<{ id: string; receipt_json: string | null; cost_micro: number | null; tier: string; model_used: string | null; prompt_tokens: number | null; completion_tokens: number | null; cache_hit: number | null; verify_reason: string | null }>();
    if (!row) throw new AppError('not_found');
    const fetchFn = deps.llm?.fetch ?? fetch;

    if (override !== null) {
      // Verify the edited copy against the cost we recorded. Nothing is written about the call.
      const v = await verifyReceiptDetailed(c.env, override, fetchFn, { expectedCostMicro: row.cost_micro, remember: false });
      return c.json({ verify_status: v.status, reason: v.reason, reason_text: reasonText(v.reason), verified_at: null, override: true, saved: false });
    }

    if (!row.receipt_json) {
      // Nothing is signed (the Groq path). Verify what can be verified: redo the cost arithmetic and compare.
      const check = costCheck(c.env, row);
      await logEvent(c.env, c.get('ws'), 'cost_rechecked', row.id, { matches: check.matches });
      return c.json({
        verify_status: 'missing',
        reason: 'no_receipt',
        reason_text: reasonText('no_receipt'),
        verified_at: nowSec(),
        override: false,
        saved: false,
        cost_check: check,
      });
    }
    const v = await verifyReceiptDetailed(c.env, row.receipt_json, fetchFn, { expectedCostMicro: row.cost_micro });
    const at = nowSec();
    await c.env.DB.prepare('UPDATE llm_calls SET verify_status = ?, verify_reason = ?, verified_at = ? WHERE id = ?').bind(v.status, v.reason, at, row.id).run();
    await logEvent(c.env, c.get('ws'), 'receipt_verified', row.id, { status: v.status, reason: v.reason });
    return c.json({ verify_status: v.status, reason: v.reason, reason_text: reasonText(v.reason), verified_at: at, override: false, saved: true, cost_check: costCheck(c.env, { ...row, verify_reason: v.reason }) });
  });
}
