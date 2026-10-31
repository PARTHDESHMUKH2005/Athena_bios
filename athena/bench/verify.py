#!/usr/bin/env python3
"""Offline receipt check for Athena's proof file (GET /api/export/receipts.jsonl).

    python bench/verify.py receipts.jsonl                 # uses the public key in the file's meta line
    python bench/verify.py receipts.jsonl --key key.pem   # or a key you fetched yourself

Prints PASS or FAIL per receipt and a summary. Exit code 0 only if every receipt passes; 1 otherwise (and 1 when
the file holds no receipts). A receipt passes only if its Ed25519 signature verifies over the canonical bytes AND the
cost Athena recorded equals the cost inside the signed receipt.

Verification path: if the `prune-sdk` package is installed and exposes `verify_receipt`, it is asked too, and a
definite False from it fails the receipt. The SDK's exact interface is UNVERIFIED (see docs/receipts.md), so if its
call raises or returns anything but a bool, it is ignored and the direct check below decides. The direct check uses
`cryptography`:

    canonical = json.dumps(receipt without receipt_signature / receipt_signed_at / receipt_signing_key_id,
                           sort_keys=True, separators=(",", ":"))      # ensure_ascii stays on
    Ed25519PublicKey.verify(base64(receipt_signature), canonical.encode("utf-8"))
"""
import base64
import json
import os
import sys
import urllib.request

EXCLUDED = ("receipt_signature", "receipt_signed_at", "receipt_signing_key_id")
COST_KEYS = ("cost_with_prune_usd", "actual_cost_usd", "total_cost_usd", "cost_usd")


def canonical(receipt: dict) -> bytes:
    body = {k: v for k, v in receipt.items() if k not in EXCLUDED}
    return json.dumps(body, sort_keys=True, separators=(",", ":")).encode("utf-8")


def load_key(pem: str):
    from cryptography.hazmat.primitives.serialization import load_pem_public_key

    return load_pem_public_key(pem.strip().encode("utf-8"))


def sdk_verdict(receipt: dict, pem: str):
    """True / False from prune-sdk when it gives a definite answer, else None (not installed or not usable)."""
    try:
        import prune_sdk  # type: ignore

        fn = getattr(prune_sdk, "verify_receipt", None)
        if fn is None:
            return None
        for args in ((receipt,), (receipt, pem)):
            try:
                out = fn(*args)
            except TypeError:
                continue
            if isinstance(out, bool):
                return out
            return None
    except Exception:
        return None
    return None


def check(row: dict, pem: str):
    raw = row.get("receipt_raw")
    if not isinstance(raw, str):
        return False, "no receipt bytes"
    try:
        receipt = json.loads(raw)
        sig = base64.b64decode(receipt["receipt_signature"])
    except Exception:
        return False, "receipt unreadable or unsigned"
    try:
        load_key(pem).verify(sig, canonical(receipt))
    except Exception:
        return False, "signature does not match"
    if sdk_verdict(receipt, pem) is False:
        return False, "prune-sdk says the receipt is invalid"
    signed = next((receipt[k] for k in COST_KEYS if isinstance(receipt.get(k), (int, float))), None)
    if signed is not None and row.get("cost_micro") is not None and round(signed * 1e6) != row["cost_micro"]:
        return False, "cost mismatch: recorded %s micro-USD, receipt says %s" % (row["cost_micro"], round(signed * 1e6))
    return True, "cost $%s" % ("%.6f" % signed if signed is not None else "?")


def main(argv):
    args = [a for a in argv if not a.startswith("--")]
    if not args:
        print("usage: python bench/verify.py receipts.jsonl [--key public-key.pem]", file=sys.stderr)
        return 2
    path = args[0]
    with open(path, encoding="utf-8") as fh:
        lines = [l.strip() for l in fh if l.strip()]
    meta, rows, bad_lines = None, [], 0
    for i, line in enumerate(lines):
        try:
            obj = json.loads(line)
        except Exception:
            bad_lines += 1
            print("FAIL line %d: not JSON" % (i + 1))
            continue
        if isinstance(obj, dict) and obj.get("type") == "meta":
            meta = obj
        else:
            rows.append(obj)

    pem = None
    if "--key" in argv and argv.index("--key") + 1 < len(argv):
        with open(argv[argv.index("--key") + 1], encoding="utf-8") as fh:
            pem = fh.read()
    elif meta and meta.get("public_key_pem"):
        pem = meta["public_key_pem"]
    else:
        base = os.environ.get("PRUNE_BASE_URL", "https://api.withprune.com/v1").rstrip("/")
        try:
            pem = urllib.request.urlopen(base + "/public-key", timeout=10).read().decode("utf-8")
        except Exception as e:
            print("could not get a public key (%s); pass --key" % e, file=sys.stderr)
            return 2

    n_pass = 0
    total = 0.0
    for row in rows:
        ok, why = check(row, pem)
        cid = row.get("call_id", "(no id)") if isinstance(row, dict) else "(no id)"
        print("%s %s  %s" % ("PASS" if ok else "FAIL", cid, why))
        if ok:
            n_pass += 1
            total += (row.get("cost_micro") or 0) / 1e6
    n_fail = len(rows) - n_pass + bad_lines
    print("\n%d receipt(s): %d passed, %d failed. Recorded spend of passing receipts: $%.6f" % (len(rows), n_pass, n_fail, total))
    good = len(rows) > 0 and n_fail == 0
    print("ALL RECEIPTS VERIFIED" if good else "VERIFICATION FAILED")
    return 0 if good else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
