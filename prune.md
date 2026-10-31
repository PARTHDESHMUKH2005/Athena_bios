# Using the Prune base URL

Source: Prune's public pages and `prune-sdk` docs. Treat everything here as unverified until it is confirmed in Phase 0 and logged in the Findings log in `memory.md`.

## Option 1: plain OpenAI SDK (simplest)

```python
from openai import OpenAI
import os

client = OpenAI(
    base_url="https://api.withprune.com/v1",   # the one line that changes
    api_key=os.environ["PRUNE_API_KEY"],       # Prune key, not an OpenAI key
)

resp = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "Label this issue: ..."}],
    extra_headers={
        "X-Prune-Workload": "support_chat",    # optional: tells Prune the job type
    },
)
print(resp.choices[0].message.content)
```

## Option 2: Prune's Python SDK

```bash
pip install prune-sdk
```

```python
import prune

prune.configure(api_key="prune_your_key", base_url="https://api.withprune.com")
client = prune.OpenAI(api_key="sk-...")   # per the SDK docs, wraps the normal client
```

The SDK docs show the base URL without `/v1`, while the OpenAI-client example uses `/v1`. Test which one works for each option.

## Setup steps

1. Sign up at withprune.com and get your Prune key.
2. Add your provider key (OpenAI, Anthropic and so on) to Prune's vault. This keeps provider keys out of your code.
3. Put only `PRUNE_API_KEY` in `.env`.
4. Use non-streaming calls. Anthropic streaming bypasses Prune in the SDK docs.

## Headers from the SDK docs

| Header | Purpose |
|---|---|
| `X-Prune-Key` | Prune API key |
| `X-Prune-Workload` | Job type. Packs: `structured_planning`, `structured_extraction`, `support_chat`, `agent_step`, `rag`, `batch`, `creative` |
| `X-Prune-Template-Id` | Identifies a reusable prompt template |
| `X-Prune-Optimize` | Prompt optimization: `light` or `compact` (default off) |

## Receipts

- Every response carries a signed receipt: cost, model, what fired.
- Cache hit receipts show `cache_hit: true` and zero upstream cost.
- Live receipts carry `cost_without_prune_usd` and `cost_with_prune_usd`, plus an estimated `cost_saved`.
- The SDK can verify signatures (Ed25519):

```python
from prune.verify import verify_receipt
ok = verify_receipt(receipt, public_key_url)
```

## Day one tests

1. Print the raw response and find where the receipt appears (headers or body).
2. Confirm `verify_receipt` accepts it.
3. Send the same request twice and check the second shows `cache_hit: true`.
4. Send an obvious prompt injection and record what Shield does.
5. Try a bad provider key and a rate-limited call to see the error shapes.

## Free tier

15,000 proxied requests per month. Our benchmark (about 250 tasks, 4 to 6 calls each, several runs) must stay well under this. Count requests per run.

## How we use it in the project

The base URL lives in exactly one place, `sift/llm.py`. Every other module calls `llm.call(...)` and never imports an LLM client. CI fails if any other file does, or if it contains a direct provider URL. This is our proof that every call goes through Prune.

## Sources

- https://www.withprune.com/
- https://www.withprune.com/docs/how-it-works
- https://pypi.org/project/prune-sdk/0.3.1/
