# Athena: project status, ownership and phases

Last updated: 2026-10-31. Everyone keeps their own progress in `status/<name>.md` (see section 6). This file changes rarely, and only through a pull request all four members approve.

- Agreed product scope: [memory.md](memory.md) (the source of truth for what Athena should do)
- Technical plan for the engine that is already built: [athena.md](athena.md)
- How we avoid merge conflicts: [CONTRIBUTING.md](CONTRIBUTING.md)

## 1. Where we are, honestly

The repo holds a working **document question-and-answer engine** in `athena/`: a TypeScript Cloudflare Worker API, a React app, a mock Prune, and 84 passing tests. **All of it has been tested only against a mock Prune and SQLite.** Nothing has run against the real Prune, a real D1 database, or deployed Workers. The broader product in `memory.md` (general chat, writing and code help, model-choice explanations, OCR, session checkpoints) is mostly not built.

Mapped onto the team's own phases from `memory.md` section 13:

| Phase | Exit criterion (from memory.md) | State | Evidence and gap |
|---|---|---|---|
| 0 | Real call works and receipt verifies | **Started, not finished** | Two Prune keys tested on 2026-10-31: both are valid and both auth headers (`Authorization: Bearer` and `X-Prune-Key`) work. A real model call has **not** completed yet: key 1 has an invalid OpenAI key and an Anthropic account with no credits in its vault; key 2 has a working Gemini key (see `athena/PHASE0-FINDINGS.md`). Receipt fields and cost fields are still unconfirmed |
| 1 | Saved chat returns answer, model, cost, receipt; survives refresh | **Built on mock, document chats only** | A chat is bound to an uploaded document. Chat with no document is not supported yet |
| 2 | Duplicates and exhausted allowance handled | **Built and tested on mock** | Reservation, bounded retries, duplicate protection, pause and timeline pass tests. Uncertain charges are currently charged at the estimate; memory.md wants them kept "pending" and reconciled |
| 3 | Evaluated routing reflects task needs | **Partial** | Three tiers with rules and served-model tracking exist. Model ids and prices are placeholders; routing is not evaluated |
| 4 | Text PDFs, saved index, retrieval, citations, broad summaries | **Partial** | Text PDFs, index, citations and follow-ups work. Summaries sample the document rather than cover it; no document hash or version reuse |
| 5 | Selective OCR, incremental memory, Markdown checkpoint | **Partial** | Rolling memory summary and a no-AI Markdown export exist. No OCR and no cost-triggered checkpoint |
| 6 | Reproducible evidence, reliable demo | **Harness only** | Benchmark, injection suite and offline receipt verifier exist. No real runs; deployment of the combined app is not wired |

## 2. Four workstreams, one owner each

Names are **proposed**: change a name in this table and nothing else moves, because ownership is by file path. Each file in the repo has exactly one owner.

