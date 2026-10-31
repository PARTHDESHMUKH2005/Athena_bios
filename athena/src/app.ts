import { Hono } from 'hono';
import type { Context } from 'hono';
import { ZodError } from 'zod';
import type { z } from 'zod';
import { getBudget, remainingMicro, setLimit } from './budget.ts';
import type { Env, ExecLike } from './env.ts';
import { AppError } from './errors.ts';
import { isKilled } from './killswitch.ts';
import type { LlmDeps } from './llm.ts';
import { ask, readMessage, resumePaused, retryCall, toMessageOut, usageFor } from './orchestrator.ts';
import { PACK_IDS } from './packs/index.ts';
import { hit } from './ratelimit.ts';
import { verifyReceipt } from './receipts.ts';
import { sectionPages } from './sectioner.ts';
import { AskBody, CreateChatBody, CreateDocumentBody, FinalizeBody, LIMITS, PagesBody, PutBudgetBody, ResumeBody } from './schemas.ts';
import { loadTiers } from './tiers.ts';
import { microToUsd, newId, nowSec, numEnv, parseJsonSafe, randomToken, sanitizeText, sha256Hex, usdToMicro } from './util.ts';

type Vars = { ws: string; reqId: string };
type HC = Context<{ Bindings: Env; Variables: Vars }>;
export interface AppDeps {
  llm?: LlmDeps;
}

const VERSION = '0.1.0';

function execOf(c: HC): ExecLike {
  try {
    return c.executionCtx;
  } catch {
    return { waitUntil: (p) => void p.catch(() => undefined) };
  }
}

async function parse<S extends z.ZodType>(c: HC, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new AppError('validation_failed', 'The request body must be JSON.');
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    const why = r.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    throw new AppError('validation_failed', `Invalid request: ${why}`);
  }
  return r.data;
}

const budgetOut = (b: { limit_micro: number; spent_micro: number; reserved_micro: number; per_call_cap_micro: number }, env: Env) => ({
  limit_usd: microToUsd(b.limit_micro),
  spent_usd: microToUsd(b.spent_micro),
  reserved_usd: microToUsd(b.reserved_micro),
  remaining_usd: microToUsd(Math.max(0, remainingMicro(b))),
  per_call_cap_usd: microToUsd(b.per_call_cap_micro),
  max_limit_usd: numEnv(env.MAX_WORKSPACE_BUDGET_USD, 1),
});

