// Benchmark (athena.md 4.6). Four arms over the same synthetic documents and questions, all through Prune:
//   A  naive extreme   whole document + whole history every time, strong model, no cache
//   T  typical         what chat-with-PDF apps do: top-8 retrieved sections + whole history, strong model, no cache
//   B  Athena          the real app (retrieval, memory window, tiering, cache, budget) over its own API
//   C  Athena, re-asked the same questions again in a fresh chat (shows exact-repeat caching only)
//
//   npm run bench                              # no key: runs against the in-process MOCK. Numbers are NOT results.
//   npm run bench -- --docs 1 --pages 30 --facts 6 --confirm-spend      # real, with PRUNE_API_KEY set
//
// Cost always comes from signed Prune receipts. Accuracy is a gold-answer match; citation is a gold-page match.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildContext, SYSTEM_PROMPT_V1 } from '../src/context.ts';
import { AppError } from '../src/errors.ts';
import { callModel } from '../src/llm.ts';
import { loadTiers } from '../src/tiers.ts';
import { estTokens, sha256Hex } from '../src/util.ts';
import { makeHarness } from '../tests/harness.ts';
import { makeWorkspace, rowOf } from '../tests/helpers.ts';
import { startMock } from '../tools/mock-prune/mock.mjs';
import { buildDataset } from './dataset.mjs';
import { citedPages, hasAny, mean, nonInferiority, pairedBootstrap, percentile } from './stats.mjs';

class BenchStop extends Error {}
const usd = (micro) => micro / 1e6;
const fmt = (n, d = 6) => (n === null || n === undefined || Number.isNaN(n) ? 'n/a' : `$${n.toFixed(d)}`);
const pct = (x) => `${(x * 100).toFixed(1)}%`;

export function estimateRunUsd(dataset, tiers) {
  let total = 0;
  const out = 120; // typical answer tokens
  for (const doc of dataset.docs) {
    const docTokens = estTokens(doc.pages.join('\n')) + doc.pages.length * 5;
    doc.facts.forEach((_, i) => {
      const hist = 120 * i;
      total += ((docTokens + hist + 200) * tiers.strong.inPerM + out * tiers.strong.outPerM) / 1e6; // A
      total += ((3400 + hist) * tiers.strong.inPerM + out * tiers.strong.outPerM) / 1e6; // T
      total += 2 * ((3200 + Math.min(4, i) * 120) * tiers.standard.inPerM + out * tiers.standard.outPerM) / 1e6; // B and C, upper bound
    });
  }
  return total;
}

