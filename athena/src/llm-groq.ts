// THE GROQ MODEL CALLER: the second (and only other) place a model host may be called. It is selected with
// LLM_PROVIDER=groq and mirrors llm.ts step for step: reserve the estimate, write the ledger row, send with bounded
// retries, settle the real charge, release on a known failure, charge the estimate when billing is uncertain.
//
// What differs from Prune (and why the code differs):
//  - Groq signs nothing. There is no receipt, so cost is the response's token usage times the tier prices
//    (GROQ_MODEL_TIERS), `costSource` is 'estimate', and verify_status is 'missing'. Nothing here can be shown as
//    "verified"; the UI and exports must say so.
//  - Groq has no server-side run budget, step cap, idempotency key or cache. The local reservation in budget.ts is the
//    only spending guard, and a repeated idempotency key is refused locally before anything is sent.
//  - Groq's tokens-per-minute limit is small (about 8,000 on the key tested), so a 429 or 413 is expected under load.
import type { CallRequest, CallResult, LlmDeps } from './llm.ts';
import type { Env } from './env.ts';
import { AppError, classifyHttp, classifyNetworkError } from './errors.ts';
import type { ErrorCode } from './errors.ts';
import { assertNotKilled } from './killswitch.ts';
import { getBudget, releaseStatement, remainingMicro, reserve, settleStatement } from './budget.ts';
import { parseCompletion } from './completion.ts';
import { estimateMicro, loadGroqTiers } from './tiers.ts';
import { newId, nowSec } from './util.ts';

export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const MAX_RETRIES = 2;
// Longer than Prune's 45 s: a per-minute token limit can legitimately ask us to wait 10 to 20 seconds, twice.
const DEADLINE_MS = 60_000;
// Never wait longer than this for one retry; past it we stop and tell the user how long Groq asked for.
const MAX_WAIT_MS = 25_000;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Groq's per-minute token limit is a sliding window: retrying before the advised wait ends fails again, so honour it in full. */
function backoff(attempt: number, retryAfter: string | null): { ms: number; advised: boolean } {
  const ra = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(ra) && ra >= 0) return { ms: Math.ceil(ra * 1000) + 250, advised: true };
  return { ms: Math.min(4000, 400 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 200), advised: false };
}

