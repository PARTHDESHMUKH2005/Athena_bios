// Glue between the pure checks (gate.ts, baseline.ts) and the database. Everything here is best-effort and
// additive: a failure is swallowed so it can never change an answer, a charge or a status.
import type { D1Database } from '@cloudflare/workers-types';
import type { Citation } from './answer.ts';
import { recordBaseline } from './baseline.ts';
import type { Env } from './env.ts';
import { gateSummary, runGate } from './gate.ts';
import type { GateResult } from './gate.ts';
import type { RetrievedSection } from './context.ts';
import type { Tier } from './tiers.ts';

const MAX_PAGES_PER_CITATION = 5;

/** Run the no-AI citation and number check on a finished answer, using page text from D1 only. */
export async function gateForAnswer(
  db: D1Database,
  p: { answer: string; citations: Citation[]; sections: Pick<RetrievedSection, 'document_id' | 'page_start' | 'page_end'>[] },
): Promise<GateResult> {
  const cited: { document_id: string; page: number }[] = [];
  for (const c of p.citations) {
    const end = Math.min(c.page_end, c.page_start + MAX_PAGES_PER_CITATION - 1);
    for (let pg = c.page_start; pg <= end; pg++) if (!cited.some((x) => x.document_id === c.document_id && x.page === pg)) cited.push({ document_id: c.document_id, page: pg });
  }
  const text = new Map<string, string>();
  for (const c of cited) {
    const row = await db.prepare('SELECT text FROM pages WHERE document_id = ? AND page_no = ?').bind(c.document_id, c.page).first<{ text: string }>();
    if (row) text.set(`${c.document_id}:${c.page}`, row.text);
  }
  const sent = (doc: string | undefined, page: number) => p.sections.some((s) => (doc === undefined || s.document_id === doc) && page >= s.page_start && page <= s.page_end);
  return runGate({
    answer: p.answer,
    citations: cited.map((c) => ({ page: c.page, document_id: c.document_id })),
    pageText: (doc, page) => text.get(`${doc}:${page}`),
    wasSent: sent,
  });
}

export interface GateStored extends GateResult {
  summary: string;
}

/**
 * Gate plus baseline for one finished answer. Stores `messages.gate_json` and the naive baseline on the answering
 * call. Never throws.
 */
export async function recordAnswerExtras(
  env: Env,
  p: {
    ws: string;
    chatId: string;
    userId: string;
    asstId: string;
    question: string;
    mode: 'answer' | 'summarize' | 'extract';
    answer: string;
    citations: Citation[];
    sections: RetrievedSection[];
    systemText: string;
    callId: string;
    tier: Tier;
    outputTokens: number;
    model: string | null;
    gate?: GateResult | null;
  },
): Promise<void> {
  try {
    await recordBaseline(env, {
      ws: p.ws,
      chatId: p.chatId,
      turnMessageIds: [p.userId, p.asstId],
      question: p.question,
      systemText: p.systemText,
      callId: p.callId,
      tier: p.tier,
      outputTokens: p.outputTokens,
      model: p.model,
    });
    if (p.mode !== 'answer') return; // summaries and extraction have their own checks
    const g = p.gate ?? (await gateForAnswer(env.DB, { answer: p.answer, citations: p.citations, sections: p.sections }));
    const stored: GateStored = { ...g, summary: gateSummary(g) };
    await env.DB.prepare('UPDATE messages SET gate_json = ? WHERE id = ?').bind(JSON.stringify(stored), p.asstId).run();
  } catch {
    /* informational only */
  }
}

/** Store an abstention as a passing gate result so it counts as an answer that needed no checking. */
export const ABSTAIN_GATE: GateStored = {
  pass: true,
  failures: [],
  checked: { quotes: 0, numbers: 0, pages: 0 },
  mode: 'pages_only',
  abstained: true,
  summary: 'Nothing to check: the answer says it is not in the document',
};
