// The orchestrator: runs one question through the whole pipeline (athena.md 2.5). There are no autonomous
// agent loops by design. The "agents" are fixed roles, each a module with one job, and Prune's
// X-Prune-Max-Steps caps any run at 6 requests (every HTTP attempt counts, retries included):
//   retrieval agent   -> context.ts      router agent   -> tiers.ts
//   answer agent      -> llm.ts          verifier agent -> receipts.ts + answer.ts
//   memory agent      -> maybeSummarize  budget guard   -> budget.ts
import type { D1Database } from '@cloudflare/workers-types';
import { validateAnswer, validateExtraction } from './answer.ts';
import type { Citation } from './answer.ts';
import { getBudget } from './budget.ts';
import { buildContext, PLANS } from './context.ts';
import type { RetrievedSection } from './context.ts';
import type { Env, ExecLike } from './env.ts';
import { AppError } from './errors.ts';
import { assertNotKilled } from './killswitch.ts';
import { callModel } from './llm.ts';
import type { CallResult, LlmDeps } from './llm.ts';
import { ABSTAIN_GATE, gateForAnswer, recordAnswerExtras } from './extras.ts';
import type { GateStored } from './extras.ts';
import { ABSTAIN_ANSWER, gateSummary, shouldAbstain } from './gate.ts';
import type { GateResult } from './gate.ts';
import { scanOutput } from './outputscan.ts';
import { hit } from './ratelimit.ts';
import { estimateMicro, loadTiers, lowerTier, nextTier, pickTier } from './tiers.ts';
import type { Purpose, Tier } from './tiers.ts';
import { Trace } from './trace.ts';
import type { TraceStep } from './trace.ts';
import { estTokens, microToUsd, newId, nowSec, numEnv, parseJsonSafe } from './util.ts';

export type Mode = 'answer' | 'summarize' | 'extract';
export interface AskInput {
  clientMsgId: string;
  content: string;
  mode: Mode;
  output: 'short' | 'normal';
}

export interface PauseInfo {
  reason: 'insufficient_allowance' | 'service_cap';
  est_usd: number;
  remaining_usd: number;
  options: ('shorter' | 'raise_budget' | 'cancel')[];
}
export interface MessageOut {
  id: string;
  role: 'user' | 'assistant' | 'note';
  status: 'pending' | 'done' | 'paused' | 'failed';
  content: string;
  mode: Mode;
  model_used: string | null;
  call_id: string | null;
  citations: Citation[];
  pause: PauseInfo | null;
  trace: TraceStep[];
  created_at: number;
  /** Result of the no-AI citation and number check (src/gate.ts), when one was recorded. */
  gate?: GateStored | null;
}
export interface UsageOut {
  call_id: string;
  model_used: string | null;
  tier: string;
  cost_usd: number;
  cache_hit: boolean;
  verify_status: string;
  /** Signed by Prune: what this answer would have cost without Prune's savings. Null when the receipt has no such field. */
  cost_without_prune_usd?: number | null;
  /** Athena's own estimate of a naive system's cost (NOT signed). Null when not recorded. */
  naive_baseline_usd?: number | null;
}
export interface AskResult {
  message: MessageOut;
  usage: UsageOut | null;
}

interface MessageRow {
  id: string;
  role: MessageOut['role'];
  content: string;
  mode: Mode;
  status: MessageOut['status'];
  call_id: string | null;
  model_used: string | null;
  citations_json: string | null;
  pause_json: string | null;
  trace_json: string | null;
  created_at: number;
  gate_json?: string | null;
}

export async function readMessage(db: D1Database, id: string): Promise<MessageOut> {
  const r = await db
    .prepare(
      `SELECT id, role, content, mode, status, call_id, model_used, citations_json, pause_json, trace_json, created_at, gate_json
       FROM messages WHERE id = ?`,
    )
    .bind(id)
    .first<MessageRow>();
  if (!r) throw new AppError('not_found');
  return toMessageOut(r);
}

