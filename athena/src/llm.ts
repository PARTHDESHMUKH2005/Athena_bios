// THE MODEL CALLER. Nothing but this file and its sibling src/llm-groq.ts may fetch a model host
// (scripts/check-single-caller.mjs enforces this in CI). By default every call goes to Prune's one base URL with
// the Prune key; provider keys live in the Prune vault. LLM_PROVIDER=groq hands the call to llm-groq.ts.
import type { Env, Fetcher } from './env.ts';
import { AppError, classifyHttp, classifyNetworkError } from './errors.ts';
import type { ErrorCode } from './errors.ts';
import { assertNotKilled } from './killswitch.ts';
import { getBudget, releaseStatement, remainingMicro, reserve, settleStatement } from './budget.ts';
import { parseCompletion } from './completion.ts';
import { callGroq } from './llm-groq.ts';
import { extractReceipt, verifyReceiptDetailed } from './receipts.ts';
import type { VerifyStatus } from './receipts.ts';
import { estimateMicro, loadTiers } from './tiers.ts';
import type { Purpose, Tier } from './tiers.ts';
import { newId, nowSec, sha256Hex } from './util.ts';

export type Workload = 'rag' | 'structured_extraction' | 'batch' | 'support_chat';
export type CacheMode = 'off' | 'exact' | 'normalized' | 'semantic';
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CallRequest {
  workspaceId: string;
  chatId?: string;
  documentId?: string;
  /** Message id (or document id): sent as X-Prune-Run-Id so Prune enforces the run budget server side. */
  runId: string;
  purpose: Purpose;
  workload: Workload;
  cache: CacheMode;
  tier: Tier;
  messages: ChatMessage[];
  /** Estimated prompt tokens, used for the reservation. */
  promptTokens: number;
  maxOutputTokens: number;
  /** Per-call cap sent as X-Prune-Run-Budget-Usd. */
  runBudgetMicro: number;
  /** Stable per logical call. A second call with the same key is refused. */
  idempotencyKey: string;
  json?: boolean;
}

export interface CallResult {
  callId: string;
  text: string;
  tier: Tier;
  modelUsed: string | null;
  costMicro: number;
  costSource: 'receipt' | 'estimate';
  cacheHit: boolean;
  promptTokens: number;
  completionTokens: number;
  receiptRaw: string;
  verifyStatus: VerifyStatus;
  attempts: number;
  /** X-Prune-Shield-Code on a 200 response (e.g. prompt_injection_signal), else null. */
  shieldSignal: string | null;
  /** The model stopped at the output limit: the answer may be cut off, or empty if hidden thinking used it all. */
  truncated: boolean;
  /** Prune's default pipeline shortened our max_tokens for this call (an adaptive cap; there is no per-request switch). */
  outputCapApplied: boolean;
}

