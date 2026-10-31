# Status: Parth Deshmukh

Stream **A: Prune client, receipts, routing, proof** (see [STATUS.md](../STATUS.md) section 2 for your paths).
Last updated: 2026-10-31. *First draft written from the repo history and the plan; Parth, please correct anything that is wrong and keep this file current. It is the only status file you edit.*

## Done
- Wrote the first `memory.md` and `prune.md` (Prune integration notes) in this repo.
- Already in the repo for you, built by Harshdeep and tested only against a mock: the shared model caller `athena/src/llm.ts` (the only code that calls a model), receipt capture and Ed25519 verification `athena/src/receipts.ts`, the error and shield-code handling `athena/src/errors.ts`, the three model tiers `athena/src/tiers.ts`, a mock Prune `athena/tools/mock-prune/`, the Phase 0 probe `athena/scripts/phase0.mjs`, the benchmark `athena/bench/` and the offline receipt verifier `athena/scripts/verify-receipts.mjs`.

## Findings so far (2026-10-31, from a test run by Harshdeep with two Prune keys; details in `athena/PHASE0-FINDINGS.md`)
- Both keys are valid; both `Authorization: Bearer` and `X-Prune-Key` are accepted.
- **Key 1:** the OpenAI key in its vault is rejected by OpenAI ("Incorrect API key provided") and the Anthropic account has no credits. No model call succeeds yet.
- **Key 2:** the vault has a working **Gemini** key. `gemini/gemini-3.5-flash`, `gemini/gemini-3.1-flash-lite`, `gemini/gemini-2.5-pro` and `gemini/gemini-3.1-pro-preview` answered; `gemini/gemini-2.5-flash` and `gemini/gemini-2.0-flash` returned 404. Its OpenAI and Anthropic keys are missing.
- Gemini answers came back in Gemini's own JSON shape (`candidates`), **not** the OpenAI `choices` shape our model caller reads. This needs a decision (see PHASE0-FINDINGS.md).
- **A real signed receipt verified with our code** (local Ed25519 and Prune's hosted check). Cost fields are named as assumed. Surprises to decide: Prune's default pipeline cut our `max_tokens` from 200 to 64, the free-trial clock may have started, and the receipt names the model `original_model`/`routed_model`.
- Real Shield codes and bodies confirmed for `run_budget`, `run_budget_missing_run_id`, `agent_step_budget`, `prompt_injection` and `prompt_injection_signal`.

## Doing now: Phase 0 (this blocks the whole team)
Exit criterion: a real call works and its receipt verifies.

- [ ] Create a Prune account and API key; add one provider key to the Prune vault.
- [ ] On the Prune key set a **daily spend cap**, a **model allowlist** and a rate limit.
- [ ] Put the key in `athena/.env` yourself (never in chat or Git), then run from `athena/`: `npm run phase0`
- [ ] Write dated findings in **`prune.md`** (not `memory.md`, which is Keha's file) and tell the team. Never record a key.
- [ ] Share `athena/phase0-findings.json` (it contains responses only; the key is redacted).

Checklist from `memory.md` section 16, and how much the probe script covers:

| Item to verify | Covered by `npm run phase0`? |
|---|---|
| Authentication and vaulted provider-key setup | Auth styles yes; the vault is a manual dashboard step |
| Available models and current prices | Lists models if the endpoint exists; prices are manual |
| Receipt fields, signature payload, public key | Yes, including which canonical form verifies |
| Model forcing versus Prune routing | Records routing headers; forcing a model is **not** tested |
| SDK and gateway retries, fallback cost visibility | **No** |
| Timeout reconciliation and idempotency | Idempotency yes; timeout reconciliation **no** |
| Spending cap and concurrent-call behaviour | Run budget and step limits yes; concurrent calls **no** |
| Cache scope, controls, bypass, billing | Cache modes yes; scope across accounts **no** |
| Structured output and non-streaming | **No** (invoice extraction sends `json_object`) |
| Hosted embeddings | **No** (deferred) |
| Shield and privacy | Canary and injection signals yes; privacy options **no** |

## Next
1. Update `src/receipts.ts` (field names, canonical form), `src/errors.ts` (shield codes) and the mock from the findings; run `npm test`.
2. Set real model ids and prices in `MODEL_TIERS` (see `src/tiers.ts`; the defaults are placeholders).
3. Phase 1: switch the stack from the mock to the real Prune and fix what breaks.
4. Phase 3: evaluate economical-only vs stronger-only vs Athena routing with `bench/` (all calls still through Prune).
5. Add your own evaluation cases in `athena/bench/cases/` (your own file).

## Blocked / need from others
- Nothing blocks the key setup. For OCR (Phase 5) Member 4 needs your answer on whether Prune passes images through.

## Notes for the team
- Keep this checklist ticked as you go so everyone can see when Phase 0 is done.

## 2026-10-31: Verify feature and companions (built on the mock, not run against real Prune)
Built from the "Verify" build prompt, additive to the existing engine. All new work is in new files except small hooks listed under "Touched files". No Phase 0 call was made (no key in this session), so receipt format details remain **unverified**; see `docs/receipts.md`.
- **Point 1, verify savings:** three labelled cost numbers on every answer; `verify` returns a reason; tamper check (`receipt_override_raw`) that never saves; `bench/verify.py`; export meta line.
- **Point 2, cost per good answer:** `GET /api/usage` adds `cpga`, `success_rate`, `gate`, `attempts_by_answer`; the usage screen shows them next to the checker's error rate (or "not measured yet").
- **Point 3, no-AI check:** `src/gate.ts`, 46 labelled examples in `bench/gate_eval`, optional abstaining. Measured on the set: see `reports/gate_eval.json`.
- **Point 4, pause and billing uncertain:** already built; acceptance tests added (`tests/a-budget.test.ts`).
- **Point 5, protected numbers:** `src/protected.ts` and `tests/a-protected.test.ts`. Not wired into `context.ts` yet.
- **Touched files outside my paths (additive, default-off):** `app.ts` (route blocks moved to `src/routes/`), `orchestrator.ts` (gate, baseline, abstain hooks), `context.ts` (bm25 scores), `env.ts`, `package.json`, `tests/helpers.ts` (loads every migration), `tests/api.test.ts` and `tests/bench.test.ts` (one assertion each, for the new export meta line), `athena.md` and `COMPONENTS.md` (endpoint rows), `web/` (new components; `Drawer`, `ChatPanel`, `UsagePanel`, `types`, `api` hooked in).
- **Contract change (for Harshdeep and Keha):** E27 now starts with a `{"type":"meta",...}` line. E23, E24, E26 gained fields; nothing was removed or renamed.

## 2026-10-31 (later): checked the verify work, next steps
- Verify engine, cost per good answer, no-AI check and protected numbers are on `main` (e1eb2af). `npm test` passes 180/180 locally (needs Node 24, or Node 22 with `NODE_OPTIONS=--experimental-strip-types`); typecheck and the single-caller check pass.
- PR `a/phase0-receipts-tiers`: default tiers now use the Gemini ids that answered real calls (`gemini/gemini-3.1-flash-lite`, `gemini/gemini-3.5-flash`, `gemini/gemini-3.1-pro-preview`) with an output floor for hidden thinking. **The prices are unverified placeholders**; set the real ones via `MODEL_TIERS`. `tests/llm.test.ts` now pins its own tier table. `docs/receipts.md` moves the confirmed items to Observed.
- Still open for me, all needing a working key: cache hit (second identical call), `Idempotency-Key`, accepted `X-Prune-Pipeline-Mode` values (the default `auto` cut `max_tokens` 200 to 64), whether a third identical retry trips `agent_loop`, concurrent-spend behaviour, Ed25519 inside a Worker, real per-model prices, then the first real Phase 1 run and the routing benchmark.
- Protected-number pruning (`src/protected.ts`) is not wired into `context.ts`; that file is Member 4's, so it needs their OK.

## 2026-10-31 (Phase 3 start): "why this model" explanations
- `explainRouting` and `explainEscalation` in `src/tiers.ts` turn the rule that fired into one plain sentence (tier, reason, and a note when the allowance forced a cheaper tier). They are built from rules, never a model call. The activity timeline now shows them (`tier` and `escalate` steps); the orchestrator change is those two lines only. Tests: `tests/a-routing.test.ts`.
- Not done: a field on the answer itself for Keha's UI (that is an API addition for Harshdeep), the economical-only vs stronger-only vs Athena evaluation (needs a working key), and `bench/cases/` evaluation cases.