export function toMessageOut(r: MessageRow): MessageOut {
  return {
    id: r.id,
    role: r.role,
    status: r.status,
    content: r.content,
    mode: r.mode,
    model_used: r.model_used,
    call_id: r.call_id,
    citations: parseJsonSafe<Citation[]>(r.citations_json, []),
    pause: parseJsonSafe<PauseInfo | null>(r.pause_json, null),
    trace: parseJsonSafe<TraceStep[]>(r.trace_json, []),
    created_at: r.created_at,
    gate: parseJsonSafe<GateStored | null>(r.gate_json, null),
  };
}

/** Total cost of one answer across all its calls (answer plus any escalation), from receipts. */
export async function usageFor(db: D1Database, asstId: string): Promise<UsageOut | null> {
  const prefix = `${asstId}:`;
  const rows = (
    await db
      .prepare(
        `SELECT id, tier, model_used, cost_micro, cost_without_prune_micro, naive_cost_micro, cache_hit, verify_status, status FROM llm_calls
         WHERE substr(idempotency_key, 1, ?) = ? ORDER BY created_at, rowid`,
      )
      .bind(prefix.length, prefix)
      .all<{ id: string; tier: string; model_used: string | null; cost_micro: number | null; cost_without_prune_micro: number | null; naive_cost_micro: number | null; cache_hit: number | null; verify_status: string; status: string }>()
  ).results;
  const ok = rows.filter((r) => r.status === 'ok');
  const last = ok[ok.length - 1];
  if (!last) return null;
  const total = rows.reduce((s, r) => s + (r.cost_micro ?? 0), 0);
  const withoutParts = ok.map((r) => r.cost_without_prune_micro).filter((x): x is number => x != null);
  return {
    call_id: last.id,
    model_used: last.model_used,
    tier: last.tier,
    cost_usd: microToUsd(total),
    cache_hit: last.cache_hit === 1,
    verify_status: last.verify_status,
    cost_without_prune_usd: withoutParts.length ? microToUsd(withoutParts.reduce((a, b) => a + b, 0)) : null,
    naive_baseline_usd: last.naive_cost_micro == null ? null : microToUsd(last.naive_cost_micro),
  };
}

async function stored(db: D1Database, userMsgId: string): Promise<AskResult> {
  const asstId = `${userMsgId}_a`;
  const message = await readMessage(db, asstId);
  return { message, usage: await usageFor(db, asstId) };
}

/* ----------------------------------- ask ----------------------------------- */

export async function ask(env: Env, exec: ExecLike, ws: string, chatId: string, input: AskInput, deps: LlmDeps = {}): Promise<AskResult> {
  const db = env.DB;
  const chat = await db.prepare('SELECT id FROM chats WHERE id = ? AND workspace_id = ?').bind(chatId, ws).first();
  if (!chat) throw new AppError('not_found');

  // Idempotency first: a resent client_msg_id returns the stored message and never makes a second paid call.
  const existing = await db.prepare('SELECT id FROM messages WHERE chat_id = ? AND client_msg_id = ?').bind(chatId, input.clientMsgId).first<{ id: string }>();
  if (existing) return stored(db, existing.id);

  await assertNotKilled(env);
  await hit(db, ws, 'msg', 60, numEnv(env.MSG_LIMIT_PER_MIN, 20));

  if (input.mode === 'extract') {
    const inv = await db
      .prepare(
        `SELECT 1 AS ok FROM chat_documents cd JOIN documents d ON d.id = cd.document_id
         WHERE cd.chat_id = ? AND d.pack = 'invoice' LIMIT 1`,
      )
      .bind(chatId)
      .first();
    if (!inv) throw new AppError('validation_failed', 'Extract is only available for invoice documents.');
  }

  const userId = newId('m');
  const asstId = `${userId}_a`;
  const t = nowSec();
  try {
    await db.batch([
      db
        .prepare(`INSERT INTO messages (id, chat_id, role, content, mode, client_msg_id, status, created_at) VALUES (?, ?, 'user', ?, ?, ?, 'done', ?)`)
        .bind(userId, chatId, input.content, input.mode, input.clientMsgId, t),
      db
        .prepare(`INSERT INTO messages (id, chat_id, role, content, mode, status, trace_json, created_at) VALUES (?, ?, 'assistant', '', ?, 'pending', '[]', ?)`)
        .bind(asstId, chatId, input.mode, t),
    ]);
  } catch (e) {
    // A concurrent request with the same client_msg_id won the race.
    const again = await db.prepare('SELECT id FROM messages WHERE chat_id = ? AND client_msg_id = ?').bind(chatId, input.clientMsgId).first<{ id: string }>();
    if (again) return stored(db, again.id);
    throw e;
  }

  return runAssistant(env, exec, { ws, chatId, userId, asstId, question: input.content, mode: input.mode, short: input.output === 'short', deps });
}