export async function runBench(opts) {
  const { baseUrl, key, seed = 1, docs = 3, pages = 30, facts = 12, maxUsd = 3, arms = ['A', 'T', 'B', 'C'], mock = false, log = () => {} } = opts;
  const dataset = buildDataset({ seed, docs, pages, facts });
  const h = await makeHarness({ url: baseUrl }, {
    PRUNE_API_KEY: key,
    PRUNE_BASE_URL: baseUrl,
    MSG_LIMIT_PER_MIN: '1000000',
    DOC_LIMIT_PER_MIN: '1000000',
    SESSION_LIMIT_PER_HOUR: '1000',
    ...(process.env.MODEL_TIERS ? { MODEL_TIERS: process.env.MODEL_TIERS } : {}),
  });
  const tiers = loadTiers(h.env);
  const limit = Math.round(maxUsd * 1e6 * 2);
  const state = { spentMicro: 0, stopped: null };
  const results = [];

  const record = (arm, d, i, fact, answer, extra) => {
    const correct = hasAny(answer, fact.gold);
    const cited = new Set([...citedPages(answer), ...(extra.citedPages ?? [])]);
    results.push({
      arm,
      doc: d,
      idx: i + 1,
      key: `${d}:${i + 1}`,
      fact: fact.key,
      correct,
      fellForDistractor: !correct && fact.wrong.length > 0 && hasAny(answer, fact.wrong),
      citationOk: cited.has(fact.page),
      costMicro: extra.costMicro ?? 0,
      promptTokens: extra.promptTokens ?? 0,
      cacheHit: !!extra.cacheHit,
      tier: extra.tier ?? null,
      error: extra.error ?? null,
      answer: String(answer).slice(0, 300),
    });
    state.spentMicro += extra.costMicro ?? 0;
    if (state.spentMicro > maxUsd * 1e6) {
      state.stopped = `spend reached the --max-usd cap of $${maxUsd}`;
      throw new BenchStop(state.stopped);
    }
    if (results.length % 10 === 0) log(`  ${results.length} answers, ${fmt(usd(state.spentMicro), 4)} spent`);
  };

  // ---- Direct arms (A, T): they call llm.ts like any caller, so every call is still through Prune ----
  async function directArm(arm) {
    const ws = await makeWorkspace(h.env, { limitMicro: limit, perCallMicro: limit });
    for (let d = 0; d < dataset.docs.length; d++) {
      const doc = dataset.docs[d];
      const history = [];
      let chatId = null;
      if (arm === 'T') {
        const up = await h.upload(ws.token, 'general', doc.pages);
        chatId = await h.newChat(ws.token, up.id);
      }
      for (let i = 0; i < doc.facts.length; i++) {
        const fact = doc.facts[i];
        let messages;
        if (arm === 'A') {
          const whole = doc.pages.map((t, p) => `[Page ${p + 1}]\n${t}`).join('\n\n');
          messages = [
            { role: 'system', content: SYSTEM_PROMPT_V1 },
            ...history,
            { role: 'user', content: `<untrusted_document id="doc" name="${doc.filename}" pages="1-${doc.pages.length}">\n${whole}\n</untrusted_document>\n\n[Question]\n${fact.q}` },
          ];
        } else {
          const ctx = await buildContext(h.env.DB, { chatId, question: fact.q, mode: 'answer', plan: { maxSections: 8, recentMessages: 0, relatedMessages: 0 }, excludeMessageIds: [] });
          messages = [ctx.messages[0], ...history, ctx.messages[ctx.messages.length - 1]];
        }
        try {
          const r = await callModel(h.env, {
            workspaceId: ws.id, runId: `${arm}-${d}-${i}`, purpose: 'answer', workload: 'rag', cache: 'off', tier: 'strong',
            messages, promptTokens: estTokens(messages.map((m) => m.content).join('\n')), maxOutputTokens: 600, runBudgetMicro: limit,
            idempotencyKey: `${arm}:${d}:${i}`,
          });
          history.push({ role: 'user', content: fact.q }, { role: 'assistant', content: r.text });
          record(arm, d, i, fact, r.text, { costMicro: r.costMicro, promptTokens: r.promptTokens, cacheHit: r.cacheHit, tier: r.tier });
        } catch (e) {
          if (e instanceof BenchStop) throw e;
          const code = e instanceof AppError ? e.code : 'internal';
          record(arm, d, i, fact, '', { error: code });
          if (code === 'budget_exhausted') throw new BenchStop(`${arm}: budget exhausted`);
        }
      }
    }
    return ws;
  }

  // ---- Athena arms (B, C): the real API, one chat per document ----
  const athena = { token: null, docIds: [] };
  async function athenaArm(arm) {
    if (!athena.token) {
      athena.token = await h.session();
      for (const doc of dataset.docs) athena.docIds.push((await h.upload(athena.token, 'general', doc.pages)).id);
      await h.env.DB.prepare('UPDATE budgets SET limit_micro = ?, per_call_cap_micro = ? WHERE workspace_id = (SELECT id FROM workspaces WHERE token_hash = ?)').bind(limit, limit, await sha256Hex(athena.token)).run();
    }
    for (let d = 0; d < dataset.docs.length; d++) {
      const doc = dataset.docs[d];
      const chat = await h.newChat(athena.token, athena.docIds[d]);
      for (let i = 0; i < doc.facts.length; i++) {
        const fact = doc.facts[i];
        const r = await h.askQ(athena.token, chat, fact.q, `${arm}-${d}-${i}`);
        if (r.status !== 200 || r.json.message.status !== 'done') {
          const why = r.status !== 200 ? r.json?.error?.code ?? `http_${r.status}` : r.json.message.status === 'paused' ? `paused:${r.json.message.pause.reason}` : r.json.message.status;
          record(arm, d, i, fact, '', { error: why });
          if (/budget/.test(why) || why.startsWith('paused')) throw new BenchStop(`${arm}: ${why}`);
          continue;
        }
        const u = r.json.usage;
        const row = await rowOf(h.env, 'SELECT prompt_tokens FROM llm_calls WHERE id = ?', u.call_id);
        record(arm, d, i, fact, r.json.message.content, {
          costMicro: Math.round(u.cost_usd * 1e6),
          promptTokens: row?.prompt_tokens ?? 0,
          cacheHit: u.cache_hit,
          tier: u.tier,
          citedPages: r.json.message.citations.flatMap((c) => Array.from({ length: c.page_end - c.page_start + 1 }, (_, k) => c.page_start + k)),
        });
      }
    }
  }

  const workspaces = {};
  try {
    for (const arm of arms) {
      log(`arm ${arm}`);
      if (arm === 'A' || arm === 'T') workspaces[arm] = await directArm(arm);
      else await athenaArm(arm);
    }
  } catch (e) {
    if (!(e instanceof BenchStop)) throw e;
    state.stopped = state.stopped ?? e.message;
  }

  const receipts = {};
  for (const arm of ['A', 'T']) if (workspaces[arm]) receipts[arm] = (await h.call('GET', '/api/export/receipts.jsonl', workspaces[arm].token)).text;
  if (athena.token) receipts.athena = (await h.call('GET', '/api/export/receipts.jsonl', athena.token)).text;

  const summary = summarize(results, arms);
  const meta = { seed, docs, pages, facts, maxUsd, baseUrl, mock, stopped: state.stopped, tiers: Object.fromEntries(Object.entries(tiers).map(([k, v]) => [k, v.model])), questionsPerArm: dataset.docs.reduce((n, d) => n + d.facts.length, 0) };
  return { meta, summary, results, receipts, report: renderReport(meta, summary) };
}