| Stream | Owner | Owns (paths under `athena/` unless stated) |
|---|---|---|
| **A. Prune client, receipts, routing, proof** | Parth Deshmukh | `src/llm.ts`, `src/receipts.ts`, `src/errors.ts`, `src/tiers.ts`; `scripts/phase0.mjs`, `scripts/verify-receipts.mjs`, `PHASE0.md`; `bench/run.mjs`, `bench/stats.mjs`, `bench/dataset.mjs`; `tools/mock-prune/**`; `tests/llm.test.ts`, `tests/verify-export.test.ts`, `tests/bench.test.ts`; root `prune.md` |
| **B. Data, budgets, recovery, memory, API, deployment** | Harshdeep Athawale | `src/app.ts`, `src/schemas.ts`, `src/orchestrator.ts`, `src/budget.ts`, `src/ratelimit.ts`, `src/janitor.ts`, `src/killswitch.ts`, `src/trace.ts`, `src/util.ts`, `src/index.ts`, `src/env.ts`; `migrations/**`, `wrangler.jsonc`, `tsconfig.json`, `package.json`, `package-lock.json`, `.gitignore`, `.env.example`, `.dev.vars.example`; `tools/dev-server.mjs`; `tests/api.test.ts`, `tests/helpers.ts`, `tests/harness.ts`; `README.md`, `COMPONENTS.md`; root `athena.md`, `.gitignore`, `.gitattributes` |
| **C. Documents: extraction, retrieval, OCR, document safety** | **Member 4 (name to confirm)** | `src/context.ts`, `src/sectioner.ts`, `src/answer.ts`, `src/outputscan.ts`, `src/packs/**`; `web/src/lib/pdf.ts`, `web/src/lib/limits.ts`, `web/src/app/useUpload.ts`, `web/public/samples/**`; `tools/make-sample-pdfs.mjs`; `tests/injection.test.ts`, `tests/fixtures/**`; `bench/injection.mjs` |
| **D. Frontend, integration, demo, product scope** | Keha Chopra | `web/**` except the three files C owns above (including `web/src/lib/types.ts` and `web/src/lib/api.ts`, which mirror B's API), `web/artifact/**`; root `athena-content.md`, `README.md`, `memory.md`, `docs/demo/**` |

Shared and frozen:
- `STATUS.md`, `CONTRIBUTING.md`: shared, edited rarely, all four approve.
- `status/<name>.md`: each person edits only their own file.
- `docs/archive/**`: frozen history.
- `tests/units.test.ts`: **frozen** (it mixes tests from three streams). To change one of its tests, move it into a new test file you own.

The repo also lists other collaborators (`arsingla786`, `SagarikaWankhede`). If either is the fourth member, put their name in stream C and rename `status/member-4-tbd.md`.

## 3. Phases: who does what

Phase names, goals and exit criteria are the team's own (`memory.md` section 13). **K0 comes first and removes the shared hotspots.** Within a phase the four streams work in parallel on different files.

**K0. Kickoff (before parallel work).** All: confirm names in section 2 and decide open decision D1 (section 4). B: one pull request that splits `src/app.ts` into per-topic route files (`routes/documents.ts`, `routes/receipts.ts`, `routes/chats.ts`, `routes/usage.ts`) and adds `npm run check`; after it lands, route files are owned by C (documents), A (receipts) and B (the rest), and nobody else edits `app.ts`. Until it lands, only B edits `app.ts` and `orchestrator.ts`.

| Phase | Goal and exit criterion | A: Prune, receipts, routing, proof | B: data, budgets, recovery, API, deploy | C: documents and document safety | D: frontend, integration, demo |
|---|---|---|---|---|---|
| **0** | Verify Prune. A real call works and its receipt verifies | Get the key, vault, spend cap and model allowlist; run `npm run phase0`; write dated findings in `prune.md` | Verify D1, R2 and Workers (athena.md 4.9 items 11-14): apply the migration on real D1, batch atomicity, Ed25519 in Workers; deploy a skeleton | Measure pdf.js speed on a 100-page PDF; prepare scanned and mixed test PDFs; with A, test whether Prune passes images through (needed for OCR) | Run the stack decision (D1) with the team; list UI scenarios; confirm the assignments |
| **1** | Minimal chat. A saved chat returns answer, model, cost and receipt, and survives refresh, on real Prune | Switch from mock to real; update receipt fields, auth and shield codes from the findings; update the mock to match | Chat with no document (API and storage); deploy a staging copy; serve the built web app from the Worker | Tune the answer and citation prompts against real model output; fix whatever real answers break | Point the app at the real API; show the actual served model; fix UI gaps found on real data |
| **2** | Reservations, bounded attempts, duplicates, timeline, pause. Duplicates and exhausted allowance handled | Test concurrent spend against the real cap; check whether idempotency keys are honoured | Keep uncertain charges "pending" and reconcile them (memory.md section 9); admin stop endpoints | Cross-user isolation tests for documents and search | Failure timeline and pause screens against the real service |
| **3** | Two model tiers, rules, short explanations, served-model tracking. Evaluated routing reflects task needs | Set real model ids and prices; evaluate economical-only vs stronger-only vs Athena routing; write the short explanations | Record requested vs served model everywhere; reconcile estimates against receipts | Add document-task evaluation cases (`bench/cases/documents.json`) | Show the model explanation in the UI; add writing, explanation and code evaluation cases (`bench/cases/general.json`) |
| **4** | Text PDFs, saved index, retrieval, citations, broad summaries. Follow-ups reuse document preparation | Route and cost-account the summary calls | Store document hash and version; tables for summaries | Broad summaries (bounded section summaries plus synthesis), hash-based reuse, retrieval quality, citation checks | Sources panel and citations for multi-document chats |
| **5** | Selective OCR, incremental memory, Markdown checkpoint. Supported scans work; checkpoint coverage is explicit | Pick the cheapest suitable model for checkpoints; verify vision calls | Checkpoint job: configurable usage trigger, unique per session and message range, no-AI export fallback; memory pointer | Per-page OCR with a page cap and budget check per page | Checkpoint screen, coverage display and download |
| **6** | Evaluation, failure tests, reports, deployment, rehearsal. Reproducible evidence and a reliable demo | Real benchmark, cost and quality report, proof package with the verify command | Deploy the combined app; CI with secret scan and the single-caller check; interrupted-worker and failure tests | Run the injection suite on a real model; document-safety report | Demo script, rehearsal, backup recording; put real numbers on the landing page (`web/src/lib/facts.ts`) |

Dependencies: nothing "real" can finish before **Phase 0 (A)** produces findings. Phase 5 OCR needs A's image-passthrough answer from Phase 0. C and D both need B's API contract (section 5 of CONTRIBUTING.md).

## 4. Open decisions (decide in K0)

| # | Decision | Notes |
|---|---|---|
| D1 | **Stack.** Keep the built TypeScript Cloudflare Worker and React app, or port to the Python and FastAPI stack that `memory.md` section 12 suggests | The TypeScript engine is built, has 84 passing tests against a mock, and deploys on Cloudflare. A port costs the work already done. Whichever is chosen, the stream ownership in section 2 stays the same (by concern, not by language) |
| D2 | **Who is the fourth member**, and do the proposed assignments stand | Section 2 |
| D3 | **Database** if we stay on Cloudflare: D1 (SQLite) is built; memory.md mentions PostgreSQL only for distributed workers | Decide after the Phase 0 D1 check |
| D4 | **Chat with no document** is required by memory.md (general assistant) but the API does not support it yet | Phase 1, stream B, with D |

## 5. Definition of done

Tracked in `memory.md` section 17. Current state: none of the twelve items is fully complete; the closest are reservations, bounded attempts, duplicate protection and pause (tested on mock only).

## 6. Status files

| Person | File |
|---|---|
| Parth Deshmukh (A) | [status/parth.md](status/parth.md) |
| Harshdeep Athawale (B) | [status/harshdeep.md](status/harshdeep.md) |
| Member 4 (C) | [status/member-4-tbd.md](status/member-4-tbd.md) |
| Keha Chopra (D) | [status/keha.md](status/keha.md) |

Update your own file when you finish a task, start one, or get blocked. Do not edit anyone else's.