async function logEvent(env: Env, ws: string | null, type: string, ref: string | null, detail: unknown = {}): Promise<void> {
  await env.DB.prepare('INSERT INTO events (workspace_id, type, ref_id, detail_json, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(ws, type, ref, JSON.stringify(detail), nowSec())
    .run();
}

interface DocRow {
  id: string;
  filename: string;
  pack: string;
  status: string;
  page_count: number;
  pages_received: number;
  scanned_pages: number;
  size_bytes: number;
  r2_key: string | null;
  summary_text: string | null;
  created_at: number;
  updated_at: number;
}
async function getDoc(env: Env, ws: string, id: string): Promise<DocRow> {
  const d = await env.DB.prepare('SELECT * FROM documents WHERE id = ? AND workspace_id = ?').bind(id, ws).first<DocRow>();
  if (!d) throw new AppError('not_found');
  return d;
}
const docOut = (d: DocRow) => ({
  id: d.id,
  filename: d.filename,
  pack: d.pack,
  status: d.status,
  page_count: d.page_count,
  pages_received: d.pages_received,
  scanned_pages: d.scanned_pages,
  size_bytes: d.size_bytes,
  has_summary: !!d.summary_text,
  created_at: d.created_at,
});

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export function createApp(deps: AppDeps = {}) {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();

  app.use('*', async (c, next) => {
    const id = newId('req');
    c.set('reqId', id);
    c.header('x-request-id', id);
    await next();
  });

  app.onError((err, c) => {
    const reqId = c.get('reqId');
    if (err instanceof AppError) {
      const callId = err.detail['callId'];
      return c.json(
        { error: { code: err.code, message: err.message, retryable: err.retryable, request_id: reqId, ...(typeof callId === 'string' ? { call_id: callId } : {}) } },
        err.status as 400,
      );
    }
    if (err instanceof ZodError) {
      return c.json({ error: { code: 'validation_failed', message: 'Invalid request.', retryable: false, request_id: reqId } }, 400);
    }
    // Never echo internals, document text, keys or stack traces to the client.
    console.error('internal_error', reqId, err instanceof Error ? err.name : 'unknown');
    return c.json({ error: { code: 'internal', message: 'Something went wrong on our side. Your documents are saved.', retryable: false, request_id: reqId } }, 500);
  });

  /* ------------------------------ public ------------------------------ */

  app.get('/api/health', async (c) =>
    c.json({ ok: true, version: VERSION, kill_switch: await isKilled(c.env), mock_prune: /127\.0\.0\.1|localhost/.test(c.env.PRUNE_BASE_URL ?? '') }),
  ); // E01

  app.post('/api/session', async (c) => {
    // E02. Limited per IP, because a brand-new visitor has no workspace for a per-workspace limit to key on.
    const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    await hit(c.env.DB, `ip:${(await sha256Hex(ip)).slice(0, 32)}`, 'session', 3600, numEnv(c.env.SESSION_LIMIT_PER_HOUR, 5));
    const id = newId('w');
    const token = randomToken();
    const limit = usdToMicro(numEnv(c.env.DEFAULT_BUDGET_USD, 0.25));
    const cap = usdToMicro(numEnv(c.env.PER_CALL_CAP_USD, 0.05));
    const t = nowSec();
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO workspaces (id, token_hash, created_at) VALUES (?, ?, ?)').bind(id, await sha256Hex(token), t),
      c.env.DB.prepare('INSERT INTO budgets (workspace_id, limit_micro, per_call_cap_micro, updated_at) VALUES (?, ?, ?, ?)').bind(id, limit, cap, t),
    ]);
    return c.json({
      workspace_id: id,
      token,
      budget: budgetOut({ limit_micro: limit, spent_micro: 0, reserved_micro: 0, per_call_cap_micro: cap }, c.env),
    });
  });

  /* ------------------------------ authenticated ------------------------------ */

  app.use('/api/*', async (c, next) => {
    const m = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '');
    if (!m) throw new AppError('unauthorized');
    const row = await c.env.DB.prepare('SELECT id FROM workspaces WHERE token_hash = ?').bind(await sha256Hex(m[1]!)).first<{ id: string }>();
    if (!row) throw new AppError('unauthorized');
    c.set('ws', row.id);
    await next();
  });

  app.get('/api/config', (c) => {
    // E03
    const tiers = loadTiers(c.env);
    return c.json({
      tiers: (['economy', 'standard', 'strong'] as const).map((t) => ({ tier: t, model: tiers[t].model })),
      limits: LIMITS,
      packs: PACK_IDS,
    });
  });

  app.get('/api/budget', async (c) => {
    // E04
    const b = await getBudget(c.env.DB, c.get('ws'));
    if (!b) throw new AppError('not_found');
    return c.json(budgetOut(b, c.env));
  });

  app.put('/api/budget', async (c) => {
    // E05
    const body = await parse(c, PutBudgetBody);
    const max = numEnv(c.env.MAX_WORKSPACE_BUDGET_USD, 1);
    if (body.limit_usd > max) throw new AppError('validation_failed', `The spending limit cannot be above $${max.toFixed(2)} for this demo.`);
    await setLimit(c.env.DB, c.get('ws'), usdToMicro(body.limit_usd));
    await logEvent(c.env, c.get('ws'), 'budget_set', null, { limit_usd: body.limit_usd });
    return c.json(budgetOut((await getBudget(c.env.DB, c.get('ws')))!, c.env));
  });

  /* ------------------------------ documents ------------------------------ */

  app.post('/api/documents', async (c) => {
    // E06
    const ws = c.get('ws');
    const body = await parse(c, CreateDocumentBody);
    if (body.size_bytes > LIMITS.maxFileBytes || body.page_count > LIMITS.maxPages) throw new AppError('payload_too_large');
    await hit(c.env.DB, ws, 'doc', 60, numEnv(c.env.DOC_LIMIT_PER_MIN, 10));
    const id = newId('d');
    const t = nowSec();
    await c.env.DB.prepare(
      `INSERT INTO documents (id, workspace_id, filename, pack, status, page_count, size_bytes, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'created', ?, ?, ?, ?)`,
    )
      .bind(id, ws, sanitizeText(body.filename), body.pack, body.page_count, body.size_bytes, t, t)
      .run();
    await logEvent(c.env, ws, 'document_created', id);
    return c.json({ document_id: id, status: 'created' });
  });

  app.put('/api/documents/:id/file', async (c) => {
    // E07
    const ws = c.get('ws');
    const doc = await getDoc(c.env, ws, c.req.param('id'));
    if (Number(c.req.header('content-length') ?? 0) > LIMITS.maxFileBytes) throw new AppError('payload_too_large');
    const buf = await c.req.arrayBuffer();
    if (buf.byteLength === 0) throw new AppError('validation_failed', 'The file is empty.');
    if (buf.byteLength > LIMITS.maxFileBytes) throw new AppError('payload_too_large');
    const key = `${ws}/${doc.id}.pdf`;
    await c.env.FILES.put(key, buf, { httpMetadata: { contentType: 'application/pdf' } });
    await c.env.DB.prepare(
      `UPDATE documents SET r2_key = ?, size_bytes = ?, status = CASE WHEN status = 'created' THEN 'uploading' ELSE status END, updated_at = ? WHERE id = ?`,
    )
      .bind(key, buf.byteLength, nowSec(), doc.id)
      .run();
    return c.json({ r2_key: key, size_bytes: buf.byteLength });
  });

  app.post('/api/documents/:id/pages', async (c) => {
    // E08
    const doc = await getDoc(c.env, c.get('ws'), c.req.param('id'));
    if (['ready', 'partial', 'processing'].includes(doc.status)) throw new AppError('conflict', 'This document is already indexed.');
    const body = await parse(c, PagesBody);
    const stmts = body.pages.map((p) => {
      if (p.page_no > doc.page_count) throw new AppError('validation_failed', `Page ${p.page_no} is beyond the declared page count.`);
      if (p.text.length > LIMITS.maxCharsPerPage) throw new AppError('validation_failed', `Page ${p.page_no} has too much text.`);
      const text = sanitizeText(p.text);
      // The server decides what counts as scanned; the client flag is only a hint.
      const scanned = text.trim().length < LIMITS.minCharsForText;
      return c.env.DB.prepare(
        `INSERT OR REPLACE INTO pages (document_id, page_no, text, source, needs_ocr, ocr_status) VALUES (?, ?, ?, ?, ?, 'none')`,
      ).bind(doc.id, p.page_no, text, scanned ? 'empty' : 'text', scanned ? 1 : 0);
    });
    await c.env.DB.batch(stmts);
    const n = await c.env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(needs_ocr), 0) AS s FROM pages WHERE document_id = ?')
      .bind(doc.id)
      .first<{ n: number; s: number }>();
    await c.env.DB.prepare('UPDATE documents SET pages_received = ?, scanned_pages = ?, status = ?, updated_at = ? WHERE id = ?')
      .bind(n!.n, n!.s, n!.n >= doc.page_count ? 'pages_received' : 'uploading', nowSec(), doc.id)
      .run();
    return c.json({ pages_received: n!.n, scanned_pages: n!.s });
  });

  app.post('/api/documents/:id/finalize', async (c) => {
    // E10 (MVP: section and index inside the request; the OCR workflow is a stretch)
    const ws = c.get('ws');
    const doc = await getDoc(c.env, ws, c.req.param('id'));
    await parse(c, FinalizeBody);
    if (doc.pages_received < doc.page_count) throw new AppError('conflict', 'Not all pages have been received yet.');
    const pages = (
      await c.env.DB.prepare('SELECT page_no, text FROM pages WHERE document_id = ? ORDER BY page_no').bind(doc.id).all<{ page_no: number; text: string }>()
    ).results;
    const sections = sectionPages(pages);
    // D1 allows 100 bound parameters per statement: 7 columns x 10 rows = 70.
    const inserts = chunk(sections, 10).map((rows) =>
      c.env.DB.prepare(
        `INSERT INTO sections (document_id, ordinal, title, text, page_start, page_end, token_est) VALUES ${rows.map(() => '(?,?,?,?,?,?,?)').join(',')}`,
      ).bind(...rows.flatMap((s) => [doc.id, s.ordinal, s.title, s.text, s.page_start, s.page_end, s.token_est])),
    );
    const status = doc.scanned_pages > 0 ? 'partial' : 'ready';
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM sections WHERE document_id = ?').bind(doc.id),
      ...inserts,
      c.env.DB.prepare('UPDATE documents SET status = ?, updated_at = ? WHERE id = ?').bind(status, nowSec(), doc.id),
    ]);
    await logEvent(c.env, ws, 'document_indexed', doc.id, { sections: sections.length, status });
    return c.json({ status, sections: sections.length });
  });

  app.get('/api/documents/:id', async (c) => {
    // E11
    const doc = await getDoc(c.env, c.get('ws'), c.req.param('id'));
    return c.json({ document: docOut(doc), progress: { pages_done: doc.pages_received, ocr_done: 0, ocr_skipped: doc.scanned_pages } });
  });

  app.get('/api/documents', async (c) => {
    // E12
    const rows = (await c.env.DB.prepare('SELECT * FROM documents WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC').bind(c.get('ws')).all<DocRow>()).results;
    return c.json({ documents: rows.map(docOut) });
  });

  app.delete('/api/documents/:id', async (c) => {
    // E13
    const doc = await getDoc(c.env, c.get('ws'), c.req.param('id'));
    if (doc.r2_key) await c.env.FILES.delete(doc.r2_key);
    await c.env.DB.prepare('DELETE FROM documents WHERE id = ?').bind(doc.id).run();
    return c.json({ deleted: true });
  });

  app.get('/api/documents/:id/pages/:n', async (c) => {
    // E14
    const doc = await getDoc(c.env, c.get('ws'), c.req.param('id'));
    const p = await c.env.DB.prepare('SELECT page_no, text, source FROM pages WHERE document_id = ? AND page_no = ?')
      .bind(doc.id, Number(c.req.param('n')))
      .first();
    if (!p) throw new AppError('not_found');
    return c.json(p);
  });

  app.get('/api/documents/:id/file', async (c) => {
    // E15
    const doc = await getDoc(c.env, c.get('ws'), c.req.param('id'));
    if (!doc.r2_key) throw new AppError('not_found');
    const obj = await c.env.FILES.get(doc.r2_key);
    if (!obj) throw new AppError('not_found');
    return new Response(obj.body as ReadableStream, { headers: { 'content-type': 'application/pdf', 'x-request-id': c.get('reqId') } });
  });

  /* ------------------------------ chats ------------------------------ */

  app.post('/api/chats', async (c) => {
    // E17
    const ws = c.get('ws');
    const body = await parse(c, CreateChatBody);
    const ids = [...new Set(body.document_ids)];
    const docs = (
      await c.env.DB.prepare(`SELECT id, filename, status FROM documents WHERE workspace_id = ? AND id IN (${ids.map(() => '?').join(',')})`)
        .bind(ws, ...ids)
        .all<{ id: string; filename: string; status: string }>()
    ).results;
    if (docs.length !== ids.length) throw new AppError('not_found');
    if (docs.some((d) => !['ready', 'partial'].includes(d.status))) throw new AppError('document_not_ready');
    const id = newId('c');
    const t = nowSec();
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO chats (id, workspace_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').bind(id, ws, sanitizeText(body.title ?? docs[0]!.filename), t, t),
      ...ids.map((d) => c.env.DB.prepare('INSERT INTO chat_documents (chat_id, document_id) VALUES (?, ?)').bind(id, d)),
    ]);
    return c.json({ chat_id: id });
  });

  app.get('/api/chats', async (c) => {
    // E18
    const rows = (await c.env.DB.prepare('SELECT id, title, created_at, updated_at FROM chats WHERE workspace_id = ? ORDER BY updated_at DESC, rowid DESC').bind(c.get('ws')).all()).results;
    return c.json({ chats: rows });
  });

  app.get('/api/chats/:id', async (c) => {
    // E19 (pending messages include their trace so far; the UI polls this for live progress)
    const ws = c.get('ws');
    const chat = await c.env.DB.prepare('SELECT id, title, created_at, updated_at FROM chats WHERE id = ? AND workspace_id = ?').bind(c.req.param('id'), ws).first();
    if (!chat) throw new AppError('not_found');
    const documents = (
      await c.env.DB.prepare('SELECT d.id, d.filename, d.pack, d.status FROM chat_documents cd JOIN documents d ON d.id = cd.document_id WHERE cd.chat_id = ?').bind(c.req.param('id')).all()
    ).results;
    const rows = (
      await c.env.DB.prepare(
        `SELECT id, role, content, mode, status, call_id, model_used, citations_json, pause_json, trace_json, created_at
         FROM messages WHERE chat_id = ? AND role IN ('user','assistant') ORDER BY created_at, rowid`,
      )
        .bind(c.req.param('id'))
        .all<Parameters<typeof toMessageOut>[0]>()
    ).results;
    const summary = await c.env.DB.prepare('SELECT text, created_at FROM summaries WHERE chat_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').bind(c.req.param('id')).first();
    // Each finished answer carries its usage (cost across all its calls, model, receipt status), so a reloaded chat still shows it.
    const messages = await Promise.all(
      rows.map(async (r) => ({ ...toMessageOut(r), usage: r.role === 'assistant' && r.status === 'done' ? await usageFor(c.env.DB, r.id) : null })),
    );
    return c.json({ chat, documents, messages, summary: summary ?? null });
  });

  app.delete('/api/chats/:id', async (c) => {
    // E20
    const r = await c.env.DB.prepare('DELETE FROM chats WHERE id = ? AND workspace_id = ?').bind(c.req.param('id'), c.get('ws')).run();
    if ((r.meta.changes ?? 0) === 0) throw new AppError('not_found');
    return c.json({ deleted: true });
  });

  app.post('/api/chats/:id/messages', async (c) => {
    // E21
    const b = await parse(c, AskBody);
    const result = await ask(c.env, execOf(c), c.get('ws'), c.req.param('id'), { clientMsgId: b.client_msg_id, content: b.content, mode: b.mode, output: b.output }, deps.llm);
    return c.json(result);
  });

  app.post('/api/chats/:id/messages/:mid/resume', async (c) => {
    // E22
    const b = await parse(c, ResumeBody);
    return c.json(await resumePaused(c.env, execOf(c), c.get('ws'), c.req.param('id'), c.req.param('mid'), b.action, deps.llm));
  });

  app.get('/api/chats/:id/summary', async (c) => {
    // E30: Markdown export built from stored data only. No model call, no cost.
    const ws = c.get('ws');
    const chat = await c.env.DB.prepare('SELECT id, title FROM chats WHERE id = ? AND workspace_id = ?').bind(c.req.param('id'), ws).first<{ id: string; title: string }>();
    if (!chat) throw new AppError('not_found');
    const docs = (
      await c.env.DB.prepare('SELECT d.id, d.filename, d.page_count, d.summary_text FROM chat_documents cd JOIN documents d ON d.id = cd.document_id WHERE cd.chat_id = ?').bind(chat.id).all<{ id: string; filename: string; page_count: number; summary_text: string | null }>()
    ).results;
    const nameOf = new Map(docs.map((d) => [d.id, d.filename]));
    const summary = await c.env.DB.prepare('SELECT text FROM summaries WHERE chat_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').bind(chat.id).first<{ text: string }>();
    const msgs = (
      await c.env.DB.prepare(`SELECT id, role, content, status, model_used, citations_json FROM messages WHERE chat_id = ? AND role IN ('user','assistant') ORDER BY created_at, rowid`).bind(chat.id).all<{ id: string; role: string; content: string; status: string; model_used: string | null; citations_json: string | null }>()
    ).results;
    const lines: string[] = [`# ${chat.title}`, '', `Exported ${new Date().toISOString()}`, '', '## Documents'];
    for (const d of docs) lines.push(`- ${d.filename} (${d.page_count} pages)${d.summary_text ? `: ${d.summary_text}` : ''}`);
    lines.push('', '## Conversation summary', '', summary?.text ?? 'No saved summary yet.', '', '## Questions and answers', '');
    let q = 0;
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i]!;
      if (m.role === 'user') {
        q++;
        lines.push(`### Question ${q}`, '', m.content, '');
      } else if (m.status === 'done') {
        const cites = parseJsonSafe<{ document_id: string; page_start: number; page_end: number }[]>(m.citations_json, []);
        const u = await usageFor(c.env.DB, m.id);
        lines.push(m.content, '');
        const meta = [
          cites.length ? `Citations: ${cites.map((x) => `p.${x.page_start}${x.page_end !== x.page_start ? `-${x.page_end}` : ''} (${nameOf.get(x.document_id) ?? 'document'})`).join(', ')}` : '',
          m.model_used ? `Model: ${m.model_used}` : '',
          u ? `Cost: $${u.cost_usd.toFixed(6)}` : '',
          u ? `Receipt: ${u.verify_status}` : '',
        ].filter(Boolean);
        if (meta.length) lines.push(`*${meta.join(' · ')}*`, '');
      } else {
        lines.push(`*(${m.status})*`, '');
      }
    }
    return new Response(lines.join('\n'), {
      headers: { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': 'attachment; filename="athena-summary.md"', 'x-request-id': c.get('reqId') },
    });
  });

  /* ------------------------------ receipts, retry, usage, export ------------------------------ */

  app.get('/api/receipts/:call_id', async (c) => {
    // E23
    const row = await c.env.DB.prepare(
      `SELECT id, purpose, tier, model_used, status, attempt, cost_micro, cost_without_prune_micro, cache_hit, prompt_tokens, completion_tokens, receipt_json, verify_status, created_at, finished_at
       FROM llm_calls WHERE id = ? AND workspace_id = ?`,
    )
      .bind(c.req.param('call_id'), c.get('ws'))
      .first<Record<string, unknown> & { receipt_json: string | null; verify_status: string; cost_micro: number | null; cost_without_prune_micro: number | null; cache_hit: number | null }>();
    if (!row) throw new AppError('not_found');
    const { receipt_json, cost_micro, cost_without_prune_micro, cache_hit, ...call } = row;
    return c.json({
      call: { ...call, cost_usd: cost_micro == null ? null : microToUsd(cost_micro), cost_without_prune_usd: cost_without_prune_micro == null ? null : microToUsd(cost_without_prune_micro), cache_hit: cache_hit === 1 },
      receipt_json,
      verify_status: row.verify_status,
    });
  });

  app.post('/api/receipts/:call_id/verify', async (c) => {
    // E24
    const row = await c.env.DB.prepare('SELECT id, receipt_json FROM llm_calls WHERE id = ? AND workspace_id = ?').bind(c.req.param('call_id'), c.get('ws')).first<{ id: string; receipt_json: string | null }>();
    if (!row) throw new AppError('not_found');
    if (!row.receipt_json) throw new AppError('receipt_missing');
    const status = await verifyReceipt(c.env, row.receipt_json, deps.llm?.fetch ?? fetch);
    await c.env.DB.prepare('UPDATE llm_calls SET verify_status = ? WHERE id = ?').bind(status, row.id).run();
    await logEvent(c.env, c.get('ws'), 'receipt_verified', row.id, { status });
    return c.json({ verify_status: status });
  });

  app.post('/api/calls/:call_id/retry', async (c) => {
    // E25
    return c.json(await retryCall(c.env, execOf(c), c.get('ws'), c.req.param('call_id'), deps.llm));
  });

  app.get('/api/usage', async (c) => {
    // E26
    const ws = c.get('ws');
    const b = await getBudget(c.env.DB, ws);
    const t = await c.env.DB.prepare(
      `SELECT COUNT(*) AS calls, COALESCE(SUM(cache_hit), 0) AS hits,
         COALESCE(SUM(CASE WHEN verify_status = 'verified' THEN 1 ELSE 0 END), 0) AS verified,
         COALESCE(SUM(CASE WHEN receipt_json IS NOT NULL THEN 1 ELSE 0 END), 0) AS receipts
       FROM llm_calls WHERE workspace_id = ? AND status = 'ok'`,
    )
      .bind(ws)
      .first<{ calls: number; hits: number; verified: number; receipts: number }>();
    const rows = (
      await c.env.DB.prepare(
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
    const spent = b?.spent_micro ?? 0;
    const byChat = [...perChat.keys()].map((id) => {
      const s = series.filter((x) => x.chat_id === id);
      return { chat_id: id, answers: s.length, cost_usd: Number(s.reduce((a, x) => a + x.cost_usd, 0).toFixed(6)) };
    });
    return c.json({
      totals: {
        spent_usd: microToUsd(spent),
        calls: t!.calls,
        answers: rows.length,
        avg_cost_per_answer_usd: rows.length ? microToUsd(Math.round(rows.reduce((a, r) => a + r.cost, 0) / rows.length)) : 0,
        cache_hits: t!.hits,
        receipts: t!.receipts,
        receipts_verified: t!.verified,
      },
      by_chat: byChat,
      series,
    });
  });

  app.get('/api/export/receipts.jsonl', async (c) => {
    // E27: each line keeps the receipt's raw bytes as a string, so signatures can be re-checked offline.
    const rows = (
      await c.env.DB.prepare(
        `SELECT id, created_at, purpose, tier, model_used, cost_micro, cost_without_prune_micro, cache_hit, verify_status, receipt_json
         FROM llm_calls WHERE workspace_id = ? AND receipt_json IS NOT NULL ORDER BY created_at, rowid`,
      )
        .bind(c.get('ws'))
        .all<{ id: string; created_at: number; purpose: string; tier: string; model_used: string | null; cost_micro: number | null; cost_without_prune_micro: number | null; cache_hit: number | null; verify_status: string; receipt_json: string }>()
    ).results;
    const body = rows
      .map((r) => JSON.stringify({ call_id: r.id, created_at: r.created_at, purpose: r.purpose, tier: r.tier, model_used: r.model_used, cost_micro: r.cost_micro, cost_without_prune_micro: r.cost_without_prune_micro, cache_hit: r.cache_hit === 1, verify_status: r.verify_status, receipt_raw: r.receipt_json }))
      .join('\n');
    return new Response(body ? body + '\n' : '', { headers: { 'content-type': 'application/x-ndjson', 'x-request-id': c.get('reqId') } });
  });

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Not found.', retryable: false, request_id: c.get('reqId') } }, 404));

  return app;
}

export { readMessage };