export function summarize(results, arms) {
  const out = {};
  for (const arm of arms) {
    const rs = results.filter((r) => r.arm === arm);
    if (!rs.length) continue;
    const ok = rs.filter((r) => !r.error);
    const costs = rs.map((r) => usd(r.costMicro));
    const byIdx = new Map();
    for (const r of rs) {
      const a = byIdx.get(r.idx) ?? { cost: [], prompt: [] };
      a.cost.push(usd(r.costMicro));
      a.prompt.push(r.promptTokens);
      byIdx.set(r.idx, a);
    }
    const idxs = [...byIdx.keys()].sort((a, b) => a - b);
    const costCurve = idxs.map((i) => mean(byIdx.get(i).cost));
    const promptCurve = idxs.map((i) => mean(byIdx.get(i).prompt));
    out[arm] = {
      n: rs.length,
      errors: rs.length - ok.length,
      accuracy: mean(rs.map((r) => (r.correct ? 1 : 0))),
      citationRate: mean(rs.map((r) => (r.citationOk ? 1 : 0))),
      fellForDistractor: rs.filter((r) => r.fellForDistractor).length,
      avgCostUsd: mean(costs),
      totalCostUsd: costs.reduce((a, b) => a + b, 0),
      p50CostUsd: percentile(costs, 50),
      p95CostUsd: percentile(costs, 95),
      avgPromptTokens: mean(rs.map((r) => r.promptTokens)),
      cacheHitRate: mean(rs.map((r) => (r.cacheHit ? 1 : 0))),
      costCurve,
      promptCurve,
      lastOverFirstCost: costCurve[0] > 0 ? costCurve[costCurve.length - 1] / costCurve[0] : null,
      lastOverFirstPrompt: promptCurve[0] > 0 ? promptCurve[promptCurve.length - 1] / promptCurve[0] : null,
    };
  }
  const aligned = (x, y) => {
    const ym = new Map(results.filter((r) => r.arm === y).map((r) => [r.key, r.correct ? 1 : 0]));
    const xs = results.filter((r) => r.arm === x && ym.has(r.key));
    return [xs.map((r) => (r.correct ? 1 : 0)), xs.map((r) => ym.get(r.key))];
  };
  const cmp = {};
  for (const base of ['T', 'A']) {
    if (out.B && out[base]) {
      const [b, t] = aligned('B', base);
      const ci = pairedBootstrap(b, t, { seed: 7 });
      cmp[`B_vs_${base}`] = { ...ci, verdict: nonInferiority(ci, 0.02), costRatio: out[base].avgCostUsd && out.B.avgCostUsd ? out[base].avgCostUsd / out.B.avgCostUsd : null, promptRatio: out.B.avgPromptTokens ? out[base].avgPromptTokens / out.B.avgPromptTokens : null };
    }
  }
  return { arms: out, comparisons: cmp };
}

