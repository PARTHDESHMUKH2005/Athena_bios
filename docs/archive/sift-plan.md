# Sift: Lean Issue Triage on Prune

Working name: **Sift**. Hackathon: FORGE, track "Ship It Lean: AI Apps on a Budget". Team of 4.

> **Archived.** Superseded by `athena.md` (technical plan) and the team's `memory.md` (agreed scope). Kept for reference; the Prune findings in section 14 still apply.

This file is the single source of truth for scope, architecture, phases and ownership. Update it as decisions change. Anything marked **VERIFY** is an assumption about Prune we must confirm in Phase 0 before building on it.

---

## 1. The brief, restated

Build a useful AI app or agent. Route every LLM call through Prune with one base URL. Prove three things: it does the job, it is cheap, and it is safe and reliable (no keys in code, failures cannot run up the bill).

Deliverables: working demo, cost per task, Prune's signed receipts as proof.

| Criterion | Weight | How Sift earns it |
|---|---|---|
| Usefulness | 40% | Real maintainers drown in issues. We run on a real public repo with real issues and measure accuracy against the maintainers' own labels. |
| Cost efficiency | 30% | Most issues are simple and many repeat. Tiered routing plus caching, measured against two baselines, using receipt numbers not estimates. |
| Reliability and safety | 20% | Hard budget gate, retry and loop caps, injection defense, keys vaulted in Prune, secret scanning, human approval before anything is posted. |
| Demo | 10% | 3 minute script built around live cost ticking down and a verified receipt. |

Prize: Best Use of Prune (12 months Pro for 1st, 6 months for 2nd). "Best use" means we should use more than the base URL: workload tags, template ids, optimize modes, cache behavior, receipt verification.

---

## 2. What Sift does

Sift watches a public GitHub repo's issues and, for each new issue:

1. **Classifies** it: bug, feature, question, docs, spam, or needs-info.
2. **Checks for duplicates** against recent open and closed issues.
3. **Extracts structure**: affected component, version mentioned, reproduction present yes/no, severity guess.
4. **Drafts a reply** for a maintainer, using templates for the easy cases.
5. **Escalates** only hard or ambiguous issues to a stronger model for deeper reasoning.
6. **Waits for human approval.** Sift never posts to GitHub on its own in v1.

One **task** for cost accounting = one issue taken from ingest to a finished draft or a final "needs human" state.

### Non-goals (to protect scope)
- No auto-posting, auto-closing or auto-labeling on GitHub.
- No multi-repo tenancy, no auth beyond a single admin password.
- No fine-tuning, no vector database beyond what is needed for duplicates.
- No streaming responses (see Prune notes below).

---

## 3. Prune: what we know and what we must verify

**Known from Prune's public pages and SDK docs:**
- Managed gateway. Change the base URL to `https://api.withprune.com/v1` and keep the OpenAI-style SDK.
- Fronts OpenAI, Anthropic, Gemini, Bedrock and OpenRouter.
- Every response carries a signed receipt (cost, model, what fired). Receipts include cache hit info and cost saved. Live receipts carry `cost_without_prune_usd` and `cost_with_prune_usd`.
- Python SDK (`prune-sdk`) offers `verify_receipt(receipt, public_key_url)` for Ed25519-signed receipts.
- Workload tags via headers: `X-Prune-Workload` (packs: `structured_planning`, `structured_extraction`, `support_chat`, `agent_step`, `rag`, `batch`, `creative`), `X-Prune-Template-Id`, `X-Prune-Optimize` (`light` or `compact`, default off). Auth: docs show both `X-Prune-Key` and the Prune key as SDK `api_key` (`Authorization: Bearer`); test both.
- Attribution and limits via headers: `X-Prune-Run-Id`, `X-Prune-Run-Budget-Usd`, `X-Prune-Max-Steps` (Prune returns 429 + `X-Prune-Shield-Code` when hit), `X-Prune-Feature-Id`, `X-Prune-Customer-Id`. Cache control: `X-Prune-Cache` = `off|exact|normalized|semantic`.
- Shadow mode reports projected savings without changing the upstream model.
- Key-level Shield policy: rate limits, daily spend caps, model and IP allowlists. Fails closed.
- Anthropic streaming bypasses Prune in SDK 0.3.x. We use non-streaming OpenAI-compatible calls.
- Free tier: 15,000 proxied requests per month **or 14 days from the first Optimize receipt, whichever comes first**. Our benchmark must fit inside this (see 11.4).

**VERIFY in Phase 0 (do not assume).** Items 1, 2, 3, 6, 7 are answered by the docs and 5 partly (see section 14); Phase 0 confirms them against a live response. Items 4 and 8 are open.
1. Where exactly the receipt arrives (response header, body field, or separate fetch) and its full field list.
2. Where the public key lives and whether `verify_receipt` works on the raw receipt as returned.
3. How provider keys are added to the vault and how a request selects the provider/model.
4. What Shield does on a prompt-injection input (block, flag, or annotate) and what the response looks like.
5. Whether routing is automatic or driven by workload tags, and how to force a specific model for the baseline arm.
6. Cache scope and semantics (exact match only, or semantic), TTL, and whether it can be bypassed per request.
7. Rate limits and error shapes (429, 5xx) so our retry logic matches reality.
8. Whether `X-Prune-Optimize` changes output quality on our tasks.
9. Which auth header works (`X-Prune-Key` vs `Authorization: Bearer`), and whether receipts carry `cost_with_prune_usd` / `cost_without_prune_usd` under those names.
10. Whether shadow mode plus `X-Prune-Cache: off` gives a clean naive baseline for arm A (see 11.2).

