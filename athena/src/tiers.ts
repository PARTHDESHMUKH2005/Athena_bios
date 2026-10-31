import type { Env } from './env.ts';
import { parseJsonSafe } from './util.ts';

export type Tier = 'economy' | 'standard' | 'strong';

export interface TierConfig {
  model: string;
  /** USD per 1M input tokens, which equals micro-USD per input token. */
  inPerM: number;
  /** USD per 1M output tokens. */
  outPerM: number;
  /** Floor for max_tokens, for models that spend output tokens on hidden thinking (e.g. Gemini 3.x). Default 0. */
  minOutputTokens?: number;
}
export type TierTable = Record<Tier, TierConfig>;

/**
 * Model ids are the Gemini models that answered a real call through Prune on 2026-10-31 (PHASE0-FINDINGS.md);
 * only a Gemini key was working in the vaults then. PRICES ARE UNVERIFIED PLACEHOLDERS: Prune's /v1/models
 * returns no prices, so set the real ones via MODEL_TIERS and reconcile against receipts
 * (cost_with_prune_usd). Gemini 3.x spends output tokens on hidden thinking, hence the floor.
 */
export const DEFAULT_TIERS: TierTable = {
  economy: { model: 'gemini/gemini-3.1-flash-lite', inPerM: 0.1, outPerM: 0.4, minOutputTokens: 1024 },
  standard: { model: 'gemini/gemini-3.5-flash', inPerM: 0.3, outPerM: 2.5, minOutputTokens: 1024 },
  strong: { model: 'gemini/gemini-3.1-pro-preview', inPerM: 1.25, outPerM: 10, minOutputTokens: 2048 },
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
