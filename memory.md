# Athena: General AI Assistant on a Budget

Last updated: 2026-10-31 (Asia/Calcutta).

This document is the source of truth for the agreed project scope, application flow, safety controls, and build order. It describes planned behavior, not implemented functionality. Update status and verified findings as development proceeds.

## 1. Final project decision

Athena is a general AI assistant for everyday tasks. It selects a suitable model, handles documents intelligently, maintains relevant conversation context, and makes spending visible.

**Product promise: Ask Athena naturally. It chooses suitable AI capabilities, delivers the result, and shows what you spent.**

Initial tasks: writing and rewriting, explanations, code assistance, PDF summaries, and questions about uploaded documents.

This replaces the earlier Sift GitHub issue-triage plan. GitHub issue management is not required. Athena is not only a PDF router; document handling is one workflow within general chat.

Normally one selected model answers a request. Multiple agents do not debate every answer. Extra calls for routing, recovery, document processing, or session summaries must be justified and counted.

## 2. Hackathon requirements

Track: **Ship It Lean: AI Apps on a Budget**, Prune / FORGE private brief supplied by the user.

Build a useful AI app or agent; route every LLM call through Prune with one base URL; prove task completion, cost efficiency, provider keys outside the codebase, and failures that cannot cause uncontrolled spending.

Required submission: working demo, cost per task, and Prune's signed receipts as proof.

| Criterion | Weight | Evidence |
|---|---:|---|
| Usefulness | 40% | Working daily-task and document workflows; evaluated answers |
| Cost efficiency | 30% | Suitable routing, relevant context, reused document preparation, measured costs |
| Reliability and safety | 20% | Protected secrets, spending reservations, bounded attempts, safe recovery |
| Demo | 10% | Repeatable workflow, receipts, measured results, controlled failure demonstration |

Best Use of Prune prizes stated in the brief: 12 months Pro for first place, 6 months for second. Winning and savings percentages are not guaranteed.

## 3. Current status

At this update, planning documents exist; the Athena application has not been implemented or tested. The comparison directory contains PAL reference material and is not app source or a dependency.

prune.md contains earlier integration notes. Treat its model names, pricing, headers, examples, and assumptions as unverified until tested. This document takes precedence on product scope.

## 4. Selected features

| Feature | Agreed behavior |
|---|---|
| Chat and history | Save conversations and support follow-up questions |
| Chat memory | Use relevant recent messages plus a saved summary; no promise of perfect recall |
| Automatic model selection | Choose an economical or stronger suitable model based on requirements and capabilities |
| Model explanation | Show a short selection reason and actual model served where available |
| PDF summarization | Cover the document appropriately, not only a few retrieved pages |
| Direct extraction and OCR | Extract usable PDF text directly; OCR scanned pages or images containing text |
| Document indexing | Save extracted text, searchable sections, page references, and document version/hash |
| Document questions | Retrieve relevant passages and answer with inspectable source references |
| Budget-aware processing | Reserve allowance before paid calls; offer shorter output or smaller scope if necessary |
| Costs and receipts | Record all calls and expose verification status |
| Bounded recovery | Limit attempts, preserve completed work, and pause safely |
| Failure timeline | Show steps, failures, actions taken, and unresolved costs |
| Markdown checkpoint | Save a reviewable session handoff near the spending limit using reserved allowance |

Emails, checklists, explanations, and summaries can be returned in chat. Rich artifact creation is not required for v1.

## 5. Entire application flow

1. User starts or reopens a session and optionally sets a spending allowance.
2. User sends a message and may attach a PDF or supported text image.
3. Backend checks access, assigns a unique operation ID, and loads relevant conversation context.
4. For a new document, validate type and limits, extract text page by page, selectively OCR when needed, and save an index with page references.
5. Prepare relevant chat context or document passages. Whole-document summaries require broad coverage.
6. Select a suitable model based on requested work, input size, capabilities, and evaluated policy.
7. Check task limits and centrally reserve bounded call allowance. Offer a smaller request or pause if insufficient.
8. Send the call through the shared Prune client. Never bypass Prune during outages.
9. Perform practical task-specific checks; recover only within call, time, and spending limits.
10. Save response, model information, recorded cost, receipt, verification status, and timeline events.
11. Display answer first; expand details for model, cost, sources, and receipts.
12. Save conversation state and memory; reuse document preparation for follow-ups.
13. Near the spending threshold, create one checkpoint for a fixed message range and offer Markdown download.

```text
Message / PDF / supported text image
                 |
       Load relevant chat context
                 |
    Direct extraction / selective OCR
                 |
       Save and reuse document index
                 |
    Prepare relevant context for task
                 |
       Select suitable model
                 |
    Check limits and reserve allowance
                 |
       Shared client -> Prune -> model
                 |
    Check result / bounded recovery / pause
                 |
 Answer + sources + model + cost + receipt
                 |
      Save memory and checkpoint state
```

