# Phase 0: verify Athena against the real Prune

The code is tested against a mock Prune. This step finds out where the real service differs. It takes about 15 minutes and about 29 tiny requests (fractions of a cent, inside the free tier).

## Already settled without a key

See `../athena.md` section 4.9a. In short: the public key is a plain-text Ed25519 PEM, and Prune's full shield-code table is documented and now handled in `src/errors.ts`.

## Steps (you do these; they need your Prune account)

1. **Prune dashboard**: create an account and an API key.
2. **Provider key in the vault**: Connect, then Providers, add one provider key (for example OpenAI). It stays in Prune's encrypted vault; it never goes in this repo.
3. **Shield on the key** (this is the safety net behind our own budget):
   - daily spend cap: a small number while developing, for example $2;
   - model allowlist: only the models you will put in `MODEL_TIERS`;
   - a rate limit.
4. **Put the key in a file yourself.** Copy `.env.example` to `.env` and fill in `PRUNE_API_KEY=`. Do not paste the key into chat. `.env` is git-ignored.
5. Run:
   ```bash
   npm run phase0
   ```
6. Share **`phase0-findings.json`** (it contains responses only, with the key redacted) and the summary the script prints.

If the default model is not enabled in your vault, run it with the one that is: `PHASE0_MODEL=<model id> npm run phase0`.

## What each answer changes in the code

| Finding | Where it goes |
|---|---|
| Which auth style returns 200 | `PRUNE_AUTH` in `wrangler.jsonc` (`bearer` or `x-prune-key`) |
| Real receipt field names; is there a cost field | `COST_KEYS`, `COST_WITHOUT_KEYS` in `src/receipts.ts` |
| `localVerify` false and a `variantsThatVerify` entry | the canonical form in `src/receipts.ts` (`canonicalNode`) |
| Hosted verify request and response shape | `hostedVerify` in `src/receipts.ts` |
| Accepted workload tags | `Workload` type in `src/llm.ts` |
| Cache hit field and headers | `cacheHit` handling in `src/llm.ts` |
| Real `run_budget` / `agent_step_budget` / `spend_cap` bodies | the paused message text in `src/orchestrator.ts` |
| Injection default-mode behaviour | the wording of "harmless, not blocked" in the pitch; optional `X-Prune-Injection` header |
| Enabled models and prices | `MODEL_TIERS` (see `src/tiers.ts` defaults, which are placeholders) |
| Idempotency honoured or not | nothing breaks either way; it only changes what we can claim |

After the findings arrive, update the mock to match the real responses, re-run `npm test`, and the Phase 0 gate in `athena.md` 4.8 is met.