export function renderReport(meta, s) {
  const L = [];
  L.push('# Athena benchmark report', '');
  if (meta.mock) {
    L.push('> **MOCK RUN. Not results.** Answers are canned and every call costs the same flat amount, so accuracy and cost below mean nothing. Only the **prompt sizes** are real (they show how much each arm sends). Run with a Prune key for results.', '');
  } else {
    L.push(`> Real run against ${meta.baseUrl}. Tiers: ${Object.entries(meta.tiers).map(([k, v]) => `${k}=${v}`).join(', ')}. Cost is read from signed Prune receipts.`, '');
  }
  if (meta.stopped) L.push(`> **Run stopped early:** ${meta.stopped}. Partial data.`, '');
  L.push(`Synthetic documents (seed ${meta.seed}): ${meta.docs} documents x ${meta.pages} pages, ${meta.questionsPerArm} questions per arm. Gold answers and gold pages are known by construction.`, '');
  L.push('| Arm | Questions | Accuracy | Right page cited | Avg cost / answer | p95 cost | Avg prompt tokens | Cache hits | Errors |', '|---|---|---|---|---|---|---|---|---|');
  const names = { A: 'A naive (whole doc + history)', T: 'T typical (top-8 + history)', B: 'B Athena', C: 'C Athena, same questions re-asked' };
  for (const [arm, a] of Object.entries(s.arms)) {
    L.push(`| ${names[arm]} | ${a.n} | ${pct(a.accuracy)} | ${pct(a.citationRate)} | ${fmt(a.avgCostUsd)} | ${fmt(a.p95CostUsd)} | ${Math.round(a.avgPromptTokens)} | ${pct(a.cacheHitRate)} | ${a.errors} |`);
  }
  L.push('', '## Follow-up curve (average per question number)', '', '| Question # | ' + Object.keys(s.arms).map((a) => `${a} cost`).join(' | ') + ' | ' + Object.keys(s.arms).map((a) => `${a} prompt tok`).join(' | ') + ' |', '|---|' + Object.keys(s.arms).map(() => '---|').join('') + Object.keys(s.arms).map(() => '---|').join(''));
  const k = Math.max(...Object.values(s.arms).map((a) => a.costCurve.length));
  for (let i = 0; i < k; i++) {
    L.push(`| ${i + 1} | ` + Object.values(s.arms).map((a) => fmt(a.costCurve[i], 6)).join(' | ') + ' | ' + Object.values(s.arms).map((a) => (a.promptCurve[i] === undefined ? 'n/a' : Math.round(a.promptCurve[i]))).join(' | ') + ' |');
  }
  L.push('', 'Last question over first (cost / prompt tokens): ' + Object.entries(s.arms).map(([arm, a]) => `${arm} ${a.lastOverFirstCost === null ? 'n/a' : a.lastOverFirstCost.toFixed(2) + 'x'} / ${a.lastOverFirstPrompt === null ? 'n/a' : a.lastOverFirstPrompt.toFixed(2) + 'x'}`).join(', '));
  L.push('', '## Is Athena as accurate as the baseline?', '');
  for (const [name, c] of Object.entries(s.comparisons)) {
    L.push(`- **${name.replace('_vs_', ' vs ')}:** accuracy difference ${(c.diff * 100).toFixed(1)} points, 95% interval [${(c.lo * 100).toFixed(1)}, ${(c.hi * 100).toFixed(1)}] over ${c.n} questions. Non-inferiority at 2 points: **${c.verdict}**. Baseline costs ${c.costRatio ? c.costRatio.toFixed(2) + 'x' : 'n/a'} as much per answer and sends ${c.promptRatio ? c.promptRatio.toFixed(2) + 'x' : 'n/a'} as many prompt tokens.`);
  }
  L.push('', '`pass` means even the pessimistic end of the interval is within 2 points; `inconclusive` means too few questions to say. A savings claim is only valid on `pass`.', '', '## Limits', '', '- Synthetic documents with keyword-friendly questions: real contracts are messier. Treat these as a controlled comparison, not a field study.', '- Cache hits in arm C come from exact repeats of the same chat; fresh questions rarely hit the cache.', '- Accuracy is a gold-string match, so a correct answer worded differently (for example "sixty days") is counted wrong, equally for every arm.');
  return L.join('\n') + '\n';
}

