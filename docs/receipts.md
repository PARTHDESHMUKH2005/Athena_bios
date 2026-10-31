# Receipts: what is confirmed and what is not

Last updated 2026-10-31. Everything under "Observed" came from real calls (see `athena/PHASE0-FINDINGS.md`). Everything under "Assumed" is what the code does today, on the mock, and **must be re-checked against a real receipt before it is relied on**. Phase 0 is not finished: no complete real call with a verified receipt has been recorded yet.

## Observed (real service)
- `GET {PRUNE_BASE_URL}/public-key` returns a plain-text Ed25519 PEM.
- A 200 chat response from a working model (Gemini models, key 2) carries a `prune_metadata` object with a receipt.
- Auth works with `Authorization: Bearer prune_...` and with `X-Prune-Key`.
- Provider failures, budget and loop stops, and Shield blocks come back as documented in `PHASE0-FINDINGS.md`.

## Assumed (implemented, not yet confirmed on a real receipt)
- Canonical signed text: every receipt field except `receipt_signature`, `receipt_signed_at`, `receipt_signing_key_id`; keys sorted; compact separators (`,` and `:`); non-ASCII escaped as `\uXXXX` (Python `json.dumps(sort_keys=True, separators=(",", ":"))`); Ed25519 over the UTF-8 bytes; the signature is base64. Number tokens are kept exactly as written in the response, which is why the raw bytes are stored and never re-serialized.
- The cost is `cost_with_prune_usd`; the counterfactual is `cost_without_prune_usd`; cache hits are `cache_hit` (see `COST_KEYS` in `src/receipts.ts`). If a real receipt names them differently, cost falls back to our estimate and says so.
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
