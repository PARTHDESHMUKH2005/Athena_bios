import type { Env } from './env.ts';
import { parseJsonSafe } from './util.ts';

export type Tier = 'economy' | 'standard' | 'strong';

export interface TierConfig {
  model: string;
  /** USD per 1M input tokens, which equals micro-USD per input token. */
  inPerM: number;
  /** USD per 1M output tokens. */
  outPerM: number;
}
export type TierTable = Record<Tier, TierConfig>;

/**
 * PLACEHOLDERS. Models are addressed by capability tier in code; the concrete model ids and prices
 * come from MODEL_TIERS and must be set after checking which models are enabled in the Prune vault
 * (Phase 0 item 11). Reconcile estimates against real receipts.
 */
export const DEFAULT_TIERS: TierTable = {
  economy: { model: 'gpt-4o-mini', inPerM: 0.15, outPerM: 0.6 },
  standard: { model: 'gpt-4.1', inPerM: 2, outPerM: 8 },
  strong: { model: 'gpt-4o', inPerM: 2.5, outPerM: 10 },
};

export function loadTiers(env: Pick<Env, 'MODEL_TIERS'>): TierTable {
  const custom = parseJsonSafe<Partial<TierTable>>(env.MODEL_TIERS, {});
  return {
    economy: { ...DEFAULT_TIERS.economy, ...custom.economy },
    standard: { ...DEFAULT_TIERS.standard, ...custom.standard },
    strong: { ...DEFAULT_TIERS.strong, ...custom.strong },
  };
}

const ORDER: Tier[] = ['economy', 'standard', 'strong'];
export const nextTier = (t: Tier): Tier => ORDER[Math.min(ORDER.indexOf(t) + 1, 2)]!;
export const lowerTier = (t: Tier, steps = 1): Tier => ORDER[Math.max(ORDER.indexOf(t) - steps, 0)]!;

export function estimateMicro(cfg: TierConfig, promptTokens: number, maxOutputTokens: number): number {
  return Math.ceil(promptTokens * cfg.inPerM + maxOutputTokens * cfg.outPerM);
}

export type Purpose = 'answer' | 'summarize' | 'extract' | 'ocr' | 'memory_summary' | 'repair';

const STRONG_WORDS = /\b(compare|comparison|versus|vs\.?|calculate|compute|reconcile|discrepanc\w*)\b/i;

/** Rules only, no model call. */
export function pickTier(input: {
  purpose: Purpose;
  question: string;
  contextTokens: number;
  documentCount: number;
}): { tier: Tier; reason: string } {
  const { purpose, question, contextTokens, documentCount } = input;
  if (purpose === 'extract') return { tier: 'standard', reason: 'structured extraction' };
  if (purpose === 'summarize') return { tier: 'standard', reason: 'summary' };
  if (purpose === 'memory_summary') return { tier: 'economy', reason: 'memory summary' };
  const strong =
    STRONG_WORDS.test(question) || (documentCount > 1 && /\b(difference|differ)\b/i.test(question)) || contextTokens > 12000;
  if (strong) return { tier: 'strong', reason: 'comparison, calculation or very long context' };
  if (question.length <= 140 && contextTokens < 3000) return { tier: 'economy', reason: 'short lookup' };
  return { tier: 'standard', reason: 'general question' };
}
