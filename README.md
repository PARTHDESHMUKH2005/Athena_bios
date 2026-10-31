# Athena

Ask any document anything, see what each answer cost, and verify the receipt. Built for the FORGE "Ship It Lean: AI Apps on a Budget" track: every model call goes through Prune, provider keys stay out of the code, and spending is checked before each call.

| Path | What |
|---|---|
| `memory.md` | The team's agreed product scope, flow, safety controls and build order (source of truth) |
| `prune.md` | Notes on integrating with Prune (unverified until Phase 0) |
| `athena.md` | Technical plan for the document question-and-answer engine: architecture, database, API, tests, benchmark |
| `athena-content.md` | Website and in-app copy |
| `athena/` | The code: Cloudflare Worker backend (`src/`), React app (`web/`), mock Prune, tests, benchmark. Start at `athena/README.md` |
| `docs/archive/` | Earlier plans kept for reference |

## Status

The code in `athena/` covers the **document engine**: upload and index a PDF, ask questions with page citations, per-answer cost and signed receipts, budget reservation, bounded retries, pause and recovery, activity timeline, usage and receipt export, and an offline receipt verifier. It has been tested against a **mock** Prune and SQLite only (84 backend tests pass). It has **not** run against the real Prune, D1 or Workers yet: see `athena/PHASE0.md`.

The broader scope in `memory.md` (general chat, writing and code help, automatic model selection beyond tiers, OCR, session checkpoints) is not built.

## Try it locally (no accounts needed)

```bash
cd athena && npm install && npm --prefix web install
npm test                 # 84 tests
npm run dev:stack        # API + mock Prune        (terminal 1)
npm run web              # http://127.0.0.1:5173   (terminal 2)
```