/* ------------------------------- the pipeline ------------------------------- */

interface RunParams {
  ws: string;
  chatId: string;
  userId: string;
  asstId: string;
  question: string;
  mode: Mode;
  short: boolean;
  deps?: LlmDeps;
}

const MAX_OUT: Record<Mode, number> = { answer: 600, summarize: 700, extract: 900 };
const SHORT_OUT = 200;

/** Shrink order from athena.md 2.5: fewer sections, then shorter history, then a cheaper tier and shorter output. */
const ATTEMPTS = [
  { plan: 0, down: 0, short: false },
  { plan: 1, down: 0, short: false },
  { plan: 2, down: 0, short: false },
  { plan: 2, down: 2, short: true },
];

async function nextAttemptNo(db: D1Database, asstId: string): Promise<number> {
  const prefix = `${asstId}:`;
  const r = await db
    .prepare(`SELECT COUNT(*) AS n FROM llm_calls WHERE substr(idempotency_key, 1, ?) = ? AND purpose != 'repair'`)
    .bind(prefix.length, prefix)
    .first<{ n: number }>();
  return (r?.n ?? 0) + 1;
}

const pagesLabel = (s: RetrievedSection[]) =>
  [...new Set(s.map((x) => x.page_start))].sort((a, b) => a - b).slice(0, 6).join(', ') || 'none';

