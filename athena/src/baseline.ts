// The "naive baseline" shown next to the real cost. It is Athena's own calculation, NOT part of Prune's
// signed receipt: the signature proves what Prune charged, not what a naive system would have paid.
import type { D1Database } from '@cloudflare/workers-types';
import type { Env } from './env.ts';
import { loadTiers } from './tiers.ts';
import type { Tier } from './tiers.ts';
import { estTokens, parseJsonSafe } from './util.ts';

export const NAIVE_FORMULA_VERSION = 'v1';

/** Shown on click ("How is this calculated?") and stored with the number. */
export const NAIVE_FORMULA_TEXT =
  'naive_input_tokens = full_document_tokens + full_chat_history_tokens + question_tokens + system_tokens\n' +
  'naive_cost = naive_input_tokens * input_price + actual_output_tokens * output_price\n' +
  'Same model that answered. Token counts are estimated (about 4 characters per token) unless the signed receipt carries them.';

export const BASELINE_TOOLTIP = 'The signature proves what Prune charged. The naive baseline is Athena’s own calculation.';
export const SAVINGS_NOTE = 'Prune’s own savings are separate from Athena’s retrieval savings. They are not added together.';

export interface NaiveInputs {
  full_document_tokens: number;
  full_chat_history_tokens: number;
  question_tokens: number;
  system_tokens: number;
  output_tokens: number;
  model: string;
  in_per_m: number;
  out_per_m: number;
}

export const naiveInputTokens = (i: NaiveInputs): number =>
  i.full_document_tokens + i.full_chat_history_tokens + i.question_tokens + i.system_tokens;

/** micro-USD: tokens times USD-per-million equals micro-USD. */
export const naiveCostMicro = (i: NaiveInputs): number => Math.ceil(naiveInputTokens(i) * i.in_per_m + i.output_tokens * i.out_per_m);

/**
 * Receipt field names are unconfirmed until Phase 0 runs against the real service. Only when the signed fields
 * carry BOTH a model and token counts can the baseline be recomputed from signed data.
 */
export function baselineInputsSigned(receiptFields: Record<string, unknown> | null): boolean {
  if (!receiptFields) return false;
  const hasModel = ['model', 'model_used', 'routed_model'].some((k) => typeof receiptFields[k] === 'string');
  const num = (k: string) => typeof receiptFields[k] === 'number';
  const hasIn = num('prompt_tokens') || num('input_tokens');
  const hasOut = num('completion_tokens') || num('output_tokens');
  return hasModel && hasIn && hasOut;
}

export interface BaselineParams {
  ws: string;
  chatId: string;
  /** The user and assistant message ids of this turn (excluded from "history"). */
  turnMessageIds: string[];
  question: string;
  systemText: string;
  /** The call whose row receives the numbers: the call that produced the shown answer. */
  callId: string;
  tier: Tier;
  outputTokens: number;
  model: string | null;
}

/**
 * Store the baseline on the answering call's row. Never throws: a failure here must not touch the answer.
 */
export async function recordBaseline(env: Env, p: BaselineParams): Promise<void> {
  try {
    const db: D1Database = env.DB;
    const doc = await db
      .prepare(
        `SELECT COALESCE(SUM(LENGTH(p.text)), 0) AS chars FROM pages p
         JOIN chat_documents cd ON cd.document_id = p.document_id WHERE cd.chat_id = ?`,
      )
      .bind(p.chatId)
      .first<{ chars: number }>();
    const ids = ['', ...p.turnMessageIds];
    const hist = await db
      .prepare(
        `SELECT COALESCE(SUM(LENGTH(content)), 0) AS chars FROM messages
         WHERE chat_id = ? AND status = 'done' AND role IN ('user','assistant') AND id NOT IN (${ids.map(() => '?').join(',')})`,
      )
      .bind(p.chatId, ...ids)
      .first<{ chars: number }>();
    const cfg = loadTiers(env)[p.tier];
    const inputs: NaiveInputs = {
      full_document_tokens: Math.ceil((doc?.chars ?? 0) / 4),
      full_chat_history_tokens: Math.ceil((hist?.chars ?? 0) / 4),
      question_tokens: estTokens(p.question),
      system_tokens: estTokens(p.systemText),
      output_tokens: p.outputTokens,
      model: p.model ?? cfg.model,
      in_per_m: cfg.inPerM,
      out_per_m: cfg.outPerM,
    };
    await db
      .prepare('UPDATE llm_calls SET naive_input_tokens = ?, naive_cost_micro = ?, naive_formula_version = ?, naive_inputs_json = ? WHERE id = ?')
      .bind(naiveInputTokens(inputs), naiveCostMicro(inputs), NAIVE_FORMULA_VERSION, JSON.stringify(inputs), p.callId)
      .run();
  } catch {
    /* the baseline is informational */
  }
}

export const readInputs = (json: string | null): NaiveInputs | null => parseJsonSafe<NaiveInputs | null>(json, null);
