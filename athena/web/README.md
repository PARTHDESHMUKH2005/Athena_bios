# Athena web app

React + Vite + TypeScript. Landing page, "start a workspace" screen, and the workspace (documents, chat, activity timeline, receipts, usage). Design: editorial black and white with hairline grids, generative artwork drawn on canvas (original), Hanken Grotesk self-hosted. Copy lives in `../../athena-content.md`.

## Run it locally (no accounts, no Prune key)

```bash
# terminal 1, in athena/: the real API over in-memory SQLite, talking to the mock Prune
npm run dev:stack
# terminal 2
npm run web          # http://127.0.0.1:5173  (Vite proxies /api to :8787)
```

Try it: **Start a workspace** → **Try a sample contract** (a real PDF read in the browser by pdf.js) → ask a question. Add `[[mock:drop]]`, `[[mock:429_spend_cap]]`, `[[mock:500]]` to a question to see the failure screens.

## What is where

| Path | What |
|---|---|
| `src/pages/Landing.tsx`, `Start.tsx`, `Workspace.tsx` | the three screens |
| `src/app/` | `Sidebar` (documents, upload, chats, spending limit), `ChatPanel` (answers, pause and retry cards, composer), `Drawer` (activity, receipt, page viewer), `UsagePanel`, `useUpload` |
| `src/lib/api.ts` | typed API client; the token is kept in `localStorage` with an in-memory fallback |
| `src/lib/pdf.ts` | text extraction in the browser; loaded only on first upload |
| `public/samples/` | synthetic sample contract and invoice PDFs (`node ../tools/make-sample-pdfs.mjs` regenerates them) |
| `artifact/athena-site.html` | the self-contained interactive preview published as a canvas artifact |

## Production

`npm run build` writes `dist/`. Serve it from the same origin as the Worker (Pages or Worker static assets) so `/api` needs no proxy. Wiring the Worker to serve `dist/` is not done yet.

## Honest limits

- The sign-in screen has no accounts: "start a workspace" creates an anonymous workspace and keeps its token in this browser.
- Text PDFs only. Scanned pages are flagged ("not read"), not read.
- Numbers on the landing page come from `src/lib/facts.ts` and are measured prompt sizes only. Cost and accuracy results appear only after the real benchmark runs.
