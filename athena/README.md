# Athena backend

Document Q&A on Cloudflare Workers + D1 + R2 where **every model call goes through Prune**, cost comes from signed receipts, and spending is checked before each call. Plan: `../athena.md`. Component status: `COMPONENTS.md`. UI copy: `../athena-content.md`.

## Run the tests (no accounts needed)

```bash
npm install
npm test               # 84 tests: real SQLite (FTS5) + a mock Prune that signs real Ed25519 receipts
npm run typecheck
npm run check:caller   # fails if anything but src/llm.ts and src/receipts.ts calls fetch, or a provider host/SDK/key appears
```

Needs Node 24 (built-in `node:sqlite`, TypeScript type stripping).

## Proof tooling

```bash
npm run phase0                 # probe the real Prune once you have a key (see PHASE0.md)
npm run bench                  # 4-arm benchmark; without a key it runs on the mock and says "MOCK RUN. Not results."
npm run bench -- --docs 1 --pages 30 --facts 6 --confirm-spend     # a cheap real run (hard cap: --max-usd, default 3)
npm run bench:injection -- --confirm-spend                         # 15 injection payloads against a real model
node scripts/verify-receipts.mjs bench/out/receipts-athena.jsonl   # anyone can re-check the signatures and costs
```

## Run it locally against the mock

```bash
npm run mock                      # fake Prune on http://127.0.0.1:8788/v1
cp .dev.vars.example .dev.vars    # set PRUNE_API_KEY=anything, PRUNE_BASE_URL=http://127.0.0.1:8788/v1
npx wrangler dev --local          # or the cf CLI equivalent
```

Add `[[mock:429]]`, `[[mock:500]]`, `[[mock:drop]]` or `[[mock:429_spend_cap]]` to a question to inject a failure.

## Go real

1. Create a Prune key, add a provider key to the **Prune vault**, and set a daily spend cap and model allowlist on the Prune key.
2. `PRUNE_API_KEY` and `ADMIN_TOKEN` as Worker secrets (never in code or `wrangler.jsonc`).
3. Create D1 + R2, apply every file in `migrations/` in order (`0001_init.sql`, then `0002_verify_gate.sql`), set `database_id` in `wrangler.jsonc`, then `cf migrate` to move to `cloudflare.config.ts`.
4. Do Phase 0 (`../athena.md` 4.9): confirm the auth header (`PRUNE_AUTH`), real receipt fields, shield code strings, and set real `MODEL_TIERS` ids and prices.

## Run on Groq (the parallel path)

Same engine, a second model door: `src/llm-groq.ts`, chosen per deployment with `LLM_PROVIDER=groq`. Prune stays the default.

```bash
# athena/.dev.vars (wrangler dev) or athena/.env (scripts); both are gitignored
LLM_PROVIDER=groq
GROQ_API_KEY=<your key>          # as a Worker secret when deployed: npx wrangler secret put GROQ_API_KEY
```

What is the same: budget reservation, the ledger, bounded retries, billing-uncertain handling, tiers, citation checks.
What is different, on purpose and visibly:
- **No signed receipts.** Cost is the response's token usage times the prices in `GROQ_MODEL_TIERS`, so it is an estimate (`cost_source: estimate`) and the receipt is shown as missing, never "verified". The verify screen, the exported receipt file and the cost-without-Prune figure do not apply.
- **No server-side spending cap, step cap, idempotency or cache.** The local allowance is the only guard; set a spend limit in the Groq console too.
- **Small rate limits.** The key tested had about 8,000 tokens per minute; a long document context can get a 413/429, reported as "rate limited".
- **Prices are unverified.** Default models are `openai/gpt-oss-20b`, `qwen/qwen3.8-27b` and `openai/gpt-oss-120b` (what the key listed); the prices are from memory. Set real ones in `GROQ_MODEL_TIERS`.

`npm run check:caller` allows the Groq host in `src/llm-groq.ts` only.

## Web app

```bash
npm run dev:stack   # real API + mock Prune, in-memory database, http://127.0.0.1:8787
npm run web         # the React app, http://127.0.0.1:5173 (see web/README.md)
```

## Layout

