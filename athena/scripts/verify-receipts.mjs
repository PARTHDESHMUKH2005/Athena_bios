// Offline proof check (athena.md 4.6). Anyone can run this on the exported receipts, with no access to our
// database or our code's word for anything:
//
//   node scripts/verify-receipts.mjs receipts.jsonl                 # fetches Prune's public key
//   node scripts/verify-receipts.mjs receipts.jsonl --key key.pem   # or use a saved key
//
// For every line it re-checks the Ed25519 signature on the exact receipt bytes, re-reads the cost from the
// receipt itself, and compares it with the cost we recorded. Exit code 1 if anything fails.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractReceipt, verifyLocal } from '../src/receipts.ts';

/** @returns {Promise<{ total: number, verified: number, failed: string[], costMismatch: string[], receiptCostUsd: number, recordedCostUsd: number, cacheHits: number, withoutPruneUsd: number }>} */
export async function verifyExport(jsonl, keyText) {
  const lines = jsonl.split('\n').map((l) => l.trim()).filter(Boolean);
  const out = { total: lines.length, verified: 0, failed: [], costMismatch: [], receiptCostUsd: 0, recordedCostUsd: 0, cacheHits: 0, withoutPruneUsd: 0 };
  for (const line of lines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      out.failed.push('(unreadable line)');
      continue;
    }
    const id = row.call_id ?? '(no id)';
    // Wrap the raw receipt the same way a live response carries it, so the same extractor finds it.
    const rc = typeof row.receipt_raw === 'string' ? extractReceipt(`{"prune_metadata":${row.receipt_raw}}`) : null;
    if (!rc) {
      out.failed.push(`${id}: no signed receipt`);
      continue;
    }
    let ok = false;
    try {
      ok = await verifyLocal(rc.raw, keyText);
    } catch {
      ok = false;
    }
    if (!ok) {
      out.failed.push(`${id}: signature does not verify`);
      continue;
    }
    out.verified++;
    if (rc.costMicro !== null) {
      out.receiptCostUsd += rc.costMicro / 1e6;
      if (row.cost_micro !== rc.costMicro) out.costMismatch.push(`${id}: recorded ${row.cost_micro}, receipt says ${rc.costMicro} (micro-USD)`);
    }
    out.recordedCostUsd += (row.cost_micro ?? 0) / 1e6;
    if (rc.cacheHit) out.cacheHits++;
    if (rc.costWithoutMicro !== null) out.withoutPruneUsd += rc.costWithoutMicro / 1e6;
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const keyIdx = args.indexOf('--key');
  if (!file) {
    console.error('usage: node scripts/verify-receipts.mjs <receipts.jsonl> [--key public-key.pem]');
    process.exit(2);
  }
  let keyText;
  if (keyIdx >= 0 && args[keyIdx + 1]) keyText = readFileSync(args[keyIdx + 1], 'utf8');
  else {
    const base = (process.env.PRUNE_BASE_URL ?? 'https://api.withprune.com/v1').replace(/\/$/, '');
    const r = await fetch(`${base}/public-key`);
    if (!r.ok) {
      console.error(`could not fetch the public key from ${base}/public-key (HTTP ${r.status}); pass --key`);
      process.exit(2);
    }
    keyText = await r.text();
  }
  const r = await verifyExport(readFileSync(file, 'utf8'), keyText);
  console.log(`receipts checked : ${r.total}`);
  console.log(`signature valid  : ${r.verified}`);
  console.log(`total from receipts: $${r.receiptCostUsd.toFixed(6)}   recorded by Athena: $${r.recordedCostUsd.toFixed(6)}`);
  if (r.withoutPruneUsd) console.log(`counterfactual (without Prune), from receipts: $${r.withoutPruneUsd.toFixed(6)}`);
  console.log(`cache hits       : ${r.cacheHits}`);
  for (const f of r.failed) console.log(`  FAIL ${f}`);
  for (const m of r.costMismatch) console.log(`  COST MISMATCH ${m}`);
  const good = r.total > 0 && r.failed.length === 0 && r.costMismatch.length === 0;
  console.log(good ? '\nALL RECEIPTS VERIFIED' : '\nVERIFICATION FAILED');
  process.exit(good ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