export async function callGroq(env: Env, req: CallRequest, deps: LlmDeps = {}): Promise<CallResult> {
  const db = env.DB;
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;

  await assertNotKilled(env);
  if (!env.GROQ_API_KEY) throw new AppError('provider_auth_failed', 'GROQ_API_KEY is not set.');

  const dup = await db.prepare('SELECT id FROM llm_calls WHERE idempotency_key = ?').bind(req.idempotencyKey).first<{ id: string }>();
  if (dup) throw new AppError('conflict', 'This call was already made.', { detail: { callId: dup.id } });

  const cfg = loadGroqTiers(env)[req.tier];
  const est = estimateMicro(cfg, req.promptTokens, req.maxOutputTokens);

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
    // gpt-oss models think before answering; "low" keeps hidden reasoning tokens (which are billed) small.
    ...(/gpt-oss/i.test(cfg.model) ? { reasoning_effort: 'low' } : {}),
    ...(req.json ? { response_format: { type: 'json_object' } } : {}),
  });
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${env.GROQ_API_KEY}` };
  const url = `${(env.GROQ_BASE_URL || GROQ_BASE_URL).replace(/\/$/, '')}/chat/completions`;

  await db.prepare("UPDATE llm_calls SET status = 'sent' WHERE id = ?").bind(callId).run();

  const started = now();
  let lastVerdict: { code: ErrorCode; detail: string } = { code: 'provider_unavailable', detail: 'no attempt completed' };
  let waitSec: number | null = null; // how long Groq asked us to wait on the last rate limit
  let attempt = 0;

  for (attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    if (attempt > 1) await db.prepare('UPDATE llm_calls SET attempt = ? WHERE id = ?').bind(attempt, callId).run();
    const remaining = DEADLINE_MS - (now() - started);
    if (remaining <= 0) break;

    let res: Response;
    let text: string;
    try {
      res = await doFetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(Math.min(remaining, 40_000)) });
      text = await res.text();
    } catch (e) {
      if (classifyNetworkError(e) === 'not_sent') {
        lastVerdict = { code: 'provider_unavailable', detail: 'connection failed before sending' };
        if (attempt <= MAX_RETRIES) {
          await sleep(backoff(attempt, null).ms);
          continue;
        }
        break;
      }
      // The request may have reached Groq: never retry blindly, count the estimate as a precaution.
      await finish('unknown_cost', est, 'billing_uncertain', attempt, 'no response after the request was sent');
      throw new AppError('billing_uncertain', undefined, { detail: { callId, estMicro: est } });
    }

    if (!res.ok) {
      const verdict = classifyHttp(res.status, null, text);
      // 413 is Groq's "request too large for the tokens-per-minute limit": waiting helps, a bigger retry does not.
      const code: ErrorCode = res.status === 413 ? 'rate_limited' : verdict.code;
      lastVerdict = { code, detail: `HTTP ${res.status}` };
      const ra = res.headers.get('retry-after');
      waitSec = code === 'rate_limited' && ra && Number.isFinite(Number(ra)) ? Number(ra) : null;
      if (verdict.retry && res.status !== 413 && attempt <= MAX_RETRIES) {
        const wait = backoff(attempt, ra);
        // Waiting would run past the deadline or the per-retry cap: stop now and report the advised wait instead.
        if (wait.ms > MAX_WAIT_MS || wait.ms >= DEADLINE_MS - (now() - started)) break;
        await sleep(wait.ms);
        continue;
      }
      break;
    }

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      await finish('failed', est, 'internal', attempt, 'response was not JSON');
      throw new AppError('internal', 'The model service sent a response we could not read.', { detail: { callId, estMicro: est } });
    }

    const parsed = parseCompletion(data);
    const promptTokens = parsed.promptTokens ?? req.promptTokens;
    // Groq's completion_tokens already includes hidden reasoning tokens, which are billed.
    const completionTokens = parsed.completionTokens ?? 0;
    const costMicro = Math.ceil(promptTokens * cfg.inPerM + completionTokens * cfg.outPerM);
    const modelUsed = parsed.model ?? cfg.model;

    await db.batch([
      db
        .prepare(
          `UPDATE llm_calls SET status = 'ok', model_used = ?, attempt = ?, cost_micro = ?, cost_without_prune_micro = NULL,
             cache_hit = 0, prompt_tokens = ?, completion_tokens = ?, receipt_json = NULL, verify_status = 'missing',
             verify_reason = 'no_receipt', finished_at = ?, verified_at = NULL
           WHERE id = ?`,
        )
        .bind(modelUsed, attempt, costMicro, promptTokens, completionTokens, nowSec(), callId),
      settleStatement(db, req.workspaceId, est, costMicro),
    ]);

    return {
      callId,
      text: parsed.text,
      tier: req.tier,
      modelUsed,
      costMicro,
      costSource: 'estimate',
      cacheHit: false,
      promptTokens,
      completionTokens,
      receiptRaw: '',
      verifyStatus: 'missing',
      attempts: attempt,
      shieldSignal: null,
      truncated: parsed.truncated,
      outputCapApplied: false,
    };
  }

  const status = lastVerdict.code === 'budget_exhausted' ? 'budget_stopped' : 'failed';
  await finish(status, 0, lastVerdict.code, Math.min(attempt, MAX_RETRIES + 1), lastVerdict.detail);
  throw new AppError(lastVerdict.code, undefined, {
    retryable: lastVerdict.code === 'provider_unavailable' || lastVerdict.code === 'rate_limited',
    detail: { callId, attempts: Math.min(attempt, MAX_RETRIES + 1), ...(waitSec !== null ? { retryAfterSec: waitSec } : {}) },
  });
}
