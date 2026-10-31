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
3. Create D1 + R2, apply `migrations/0001_init.sql`, set `database_id` in `wrangler.jsonc`, then `cf migrate` to move to `cloudflare.config.ts`.
4. Do Phase 0 (`../athena.md` 4.9): confirm the auth header (`PRUNE_AUTH`), real receipt fields, shield code strings, and set real `MODEL_TIERS` ids and prices.

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
migrations/       D1 schema (from athena.md 3.1, plus messages.trace_json)
tools/mock-prune/ fake Prune with failure injection
tests/            units, model-caller and API tests
```
