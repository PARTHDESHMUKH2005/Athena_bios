# Athena: component verification

What the project needs (from `athena.md`), where it is in this repo, and how far it is verified.
Run `npm test` (84 tests), `npm run typecheck` and `npm run check:caller` to reproduce every "tested" claim.

Legend: **Tested** = automated test in this repo exercises it against real SQLite (FTS5) and a mock Prune that signs real Ed25519 receipts. **Written, not run for real** = code exists but depends on something only available on real Cloudflare or real Prune. **Not built** = deliberately out of this pass.

## Backend core (the Worker)

| Component | Plan | File | Status |
|---|---|---|---|
| HTTP app, request ids, error envelope, auth by hashed token | 3.2, 2.9 | `src/app.ts` | Tested (`api.test.ts`) |
| D1 schema and migration (13 tables, FTS5 + triggers) | 3.1 | `migrations/0001_init.sql` | Tested on SQLite. **Not applied to a real D1 yet** (Phase 0 item 13) |
| Document ingest: pages in, sectioning, FTS index | 2.4 | `src/sectioner.ts`, `app.ts` (E06 to E11) | Tested |
| Retrieval and context builder, FTS query sanitizing, fenced untrusted text | 2.5 | `src/context.ts` | Tested, including hostile queries and a document that tries to close its own fence |
| Tier picker (capability tiers, no hardcoded model) | 2.5 | `src/tiers.ts` | Tested. Model ids and prices are **placeholders** until the vault check |
| Budget manager: atomic reserve, settle, release | 2.5 | `src/budget.ts` | Tested (parallel reservations, per-call cap, invariant over a mixed run) |
| **Single model caller** (reserve, Prune headers, bounded retries, billing-uncertain, receipt handling) | 4.1 | `src/llm.ts` | Tested against the mock: 429 then success, shield-code 429s never retry, 5xx stops after 2 retries, connection lost = no blind retry, missing receipt is not success |
| Error classifier (shield code read before status) | 2.6 | `src/errors.ts` | Tested. Shield code strings are from the docs, **unconfirmed** |
| Receipts: raw-byte capture, canonical form, Ed25519 verify, hosted fallback | 2.7 | `src/receipts.ts` | Tested including `5e-05`, `1.0`, non-ASCII, tampering, bad signature. Real receipt field names and canonicalization **unconfirmed** |
| Orchestrator (the pipeline for one question) | 2.5 | `src/orchestrator.ts` | Tested: idempotent `client_msg_id`, shrink then pause, resume/cancel, Prune-side cap pause, escalate once, retry after uncertain billing |
| Memory summary | 2.5 | `maybeSummarize` in `orchestrator.ts` | Tested (summary stored, then used in the next prompt) |
| Activity timeline (`trace`) | 2.5 | `src/trace.ts` | Tested (steps, labels, no document text) |
| Packs: general, invoice (JSON schema + total check) | 1.4 | `src/packs/index.ts`, `src/answer.ts` | Tested |
| Rate limits (per IP for sessions, per workspace otherwise) | 2.9 | `src/ratelimit.ts` | Session limit tested. Message and upload buckets exist; only the session one has a dedicated test |
| Kill switch | 2.9 | `src/killswitch.ts` | `KILL_SWITCH` env var tested. The settings-table switch (stretch endpoint) is read but untested |
| Janitor (stuck reservations, stuck calls, retention) | 2.2 | `src/janitor.ts` | Tested for reserved and sent rows. Retention delete untested |
| Usage, receipt export, summary export | 3.3 | `app.ts` (E26, E27, E30) | Tested |
| **Output guardrail**: redact secrets, remove links the document never contained, remove download-and-run commands; also applied to stored memory summaries | 2.9 | `src/outputscan.ts` | Tested (`injection.test.ts`): a model that obeys a payload still cannot leak the Prune key, a key-shaped string, a foreign link or a shell one-liner, and legitimate document links survive |
| Worker entry + cron | 2.1 | `src/index.ts`, `wrangler.jsonc` | Written, **not deployed** |

## Endpoints

26 MVP endpoints implemented: E01 to E08, E10 to E15, E17 to E27, E30. Each is exercised by `tests/api.test.ts` (E15 and the delete/list endpoints included). **Not built (stretch):** E09, E16 (OCR), E28, E29 (admin).

## "Agents" and the orchestrator

There are no autonomous agent loops, by design: cost and failure behaviour must be bounded. The roles are fixed modules the orchestrator calls in order, and Prune's `X-Prune-Max-Steps: 6` caps any run server side.

| Role | Module |
|---|---|
| Retrieval | `context.ts` |
| Router (picks the capability tier) | `tiers.ts` |
| Answer (the only model call) | `llm.ts` |
| Verifier (receipt + output validation) | `receipts.ts`, `answer.ts` |
| Memory | `maybeSummarize` |
| Budget guard | `budget.ts` |