export async function runAssistant(env: Env, exec: ExecLike, p: RunParams): Promise<AskResult> {
  const db = env.DB;
  const tiers = loadTiers(env);
  const trace = new Trace(db, p.asstId);
  await db.prepare("UPDATE messages SET status = 'pending', pause_json = NULL, content = '', trace_json = '[]', call_id = NULL WHERE id = ?").bind(p.asstId).run();

  const attemptNo = await nextAttemptNo(db, p.asstId);
  const purpose: Purpose = p.mode === 'extract' ? 'extract' : p.mode === 'summarize' ? 'summarize' : 'answer';
  const perCall = (await getBudget(db, p.ws))?.per_call_cap_micro ?? 0;
  const baseKey = `${p.asstId}:r${attemptNo}:${purpose}`;

  let shortfall = { est: 0, remaining: 0 };
  let first: { call: CallResult; built: Awaited<ReturnType<typeof buildContext>>; tier: Tier; short: boolean } | null = null;

  for (const a of ATTEMPTS) {
    const short = p.short || a.short;
    const built = await buildContext(db, {
      chatId: p.chatId,
      question: p.question,
      mode: p.mode,
      plan: PLANS[a.plan]!,
      excludeMessageIds: [p.userId, p.asstId],
      short,
    });
    await trace.add('context', `${built.sections.length} sections, pages ${pagesLabel(built.sections)}`);
    // Weak retrieval means the document probably does not hold the answer: say so without calling any model.
    if (env.ABSTAIN_MIN_SCORE !== undefined && env.ABSTAIN_MIN_SCORE !== '' && p.mode === 'answer' && built.documentCount > 0) {
      if (shouldAbstain(built.scores, { minStrength: numEnv(env.ABSTAIN_MIN_SCORE, 0), minMargin: numEnv(env.ABSTAIN_MIN_MARGIN, 0) })) return abstain(db, trace, p);
    }
    const picked = pickTier({ purpose, question: p.question, contextTokens: built.promptTokens, documentCount: built.documentCount });
    const tier = lowerTier(picked.tier, a.down);
    await trace.add('tier', `${tier}: ${picked.reason}`);
    // Models that spend output tokens on hidden thinking (Gemini 3.x) can need a floor, set per tier in MODEL_TIERS.
    const maxOut = Math.max(short ? SHORT_OUT : MAX_OUT[p.mode], tiers[tier].minOutputTokens ?? 0);
    const est = estimateMicro(tiers[tier], built.promptTokens, maxOut);
    await trace.add('reserve', `up to $${(est / 1e6).toFixed(6)}`);
    try {
      const call = await callModel(
        env,
        {
          workspaceId: p.ws,
          chatId: p.chatId,
          // One Prune run per attempt: a manual retry must not count against the previous attempt's
          // X-Prune-Max-Steps, and repeated identical steps in one run trip Prune's agent_loop stop.
          runId: `${p.asstId}:r${attemptNo}`,
          purpose,
          workload: p.mode === 'extract' ? 'structured_extraction' : 'rag',
          // Never 'normalized' or 'semantic' for answers: on the real Prune a different question was served a cached answer
          // to an earlier one (the document context dominates the prompt). 'exact' only matches an identical request.
          cache: 'exact',
          tier,
          messages: built.messages,
          promptTokens: built.promptTokens,
          maxOutputTokens: maxOut,
          runBudgetMicro: perCall,
          idempotencyKey: baseKey,
          json: p.mode === 'extract',
        },
        p.deps,
      );
      first = { call, built, tier, short };
      break;
    } catch (e) {
      if (e instanceof AppError && e.code === 'budget_exhausted' && e.detail['local'] === true) {
        shortfall = { est: Number(e.detail['estMicro'] ?? est), remaining: Number(e.detail['remainingMicro'] ?? 0) };
        continue; // shrink and try again
      }
      if (e instanceof AppError && e.code === 'budget_exhausted') {
        return pause(db, trace, p, 'service_cap', est, shortfall.remaining);
      }
      return failMessage(db, trace, p.asstId, e);
    }
  }

  if (!first) return pause(db, trace, p, 'insufficient_allowance', shortfall.est, shortfall.remaining);

  let { call } = first;
  const { built, tier } = first;
  const calls: CallResult[] = [call];
  await trace.add(
    'call',
    [call.attempts > 1 ? `succeeded on attempt ${call.attempts}` : 'attempt 1', call.truncated ? 'cut off at the output limit' : '', call.outputCapApplied ? 'Prune shortened the output limit' : ''].filter(Boolean).join(', '),
  );
  await trace.add('verify', `receipt ${call.verifyStatus}${call.cacheHit ? ', cache hit' : ''}${call.shieldSignal ? `, shield: ${call.shieldSignal}` : ''}`);

  // Validate the output; escalate to the next tier at most once.
  const check = (text: string) =>
    p.mode === 'extract'
      ? validateExtraction(text)
      : (() => {
          const v = validateAnswer(text, built.sections);
          return p.mode === 'summarize' ? { ...v, ok: true } : v;
        })();
  // Optional (GATE_ENFORCE=1): a failed citation or number check counts as a failed validation, so it can use the one escalation.
  const enforceGate = env.GATE_ENFORCE === '1' && p.mode === 'answer';
  const gated = async (text: string, v: ReturnType<typeof check>) => {
    if (!enforceGate || !v.ok || !('citations' in v)) return v;
    const g: GateResult = await gateForAnswer(db, { answer: text, citations: v.citations, sections: built.sections }).catch(() => ({ pass: true }) as GateResult);
    return g.pass ? v : { ...v, ok: false, reason: gateSummary(g) };
  };
  let verdict = await gated(call.text, check(call.text));
  if (!verdict.ok && tier !== 'strong') {
    const target = nextTier(tier);
    await trace.add('escalate', `${tier} to ${target}: ${verdict.reason}`);
    try {
      const retry = await callModel(
        env,
        {
          workspaceId: p.ws,
          chatId: p.chatId,
          runId: `${p.asstId}:r${attemptNo}`,
          purpose: 'repair',
          workload: p.mode === 'extract' ? 'structured_extraction' : 'rag',
          cache: 'off',
          tier: target,
          messages: built.messages,
          promptTokens: built.promptTokens,
          maxOutputTokens: Math.max(first.short ? SHORT_OUT : MAX_OUT[p.mode], tiers[target].minOutputTokens ?? 0),
          runBudgetMicro: perCall,
          idempotencyKey: `${baseKey}:esc`,
          json: p.mode === 'extract',
        },
        p.deps,
      );
      calls.push(retry);
      const v2 = await gated(retry.text, check(retry.text));
      if (v2.ok || p.mode !== 'extract') {
        call = retry;
        verdict = v2;
      }
      await trace.add('verify', `second receipt ${retry.verifyStatus}`);
    } catch (e) {
      await trace.add('escalate', `skipped: ${e instanceof AppError ? e.code : 'error'}`);
    }
  }

  let content = call.text;
  // Never present a cut-off answer as complete. An empty one means the model used its whole output limit before writing.
  if (call.truncated && p.mode !== 'extract') {
    content = content.trim()
      ? `${content}

(This answer was cut off because it reached the output limit.)`
      : 'The model used its whole output limit before writing an answer. Try again, or ask a shorter question.';
  }
  let citations: Citation[] = [];
  if (p.mode === 'extract') {
    if (!('invoice' in verdict)) return failMessage(db, trace, p.asstId, new AppError('validation_failed', 'Could not read this invoice into fields. Nothing is shown as verified.'), call.callId);
    content = `${JSON.stringify(verdict.invoice, null, 2)}\n\nTotal check: ${verdict.check.message}`;
  } else if ('citations' in verdict) {
    citations = verdict.citations;
  }

  // Output is untrusted too: strip secrets, links the document did not contain, and dangerous commands.
  const scanned = scanOutput(content, { context: built.messages[built.messages.length - 1]!.content, secrets: [env.PRUNE_API_KEY, env.ADMIN_TOKEN] });
  content = scanned.text;
  if (scanned.flags.length) await trace.add('scan', `removed: ${scanned.flags.join(', ')}`);

  const totalMicro = calls.reduce((s, c) => s + c.costMicro, 0);
  await trace.add('done', `$${(totalMicro / 1e6).toFixed(6)}`);
  await db.batch([
    db
      .prepare(`UPDATE messages SET content = ?, status = 'done', call_id = ?, model_used = ?, citations_json = ?, trace_json = ? WHERE id = ?`)
      .bind(content, call.callId, call.modelUsed, JSON.stringify(citations), JSON.stringify(trace.steps), p.asstId),
    db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').bind(nowSec(), p.chatId),
  ]);

  // Gate result and naive baseline are informational: stored after the answer, errors swallowed inside.
  await recordAnswerExtras(env, {
    ws: p.ws,
    chatId: p.chatId,
    userId: p.userId,
    asstId: p.asstId,
    question: p.question,
    mode: p.mode,
    answer: content,
    citations,
    sections: built.sections,
    systemText: built.messages[0]?.content ?? '',
    callId: call.callId,
    tier: call.tier,
    outputTokens: call.completionTokens,
    model: call.modelUsed,
  });

  // Memory runs after the answer, outside the user's wait. A failure here never affects the answer.
  exec.waitUntil(maybeSummarize(env, p.ws, p.chatId, p.deps).catch(() => undefined));

  return { message: await readMessage(db, p.asstId), usage: await usageFor(db, p.asstId) };
}

