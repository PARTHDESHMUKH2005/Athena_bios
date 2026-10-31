// "How was this cost calculated?" for one model call, recomputed on demand from what we stored.
//
// Two cases:
//  - The call has a signed receipt (Prune): the cost IS the signed number; the token math is shown as a reference only.
//  - The call has no receipt (Groq signs nothing): the cost was calculated by us as tokens x price. We redo that
//    arithmetic from the stored token counts and the tier price table, and say whether it matches what we charged.
//    This proves the arithmetic and the inputs we used; it cannot prove what the provider billed.
import type { Env } from './env.ts';
import { loadGroqTiers, loadTiers } from './tiers.ts';
import type { Tier } from './tiers.ts';
import { microToUsd } from './util.ts';

export interface CostCheckRow {
  tier: string;
  model_used: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost_micro: number | null;
  cache_hit: number | null;
  receipt_json: string | null;
  verify_reason: string | null;
}

export interface CostCheck {
  /** 'receipt': cost is the signed number. 'token_math': cost was computed by Athena from tokens x price. */
  basis: 'receipt' | 'token_math';
  provider: 'prune' | 'groq';
  model: string | null;
  /** The model the current price table holds for this tier (may differ if the table changed after the call). */
  price_model: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  in_per_m_usd: number;
  out_per_m_usd: number;
  input_cost_usd: number | null;
  output_cost_usd: number | null;
  /** Rounded up to the next millionth of a dollar, the same rule the model caller uses. */
  computed_usd: number | null;
  recorded_usd: number | null;
  /** token_math only: does the recomputation equal what was charged? null when it cannot be computed. */
  matches: boolean | null;
  steps: string[];
  note: string;
}

const fmt = (micro: number) => `$${(micro / 1e6).toFixed(6)}`;

export function costCheck(env: Env, row: CostCheckRow): CostCheck {
  const groq = !row.receipt_json && row.verify_reason === 'no_receipt';
  const tier = (['economy', 'standard', 'strong'].includes(row.tier) ? row.tier : 'standard') as Tier;
  const cfg = (groq ? loadGroqTiers(env) : loadTiers(env))[tier];
  const pt = row.prompt_tokens;
  const ct = row.completion_tokens;
  const known = pt != null && ct != null;
  const inMicro = known ? pt * cfg.inPerM : null;
  const outMicro = known ? ct * cfg.outPerM : null;
  const computed = known ? Math.ceil(inMicro! + outMicro!) : null;
  const recorded = row.cost_micro;

  const steps: string[] = [];
  if (known) {
    steps.push(`Input: ${pt.toLocaleString('en-US')} tokens × $${cfg.inPerM} per 1M = ${fmt(inMicro!)}`);
    steps.push(`Output: ${ct.toLocaleString('en-US')} tokens × $${cfg.outPerM} per 1M = ${fmt(outMicro!)}`);
    steps.push(`Total, rounded up to the next $0.000001: ${fmt(computed!)}`);
  } else {
    steps.push('Token counts were not recorded for this call, so the cost cannot be recomputed.');
  }
  if (recorded != null) steps.push(`Recorded cost: ${fmt(recorded)}`);

  let matches: boolean | null = null;
  let note: string;
  if (groq) {
    matches = computed != null && recorded != null ? computed === recorded : null;
    note =
      'Groq signs no receipts, so Athena calculated this cost from the token counts Groq reported and the price table above. ' +
      'This check proves the arithmetic and inputs; it cannot prove what Groq billed. The prices are configured, not confirmed by Groq.';
    if (row.model_used && row.model_used !== cfg.model) note += ` The price table now lists ${cfg.model} for this tier, not ${row.model_used}, so a mismatch may mean the table changed.`;
  } else if (row.receipt_json) {
    note = row.cache_hit === 1
      ? 'This answer was served from cache. The cost is the number Prune signed in the receipt; the token math is shown for reference.'
      : 'The cost is the number Prune signed in the receipt, so the receipt check above is the proof. The token math is our own estimate, shown for reference; Prune may price differently.';
  } else {
    note = 'There is no receipt for this call, so its cost is Athena’s estimate.';
  }

  return {
    basis: groq ? 'token_math' : 'receipt',
    provider: groq ? 'groq' : 'prune',
    model: row.model_used,
    price_model: cfg.model,
    prompt_tokens: pt,
    completion_tokens: ct,
    in_per_m_usd: cfg.inPerM,
    out_per_m_usd: cfg.outPerM,
    input_cost_usd: inMicro == null ? null : microToUsd(Math.round(inMicro)),
    output_cost_usd: outMicro == null ? null : microToUsd(Math.round(outMicro)),
    computed_usd: computed == null ? null : microToUsd(computed),
    recorded_usd: recorded == null ? null : microToUsd(recorded),
    matches,
    steps,
    note,
  };
}