## 6. Routing policy

- Begin with two verified model options: economical and stronger. Expand only if evaluation justifies it.
- Start with deterministic rules for obvious cases. Add a small routing classifier only when its benefit justifies its cost.
- Consider task type, input size, context capacity, required capabilities, and user constraints. Length or keywords alone do not establish difficulty.
- Simple rewriting may use an economical model. Difficult analysis may go directly to a stronger model; not every request must try both.
- Record requested and actual served models separately. Verify how Prune routing interacts with Athena's choice and model-forcing controls.
- Live information requires an appropriate retrieval tool, not merely a stronger model. Live web research is outside initial scope.
- Do not run an expensive judge on every answer. There is no universal automatic correctness test for general chat.
- Side-by-side answer comparison is optional evaluation/demo functionality only. It adds cost and does not automatically declare the stronger model better.

## 7. Document handling

### Extraction and OCR

- Digital PDFs with usable text: extract directly; no OCR needed.
- Scanned pages: use OCR. A page can look like text while being only a picture.
- Mixed PDFs: decide per page. Poor existing text layers may need fallback.
- OCR reads writing. It does not itself find relevant passages or answer questions.
- Start with text PDFs, then clean scans. Handwriting, complex tables, charts, and general photo understanding are deferred.
- Preserve original page references. OCR can misread amounts, dates, and names; sources must remain inspectable.

### Indexing and retrieval

- Store extracted text and searchable sections, not only a summary; a summary omits details.
- Start with local keyword/BM25-style retrieval. Add embeddings only if evaluation justifies them, and verify Prune support for any hosted embedding calls.
- Specific questions retrieve relevant sections. Whole-document summaries require broader coverage or bounded section summaries plus synthesis.
- Save document hashes/versions and reuse unchanged preparation. OCR, indexing, and storage still consume resources.
- Keep user/session ownership on files and search results. Never retrieve another user's content.
- If evidence is missing, say so rather than inventing a document answer.

## 8. Conversation memory and Markdown checkpoint

Keep original messages plus a summary with an explicit last-included message pointer. Use relevant recent messages and summary within context limits. Distinguish confirmed decisions, completed work, proposals, and open questions. Memory summaries are lossy.

Checkpoint implementation:
1. Reserve a bounded summary allowance early, within session and account limits.
2. Check usage before admitting large calls and after completed calls. An initial 80% trigger is configurable, not a fixed product guarantee.
3. Snapshot the message endpoint and create one durable job; enforce uniqueness on session plus message endpoint.
4. Use the cheapest suitable verified model through Prune. Prefer previous summary plus new messages, with bounded batches when needed.
5. Validate structured fields: goal, confirmed decisions, completed work, next steps, open questions, and references.
6. Render Markdown using code; save privately and expose an authenticated download.
7. If allowance is insufficient or generation fails, provide a labeled basic transcript export without another AI call. Preserve uncertain billing states.

Show coverage and whether newer messages are excluded. Exclude credentials and allow user review. Do not silently export sensitive content. Continuing from a summary does not restore deleted files or reset spending limits.

## 9. Spending and accounting

Pay-as-you-go is billing; a budget is a maximum spending allowance, not an upfront payment. The API account owner is charged. Charging end users is outside v1.

- Enforce task, session, and application/account limits.
- Centrally and atomically reserve allowance before each paid call. Concurrent requests must not spend the same remaining allowance.
- Bound input, output, allowed models, and attempts. Use conservative bounds based on verified pricing where supported; estimates alone are not strict spending guarantees.
- Use integer monetary micro-units or database decimals, not binary floats.
- Reconcile against returned cost information and receipt verification. Unknown charges stay pending, not zero.
- Count routing, paid document processing, hosted embeddings if used, repairs, escalation, and checkpoint calls. Report their attribution clearly.
- Configure and test Prune spending controls as an additional layer.
- Separate actual recorded cost, Prune's estimated counterfactual savings, and measured baseline differences.
- Zero upstream cost on a cache hit does not imply zero service or infrastructure cost.

If allowance is insufficient, select relevant context, offer shorter output or smaller scope, or pause. Never silently remove essential instructions/evidence. Shorter output does not erase input costs already incurred.

## 10. Safety and secrets

