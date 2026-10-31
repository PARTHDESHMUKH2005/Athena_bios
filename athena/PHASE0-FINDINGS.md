# Phase 0 findings, part 1 (2026-10-31)

Run by Harshdeep with two Prune keys against `https://api.withprune.com/v1`, using `npm run phase0` and small follow-up calls. Keys are not recorded here. Stream A (Parth) continues this file or folds it into `prune.md`. Everything below was observed, not read from docs.

## Confirmed

| Topic | What the service does |
|---|---|
| Auth | `Authorization: Bearer prune_...` and `X-Prune-Key` both work (the error text also lists `x-api-key`). A missing key gives 401 "Missing API key"; a malformed key gives 401 "Invalid API key format. Expected a Prune key starting with prune_" |
| Catalog | `GET /v1/models` with a key returns 200 and 49 model ids (OpenAI gpt-5.x, gpt-4.1, gpt-4o, o3/o4; Gemini 2.x and 3.x; Claude 4.x and haiku 4.5). No prices. Without a key it returns 401 |
| Public key | `GET /v1/public-key` returns a plain-text Ed25519 PEM |
| Provider errors | Passed through as `{error, code: "provider_upstream_4xx", provider, model, upstream_status, upstream_error_snippet}`. A bad provider key is HTTP 401; an Anthropic account with no credits is HTTP 400; a provider key missing from the vault is HTTP 400 `http_error` "Missing <provider> api key. Store one in the Prune vault"; an unknown Gemini model is HTTP 404 `not_found` |
| `run_budget` | HTTP 429. Headers `x-prune-shield-code: run_budget`, `x-prune-shield-action: reject`, `x-prune-docs-url`. Body `{error, code, run_id, spend_usd, budget_usd, pending_estimate_usd, docs_url}`. Prune compares the **pending estimate** with the budget before sending, even on the first call, and a budget of $0.000001 was treated as zero |
| `run_budget_missing_run_id` | HTTP 400 when the budget header is sent without a run id |
| `agent_step_budget` | HTTP 429, body "Agent step budget exceeded (2/1)", header `x-prune-agent-budget: exceeded`. **Every request counts as a step, including one that fails at the provider** |
| Prompt injection | Shield rejects "Ignore all previous instructions" with HTTP 403 **even in default mode** (`prompt_injection_signal`, action `reject`), and with `X-Prune-Injection: block` as `prompt_injection` (a pattern match). Docs describe the default as a non-blocking signal; observed behaviour is a block |
| Workload tag | An invalid tag (`definitely_not_a_workload`) is not rejected before the provider call |

## Model calls by key

| Key | Result |
|---|---|
| 1 | OpenAI models: 401, OpenAI rejects the key stored in the vault. `claude-haiku-4-5`: 400, Anthropic account has insufficient credits. Gemini: no key in the vault |
| 2 | OpenAI and Anthropic: no key in the vault. Gemini works: `gemini/gemini-3.5-flash`, `gemini/gemini-3.1-flash-lite`, `gemini/gemini-2.5-pro` and `gemini/gemini-3.1-pro-preview` return 200 with a `prune_metadata` receipt; `gemini/gemini-2.5-flash`, `gemini/gemini-2.0-flash` and `gemini-2.5-flash` return 404 |

## Things this changes in our code (for streams A and B to schedule)

1. **Max steps.** We send `X-Prune-Max-Steps: 3`, but each retry is a step, so three attempts plus one escalation can exceed it and return `agent_step_budget`. Send `6` (three attempts for the answer and three for an escalation).
2. **Gemini response shape.** Gemini models answered in Gemini's own JSON (`candidates`, `usageMetadata`), not the OpenAI `choices` shape that `src/llm.ts` reads, so our code would see an empty answer. Options: use models whose responses are OpenAI-shaped (needs an OpenAI or Anthropic key in the vault), add a Gemini adapter in `llm.ts`, or ask Prune whether a normalization option exists. Gemini 3.x also spent a 16-token output limit on reasoning and returned no text (`finishReason: MAX_TOKENS`): allow more output tokens for these models.
3. **Error classes.** A 400 "Missing <provider> api key" and a 400 "insufficient credits" are configuration problems, but `classifyHttp` maps any plain 400 to `validation_failed` ("request not valid"). They should map to `provider_auth_failed`.
4. **Injection tests.** Shield blocks text containing common injection phrases before any model sees it. With the real service, the injection suite will show many payloads as `shield_blocked` (protected, but not a measure of the model resisting), and a legitimate document that quotes such a phrase makes the question fail. The user-facing message and the benchmark need to account for this.
5. **Identical retries.** Prune documents an `agent_loop` stop for the same step repeated three times in a run. Our retries send identical requests; whether the third attempt trips it is **unverified**.

## Not yet verified (needs a full run with a working model)

Receipt field names and the cost field, whether the signature verifies with our canonical form, the hosted verify endpoint, cache hit fields, whether `Idempotency-Key` is honoured, routing headers, canary fields, and per-model prices.

## Next

Run the full probe on a working model: `PHASE0_MODEL=gemini/gemini-3.1-flash-lite npm run phase0` with key 2 in `athena/.env`. Do not commit keys. Rotate any key that was pasted into chat.
