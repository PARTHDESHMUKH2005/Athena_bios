# Receipts: what is confirmed and what is not

Last updated 2026-10-31. Everything under "Observed" came from real calls (see `athena/PHASE0-FINDINGS.md`). Everything under "Assumed" is what the code does today, on the mock, and **must be re-checked against a real receipt before it is relied on**. One real signed receipt (key 2, `gemini/gemini-3.5-flash`) has been verified; the items it settled are under "Observed" and the rest stay assumed.

## Observed (real service)
- `GET {PRUNE_BASE_URL}/public-key` returns a plain-text Ed25519 PEM.
- A 200 chat response from a working model (Gemini models, key 2) carries a `prune_metadata` object with a receipt.
- Auth works with `Authorization: Bearer prune_...` and with `X-Prune-Key`.
- **Canonical signed text confirmed** (2026-10-31): our local Ed25519 check (raw bytes, sorted keys, compact separators, ASCII escapes) accepts the real receipt, and Prune's hosted `POST /v1/receipts/verify` with body `{"receipt": <object>}` returns `{"valid":true,...}` (a bare receipt body returns 422).
- **Field names confirmed:** `cost_with_prune_usd`, `cost_without_prune_usd`, `cache_hit`, `cache_type`, `receipt_signature`, `receipt_signed_at`, `receipt_signing_key_id` exist as assumed (about 150 fields in all).
- **Model name:** the receipt has `original_model` and `routed_model` (null when not re-routed), not `model`. `src/receipts.ts` reads `routed_model` first, then `original_model`.
- Provider failures, budget and loop stops, and Shield blocks come back as documented in `PHASE0-FINDINGS.md`.

## Assumed (implemented, not yet confirmed on a real receipt)
- Number tokens are kept exactly as written in the response, which is why the raw bytes are stored and never re-serialized. (The canonical form itself is now confirmed; see Observed.)
- If a real receipt ever names the cost fields differently, cost falls back to our estimate and says so (`COST_KEYS` in `src/receipts.ts`).
- Token counts and the model name inside the signed fields: unknown. Until a real receipt shows them, the naive baseline is labelled "Athena's stored token counts, which are not signed".
- The signing key id is not part of the signed payload, so a signature check cannot notice it being edited. We remember the key id first seen with each public key (trust on first use) and fail a different id with the same key as `unknown_key`. How Prune issues and rotates key ids is unconfirmed.
- Prune's hosted `POST /v1/receipts/verify`: request `{"receipt": <raw>}` and a response containing `valid`, `verified` or `ok` are assumed. It is used only as a second opinion after a local mismatch, never as the first check.
- `prune-sdk` `verify_receipt`: its interface is unconfirmed. `bench/verify.py` asks it if installed and ignores any answer that is not a plain boolean; the direct `cryptography` check always runs.
- Ed25519 in Cloudflare Workers WebCrypto: not tested in a Worker. If it is unavailable the receipt is `unverified` ("Could not verify in the browser worker. Verify offline."), never `verified`.

## To do in Phase 0 (needs a working key and model)
1. One real call; record where the receipt is and its exact fields, including token counts, model and key id.
2. Confirm the canonical form by verifying that receipt with Prune's hosted endpoint, `prune-sdk`, and `bench/verify.py`.
3. Test Ed25519 verification inside a Worker.
4. Repeat an identical call and record the cache fields; record the shape of a Shield block, a bad key and a timeout.
5. Update `tools/mock-prune/mock.mjs` so it matches the real format, and replace the "assumed" list above.
