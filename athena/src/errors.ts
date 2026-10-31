export type ErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'validation_failed'
  | 'conflict'
  | 'payload_too_large'
  | 'rate_limited'
  | 'kill_switch_on'
  | 'budget_exhausted'
  | 'document_not_ready'
  | 'shield_blocked'
  | 'provider_auth_failed'
  | 'provider_unavailable'
  | 'billing_uncertain'
  | 'receipt_missing'
  | 'internal';

export const HTTP_STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 400,
  conflict: 409,
  payload_too_large: 413,
  rate_limited: 429,
  kill_switch_on: 503,
  budget_exhausted: 402,
  document_not_ready: 409,
  shield_blocked: 422,
  provider_auth_failed: 502,
  provider_unavailable: 503,
  billing_uncertain: 502,
  receipt_missing: 502,
  internal: 500,
};

export const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  unauthorized: 'Your session has expired. Start a new workspace to continue.',
  forbidden: "You don't have access to this item.",
  not_found: 'That item was not found. It may have been deleted.',
  validation_failed: 'That request was not valid. Check the file or message and try again.',
  conflict: 'That action is not available right now. Refresh and try again.',
  payload_too_large: 'That file is too large. The limit is 25 MB and 150 pages.',
  rate_limited: 'Too many requests in a short time. Wait a moment, then try again.',
  kill_switch_on: 'Model calls are paused. Nothing was sent.',
  budget_exhausted: 'Not enough allowance for this answer.',
  document_not_ready: 'This document is still being indexed. Try again in a moment.',
  shield_blocked: "Prune's safety checks blocked this request. Try rephrasing it.",
  provider_auth_failed: 'The AI service rejected our setup (credentials, credits or model access). This is not something you can fix, and we stopped instead of retrying.',
  provider_unavailable: 'The AI service is temporarily unavailable. Your documents and chats are saved.',
  billing_uncertain:
    'The connection dropped after your question was sent, so we cannot tell if it was billed. The estimated cost was counted against your allowance.',
  receipt_missing: 'We got a reply but no receipt, so it is not shown as verified.',
  internal: 'Something went wrong on our side. Your documents are saved.',
};

export class AppError extends Error {
  code: ErrorCode;
  retryable: boolean;
  status: number;
  detail: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message?: string,
    opts: { retryable?: boolean; detail?: Record<string, unknown> } = {},
  ) {
    super(message ?? DEFAULT_MESSAGES[code]);
    this.name = 'AppError';
    this.code = code;
    this.status = HTTP_STATUS[code];
    this.retryable = opts.retryable ?? false;
    this.detail = opts.detail ?? {};
  }
}

/**
 * Prune signals spend caps and run limits as HTTP 429 (or 402) plus X-Prune-Shield-Code, so a bare 429
 * does NOT mean "try again". The table below is Prune's documented list (docs /docs/errors, checked
 * 2026-10-31); body shapes are documented only for spend_cap. Any code we do not recognise is treated
 * as "do not retry".
 */
/** A cap or quota was reached: stop and pause, never retry. */
export const BUDGET_SHIELD_CODES = new Set([
  'spend_cap', // daily spend cap, resets 00:00 UTC (cache hits do not count)
  'anomaly_spike', // spend jumped far above the key's normal rate
  'token_budget', // daily token budget for the model
  'customer_budget', // monthly budget for the X-Prune-Customer-Id
  'plan_limit', // monthly Prune plan request quota (HTTP 402)
  'free_trial_ended', // free tier ended 14 days after the first Optimize receipt (HTTP 402)
  'run_budget', // X-Prune-Run-Budget-Usd reached
  'agent_step_budget', // X-Prune-Max-Steps exceeded
]);
export const RATE_SHIELD_CODES = new Set(['rate_limit']);
/** Prune could not check policy or spend: it fails closed with a 503. Temporary, honour Retry-After. */
export const TEMPORARY_SHIELD_CODES = new Set(['shield_unavailable', 'shield_preflight_timeout', 'shield_preflight_unavailable', 'check_failed']);
/** The key's own policy refused the request: a configuration problem, not something the user can fix. */
export const POLICY_SHIELD_CODES = new Set(['ip_blocked', 'provider_blocked', 'model_blocked']);
// Everything else (loop_detected, agent_loop, prompt_injection, canary_leak, tool_policy, ...) is a safety
// stop and maps to shield_blocked with no retry. prompt_injection_signal is a 200 and is not an error.

export interface HttpVerdict {
  code: ErrorCode;
  retry: boolean;
}

/**
 * Setup problems reported by Prune or the provider as a plain 4xx with no shield code, seen on the real service:
 * 400 "Missing <provider> api key. Store one in the Prune vault", 400 "<provider> account has insufficient
 * credits or quota", 404 not_found for a model the provider account cannot use. Not fixable by the user and
 * pointless to retry, so they are configuration errors rather than "your request was not valid".
 */
const CONFIG_MESSAGE = /missing .*api key|insufficient (credits|quota)|credit balance|no credits|billing/i;

function parseBody(body: string | undefined): { code?: string; error?: string } {
  if (!body) return {};
  try {
    const j = JSON.parse(body) as { code?: unknown; error?: unknown };
    return { code: typeof j.code === 'string' ? j.code : undefined, error: typeof j.error === 'string' ? j.error : undefined };
  } catch {
    return {};
  }
}

export function classifyHttp(status: number, shieldCode: string | null, body?: string): HttpVerdict {
  if (shieldCode) {
    const s = shieldCode.toLowerCase();
    if (BUDGET_SHIELD_CODES.has(s)) return { code: 'budget_exhausted', retry: false };
    if (RATE_SHIELD_CODES.has(s)) return { code: 'rate_limited', retry: true };
    if (TEMPORARY_SHIELD_CODES.has(s)) return { code: 'provider_unavailable', retry: true };
    if (POLICY_SHIELD_CODES.has(s)) return { code: 'provider_auth_failed', retry: false };
    if (s === 'run_budget_missing_run_id') return { code: 'validation_failed', retry: false };
    return { code: 'shield_blocked', retry: false };
  }
  if (status === 400 || status === 404) {
    const b = parseBody(body);
    if (CONFIG_MESSAGE.test(b.error ?? '') || (status === 404 && b.code === 'not_found')) return { code: 'provider_auth_failed', retry: false };
  }
  if (status === 429) return { code: 'rate_limited', retry: true };
  if (status === 401 || status === 403) return { code: 'provider_auth_failed', retry: false };
  if (status === 402) return { code: 'budget_exhausted', retry: false };
  if (status === 408 || status >= 500) return { code: 'provider_unavailable', retry: true };
  if (status >= 400) return { code: 'validation_failed', retry: false };
  return { code: 'internal', retry: false };
}

/**
 * 'not_sent': failed before any bytes could have reached Prune (safe to retry).
 * 'uncertain': timeout or reset after the request may have been sent (billing unknown).
 */
export function classifyNetworkError(e: unknown): 'not_sent' | 'uncertain' {
  const err = e as { cause?: { code?: string }; code?: string } | undefined;
  const code = err?.cause?.code ?? err?.code;
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'not_sent';
  return 'uncertain';
}