Rule: the first person to find an answer writes it into section 14 (Findings log) the same day.

---

## 4. System architecture

```
                         +------------------+
 GitHub REST API  -----> |  Ingestor        |  pulls issues, normalizes, dedupes ids
 (read only)             +--------+---------+
                                  |
                                  v
                         +------------------+
                         |  Task Queue      |  SQLite-backed, one row per task
                         +--------+---------+
                                  |
                                  v
        +-------------------------------------------------------+
        |  Orchestrator (state machine per task)                |
        |  sanitize -> classify -> dupes -> extract -> draft    |
        |                 |            \                          |
        |                 |             -> escalate (hard cases) |
        +-----+-----------+-------------------+-----------------+
              |                               |
              v                               v
     +----------------+              +------------------+
     | Budget Gate    |<------------>| Loop Guard       |
     | pre-call check |              | retry/cycle caps |
     +-------+--------+              +------------------+
             |
             v
     +----------------+        base URL: https://api.withprune.com/v1
     |  llm.py        | -----> PRUNE  -----> OpenAI / Anthropic / Gemini ...
     |  (only caller) | <----- response + signed receipt
     +-------+--------+
             |
             v
     +----------------+      +--------------------+
     | Receipt Store  | ---> | Verifier + Reports |
     | (SQLite+JSONL) |      | cost per task, etc |
     +-------+--------+      +----------+---------+
             |                          |
             v                          v
     +--------------------------------------------+
     |  FastAPI  ->  React UI (queue, drafts,     |
     |  approve, live cost panel, receipts view)  |
     +--------------------------------------------+
```

### Design principles
1. **One choke point.** `llm.py` is the only module allowed to import an LLM client. A CI check greps the repo for other client imports and for the string `api.openai.com` / `api.anthropic.com`. This is our proof of "every call through Prune".
2. **Receipts are the source of truth for cost.** We never compute cost ourselves for the headline numbers. Our own estimate is used only by the budget gate, and we report how close it was.
3. **Fail closed.** Budget exceeded, loop detected, Shield flagged, or receipt missing: the task stops and moves to `needs_human`. It never retries forever and never spends past the cap.
4. **Untrusted input everywhere.** Issue text is attacker-controlled. It is never concatenated into a system prompt, and model output never triggers an action without a human.
5. **Deterministic where possible.** Cheap rules (empty body, known bot, exact title match) run before any LLM call. The cheapest call is the one we never make.
6. **Two layers of enforcement.** Our budget gate and loop guard run locally, and Prune enforces the same limits server side (run budget, max steps, key spend cap, model allowlist). If our code has a bug, Prune still stops the spend.
7. **Raw bytes for receipts.** Store each receipt exactly as it arrived. Never re-serialize before verifying: a Python or JS round trip can change float formatting (`5e-05` vs `0.00005`) or unicode escaping and break the signature.

---

## 5. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Backend | Python 3.11, FastAPI, Pydantic v2 | Fast to build, Prune SDK is Python |
| LLM client | `openai` SDK pointed at Prune (or `prune-sdk` wrapper) | One base URL, non-streaming |
| Queue/DB | SQLite (WAL mode) + JSONL receipt archive | Zero ops, easy to ship raw receipts |
| Duplicate search | Start with normalized title + TF-IDF/BM25 shortlist, LLM only to confirm top-k | Keeps embedding costs out of the loop; revisit if accuracy is low |
| Frontend | React + Vite + Tailwind | Fast, familiar |
| Charts | Recharts | Cost-over-time and baseline comparison |
| Secrets | `.env` holds only the Prune key; gitleaks pre-commit and CI | Proves keys are out of code |
| CI | GitHub Actions: lint, tests, gitleaks, one-choke-point check | Visible in repo for judges |
| Deploy | Single Docker image; backend serves built frontend | One link for the demo |

---

## 6. Pipeline in detail

### 6.1 Task state machine

```
ingested -> sanitized -> classified -> (dupe_checked) -> extracted -> drafted -> awaiting_approval -> approved|rejected
                \             \               \              \            \
                 \-------------\---------------\--------------\------------\--> needs_human (terminal, with reason)
                                                                          \--> blocked_by_shield (terminal)
                                                                          \--> budget_stopped (terminal)
```

Every transition is logged with timestamp, cause, and the receipt ids that led to it.

### 6.2 Stages