Borrowed from the cloned `pal` repo (patterns only; its code is Go/Rust on Postgres/Kubernetes and cannot run in a Worker): models addressed by capability not name, idempotency keys from run + step + attempt + body hash, hard budget cut that pauses the run, every step journaled.

## Test and safety tooling

| Component | Status |
|---|---|
| Mock Prune with real Ed25519 signing and failure injection | Done (`tools/mock-prune/`). `npm run mock` for local dev |
| D1-compatible test harness on node:sqlite (FTS5) | Done (`tests/helpers.ts`) |
| Single-caller CI guard | Done and **proven to fail** on a stray `fetch`, a provider host, a provider SDK import and a key-like string |
| Typecheck | Clean |
| Prompt-injection regression suite (15 payload styles) | Done (`tests/injection.test.ts`, fixtures in `tests/fixtures/`). Proves what the model is allowed to see and do. **Does not prove a model resists**: that is `npm run bench:injection` against a real key |
| Offline receipt verifier | Done (`scripts/verify-receipts.mjs`): re-checks every signature on the exported bytes and recomputes cost from the receipts; caught edited costs, edited receipts and a wrong key |
| Benchmark harness (4 arms, seeded synthetic dataset, paired bootstrap, report generator) | Done (`bench/`). Runs on the mock for structure and prompt sizes; the report is stamped "MOCK RUN. Not results." A real run needs a key, `--confirm-spend` and a spend cap |

## Agentic engineering: where it stands

| Part | Status |
|---|---|
| Orchestration (fixed-role pipeline, bounded steps, no runaway loops) | Done, tested against the mock |
| Guardrails (budget, retries, idempotency, kill switch, fenced input, output scan) | Done, tested against the mock |
| Observability (activity trace per answer, receipts per call) | Done |
| Evals (dataset, scoring, statistics, injection fixtures) | Harness done. **No real-model results yet** |
| Behaviour with a real model (do the prompts cite correctly, does extraction parse, does escalation trigger sensibly) | **Unverified**: only a canned mock has answered so far |
| Free-roaming tool-using agents | **Deliberately not built**: loops are what run up bills; Prune also caps runs at 3 steps |
| Multi-document comparison as a multi-step plan | Not built (a comparison question is one call to the strong tier) |

## Frontend (web/)

Tested by driving the real UI in a browser against `npm run dev:stack` (the real API over SQLite and the mock Prune). Not covered by automated UI tests.

| Screen or part | Status |
|---|---|
| Landing page (hero art, mega menu, document types, seven-step diagram, activity timeline, proof with measured numbers only, safety, FAQ) | Built, checked at desktop and phone width |
| Start screen (anonymous workspace with a spending limit) | Built; limit validation checked, including amounts below one cent |
| Upload: PDF text read in the browser, batched send, sample contract and invoice | Built; real pdf.js path tested with the sample PDFs. Scanned pages are flagged, not read |
| Chat: cited answers, page viewer, live activity timeline (polls while a question runs), receipt drawer with verify, pause card (shorter / raise / cancel), billing-uncertain card with Retry once, extract mode for invoices, summary download | Built and exercised through the UI |
| Usage view and receipt export | Built |
| End session (delete my data or sign out) | Built; delete path not exercised |
| Production hosting (serve `web/dist` from the Worker or Pages) | **Not wired yet** |
| Automated browser tests (Playwright) | **Not written** |

## Not built in this pass

| Item | Why / what it needs |
|---|---|
| OCR and ingest Workflow (E09, E16) | Stretch |
| Admin endpoints (E28, E29) | Stretch |
| Real benchmark numbers and the real injection run | The harness exists; the numbers need a Prune key. The plan's `verify.py` became `scripts/verify-receipts.mjs` |
| `scripts/check_api_map.py`, `scripts/smoke.ts` | The API tests cover the same flows; the generator is not written |
| Response schemas for every endpoint | Request schemas and the key response (`AskResultSchema`, `ErrorEnvelopeSchema`) only |
| GitHub Actions CI file | Commands exist (`test`, `typecheck`, `check:caller`); workflow not written |
| `cloudflare.config.ts` | Run `cf migrate` on `wrangler.jsonc` (team standard is the `cf` CLI) |

## Needs a human (cannot be done from code)

1. Prune account and key; add a provider key to the **Prune vault**.
2. In the Prune dashboard: set the key's **daily spend cap**, **model allowlist**, rate limit.
3. Create the D1 database and R2 bucket, apply the migration, set `PRUNE_API_KEY` and `ADMIN_TOKEN` as secrets.
4. Phase 0 on real Prune (see `athena.md` 4.9): auth header, real receipt fields and canonical form, shield code strings, whether `cost_with_prune_usd` exists, model ids and prices for `MODEL_TIERS`.
5. Ask the organizers whether Cloudflare and existing libraries are allowed.
