// Measures how often the no-AI citation and number check is wrong, on a human-labelled set, and how well a
// retrieval-strength threshold separates answerable questions from ones the document cannot answer.
//
//   node bench/gate_eval/run.ts            # prints the rates, writes reports/gate_eval.json and reports/gate_eval.sql
//
// Apply the SQL to the database that serves /api/usage so the app shows the rate:
//   npx wrangler d1 execute <db> --file reports/gate_eval.sql
// Nothing here calls a model or the network.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildContext, PLANS } from '../../src/context.ts';
import { runGate } from '../../src/gate.ts';
import { sectionPages } from '../../src/sectioner.ts';
import { FakeD1 } from '../../tests/helpers.ts';

export interface Labelled {
  id: string;
  question: string;
  answer: string;
  citations: { page: number; quote?: string }[];
  pages: Record<string, string>;
  sent: number[];
  label: 'supported' | 'not_supported';
  note: string;
}

export interface GateEval {
  n: number;
  true_pass: number;
  true_fail: number;
  false_pass: number;
  false_fail: number;
  precision: number | null;
  recall: number | null;
  false_pass_rate: number;
  false_fail_rate: number;
  errors: { id: string; label: string; gate: string; note: string; detail: string }[];
}

const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

/** Positive = "the gate says this answer is supported". A false pass is a wrong answer the gate let through. */
export function evaluateGate(rows: Labelled[]): GateEval {
  let tp = 0, tn = 0, fp = 0, fn = 0;
  const errors: GateEval['errors'] = [];
  for (const r of rows) {
    const res = runGate({
      answer: r.answer,
      citations: r.citations,
      pageText: (_d, p) => r.pages[String(p)],
      wasSent: (_d, p) => r.sent.includes(p),
    });
    const supported = r.label === 'supported';
    if (res.pass && supported) tp++;
    else if (!res.pass && !supported) tn++;
    else {
      if (res.pass) fp++;
      else fn++;
      errors.push({ id: r.id, label: r.label, gate: res.pass ? 'pass' : 'fail', note: r.note, detail: res.failures.map((f) => f.detail).join('; ') });
    }
  }
  const n = rows.length;
  return { n, true_pass: tp, true_fail: tn, false_pass: fp, false_fail: fn, precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn), false_pass_rate: fp / n, false_fail_rate: fn / n, errors };
}

export interface AbstainEval {
  n: number;
  strengths: { q: string; answerable: boolean; strength: number }[];
  sweep: { min_strength: number; answerable_kept: number; answerable_total: number; unanswerable_abstained: number; unanswerable_total: number }[];
}

/** Real retrieval over a small document (the same FTS5 search the app uses), scored by bm25 strength. */
export async function evaluateAbstain(spec: { document: string[]; questions: { q: string; answerable: boolean }[] }): Promise<AbstainEval> {
  const db = new FakeD1();
  const raw = db.raw;
  raw.exec("INSERT INTO workspaces (id, token_hash, created_at) VALUES ('w', 'h', 1)");
  raw.exec("INSERT INTO documents (id, workspace_id, filename, status, page_count, created_at, updated_at) VALUES ('d', 'w', 'eval.pdf', 'ready', " + spec.document.length + ', 1, 1)');
  raw.exec("INSERT INTO chats (id, workspace_id, created_at, updated_at) VALUES ('c', 'w', 1, 1)");
  raw.exec("INSERT INTO chat_documents (chat_id, document_id) VALUES ('c', 'd')");
  const sections = sectionPages(spec.document.map((text, i) => ({ page_no: i + 1, text })));
  for (const s of sections) {
    raw.prepare('INSERT INTO sections (document_id, ordinal, title, text, page_start, page_end, token_est) VALUES (?, ?, ?, ?, ?, ?, ?)').run('d', s.ordinal, s.title, s.text, s.page_start, s.page_end, s.token_est);
  }
  const strengths: AbstainEval['strengths'] = [];
  for (const q of spec.questions) {
    const b = await buildContext(db as never, { chatId: 'c', question: q.q, mode: 'answer', plan: PLANS[0]!, excludeMessageIds: [] });
    strengths.push({ q: q.q, answerable: q.answerable, strength: b.scores.length ? -b.scores[0]! : 0 });
  }
  const cuts = [0, ...new Set(strengths.map((s) => s.strength).filter((x) => x > 0))].sort((a, b) => a - b);
  const yes = strengths.filter((s) => s.answerable);
  const no = strengths.filter((s) => !s.answerable);
  const sweep = cuts.map((c) => ({
    min_strength: c,
    answerable_kept: yes.filter((s) => s.strength >= c && s.strength > 0).length,
    answerable_total: yes.length,
    unanswerable_abstained: no.filter((s) => s.strength < c || s.strength === 0).length,
    unanswerable_total: no.length,
  }));
  return { n: strengths.length, strengths, sweep };
}

async function main() {
  const root = new URL('./', import.meta.url);
  const rows = readFileSync(new URL('labelled.jsonl', root), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Labelled);
  const g = evaluateGate(rows);
  const ab = await evaluateAbstain(JSON.parse(readFileSync(new URL('abstain.json', root), 'utf8')));
  // The threshold to use is the largest one that still keeps every answerable question.
  const safe = [...ab.sweep].reverse().find((s) => s.answerable_kept === s.answerable_total);
  const report = { generated_at: new Date().toISOString(), gate: g, abstain: ab, suggested_abstain_min_score: safe?.min_strength ?? null };

  const out = new URL('../../reports/', import.meta.url);
  mkdirSync(out, { recursive: true });
  writeFileSync(new URL('gate_eval.json', out), JSON.stringify(report, null, 2) + '\n');
  const thresholds = JSON.stringify({ abstain_min_score: safe?.min_strength ?? null, labelled_set: 'bench/gate_eval/labelled.jsonl' });
  writeFileSync(
    new URL('gate_eval.sql', out),
    `INSERT INTO gate_eval (n, false_pass, false_fail, precision, recall, thresholds_json, created_at) VALUES (${g.n}, ${g.false_pass}, ${g.false_fail}, ${g.precision ?? 'NULL'}, ${g.recall ?? 'NULL'}, '${thresholds.replaceAll("'", "''")}', ${Math.floor(Date.now() / 1000)});\n`,
  );

  const pct = (x: number | null) => (x === null ? 'n/a' : (x * 100).toFixed(1) + '%');
  console.log(`Citation and number check on ${g.n} labelled examples`);
  console.log(`  false pass (wrong answer let through): ${g.false_pass}  (${pct(g.false_pass_rate)})`);
  console.log(`  false fail (right answer rejected)   : ${g.false_fail}  (${pct(g.false_fail_rate)})`);
  console.log(`  precision ${pct(g.precision)}   recall ${pct(g.recall)}`);
  for (const e of g.errors) console.log(`    ${e.id} [${e.label}, gate ${e.gate}] ${e.note}${e.detail ? ' | ' + e.detail : ''}`);
  console.log(`Abstaining on ${ab.n} questions (${ab.sweep[0]?.answerable_total} answerable, ${ab.sweep[0]?.unanswerable_total} not): suggested ABSTAIN_MIN_SCORE = ${safe?.min_strength ?? 'none'}`);
  console.log('Wrote reports/gate_eval.json and reports/gate_eval.sql');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