| Stage | What happens | Model tier | Prune workload tag | `X-Prune-Cache` | Runs when |
|---|---|---|---|---|---|
| Sanitize | Strip HTML comments, hidden text, zero-width and bidi-control characters; ignore text inside images; cap length; wrap content in clearly delimited data block; run local injection heuristics | none (rules) | none | n/a | always |
| Pre-filter | Rules for obvious spam, empty issues, bot-authored, exact-title duplicates | none (rules) | none | n/a | always |
| Triage | **One call** for label + confidence + component, version, repro present, severity, in one strict JSON schema (merges the former Classify and Extract stages) | small/cheap | `structured_extraction` | `normalized` | not settled by rules |
| Dupe confirm | BM25 shortlist runs locally; LLM confirms a duplicate with cited issue number | small/cheap | `structured_extraction` | `off` | only if the top BM25 score is above threshold |
| Template reply | If label is question/docs and a template matches, fill template | small/cheap | `support_chat` + `X-Prune-Template-Id` | `exact` | template matched |
| Escalate | Only if confidence < threshold, labels conflict, or severity high | mid/strong | `agent_step` | `exact` | max 1 per task |
| Draft reply | Compose maintainer-ready draft from structured fields | mid | `agent_step` | `exact` | no template matched |

**Target: about 1.5 LLM calls per task on average** (was 4 to 6). Fewer calls is the largest cost lever and protects the free-tier request budget.

**Do not use semantic cache for duplicate detection.** Semantic cache returns a *previous answer* for a *similar prompt*, so "is this a duplicate of #N?" could come back with a confirmation for the wrong issue. BM25 does the matching; the LLM only confirms, uncached.

Every call also sends `X-Prune-Run-Id` (task id), `X-Prune-Run-Budget-Usd` (task cap), `X-Prune-Max-Steps` (6) and `X-Prune-Feature-Id` (stage name), so Prune both enforces the limits and gives a per-stage cost breakdown.

Escalation threshold, BM25 threshold and model choices live in `config/policy.yaml` so the benchmark can sweep them.

### 6.3 Output contract

Every LLM stage returns JSON validated by Pydantic. On validation failure: one repair retry with the validation error, then `needs_human`. We count repair retries in the loop guard.

### 6.4 Prompt structure (injection hygiene)
- System prompt is static, versioned in `prompts/`, and contains no issue text.
- Issue content goes in the user turn inside explicit delimiters and is labeled as untrusted data.
- The model is told to treat the delimited block as data and never as instructions, and the output schema has no field that can carry an action.
- Draft replies are scanned for URLs, secrets-looking strings and mentions before display.

---

## 7. Cost control design

### 7.1 Budget Gate (before every call)
```
allow(call) iff
    task_spent + est_cost(call) <= TASK_CAP         (e.g. $0.01)
    run_spent  + est_cost(call) <= RUN_CAP          (e.g. $2.00)
    hour_spent + est_cost(call) <= HOUR_CAP
```
- `est_cost` uses a local price table and token estimate (tiktoken or char heuristic).
- After the call, we replace the estimate with the real number from the receipt, log the estimate error, and update running totals.
- States per scope: `active -> warned (80%) -> downgraded (force cheap tier) -> stopped (hard cap)`. Same idea as published agent-budget designs.
- A global **kill switch** (env flag and UI button) halts all calls instantly.

**Server-side layer (Prune):**
- Per task: `X-Prune-Run-Id` = task id, `X-Prune-Run-Budget-Usd` = `TASK_CAP`, `X-Prune-Max-Steps` = 6. Prune answers 429 + `X-Prune-Shield-Code` when exceeded; we map that to `budget_stopped` and never retry it.
- Per key (set in the Prune dashboard): daily spend cap at or below `RUN_CAP`, model allowlist containing only the models in `policy.yaml`, rate limit.
- In the demo, the cap should fire as a 429 **from Prune**, with our local gate shown as the second layer.

### 7.2 Loop Guard
- Max 2 retries per stage, max 6 LLM calls per task (mirrored by `X-Prune-Max-Steps`), max 1 escalation per task.
- Never retry a response that carries `X-Prune-Shield-Code`; that is the guard rail working.
- Detects repeated identical requests inside one task (hash of stage + input) and stops.
- Exponential backoff with jitter on 429 and 5xx, then fallback tier once, then `needs_human`.
- Circuit breaker: if more than N failures in M seconds across tasks, pause the queue and surface an alert.

### 7.3 Where savings come from (to be measured, not promised)
1. Rules before models (spam, empties, exact repeats).
2. Cheap tier for most stages, strong tier only on escalation.
3. Prune cache on repeats and near repeats.
4. Prompt compaction (`X-Prune-Optimize`) if it does not hurt accuracy.
5. Summarize very long issues once, then reuse the summary across stages.
6. Merged stages and conditional calls (Triage replaces Classify + Extract; Dupe confirm only above the BM25 threshold).

**Be honest about the cache.** Two fresh issues are almost never identical, so live cache hits will be rare. Real hit sources: re-triage after an issue is edited, benchmark reruns (arm D), the shared system-prompt prefix, and template replies. The report attributes savings **by source** (rules, call merging, tiering, cache, compaction), so judges see that most of the savings come from rules and tiering, not a staged cache demo.

---

## 8. Safety design

