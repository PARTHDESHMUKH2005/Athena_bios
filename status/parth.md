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