/** Answer "not in the document" from retrieval strength alone. No model call, no cost, no receipt. */
async function abstain(db: D1Database, trace: Trace, p: RunParams): Promise<AskResult> {
  await trace.add('abstain', 'the search found nothing strong enough; no model was called');
  await db.batch([
    db
      .prepare(`UPDATE messages SET content = ?, status = 'done', call_id = NULL, citations_json = '[]', trace_json = ?, gate_json = ? WHERE id = ?`)
      .bind(ABSTAIN_ANSWER, JSON.stringify(trace.steps), JSON.stringify(ABSTAIN_GATE), p.asstId),
    db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').bind(nowSec(), p.chatId),
  ]);
  return { message: await readMessage(db, p.asstId), usage: null };
}

async function pause(
  db: D1Database,
  trace: Trace,
  p: RunParams,
  reason: PauseInfo['reason'],
  estMicro: number,
  remainingMicro: number,
): Promise<AskResult> {
  const info: PauseInfo = {
    reason,
    est_usd: microToUsd(estMicro),
    remaining_usd: microToUsd(Math.max(0, remainingMicro)),
    options: p.short ? ['raise_budget', 'cancel'] : ['shorter', 'raise_budget', 'cancel'],
  };
  await trace.add('pause', reason === 'service_cap' ? 'service-side limit' : `needs about $${info.est_usd.toFixed(4)}`);
  await db
    .prepare("UPDATE messages SET status = 'paused', pause_json = ?, trace_json = ? WHERE id = ?")
    .bind(JSON.stringify(info), JSON.stringify(trace.steps), p.asstId)
    .run();
  return { message: await readMessage(db, p.asstId), usage: null };
}

