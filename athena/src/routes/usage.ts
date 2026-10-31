// E26: usage and cost per good answer (CPGA). Everything the old endpoint returned is unchanged; the new fields
// (cpga, success_rate, gate, attempts_by_answer, and per-chat CPGA) are added beside it.
//
// Definitions (also in the README):
//   good answer   = a finished answer that passes the no-AI citation and number check (src/gate.ts). Summaries and
//                   extractions have their own validation and count as good when finished.
//   CPGA          = spend on ALL calls of the conversation (retries and escalations included) / good answers.
//   spend         = cost_micro of calls that returned a signed receipt, plus calls from a provider that issues no receipts
//                   at all (the Groq path), whose token-based cost is reported in spend_estimated_usd so it is never
//                   passed off as signed. Charges that are only an estimate because billing was uncertain are
//                   reported separately (uncertain_calls) and are not mixed in.
import { getBudget } from '../budget.ts';
import { microToUsd, parseJsonSafe } from '../util.ts';
import type { AppT } from './shared.ts';

interface CallRow {
  id: string;
  chat_id: string | null;
  purpose: string;
  tier: string;
  model_used: string | null;
  status: string;
  cost_micro: number | null;
  verify_reason?: string | null;
  verify_status: string;
  has_receipt: number;
  idempotency_key: string;
  created_at: number;
}
interface AsstRow {
  id: string;
  chat_id: string;
  status: string;
  mode: string;
  gate_json: string | null;
  created_at: number;
}

const round = (n: number) => Number(n.toFixed(6));
const ratio = (a: number, b: number) => (b > 0 ? round(a / b) : null);