- Provider keys stay in Prune's vault after verifying the setup flow.
- Prune credentials stay in backend environment/deployment secret settings, never frontend bundles, prompts, Git, screenshots, or logs.
- Ignore .env; commit only placeholder names in .env.example.
- Secret scanning runs before commits and in CI. Revoke exposed credentials; deleting visible text is insufficient.
- Every LLM call uses one shared module and configured Prune base URL: normal answers, routing, repair, summaries, and evaluation. No direct-provider fallback.
- Enforce the shared path through review, CI checks, and runtime call records; text scanning alone is incomplete proof.
- Uploaded and retrieved text is untrusted data, separate from application instructions. It cannot authorize tools or external actions.
- Do not put credentials in model context. Initial outputs are answers/drafts, not autonomous sends, purchases, or code execution.
- Bound upload size, page count, extraction time, and output size.
- Authenticate resource access and isolate user files, search results, conversations, checkpoints, and receipts.
- Do not log raw sensitive content routinely. Protect public demos with access/rate controls and server-side spending caps.

## 11. Reliability and failure handling

Bounded recovery means limited attempts to recover. Safe pause means preserving completed work and clearly explaining why continuation stopped. One paused task does not require stopping the entire app.

Use task-specific planned-call, recovery, time, and spending limits. A three-call limit was an example starting policy, not a universal requirement for every workflow. Include automatic SDK retries and gateway fallbacks in attempt accounting; avoid nested retry loops.

| Failure | Behavior |
|---|---|
| Invalid key or invalid request | Stop; configuration/input correction required |
| Budget rejection | Pause without another paid attempt |
| Temporary rate limit | Respect retry timing; bounded backoff if allowance permits |
| Provider outage | Bounded suitable fallback through Prune if supported, otherwise pause |
| Invalid structured output | Bounded repair only if useful and affordable |
| Ambiguous timeout | Preserve pending allowance, record uncertainty, reconcile before blindly resending |
| Missing or invalid receipt | Mark unverified; stop automatic paid continuation; do not regenerate just for a receipt |
| Worker interruption | Reuse saved stages; reconcile in-flight paid calls before replay |

Additional controls:
- Unique operation IDs prevent duplicate submissions from blindly duplicating work.
- Persist stages, results, and events; reuse extraction/indexing after restart.
- Do not promise exactly-once provider billing after ambiguous failures without verified gateway support.
- A circuit breaker pauses affected calls after repeated service failures and permits controlled recovery checks.
- Admin stop control blocks new calls; it cannot guarantee cancellation of requests already accepted by providers.
- Resume never resets account limits or discards pending charges.
- Failure timeline records time, stage, safe explanation, call IDs, recovery actions, and available cost status.

Example timeline: file saved -> extraction completed -> model selected -> allowance reserved -> timeout -> charge pending -> safely paused.

## 12. Technical architecture

Initial stack: **Python, FastAPI, Pydantic, React, one shared Prune client**.

A single-process prototype can use SQLite and saved jobs. If committing to shared/distributed workers, use PostgreSQL for durable shared state and shared private file storage.

Distributed document processing is an optional extension, not a prerequisite. Redis/Celery with a small worker pool can process OCR and indexing after local workflows work. Use a supported Linux/container environment rather than assuming native Windows support. More workers increase capacity but add infrastructure cost and remain subject to provider limits.

Suggested layout:

```text
backend/
  app/
    main.py
    api/
    services/
      llm.py
      routing.py
      budget.py
      documents.py
      retrieval.py
      memory.py
      checkpoints.py
      receipts.py
    models/
    db.py
  tests/
frontend/
config/
proof/
.env.example
README.md
```

Entities: access identities/users, sessions, messages, tasks, documents, searchable chunks, AI calls, receipts, spending reservations, task events, and checkpoints. Exact schemas remain to be defined.

Proposed APIs, not implemented:

| Method | Path | Purpose |
|---|---|---|
| POST | /sessions | Start session and optional allowance |
| GET | /sessions/{id} | History and status |
| POST | /sessions/{id}/messages | Submit uniquely identified task |
| POST | /sessions/{id}/documents | Upload and enqueue preparation |
| GET | /documents/{id} | Processing state |
| GET | /tasks/{id} | Result, calls, and timeline |
| GET | /calls/{id}/receipt | Receipt and verification |
| GET | /sessions/{id}/cost | Spent, reserved, pending, remaining |
| GET | /sessions/{id}/checkpoints/{checkpoint_id}/download | Private Markdown export |
| POST | /tasks/{id}/resume | Controlled explicit resume |
| POST | /admin/pause | Admin-only stop for new calls |

Freeze task/result JSON before separate frontend/backend work. Distinguish queued, running, completed, paused, failed, and pending-reconciliation states.

## 13. Implementation roadmap

