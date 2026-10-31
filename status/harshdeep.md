# Status: Harshdeep Athawale

Stream **B: Data, budgets, recovery, memory, API, deployment** (see [STATUS.md](../STATUS.md) section 2 for your paths).
Last updated: 2026-10-31.

## Done (all tested against a mock Prune and SQLite only)
- Backend in `athena/src/`: API with 26 endpoints, atomic budget reservation, one model caller with bounded retries and shield-code handling, raw-byte receipt capture with Ed25519 verification, retrieval, rolling memory, tier routing, pause, resume and retry, output scanning, a cleanup job. 84 tests pass.
- Web app in `athena/web/`, a mock Prune, a local dev stack, a Phase 0 probe, a benchmark, a 15-payload injection suite and an offline receipt verifier. Plans in `athena.md` and `athena-content.md`.
- Pushed to `main` and wrote the team's STATUS, CONTRIBUTING and status files.

## Doing now: K0 (before parallel work starts)
- [ ] One PR that splits `athena/src/app.ts` into per-topic route files (`routes/documents.ts`, `routes/receipts.ts`, `routes/chats.ts`, `routes/usage.ts`) and adds `npm run check`. Until it merges, only B edits `app.ts` and `orchestrator.ts`.
- [ ] Phase 0 for the platform: apply `migrations/0001_init.sql` on a real D1 database, check FTS5 triggers, `db.batch` atomicity and `meta.changes`, Ed25519 in a real Worker, and that `ctx.waitUntil` finishes after the client disconnects (athena.md 4.9 items 11-14).

## Next
1. Phase 1: chat with no document (API and storage), a staging deployment, and serve the built web app from the Worker (not wired yet).
2. Phase 2: keep uncertain charges **pending** and reconcile them (today the estimate is charged); admin stop endpoints (E28, E29).
3. Phase 4: document hash and version columns, summary tables.
4. Phase 5: checkpoint job (configurable usage trigger, unique per session and message range, no-AI export fallback).
5. Phase 6: deploy the combined app; CI with a secret scan and the single-caller check; interrupted-worker tests.

## Blocked / need from others
- Phase 0 real-D1 checks need a Cloudflare account with D1 and R2 (Workers Paid plan recommended).
- Real receipt fields from Parth's findings feed back into the stored columns.

## Contract changes (append here, newest first; additive only)
- 2026-10-31: `GET /api/chats/:id` messages now include `usage` (cost, model, verify status) so a reloaded chat shows what each answer cost.
- 2026-10-31: every assistant message carries `trace` (activity timeline steps).
- 2026-10-31: `GET /api/chats/:id/summary` (Markdown export built from stored data; no model call).

## Notes for the team
- Hosting and CI are mine; ask before touching `wrangler.jsonc`, `package.json` or `migrations/`.