export function registerUsageRoutes(app: AppT): void {
  app.get('/api/usage', async (c) => {
    const ws = c.get('ws');
    const db = c.env.DB;
    const b = await getBudget(db, ws);
    const t = await db
      .prepare(
        `SELECT COUNT(*) AS calls, COALESCE(SUM(cache_hit), 0) AS hits,
           COALESCE(SUM(CASE WHEN verify_status = 'verified' THEN 1 ELSE 0 END), 0) AS verified,
           COALESCE(SUM(CASE WHEN receipt_json IS NOT NULL THEN 1 ELSE 0 END), 0) AS receipts
         FROM llm_calls WHERE workspace_id = ? AND status = 'ok'`,
      )
      .bind(ws)
      .first<{ calls: number; hits: number; verified: number; receipts: number }>();
    const rows = (
      await db
        .prepare(
          `SELECT m.id, m.chat_id, COALESCE(SUM(k.cost_micro), 0) AS cost
           FROM messages m JOIN chats ch ON ch.id = m.chat_id AND ch.workspace_id = ?
           LEFT JOIN llm_calls k ON substr(k.idempotency_key, 1, length(m.id) + 1) = m.id || ':'
           WHERE m.role = 'assistant' AND m.status = 'done'
           GROUP BY m.id ORDER BY m.chat_id, m.created_at, m.rowid`,
        )
        .bind(ws)
        .all<{ id: string; chat_id: string; cost: number }>()
    ).results;
    const perChat = new Map<string, number>();
    const series = rows.map((r) => {
      const n = (perChat.get(r.chat_id) ?? 0) + 1;
      perChat.set(r.chat_id, n);
      return { chat_id: r.chat_id, n, cost_usd: microToUsd(r.cost) };
    });

    // ---- cost per good answer, per conversation ----
    const asst = (
      await db
        .prepare(
          `SELECT m.id, m.chat_id, m.status, m.mode, m.gate_json, m.created_at FROM messages m
           JOIN chats ch ON ch.id = m.chat_id AND ch.workspace_id = ?
           WHERE m.role = 'assistant' ORDER BY m.chat_id, m.created_at, m.rowid`,
        )
        .bind(ws)
        .all<AsstRow>()
    ).results;
    const calls = (
      await db
        .prepare(
          `SELECT id, chat_id, purpose, tier, model_used, status, cost_micro, verify_status, receipt_json IS NOT NULL AS has_receipt, verify_reason, idempotency_key, created_at
           FROM llm_calls WHERE workspace_id = ? ORDER BY created_at, rowid`,
        )
        .bind(ws)
        .all<CallRow>()
    ).results;

    const stat = new Map<string, { good: number; attempted: number; spend: number; uncertain: number; estimated?: number }>();
    const of = (chat: string) => {
      let s = stat.get(chat);
      if (!s) stat.set(chat, (s = { good: 0, attempted: 0, spend: 0, uncertain: 0 }));
      return s;
    };
    const isGood = new Map<string, boolean>();
    for (const m of asst) {
      if (m.status !== 'done' && m.status !== 'failed') continue;
      const s = of(m.chat_id);
      s.attempted++;
      const gate = parseJsonSafe<{ pass?: boolean } | null>(m.gate_json, null);
      const good = m.status === 'done' && (m.mode !== 'answer' || gate?.pass === true);
      isGood.set(m.id, good);
      if (good) s.good++;
    }
    for (const k of calls) {
      if (!k.chat_id) continue;
      if (k.status === 'ok' && k.has_receipt) of(k.chat_id).spend += k.cost_micro ?? 0;
      else if (k.status === 'ok' && k.verify_reason === 'no_receipt') {
        const st = of(k.chat_id);
        st.spend += k.cost_micro ?? 0;
        st.estimated = (st.estimated ?? 0) + (k.cost_micro ?? 0);
      } else if (k.status === 'unknown_cost') of(k.chat_id).uncertain++;
    }
    const total = { good: 0, attempted: 0, spend: 0, uncertain: 0, estimated: 0 };
    for (const s of stat.values()) {
      total.good += s.good;
      total.attempted += s.attempted;
      total.spend += s.spend;
      total.uncertain += s.uncertain;
      total.estimated += s.estimated ?? 0;
    }
    const cpgaOf = (s: { good: number; attempted: number; spend: number; uncertain: number; estimated?: number }) => ({
      good_answers: s.good,
      attempted: s.attempted,
      success_rate: ratio(s.good, s.attempted),
      spend_usd: microToUsd(s.spend),
      // Part of spend_usd that comes from token counts, not a signed receipt (the Groq path). 0 on Prune.
      spend_estimated_usd: microToUsd(s.estimated ?? 0),
      cost_per_request_usd: s.attempted ? microToUsd(Math.round(s.spend / s.attempted)) : null,
      cpga_usd: s.good ? microToUsd(Math.round(s.spend / s.good)) : null,
      // The gate is deterministic code and costs nothing; there is no model judge, so both figures match.
      cpga_excluding_checker_usd: s.good ? microToUsd(Math.round(s.spend / s.good)) : null,
      cpga_including_judge_usd: s.good ? microToUsd(Math.round(s.spend / s.good)) : null,
      uncertain_calls: s.uncertain,
    });

    const byChat = [...perChat.keys()].map((id) => {
      const s = series.filter((x) => x.chat_id === id);
      return {
        chat_id: id,
        answers: s.length,
        cost_usd: Number(s.reduce((a, x) => a + x.cost_usd, 0).toFixed(6)),
        ...cpgaOf(stat.get(id) ?? { good: 0, attempted: 0, spend: 0, uncertain: 0 }),
      };
    });
    // Conversations that only have failed or paused answers are not in perChat; still report their CPGA.
    for (const [id, s] of stat) if (!perChat.has(id)) byChat.push({ chat_id: id, answers: 0, cost_usd: 0, ...cpgaOf(s) });

    const attempts = new Map<string, CallRow[]>();
    for (const k of calls) {
      const key = k.idempotency_key.split(':')[0]!;
      (attempts.get(key) ?? attempts.set(key, []).get(key)!).push(k);
    }
    const attempts_by_answer = asst
      .filter((m) => attempts.has(m.id))
      .slice(-50)
      .map((m) => ({
        message_id: m.id,
        chat_id: m.chat_id,
        status: m.status,
        good: isGood.get(m.id) ?? false,
        attempts: attempts.get(m.id)!.map((k) => ({
          call_id: k.id,
          rung: k.purpose === 'repair' ? 'escalation' : 'first',
          tier: k.tier,
          model: k.model_used,
          status: k.status,
          cost_usd: k.cost_micro == null ? null : microToUsd(k.cost_micro),
          verify_status: k.verify_status,
        })),
      }));

    const g = await db
      .prepare('SELECT n, false_pass, false_fail, precision, recall, thresholds_json, created_at FROM gate_eval ORDER BY id DESC LIMIT 1')
      .first<{ n: number; false_pass: number; false_fail: number; precision: number | null; recall: number | null; thresholds_json: string | null; created_at: number }>()
      .catch(() => null);
    const gate = g
      ? {
          measured: true,
          n: g.n,
          false_pass: g.false_pass,
          false_fail: g.false_fail,
          false_pass_rate: ratio(g.false_pass, g.n),
          false_fail_rate: ratio(g.false_fail, g.n),
          precision: g.precision,
          recall: g.recall,
          thresholds: parseJsonSafe(g.thresholds_json, null),
          last_run: g.created_at,
        }
      : { measured: false, n: 0, false_pass: 0, false_fail: 0, false_pass_rate: null, false_fail_rate: null, precision: null, recall: null, thresholds: null, last_run: null };

    return c.json({
      totals: {
        spent_usd: microToUsd(b?.spent_micro ?? 0),
        calls: t!.calls,
        answers: rows.length,
        avg_cost_per_answer_usd: rows.length ? microToUsd(Math.round(rows.reduce((a, r) => a + r.cost, 0) / rows.length)) : 0,
        cache_hits: t!.hits,
        receipts: t!.receipts,
        receipts_verified: t!.verified,
      },
      by_chat: byChat,
      series,
      cpga: cpgaOf(total),
      success_rate: ratio(total.good, total.attempted),
      gate,
      attempts_by_answer,
    });
  });
}