| Phase | Work | Exit criterion |
|---|---|---|
| 0 | Verify Prune auth, models, routing controls, costs, receipt/signature flow, errors | Real call works and receipt verifies |
| 1 | Minimal chat, database, UI, shared client, basic controls and call records | Saved chat returns answer, model, cost, receipt and survives refresh |
| 2 | Reservations, bounded attempts, duplicates, timeline, pause | Duplicate submissions and exhausted allowance handled correctly |
| 3 | Two model tiers, rules, short explanations, served-model tracking | Evaluated routing reflects task needs |
| 4 | Text PDFs, saved index, retrieval, citations, broad summaries | Follow-up questions reuse document preparation |
| 5 | Selective OCR, incremental memory, Markdown checkpoint | Supported scans work and checkpoint coverage is explicit |
| 6 | Evaluation, failure tests, reports, deployment, rehearsal | Reproducible evidence and reliable demo |

First milestone: **one saved chat request through Prune with answer, actual model information where available, recorded cost, and verifiable receipt**.

Suggested four-person ownership, to confirm with team:
- A: shared client, receipts, model routing.
- B: database, budgets, recovery, memory/checkpoints.
- C: extraction, retrieval, OCR.
- D: frontend, integration, demo packaging.

Everyone contributes evaluation cases and reviews shared contracts. Add distributed workers only after reliable local document processing, if time permits.

## 14. Evaluation and proof

Use a fixed mixed set of writing, explanation, code, document-question, and summarization tasks. Begin small; target 100-150 tasks if time/allowance permit. This is planned, not achieved.

Compare economical-only, stronger-only, and Athena routing policies. All benchmark LLM calls still go through Prune. Verify model forcing and cache controls; disclose limitations. Separate development examples from held-out final evaluation.

Measure total cost including every paid stage, completion, task-specific quality, latency, escalation, failures, and receipt coverage. Use objective checks where possible and human review for subjective tasks. Separate first-run from repeated-input results and model-selection effects from caching where measurable.

A valid signature authenticates the signed record; it does not establish answer correctness. Missing receipts and uncertain costs must be visible.

Test: duplicate submission, concurrent reservations, exhausted allowance, rate limit, invalid key, timeout, malformed output, missing/altered receipt, interrupted worker, cross-user resource access, and malicious instructions inside documents.

Proof package: safely stored raw receipts, verification command, generated cost/quality report, methodology and limits. No invented savings claims.

## 15. Demo and deferred scope

Demo: simple rewrite routed economically -> justified stronger-model task -> document answer with cited page -> recorded cost and verified receipt -> controlled budget stop or clearly labeled simulated failure -> saved progress/checkpoint if stable. Prepare a backup recording and distinguish replay from live data.

Outside required v1 scope: GitHub issue triage, always-on answer comparison, debating agents, expensive judging of every answer, live web research, arbitrary generated-code execution, autonomous external actions, end-user billing, complex image/chart understanding, and large microservice deployments.

Possible later extensions: calculator/predefined data-analysis tools, richer downloadable outputs, editable saved preferences, sensitive-information preview, more providers, and distributed document workers. Do not add before core correctness, safety, and evidence work.

## 16. Prune connection things to test

| Question | Status |
|---|---|
| Authentication and vaulted provider-key setup | VERIFY |
| Available models and current prices | VERIFY |
| Actual receipt/cost fields, signature payload, public key | VERIFY |
| Model forcing versus Prune routing | VERIFY |
| SDK/gateway retries and fallback cost visibility | VERIFY |
| Timeout reconciliation and idempotency support | VERIFY |
| Spending-cap and concurrent-call behavior | VERIFY |
| Cache scope, controls, bypass, and billing | VERIFY |
| Structured output and non-streaming behavior | VERIFY |
| Hosted embeddings if later used | VERIFY |
| Shield and optional privacy behavior | VERIFY |

References: https://www.withprune.com/docs/how-it-works ; https://www.withprune.com/docs/security ; https://pypi.org/project/prune-sdk/

Record dated experiments, safe sample responses, configurations, and limitations here. Never record keys. Public documentation is guidance, not proof of the deployed behavior.

## 17. Definition of done

- [ ] Saved chat and follow-ups work with relevant context.
- [ ] Routing is evaluated and actual model behavior is visible.
- [ ] Text PDF extraction, reusable search, citations, and summaries work.
- [ ] Selective OCR works on supported clean scans.
- [ ] All LLM calls go through Prune; no direct-provider fallback.
- [ ] Secrets, access isolation, and secret scanning are verified.
- [ ] Reservations, bounded attempts, duplicate protection, and pause are tested.
- [ ] Uncertain charges remain pending, not zero.
- [ ] Call costs and receipts are recorded and signatures verified.
- [ ] Markdown checkpoint, coverage display, and no-AI export work.
- [ ] Report includes measured cost, quality, and limitations.
- [ ] Demo access/spending are controlled; rehearsal and backup recording are complete.

Decision log: 2026-10-31 - replaced the earlier Sift scope with the user-selected general Athena assistant. This is a planning update; no functionality is claimed as implemented.