| Threat | Control | Evidence for judges |
|---|---|---|
| Provider keys leak in code | Keys only in Prune vault; repo has Prune key only in `.env`; gitleaks pre-commit + CI | Clean gitleaks run, `.env.example`, README note |
| Prune key leak | Key read from env, never logged, redacted in logs, rotated before submission | Log redaction test |
| Prompt injection via issue body | Delimited data block, local heuristics (incl. zero-width/bidi stripping), Prune Shield, output schema with no action fields, human approval | Injection test set with pass/fail table |
| GitHub token misuse | Read-only fine-grained token, public repos only, read from env, never logged (unauthenticated access is only 60 req/hour, so a token is needed) | `.env.example`, token scope in README |
| Runaway spend | Budget gate, loop guard, circuit breaker, kill switch | Live demo of cap firing |
| Provider outage | Retries with cap, fallback tier, `needs_human` terminal state | Failure-injection test |
| Bad draft posted | No auto-post; approval required; draft scanner | UI flow |
| PII in issues | Only public repos; no private data stored beyond issue text; receipts store metadata not bodies | README data policy |
| Receipt forgery or missing receipt | Every call must have a verifiable receipt or task stops | Verify script, stored public key |

### Injection test set (minimum 15 cases)
Direct override, hidden HTML comment instructions, markdown link exfiltration, "post my token", role-play jailbreaks, instructions in a code block, instructions in a quoted reply, unicode tricks, very long padding then instruction, multilingual instruction, instruction asking to disable the budget cap, instruction asking to reveal the system prompt. Record outcome per case: blocked by Shield, blocked by us, or passed through harmlessly. Shield's injection behavior is undocumented (VERIFY 4), so the claim we make is "every case was **harmless**", not "every case was blocked".

---

## 9. Data model (SQLite)

```
issues(id PK, repo, number, title, body_hash, author, created_at, raw_json_path)
tasks(id PK, issue_id FK, status, reason, created_at, finished_at,
      final_label, final_confidence, draft_text, approved_by, approved_at)
llm_calls(id PK, task_id FK, stage, workload_tag, template_id, model_requested,
          model_served, input_tokens, output_tokens, latency_ms, status,
          est_cost_usd, receipt_id, cache_hit, retry_index, created_at)
receipts(id PK, llm_call_id FK, raw_json, signature_valid BOOL,
         cost_with_prune_usd, cost_without_prune_usd, cost_saved_usd, fired_json)
budget_events(id PK, scope, scope_key, event, spent_usd, cap_usd, created_at)
bench_runs(id PK, arm, started_at, finished_at, config_json)
bench_results(run_id FK, task_id FK, predicted_label, true_label, cost_usd, calls, correct BOOL)
injection_tests(id PK, case_name, payload_path, outcome, notes)
```
Receipts are also appended to `receipts/YYYYMMDD.jsonl` so we can ship the raw files.

---

## 10. API surface (FastAPI)

| Method | Path | Purpose |
|---|---|---|
| POST | `/ingest` | Pull N issues from the configured repo |
| GET | `/tasks` | Queue with status, label, cost |
| GET | `/tasks/{id}` | Full trace: stages, calls, receipts, draft |
| POST | `/tasks/{id}/approve` | Approve (optionally edited) draft |
| POST | `/tasks/{id}/reject` | Reject with reason |
| GET | `/cost/summary` | Totals, cost per task, cache hit rate, saved |
| GET | `/cost/timeseries` | For live chart |
| GET | `/receipts/{id}` | Raw receipt + verification result |
| POST | `/receipts/verify-all` | Re-verify every stored receipt |
| POST | `/admin/kill` | Kill switch on/off |
| POST | `/bench/run` | Run a benchmark arm |
| GET | `/bench/report` | Comparison tables and chart data |
| POST | `/safety/run-injection-suite` | Run the injection cases, return table |

---

## 11. Benchmark and proof plan

### 11.1 Dataset
- 250 issues from one active public repo, chosen for volume and clear license. Pull via GitHub API.
- **Repo criteria:** more than about 20 new issues a week, issue templates, a consistent label set (bug, enhancement, question, duplicate, needs-repro or similar), permissive license.
- Ground truth for classification = the maintainers' own labels, mapped to our six classes. Hand-review 50 to fix mapping errors. Expect spam and needs-info to be rare in maintainer labels; hand-label extra examples of those if needed.
- **Duplicate ground truth from the repo itself:** issues closed with a `duplicate` label or a "Duplicate of #N" comment give real labelled pairs. Use these first; add synthetic near-duplicates only to fill gaps.
- Injection cases kept in a separate suite (15+).
- Freeze the dataset and its hash. Same input for every arm.
- **Dev subset:** a frozen 50-issue slice for prompt work and policy sweeps; the full 250 is run only with the frozen final policy.

### 11.2 Arms
| Arm | Description |
|---|---|
| A. Naive | Every stage (unmerged: classify, extract, dupe, draft) to a premium model, no cache. **Preferred: run it through Prune** with the premium model forced, `X-Prune-Cache: off` and shadow mode, so its numbers are also in signed receipts and no provider key leaves the vault. Cross-check against each arm-C receipt's counterfactual cost (`cost_without_prune_usd`, if present per VERIFY 9). Fallback only if VERIFY 10 fails: a separate script outside the app repo with a local provider key, never committed. |
| B. DIY | Cheap/strong tiering and a simple local exact-match cache we wrote, direct to provider |
| C. Sift on Prune | Full pipeline through Prune with workload tags and cache |
| D. Sift on Prune, cold vs warm | Run C twice to show the cache effect separately |