async function failMessage(db: D1Database, trace: Trace, asstId: string, e: unknown, callIdOverride?: string): Promise<never> {
  const err = e instanceof AppError ? e : new AppError('internal');
  const callId = (callIdOverride ?? (err.detail['callId'] as string | undefined)) || null;
  await trace.add('error', err.code);
  await db
    .prepare("UPDATE messages SET status = 'failed', content = ?, call_id = ?, trace_json = ? WHERE id = ?")
    .bind(err.message, callId, JSON.stringify(trace.steps), asstId)
    .run();
  throw err;
}

/* --------------------------- resume, retry, memory --------------------------- */

export async function resumePaused(
  env: Env,
  exec: ExecLike,
  ws: string,
  chatId: string,
  messageId: string,
  action: 'shorter' | 'full' | 'cancel',
  deps: LlmDeps = {},
): Promise<AskResult> {
  const db = env.DB;
  const chat = await db.prepare('SELECT id FROM chats WHERE id = ? AND workspace_id = ?').bind(chatId, ws).first();
  if (!chat) throw new AppError('not_found');
  const msg = await db.prepare('SELECT id, status FROM messages WHERE id = ? AND chat_id = ?').bind(messageId, chatId).first<{ id: string; status: string }>();
  if (!msg) throw new AppError('not_found');
  if (msg.status !== 'paused' || !messageId.endsWith('_a')) throw new AppError('conflict', 'This message is not waiting on a decision.');
  if (action === 'cancel') {
    await db.prepare("UPDATE messages SET status = 'failed', content = 'Cancelled.', pause_json = NULL WHERE id = ?").bind(messageId).run();
    return { message: await readMessage(db, messageId), usage: null };
  }
  const userId = messageId.slice(0, -2);
  const u = await db.prepare('SELECT content, mode FROM messages WHERE id = ?').bind(userId).first<{ content: string; mode: Mode }>();
  if (!u) throw new AppError('not_found');
  await assertNotKilled(env);
  return runAssistant(env, exec, { ws, chatId, userId, asstId: messageId, question: u.content, mode: u.mode, short: action === 'shorter', deps });
}

const RETRYABLE_CLASSES = new Set(['billing_uncertain', 'receipt_missing', 'provider_unavailable', 'rate_limited']);