```
src/
  app.ts          26 MVP endpoints, auth, error envelope
  orchestrator.ts the pipeline for one question; pause/resume/retry; memory
  llm.ts          THE ONLY MODEL CALLER (reserve, Prune headers, bounded retries, receipts)
  receipts.ts     raw-byte receipt capture and Ed25519 verification
  errors.ts       shield-code-first error classification
  budget.ts       atomic reserve / settle / release
  context.ts      retrieval, memory, fenced untrusted text, safe FTS queries
  tiers.ts        capability tiers (economy / standard / strong)
  sectioner.ts    deterministic indexing, page ranges
  packs/          general + invoice (schema and total check)
  trace.ts        activity timeline
  janitor.ts      cron cleanup
  gate.ts         no-AI citation and number check, abstaining (pure, no network)
  extras.ts       stores the gate result and the naive baseline for each answer
  baseline.ts     the naive-baseline calculation (Athena's own estimate, not signed)
  protected.ts    protected numbers: extractive pruning that never alters figures, dates or ids
  routes/         receipts (E23, E24), usage (E26) and export (E27), split out of app.ts
migrations/       D1 schema: 0001 (athena.md 3.1 plus messages.trace_json), 0002 (verify, baseline, gate, gate_eval)
tools/mock-prune/ fake Prune with failure injection
tests/            units, model-caller and API tests
```

## Verifiable cost, cost per good answer, and the citation check

What each piece does, in plain terms. None of it claims to be new; it says what the code does.

**Three cost numbers on every answer**, in this order: *Actual cost* and *Without Prune's savings* (both read from Prune's signed receipt), and *Naive baseline (Athena estimate)* (our own calculation, not signed).
`naive_input_tokens = full_document_tokens + full_chat_history_tokens + question_tokens + system_tokens`, then `naive_cost = naive_input_tokens * input_price + actual_output_tokens * output_price`, for the model that answered. Token counts are estimates (about 4 characters per token) unless the signed receipt carries them, and the inputs are stored in `llm_calls.naive_inputs_json` so the number can be recomputed. The signature proves what Prune charged; it does not prove the baseline. Prune's own savings are separate from Athena's retrieval savings and are never added together.

**Verify** (`POST /api/receipts/:call_id/verify`): re-checks the Ed25519 signature on the stored raw bytes, that the signing key id is the one first seen with this public key, and that the cost we recorded equals the signed cost. States: `verified`, `failed` (with a reason), `unverified` (could not check, for example no Ed25519 in the runtime: never shown as verified), `missing`. Send `receipt_override_raw` to check an edited copy; it is never saved. Offline: `python bench/verify.py athena-receipts.jsonl` or `node scripts/verify-receipts.mjs athena-receipts.jsonl` (the first line of the export carries the public key).

**Cost per good answer (CPGA)**: spend on every call of the conversation (retries and escalations included, from signed receipts) divided by the number of good answers. A *good answer* is one that passes the no-AI check in `src/gate.ts`; summaries and extractions count when they finish. Also reported: success rate, cost per request, and CPGA with and without a judge (there is no model judge, so they match). Charges that are only an estimate (billing uncertain) are listed separately.

**The check** (`src/gate.ts`): code confirms the quote and the numbers, percentages and dates in an answer appear on the cited pages, and that the cited pages were sent. It runs on `[p.N]` answers today (page and figure checks) and also on `{answer, citations:[{page, quote}]}` JSON (quote check too); the live prompt still produces `[p.N]` text. Its error rate is measured, not assumed: `npm run gate:eval` scores it on `bench/gate_eval/labelled.jsonl` and writes `reports/gate_eval.json` and `reports/gate_eval.sql`; apply the SQL so `/api/usage` and the usage screen show it. Until then the screen says "Checker error rate not measured yet".

**Optional behaviour, off unless set** (nothing changes if you set none of these): `GATE_ENFORCE=1` lets a failed check use the one allowed escalation; `ABSTAIN_MIN_SCORE` (and `ABSTAIN_MIN_MARGIN`) answer "This does not appear to be in the document" with no model call when retrieval is weak. Pick the threshold from `reports/gate_eval.json`.

**Budget pause and billing uncertain** were already built; see `tests/a-budget.test.ts` for the acceptance tests. **Protected numbers** live in `src/protected.ts` with tests; they are not yet applied inside `context.ts`.
