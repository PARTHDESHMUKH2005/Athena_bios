// E27: the receipts proof file, one JSON object per line. The first line is a meta line carrying the public key,
// so a verifier needs nothing else. Later lines keep each receipt's exact bytes in `receipt_raw`.
import { parseJsonSafe } from '../util.ts';
import type { AppT } from './shared.ts';

export const CANONICALIZATION =
  'Ed25519 over the UTF-8 bytes of the receipt JSON without receipt_signature, receipt_signed_at and receipt_signing_key_id; ' +
  'keys sorted, compact separators (, and :), non-ASCII escaped as \\uXXXX (Python json.dumps(sort_keys=True, separators=(",",":"))); ' +
  'the signature is base64. UNVERIFIED against the real service until Phase 0 confirms it (see docs/receipts.md).';

interface Row {
  id: string;
  created_at: number;
  purpose: string;
  tier: string;
  model_used: string | null;
  cost_micro: number | null;
  cost_without_prune_micro: number | null;
  cache_hit: number | null;
  verify_status: string;
  receipt_json: string;
}

export function registerExportRoutes(app: AppT): void {
  app.get('/api/export/receipts.jsonl', async (c) => {
    const rows = (
      await c.env.DB.prepare(
        `SELECT id, created_at, purpose, tier, model_used, cost_micro, cost_without_prune_micro, cache_hit, verify_status, receipt_json
         FROM llm_calls WHERE workspace_id = ? AND receipt_json IS NOT NULL ORDER BY created_at, rowid`,
      )
        .bind(c.get('ws'))
        .all<Row>()
    ).results;
    const key = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'prune_public_key'").first<{ value: string }>();
    const keyId = rows.map((r) => parseJsonSafe<Record<string, unknown>>(r.receipt_json, {})['receipt_signing_key_id']).find((k) => typeof k === 'string') ?? null;
    const meta = { type: 'meta', version: 1, public_key_pem: key?.value ?? null, key_id: keyId, canonicalization: CANONICALIZATION, receipts: rows.length };
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(JSON.stringify(meta) + '\n'));
        for (const r of rows) {
          controller.enqueue(
            enc.encode(
              JSON.stringify({
                call_id: r.id,
                created_at: r.created_at,
                purpose: r.purpose,
                tier: r.tier,
                model_used: r.model_used,
                cost_micro: r.cost_micro,
                cost_without_prune_micro: r.cost_without_prune_micro,
                cache_hit: r.cache_hit === 1,
                verify_status: r.verify_status,
                receipt_raw: r.receipt_json,
              }) + '\n',
            ),
          );
        }
        controller.close();
      },
    });
    return new Response(stream, { headers: { 'content-type': 'application/x-ndjson', 'x-request-id': c.get('reqId') } });
  });
}