/* ---------------------------------- CLI ---------------------------------- */

function parseArgs(argv) {
  const a = { docs: 3, pages: 30, facts: 12, seed: 1, maxUsd: 3, arms: 'A,T,B,C', out: new URL('./out/', import.meta.url), confirmSpend: false, mock: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--confirm-spend') a.confirmSpend = true;
    else if (k === '--mock') a.mock = true;
    else if (k.startsWith('--')) a[k.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = argv[++i];
  }
  for (const n of ['docs', 'pages', 'facts', 'seed', 'maxUsd']) a[n] = Number(a[n]);
  return a;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const key = process.env.PRUNE_API_KEY;
  const real = !!key && !a.mock;
  let mockServer = null;
  let baseUrl;
  if (real) baseUrl = (process.env.PRUNE_BASE_URL ?? 'https://api.withprune.com/v1').replace(/\/$/, '');
  else {
    mockServer = await startMock();
    baseUrl = mockServer.url;
    console.log('No PRUNE_API_KEY (or --mock): running against the in-process MOCK. The output is NOT a result.');
  }
  if (real) {
    const ds = buildDataset({ seed: a.seed, docs: a.docs, pages: a.pages, facts: a.facts });
    const est = estimateRunUsd(ds, loadTiers({ MODEL_TIERS: process.env.MODEL_TIERS }));
    console.log(`Real run: ${a.docs} docs x ${a.pages} pages, ${ds.docs.reduce((n, d) => n + d.facts.length, 0)} questions x 4 arms, hard cap $${a.maxUsd}. Rough estimate: $${est.toFixed(2)}.`);
    if (!a.confirmSpend) {
      console.log('This spends real money on your Prune key. Re-run with --confirm-spend to proceed (use --docs 1 --facts 6 for a cheap first try).');
      process.exit(2);
    }
  }
  const res = await runBench({ baseUrl, key: real ? key : 'mock-key', seed: a.seed, docs: a.docs, pages: a.pages, facts: a.facts, maxUsd: a.maxUsd, arms: a.arms.split(','), mock: !real, log: (m) => console.log(m) });
  const dir = a.out;
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL('report.md', dir), res.report);
  writeFileSync(new URL('results.json', dir), JSON.stringify({ meta: res.meta, summary: res.summary, results: res.results }, null, 2));
  for (const [name, text] of Object.entries(res.receipts)) writeFileSync(new URL(`receipts-${name}.jsonl`, dir), text);
  console.log('\n' + res.report);
  console.log(`Wrote report.md, results.json and receipts-*.jsonl to ${fileURLToPath(dir)}`);
  console.log('Verify the receipts yourself: node scripts/verify-receipts.mjs bench/out/receipts-athena.jsonl');
  await mockServer?.close();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