### 11.3 Metrics
- **Cost per task**: sum of receipt cost per task (arm C, and arm A when run through Prune), provider usage-based cost for B. Reported three ways so rule-only $0 tasks cannot be accused of padding the average:
  1. across all tasks,
  2. across tasks that made at least one LLM call,
  3. p50 and p95 for each of the above.
- **Total cost** for the 250 tasks.
- **Calls per task** (target about 1.5 average for arm C).
- **Cache hit rate** and cost saved from receipts, plus savings attributed by source (see 7.3).
- **Accuracy**: macro-F1 and accuracy vs maintainer labels, plus per-class precision/recall. Quality gate: arm C must not be worse than arm A by more than 2 points, **tested statistically** with a paired bootstrap confidence interval (or McNemar's test on per-issue correctness); a raw 2-point gap on 250 items is within noise. If the gate fails, the savings claim is not valid and we tune the policy.
- **Duplicate detection**: precision and recall on the repo's real duplicate pairs.
- **Reliability**: completion rate, `needs_human` rate and reasons, retry counts, p95 latency.
- **Safety**: injection suite outcomes, secret scan result.
- **Estimate error**: budget-gate estimate vs receipt actual.

### 11.4 Free-tier request budget
The free tier ends at 15,000 requests **or 14 days after the first Optimize receipt**, whichever is first. Rules:
- Do not send `X-Prune-Optimize` before Phase 3, so the 14-day clock does not start early. Note the date of the first Optimize receipt in section 14.
- Sweeps run on the 50-issue dev subset only.
- Rough budget at about 1.5 calls per task (arm A at about 4): arm A 1,000; arm C 375; arm D warm 375; 6 sweep configs on the dev subset 450; development and demo headroom about 3,000. About 5,200 total, well under the cap. Count requests per run in `bench_runs` and stop at 12,000.

### 11.5 Proof package (what we submit)
1. `proof/receipts/` raw signed receipts for the benchmark run.
2. `proof/verify.sh` (or `python -m sift.verify proof/receipts`) that checks every signature and recomputes totals.
3. `proof/report.md` with the tables and chart images, generated by script, not typed by hand.
4. A short note on methodology and limits, including that the dataset is one repo.

---

## 12. Repo layout

```
sift/
  README.md                 # problem, results table, how to run, proof links
  memory.md                 # this file
  .env.example
  .gitleaks.toml
  pyproject.toml
  config/
    policy.yaml             # tiers, thresholds, caps, model names
    prices.yaml             # local price table for the budget gate
  prompts/                  # versioned prompts and templates
  sift/
    llm.py                  # THE ONLY LLM CALLER
    receipts.py             # parse, store, verify
    budget.py               # gate and scopes
    loopguard.py
    sanitize.py
    pipeline/
      orchestrator.py
      classify.py
      dupes.py
      extract.py
      draft.py
      escalate.py
    ingest/github.py
    api/
      main.py
      routes_*.py
    db.py
    bench/
      dataset.py
      arms.py
      run.py
      report.py
    safety/
      injection_cases/
      run_suite.py
  web/                      # React app
  tests/
  proof/                    # generated: receipts, verify script, report
  scripts/
    check_single_caller.py  # CI: fails if any other module imports an LLM client
    demo_seed.py
  Dockerfile
  .github/workflows/ci.yml
```

---

## 13. Phases and team plan

### Roles (assign names at kickoff)

| Role | Owner | Primary responsibility |
|---|---|---|
| **A. Platform lead** | ______ | Prune integration, `llm.py`, receipts, budget gate, loop guard, CI checks |
| **B. Pipeline/ML** | ______ | Ingestor, sanitize, prompts, classify/dupes/extract/draft/escalate, accuracy tuning |
| **C. Frontend/UX** | ______ | React app, live cost panel, approval flow, receipts viewer, charts |
| **D. Benchmark, safety, demo** | ______ | Dataset, arms, reports, injection suite, README, demo script and video |

Rules: A and B pair on the first integration. D owns the truth of the numbers and may veto any claim that the data does not support. Everyone reviews each other's PRs within a few hours. Small PRs, main always runnable.

Time estimates are in working hours per person and assume roughly 5 to 7 focused days total. If the deadline is shorter, cut by the priority tags: **P0 must ship, P1 should ship, P2 only if time remains.**

---

### Phase 0: Spike and setup (about 0.5 day) **P0**

Goal: prove the pipe, answer every VERIFY item, agree on contracts.

| Who | Tasks |
|---|---|
| A | Create Prune account and key. Add one provider key to the vault. Set key spend cap and model allowlist. Make one call through the base URL. Capture raw request and response bytes including receipt. Confirm the docs answers for VERIFY 1, 2, 3, 6, 7 and answer 9. Send one call with a tiny `X-Prune-Run-Budget-Usd` to capture the real 429 shape. |
| B | Pick the repo. Pull 50 sample issues. Draft the label mapping and the six-class definitions. |
| C | Scaffold React + Vite + Tailwind, routing, layout shell, mock data for queue and cost panel. |
| D | Set up repo, CI skeleton, gitleaks, `.env.example`, `check_single_caller.py`. Answer VERIFY 4 (Shield), 5 and 10 with small experiments. Leave VERIFY 8 (Optimize) for Phase 3 so the free-tier clock does not start. Keep the Findings log current. |

**Exit criteria:** one call through Prune returns a receipt that `verify_receipt` accepts; Shield behavior on an obvious injection is documented; repo CI is green; roles and contracts below are agreed.

**Contracts to freeze in Phase 0:**
- `llm.call(stage, messages, schema, workload, template_id=None, tier) -> LLMResult(parsed, raw, receipt, usage)`
- Task JSON shape returned by the API
- `policy.yaml` schema

---

### Phase 1: Thin vertical slice (about 1.5 days) **P0**

Goal: one issue goes end to end, with a real receipt, visible in the UI.

| Who | Tasks |
|---|---|
| A | `llm.py` with retries, timeouts, error mapping. `receipts.py` store plus verify. Basic budget gate (task cap only). SQLite schema and migrations. |
| B | GitHub ingestor (read-only token). `sanitize.py`. Triage stage (classify + extract in one call) with Pydantic schema and prompt v1. Orchestrator with states ingested to classified to drafted (simple draft). |
| C | Queue page, task detail page showing stages and receipts, live cost panel wired to `/cost/summary`. |
| D | Dataset v0 (100 issues) with mapped labels. Benchmark runner skeleton. Unit tests for budget and receipts. Draft README outline. |

**Exit criteria:** ingest 20 issues, each ends with a label, a draft and verified receipts; cost per task visible in UI; every call goes through `llm.py` and CI proves it.

---

### Phase 2: Full pipeline (about 1.5 days) **P0**

Goal: all stages, escalation, approval flow, real cost routing.

| Who | Tasks |
|---|---|
| A | Tiering and policy loader. Workload tags, template ids, cache modes and Prune run headers wired per stage. Run and hour caps, warned and downgraded states. Loop guard with retry caps and circuit breaker. Kill switch. |
| B | Dupe confirm (BM25 shortlist plus thresholded, uncached LLM confirm), evaluated on the repo's real duplicate pairs. Escalation rules and confidence thresholds. Template replies. Draft quality prompt iterations. Repair-retry on schema failure. |
| C | Approval, edit and reject UI. Reason display for `needs_human`, `budget_stopped`, `blocked_by_shield`. Receipts viewer with verification badge. Kill switch button. |
| D | Dataset v1 (250 frozen, hashed, plus the 50-issue dev subset). Arms A, B, C implemented. First benchmark pass on the dev subset. Accuracy tracking. Start injection case library (15+). Request counter per run. |

**Exit criteria:** full 250-issue run completes with fewer than 5% unexplained failures; first cost and accuracy numbers exist for all arms; approval flow works end to end.

---

### Phase 3: Harden, tune, prove (about 1.5 days) **P0/P1**

Goal: the numbers we will defend, and the safety evidence.

| Who | Tasks |
|---|---|
| A | Failure injection (simulated 429, 5xx, timeouts, malformed JSON) with automated tests. Receipt-missing handling. Estimate-vs-actual reporting. Log redaction. Rotate keys. |
| B | Policy sweep on the dev subset: thresholds and model choices against cost and accuracy; pick the final policy and freeze it. Try `X-Prune-Optimize` light/compact (first use starts the 14-day free-tier clock) and keep only if accuracy holds. Prompt hardening against injections. |
| C | Benchmark report page: baseline vs Prune chart, cache hit chart, per-stage cost breakdown, injection results table. Mobile and empty states. Demo mode with seeded data. |
| D | Final benchmark with frozen policy, cold and warm runs. Run injection suite and record outcomes. Generate `proof/` package and `verify` script. Write limits and methodology. |

**Exit criteria:** final report generated by script; accuracy within the 2 point gate; all receipts verify; injection table complete; failure-injection tests pass.

---

### Phase 4: Package and demo (about 1 day) **P0**

Goal: a submission that is easy to judge.

| Who | Tasks |
|---|---|
| A | Dockerfile, one-command run, deploy to a public URL, health check, final key rotation. Freeze main. |
| B | Bug fixes only. Prepare 5 ideal live demo issues, including one duplicate and one injection. |
| C | Final polish, loading and error states, record screen captures for the video. |
| D | README with results table up top, architecture diagram, proof instructions. Demo script, two full rehearsals, backup video recorded. Submission form. |

**Exit criteria:** fresh clone runs in under 10 minutes using README alone; demo link works; backup video exists; everyone has rehearsed their part.

**Feature freeze at the start of Phase 4.** Nothing new after that except fixes.

---

### Stretch goals (only after all P0 and P1 are done) **P2**
- GitHub webhook for live ingestion instead of polling.
- Second repo to show generality.
- Per-label cost dashboard and a "what would this cost at 10k issues per month" projection, clearly labeled as a projection.
- Maintainer feedback loop: approved edits feed few-shot examples into prompts.
- Cost-aware autopilot: auto-approve only template replies above a very high confidence, behind a flag, off by default.

---

## 14. Findings log (fill in during Phase 0 onward)

Rows dated 2026-10-31 come from Prune's public docs ([how it works](https://www.withprune.com/docs/how-it-works), [docs](https://www.withprune.com/docs), [verify](https://www.withprune.com/verify), [llms-full.txt](https://www.withprune.com/llms-full.txt)). Status **docs** = documented but not yet confirmed against a live response; change to **confirmed** (with your name) once Phase 0 sees it.

| Date | Who | Question | Finding | Status |
|---|---|---|---|---|
| 2026-10-31 | docs | Receipt location and fields (VERIFY 1) | `prune_metadata` object merged into the JSON response body. Documented fields include `cache_hit`, `cache_type`, `tokens_saved`, `cost_saved`, `optimizations_applied`, `shield_canary_injected`, `route_fallback_used`; shadow mode adds `shadow_*` fields. Fields vary per request. Response headers also carry `X-Prune-Cache-Hit`, `X-Prune-Cache-Type`, `X-Prune-Cost-Saved`, `X-Prune-Provider`. `cost_with_prune_usd` / `cost_without_prune_usd` names not seen in these docs yet. | docs |
| 2026-10-31 | docs | Public key and verify flow (VERIFY 2) | Ed25519. Public key: `GET https://api.withprune.com/v1/public-key`. Hosted check: `POST /v1/receipts/verify` (request shape undocumented). Signed payload = every receipt field except `receipt_signature`, `receipt_signed_at`, `receipt_signing_key_id`, serialized as JSON with sorted keys and `separators=(',',':')`; signature is base64. Only live-response receipts (with `receipt_signature`) and Shield → Reports 7-day exports are signed; dashboard request-log copies are unsigned and will fail. | docs |
| 2026-10-31 | docs | Provider vault setup (VERIFY 3) | Dashboard → Connect → Providers; stored AES-256-GCM. Model chosen by normal provider name (`model="gpt-4o"`). Auth: quickstart passes the Prune key as the SDK `api_key` (`Authorization: Bearer`); the how-it-works page says `X-Prune-Key`. Test both. Anthropic SDK base URL is `https://api.withprune.com` (no `/v1`). | docs |
| 2026-10-31 | docs | Shield behavior on injection (VERIFY 4) | Not documented. `shield_canary_injected` suggests canary-token leak detection rather than blocking. Shield documents rate limits, daily spend caps, model and IP allowlists, and fails closed. | open |
| 2026-10-31 | docs | Routing: automatic vs tag-driven; how to force a model (VERIFY 5) | `X-Prune-Pipeline-Mode` per request (default Recommended = `auto`, which also enables semantic cache); `X-Prune-Pipeline-Label` returns "Recommended" or "Max savings". Response headers `X-Prune-Route-Applied`, `X-Prune-Original-Model`, `X-Prune-Routed-Model`, `X-Prune-Route-Reason` (original/routed only when the model changed). Shadow mode reports projected savings without changing the upstream model. How to force no routing: still open. | partial |
| 2026-10-31 | docs | Cache semantics and bypass (VERIFY 6) | Request header `X-Prune-Cache`: `off`, `exact`, `normalized`, `semantic`. Exact = identical model, messages, temperature, tools (Redis). Semantic matches by embedding similarity above a threshold, with optional verified mode (judge model). Template-aware cache hits when only the variable part of a stable template changes. Scoped to our account. TTL undocumented. | docs |
| 2026-10-31 | docs | Rate limits and error shapes (VERIFY 7) | Blocked calls return 429 with `X-Prune-Shield-Code` (e.g. `spend_cap`, `rate_limit`, run limits). 501 for Bedrock streaming. Body shapes undocumented. Run headers: `X-Prune-Run-Id`, `X-Prune-Run-Budget-Usd`, `X-Prune-Max-Steps` (429 + shield code when hit). Also `X-Prune-Customer-Id`, `X-Prune-Feature-Id`. Overhead target p50 < 30 ms, p95 < 80 ms on cache miss. | docs |
| 2026-10-31 | docs | Effect of Optimize modes (VERIFY 8) | Not documented beyond "routing, output caps, template hoisting, compression" on unique traffic. Measure on the dev subset. | open |
| 2026-10-31 | docs | Free tier limits | 15,000 requests/month **or 14 days from the first Optimize receipt**, whichever comes first. Starter $15/mo (250k), Pro $49/mo (1M). | docs |

---

## 15. Demo script (3 minutes)

| Time | Beat | What the screen shows |
|---|---|---|
| 0:00 | Problem | One sentence: maintainers drown, AI apps burn money. Show a real repo's issue queue. |
| 0:20 | Live triage | Run 10 fresh issues. Labels, dupes and drafts appear. Cost panel ticks in fractions of a cent. |
| 1:00 | Repeat is free | Edit an issue and re-triage it. Receipt shows cache hit and zero upstream cost. Say plainly that most savings come from rules and tiering (show the by-source breakdown). |
| 1:25 | Proof | Open one receipt, click verify, signature valid. Show cost with Prune vs the counterfactual cost without it. |
| 1:50 | Benchmark | Chart: Naive vs DIY vs Prune, cost per task and accuracy side by side. State the real measured numbers. |
| 2:20 | Safety | Paste an injection issue: harmless (no action field, human approval). Trigger a loop: Prune returns 429 with a shield code, task moves to `budget_stopped`, bill flat. Point at clean gitleaks run. |
| 2:50 | Close | Cost per task, accuracy, and "every call through one base URL". |

Backup plan: pre-recorded video of the same flow and seeded data mode in case the network fails.

---

## 16. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Prune behaves differently than docs suggest | Medium | High | Phase 0 spike; Findings log; keep `llm.py` thin so adapting is cheap |
| Receipts missing on some paths (e.g. errors, cache) | Medium | High | Treat missing receipt as failure; test every path in Phase 0 |
| Savings smaller than hoped | Medium | Medium | Honest reporting; the accuracy gate protects credibility; emphasize safety and proof |
| Accuracy drops when using cheap tiers | Medium | High | Policy sweep in Phase 3; escalation on low confidence |
| Free tier request cap hit during benchmarks | Low | Medium | Budget in 11.4; sweeps on the dev subset; request counter stops at 12,000 |
| Free tier 14-day clock starts too early | Medium | High | No `X-Prune-Optimize` before Phase 3; record the first Optimize receipt date |
| Receipt verification fails from re-serialization | Medium | High | Store raw response bytes; verify from the raw text (principle 7) |
| Semantic cache returns a wrong duplicate answer | Medium | Medium | Cache `off` for dupe confirm; BM25 does the matching |
| Provider rate limits during runs | Medium | Medium | Concurrency limit, backoff, resume-able runs |
| Scope creep | High | High | Non-goals list, P0/P1/P2 tags, feature freeze |
| Demo network failure | Medium | High | Seeded mode and backup video |
| Teammate unavailable | Medium | Medium | Every module has a named backup owner (A/B pair, C/D pair) |
| Dataset license or ToS issue | Low | Medium | Public repo, issue text only, cite the repo, store metadata and hashes where possible |

---

## 17. Definition of done (submission checklist)

- [ ] Working public demo link and backup video
- [ ] Every LLM call goes through `llm.py` to the Prune base URL; CI check passes
- [ ] No provider keys in the repo or history; gitleaks clean
- [ ] Benchmark of 250 issues across all arms, accuracy gate met
- [ ] Cost per task reported from receipt data, with p50 and p95
- [ ] `proof/` folder with raw receipts and a working verify command
- [ ] Injection suite results table (15+ cases)
- [ ] Failure-injection tests pass; budget cap and kill switch demonstrated
- [ ] README: results first, architecture diagram, run instructions, limits and honest caveats
- [ ] Demo rehearsed twice by the person presenting

---

## 18. Working agreements

- Branches off `main`, small PRs, at least one review, CI must pass.
- Daily 15 minute sync: yesterday, today, blockers. Update section 14 and tick boxes here.
- Numbers in the README come only from generated reports. No hand-typed claims.
- If a claim cannot be backed by a receipt or a test, we do not make it.
- Decisions that change scope get written into this file with the date and the reason.

---

## 19. Decision log

| Date | Decision | Reason |
|---|---|---|
| 2026-10-31 | Merge Classify and Extract into one Triage call; Dupe confirm only above a BM25 threshold. Target about 1.5 calls per task. | Fewer calls is the biggest cost lever and keeps the benchmark inside the free tier. |
| 2026-10-31 | Send Prune run headers (`Run-Id`, `Run-Budget-Usd`, `Max-Steps`, `Feature-Id`) on every call; set key spend cap and model allowlist. | Server-side enforcement behind our local gate; per-stage cost breakdown; "Best Use of Prune". |
| 2026-10-31 | Cache mode per stage; cache `off` for dupe confirm. | Semantic cache could return a confirmation for the wrong issue. |
| 2026-10-31 | Arm A runs through Prune (premium model forced, cache off, shadow mode) if VERIFY 10 passes. | Baseline numbers also come from signed receipts; no provider key outside the vault. |
| 2026-10-31 | Accuracy gate tested with paired bootstrap / McNemar; cost per task reported across all tasks and LLM-touched tasks. | A raw 2-point gap on 250 items is noise; rule-only $0 tasks could look like padding. |
| 2026-10-31 | Duplicate ground truth from the repo's own duplicate-closed issues. | Real labelled pairs beat synthetic ones. |
| 2026-10-31 | 50-issue dev subset for sweeps; no Optimize before Phase 3. | Free tier is 15k requests or 14 days from the first Optimize receipt. |
| 2026-10-31 | Store raw receipt bytes and verify from them. | Re-serialization can break Ed25519 verification. |
| 2026-10-31 | Demo says injection cases are "harmless", not "blocked". | Shield's injection behavior is undocumented. |
| 2026-10-31 | **Product switched to Athena (chat with documents); see `athena.md`.** Sift's issue triage survives there as a stretch pack. This file is kept for reference only. | Athena's flat follow-up cost curve is the stronger cost story; the Prune findings in section 14 carry over. |