/** E25: the only way to retry a call whose billing was uncertain. The UI makes the user confirm it. */
export async function retryCall(env: Env, exec: ExecLike, ws: string, callId: string, deps: LlmDeps = {}): Promise<AskResult> {
  const db = env.DB;
  const call = await db
    .prepare('SELECT idempotency_key, status, error_class FROM llm_calls WHERE id = ? AND workspace_id = ?')
    .bind(callId, ws)
    .first<{ idempotency_key: string; status: string; error_class: string | null }>();
  if (!call) throw new AppError('not_found');
  if (!['failed', 'unknown_cost'].includes(call.status) || !call.error_class || !RETRYABLE_CLASSES.has(call.error_class)) {
    throw new AppError('conflict', 'This call cannot be retried.');
  }
  const asstId = call.idempotency_key.split(':')[0]!;
  const msg = await db.prepare('SELECT chat_id, status FROM messages WHERE id = ?').bind(asstId).first<{ chat_id: string; status: string }>();
  if (!msg || msg.status !== 'failed') throw new AppError('conflict', 'This message is not waiting on a retry.');
  const userId = asstId.slice(0, -2);
  const u = await db.prepare('SELECT content, mode FROM messages WHERE id = ?').bind(userId).first<{ content: string; mode: Mode }>();
  if (!u) throw new AppError('not_found');
  await assertNotKilled(env);
  return runAssistant(env, exec, { ws, chatId: msg.chat_id, userId, asstId, question: u.content, mode: u.mode, short: false, deps });
}

/**
 * Rolling memory (athena.md 2.5): when the part of the chat outside the last four messages passes about
 * 1,500 tokens, summarize it once with the economy tier. Budget-reserved like any call. The summary
 * supports follow-ups; relevant older messages are still retrieved on top of it.
 */
export async function maybeSummarize(env: Env, ws: string, chatId: string, deps: LlmDeps = {}): Promise<boolean> {
  const db = env.DB;
  const threshold = numEnv(undefined, 1500);
  const cover = await db
    .prepare('SELECT covers_until, text FROM summaries WHERE chat_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .bind(chatId)
    .first<{ covers_until: number; text: string }>();
  const rows = (
    await db
      .prepare(
        `SELECT rowid AS rid, role, content FROM messages
         WHERE chat_id = ? AND status = 'done' AND role IN ('user','assistant') AND rowid > ?
         ORDER BY rowid`,
      )
      .bind(chatId, cover?.covers_until ?? 0)
      .all<{ rid: number; role: string; content: string }>()
  ).results;
  const older = rows.slice(0, Math.max(0, rows.length - 4));
  if (!older.length || older.reduce((s, m) => s + estTokens(m.content), 0) <= threshold) return false;
  const upTo = older[older.length - 1]!.rid;

  const body = older.map((m) => `${m.role}: ${m.content.slice(0, 1200)}`).join('\n');
  const prompt = [cover ? `Previous summary:\n${cover.text}\n` : '', `New messages:\n${body}`].join('\n');
  const messages = [
    { role: 'system' as const, content: 'Summarize this conversation in at most 150 words. Keep names, numbers, decisions and page references. Add nothing that is not in it.' },
    { role: 'user' as const, content: prompt },
  ];
  const perCall = (await getBudget(db, ws))?.per_call_cap_micro ?? 0;
  const call = await callModel(
    env,
    {
      workspaceId: ws,
      chatId,
      runId: chatId,
      purpose: 'memory_summary',
      workload: 'batch',
      cache: 'exact',
      tier: 'economy',
      messages,
      promptTokens: estTokens(messages.map((m) => m.content).join('\n')),
      maxOutputTokens: 300,
      runBudgetMicro: perCall,
      idempotencyKey: `${chatId}:sum:${upTo}`,
    },
    deps,
  );
  // The summary is fed back into later prompts, so it must not carry a poisoned link or secret forward.
  const safeSummary = scanOutput(call.text, { context: body, secrets: [env.PRUNE_API_KEY, env.ADMIN_TOKEN] }).text;
  await db
    .prepare('INSERT INTO summaries (id, chat_id, covers_until, text, call_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(newId('s'), chatId, upTo, safeSummary, call.callId, nowSec())
    .run();
  return true;
}