export interface LlmDeps {
  fetch?: Fetcher;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const MAX_RETRIES = 2;
const DEADLINE_MS = 45_000;
// Prune counts every HTTP request as a step, including retries and requests that fail at the provider (seen on
// the real service: 'Agent step budget exceeded (2/1)'). Three attempts for the answer plus three for an
// escalation is the most a run can legitimately need.
const MAX_STEPS_PER_RUN = (MAX_RETRIES + 1) * 2;
// Prune stops a run that repeats the same step three times (agent_loop, seen on the real service with three identical
// retries). A retry therefore goes out under its own run id suffix; our local budget gate still bounds total spend.
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function buildHeaders(env: Env, req: CallRequest, idem: string): Record<string, string> {
  const h: Record<string, string> = {
    'content-type': 'application/json',
    'x-prune-workload': req.workload,
    'x-prune-cache': req.cache,
    'x-prune-run-id': req.runId,
    'x-prune-run-budget-usd': (req.runBudgetMicro / 1e6).toFixed(6),
    'x-prune-max-steps': String(MAX_STEPS_PER_RUN),
    'x-prune-customer-id': req.workspaceId,
    'x-prune-feature-id': req.purpose,
    'idempotency-key': idem,
  };
  if (env.PRUNE_AUTH === 'x-prune-key') h['x-prune-key'] = env.PRUNE_API_KEY;
  else h['authorization'] = `Bearer ${env.PRUNE_API_KEY}`;
  return h;
}

export async function callModel(env: Env, req: CallRequest, deps: LlmDeps = {}): Promise<CallResult> {
  // The parallel workflow: same contract, a different provider. Selected per deployment, never per request.
  if (env.LLM_PROVIDER === 'groq') return callGroq(env, req, deps);
  const db = env.DB;
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;

  await assertNotKilled(env);
  if (!env.PRUNE_API_KEY) throw new AppError('provider_auth_failed', 'PRUNE_API_KEY is not set.');

  const dup = await db.prepare('SELECT id FROM llm_calls WHERE idempotency_key = ?').bind(req.idempotencyKey).first<{ id: string }>();
  if (dup) throw new AppError('conflict', 'This call was already made.', { detail: { callId: dup.id } });

  const cfg = loadTiers(env)[req.tier];
  const est = estimateMicro(cfg, req.promptTokens, req.maxOutputTokens);

  // 1. Reserve (atomic). If it does not fit, nothing is sent.
  if (!(await reserve(db, req.workspaceId, est))) {
    const b = await getBudget(db, req.workspaceId);
    throw new AppError('budget_exhausted', 'Not enough allowance for this call.', {
      detail: { local: true, estMicro: est, remainingMicro: b ? remainingMicro(b) : 0, perCallCapMicro: b?.per_call_cap_micro ?? 0 },
    });
  }

  const callId = newId('k');
  try {
    await db
      .prepare(
        `INSERT INTO llm_calls (id, workspace_id, chat_id, document_id, purpose, workload, tier, model_requested,
           status, attempt, est_micro, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved', 1, ?, ?, ?)`,
      )
      .bind(callId, req.workspaceId, req.chatId ?? null, req.documentId ?? null, req.purpose, req.workload, req.tier, cfg.model, est, req.idempotencyKey, nowSec())
      .run();
  } catch {
    await db.batch([releaseStatement(db, req.workspaceId, est)]);
    throw new AppError('conflict', 'This call was already made.');
  }

  const finish = async (status: string, charge: number, errorClass: string | null, attempt: number, detail?: string) => {
    await db.batch([
      db
        .prepare('UPDATE llm_calls SET status = ?, error_class = ?, error_detail = ?, attempt = ?, finished_at = ? WHERE id = ?')
        .bind(status, errorClass, detail ?? null, attempt, nowSec(), callId),
      settleStatement(db, req.workspaceId, est, charge),
    ]);
  };

  const body = JSON.stringify({
    model: cfg.model,
    messages: req.messages,
    max_tokens: req.maxOutputTokens,
    temperature: 0,
    ...(req.json ? { response_format: { type: 'json_object' } } : {}),
  });
  // PAL-style idempotency key: run, step and attempt identity plus a hash of the body (one-way, no secrets).
  const idem = await sha256Hex(`${req.idempotencyKey}|${body}`);
  const headers = buildHeaders(env, req, idem);
  const url = `${env.PRUNE_BASE_URL.replace(/\/$/, '')}/chat/completions`;

  await db.prepare("UPDATE llm_calls SET status = 'sent' WHERE id = ?").bind(callId).run();

  const started = now();
  let lastVerdict: { code: ErrorCode; shield: string | null; detail: string } = {
    code: 'provider_unavailable',
    shield: null,
    detail: 'no attempt completed',
  };
  let attempt = 0;

  for (attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    if (attempt > 1) {
      await db.prepare('UPDATE llm_calls SET attempt = ? WHERE id = ?').bind(attempt, callId).run();
    }
    const remaining = DEADLINE_MS - (now() - started);
    if (remaining <= 0) break;

    let res: Response;
    let text: string;
    try {
      res = await doFetch(url, { method: 'POST', headers: attempt === 1 ? headers : { ...headers, 'x-prune-run-id': `${req.runId}.a${attempt}` }, body, signal: AbortSignal.timeout(Math.min(remaining, 40_000)) });
      text = await res.text();
    } catch (e) {
      if (classifyNetworkError(e) === 'not_sent') {
        lastVerdict = { code: 'provider_unavailable', shield: null, detail: 'connection failed before sending' };
        if (attempt <= MAX_RETRIES) {
          await sleep(backoff(attempt, null));
          continue;
        }
        break;
      }
      // The request may have reached Prune: never retry blindly, count the estimate as a precaution.
      await finish('unknown_cost', est, 'billing_uncertain', attempt, 'no response after the request was sent');
      throw new AppError('billing_uncertain', undefined, { detail: { callId, estMicro: est } });
    }

    if (!res.ok) {
      const shield = res.headers.get('x-prune-shield-code');
      const verdict = classifyHttp(res.status, shield, text);
      lastVerdict = { code: verdict.code, shield, detail: `HTTP ${res.status}${shield ? ` [${shield}]` : ''}` };
      if (verdict.retry && attempt <= MAX_RETRIES) {
        await sleep(backoff(attempt, res.headers.get('retry-after')));
        continue;
      }
      break;
    }

    // 200: need a readable, signed receipt or we do not present this as a success.
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      await finish('failed', est, 'receipt_missing', attempt, 'response was not JSON');
      throw new AppError('receipt_missing', undefined, { detail: { callId, estMicro: est } });
    }
    const receipt = extractReceipt(text);
    if (!receipt) {
      await finish('failed', est, 'receipt_missing', attempt, 'no signed receipt in response');
      throw new AppError('receipt_missing', undefined, { detail: { callId, estMicro: est } });
    }

    const parsed = parseCompletion(data);
    const promptTokens = parsed.promptTokens ?? req.promptTokens;
    // The receipt's completion_tokens is what was billed (it includes Gemini's hidden thinking tokens).
    const completionTokens = receipt.completionTokens ?? parsed.completionTokens ?? 0;
    const cacheHit = receipt.cacheHit ?? res.headers.get('x-prune-cache-hit') === 'true';
    let costMicro = receipt.costMicro;
    let costSource: 'receipt' | 'estimate' = 'receipt';
    if (costMicro === null) {
      costSource = 'estimate'; // receipt field names are unconfirmed (Phase 0); the real value always wins
      costMicro = cacheHit ? 0 : Math.ceil(promptTokens * cfg.inPerM + completionTokens * cfg.outPerM);
    }
    let verifyStatus: VerifyStatus = 'unverified';
    let verifyReason: string | null = null;
    try {
      const v = await verifyReceiptDetailed(env, receipt.raw, doFetch, { expectedCostMicro: costMicro });
      verifyStatus = v.status;
      verifyReason = v.reason;
    } catch {
      verifyStatus = 'unverified';
    }
    const modelUsed = res.headers.get('x-prune-routed-model') ?? receipt.model ?? parsed.model ?? null;
    const outputCapApplied = receipt.outputCapApplied === true || res.headers.get('x-prune-output-cap-applied') === 'true';
    // prompt_injection_signal is a 200: flagged input went through in detect mode. Surface it, do not fail.
    const shieldSignal = res.headers.get('x-prune-shield-code');

    await db.batch([
      db
        .prepare(
          `UPDATE llm_calls SET status = 'ok', model_used = ?, attempt = ?, cost_micro = ?, cost_without_prune_micro = ?,
             cache_hit = ?, prompt_tokens = ?, completion_tokens = ?, receipt_json = ?, verify_status = ?, finished_at = ?,
             verify_reason = ?, verified_at = ?
           WHERE id = ?`,
        )
        .bind(modelUsed, attempt, costMicro, receipt.costWithoutMicro, cacheHit ? 1 : 0, promptTokens, completionTokens, receipt.raw, verifyStatus, nowSec(), verifyReason, nowSec(), callId),
      settleStatement(db, req.workspaceId, est, costMicro),
    ]);

    return {
      callId,
      text: parsed.text,
      tier: req.tier,
      modelUsed,
      costMicro,
      costSource,
      cacheHit,
      promptTokens,
      completionTokens,
      receiptRaw: receipt.raw,
      verifyStatus,
      attempts: attempt,
      shieldSignal,
      truncated: parsed.truncated,
      outputCapApplied,
    };
  }

  // Out of attempts or time. These failures are known not to have produced a receipt: release, do not charge.
  const status = lastVerdict.code === 'budget_exhausted' ? 'budget_stopped' : lastVerdict.code === 'shield_blocked' ? 'blocked_shield' : 'failed';
  await finish(status, 0, lastVerdict.code, Math.min(attempt, MAX_RETRIES + 1), lastVerdict.detail);
  throw new AppError(lastVerdict.code, undefined, {
    retryable: lastVerdict.code === 'provider_unavailable' || lastVerdict.code === 'rate_limited',
    detail: { callId, shieldCode: lastVerdict.shield, attempts: Math.min(attempt, MAX_RETRIES + 1) },
  });
}

function backoff(attempt: number, retryAfter: string | null): number {
  const ra = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(ra) && ra >= 0) return Math.min(ra * 1000, 5000);
  return Math.min(4000, 400 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 200);
}
