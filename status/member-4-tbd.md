# Status: Member 4 (name to confirm)

Stream **C: Documents: extraction, retrieval, OCR, document safety** (see [STATUS.md](../STATUS.md) section 2 for your paths).
**When you join, rename this file to `status/<your-name>.md` (one file, only you touch it) and put your name in STATUS.md section 2.**
Last updated: 2026-10-31. *Drafted before an owner was confirmed.*

## Start here (about an hour)
1. Read `memory.md` sections 7 (document handling) and 10 (safety), then `athena.md` sections 2.4 and 2.5.
2. Run it: from `athena/`, `npm install && npm --prefix web install`, then `npm test` and `npm run dev:stack` plus `npm run web`. Try **Start a workspace** then **Try a sample contract**.
3. Read your code: `src/sectioner.ts` (splits text into sections with page ranges), `src/context.ts` (retrieval, safe search queries, memory, fenced untrusted text), `src/answer.ts` (citation and extraction checks), `src/outputscan.ts` (removes secrets, foreign links and risky commands from answers), `src/packs/` (general and invoice), and in the web app `pdf.ts`, `limits.ts` and `useUpload.ts` (text is read in the browser).

## Done (already in the repo, tested only against a mock)
- Text PDFs: read in the browser, indexed into sections with page ranges, keyword retrieval, page citations validated against what was sent.
- A 15-payload prompt-injection suite (`tests/injection.test.ts`) and the output scan. The suite proves what the model may see and do; it does **not** prove a real model resists.
- Sample contract and invoice PDFs (`web/public/samples/`) and the script that makes them.

## Doing now: Phase 0
- [ ] Measure pdf.js speed and memory on a 100-page PDF (athena.md 4.9 item 15).
- [ ] Prepare scanned and mixed (text plus scan) test PDFs, clearly labelled synthetic.
- [ ] With Parth: find out whether Prune passes images through to a vision model (OCR depends on it).

## Next
1. Phase 1: run real model answers through your prompts and citation checks; fix what the real model breaks (`context.ts`, `answer.ts`).
2. Phase 2: cross-user isolation tests for documents, search and receipts (memory.md section 14).
3. Phase 3: add document-task evaluation cases in `athena/bench/cases/documents.json`.
4. Phase 4: **broad summaries** (today a summary samples the document; memory.md wants bounded section summaries plus synthesis), document hash and version reuse, retrieval quality.
5. Phase 5: per-page OCR with a page cap and a budget check per page.
6. Phase 6: run `npm run bench:injection` on a real model and write the document-safety report.

## Known gaps in your area
- Scanned pages are flagged ("not read"), not read.
- A summary can miss parts of a long document.
- Keyword search can miss a paraphrased question (memory.md says add embeddings only if evaluation justifies them).

## Blocked / need from others
- Real-model work waits for Parth's Phase 0.
- New or changed API routes for documents go through Harshdeep's K0 route split.
