# Status: Keha Chopra

Stream **D: Frontend, integration, demo, product scope** (see [STATUS.md](../STATUS.md) section 2 for your paths).
Last updated: 2026-10-31. *First draft written from the repo history and the plan; Keha, please correct anything that is wrong and keep this file current. It is the only status file you edit.*

## Done
- Finalized the Athena assistant scope and roadmap in `memory.md` (the team's source of truth for what to build).
- Already in the repo for you, built by Harshdeep and tested by driving it in a browser against a mock: a React app in `athena/web/` with a landing page, a "start a workspace" screen, and a workspace (upload a PDF, ask questions with page citations, live activity timeline, receipts, pause and retry cards, usage). A self-contained interactive preview is at `athena/web/artifact/athena-site.html`. All words are in `athena-content.md`.

Run it (two terminals, in `athena/`, no accounts needed):
```bash
npm install && npm --prefix web install
npm run dev:stack      # real API over in-memory SQLite + mock Prune
npm run web            # http://127.0.0.1:5173
```

## Doing now: kickoff (K0) and Phase 0
- [ ] Lead decision **D1** (see STATUS.md section 4): keep the built TypeScript Cloudflare Worker and React app, or port to the Python and FastAPI stack in `memory.md` section 12.
- [ ] Confirm the stream assignments in STATUS.md section 2, including who the fourth member is.
- [ ] List the screens and scenarios the demo needs (memory.md section 15), so Phase 1 knows what to build.
- [ ] Put a one-line pointer in `memory.md` section 16 to Parth's Phase 0 findings in `prune.md`.

## Next
1. **Gap list** between `memory.md` section 5 (the full flow) and the current web app. Known gaps: chat with no document, a "why this model" explanation, a sources panel for several documents, the checkpoint screen, OCR status.
2. Phase 1: point the app at the real API and show the actual served model.
3. Phase 3: add general evaluation cases (writing, explanation, code) in `athena/bench/cases/general.json`.
4. Phase 5: checkpoint screen, coverage display and download.
5. Phase 6: demo script, rehearsal, backup recording; put **real** numbers on the landing page (`athena/web/src/lib/facts.ts`) only after the benchmark has run.

## Blocked / need from others
- Chat with no document needs an API change from Harshdeep (Phase 1).
- The "why this model" text needs Parth's routing explanations (Phase 3).
- Real receipt and model data waits for Phase 0.

## Notes for the team
- The web app mirrors the API in `athena/web/src/lib/types.ts`. Keep it in step with B's contract changes (additive only; see CONTRIBUTING.md).
- Three web files belong to Member 4: `web/src/lib/pdf.ts`, `web/src/lib/limits.ts`, `web/src/app/useUpload.ts`. Ask before changing them.
