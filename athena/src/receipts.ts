import type { Env, Fetcher } from './env.ts';
import { nowSec } from './util.ts';

/**
 * Prune-specific receipt handling lives ONLY in this file (see athena.md 2.7).
 * Prune signs Ed25519 over every receipt field except receipt_signature, receipt_signed_at and
 * receipt_signing_key_id, serialized as JSON with sorted keys and compact separators. We therefore
 * keep the receipt's exact bytes and rebuild the canonical text from them, never from a parsed object.
 */

export type JNode =
  | { t: 'o'; v: [string, JNode][]; s: number; e: number }
  | { t: 'a'; v: JNode[]; s: number; e: number }
  | { t: 's' | 'n' | 'l'; v: string; s: number; e: number };

/** JSON parser that keeps number tokens and byte spans exactly as written. */
export function parseLossless(text: string): JNode {
  let i = 0;
  const ws = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i]!)) i++;
  };
  const str = (): JNode => {
    const s = i++;
    while (text[i] !== '"') {
      if (i >= text.length) throw new SyntaxError('unterminated string');
      if (text[i] === '\\') i++;
      i++;
    }
    i++;
    return { t: 's', v: JSON.parse(text.slice(s, i)) as string, s, e: i };
  };
  const val = (): JNode => {
    ws();
    const s = i;
    const c = text[i];
    if (c === '{' || c === '[') {
      const isObj = c === '{';
      const close = isObj ? '}' : ']';
      i++;
      ws();
      if (isObj) {
        const items: [string, JNode][] = [];
        if (text[i] === close) {
          i++;
          return { t: 'o', v: items, s, e: i };
        }
        for (;;) {
          ws();
          const k = str();
          ws();
          if (text[i++] !== ':') throw new SyntaxError(`expected : at ${i}`);
          items.push([k.v as string, val()]);
          ws();
          const d = text[i++];
          if (d === ',') continue;
          if (d === close) break;
          throw new SyntaxError(`unexpected ${d} at ${i}`);
        }
        return { t: 'o', v: items, s, e: i };
      }
      const items: JNode[] = [];
      if (text[i] === close) {
        i++;
        return { t: 'a', v: items, s, e: i };
      }
      for (;;) {
        items.push(val());
        ws();
        const d = text[i++];
        if (d === ',') continue;
        if (d === close) break;
        throw new SyntaxError(`unexpected ${d} at ${i}`);
      }
      return { t: 'a', v: items, s, e: i };
    }
    if (c === '"') return str();
    const m = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 64));
    if (!m) throw new SyntaxError(`bad JSON at ${i}`);
    i += m[0].length;
    return { t: /^[tfn]/.test(m[0]) ? 'l' : 'n', v: m[0], s, e: i };
  };
  const root = val();
  ws();
  if (i !== text.length) throw new SyntaxError('trailing data');
  return root;
}

const getKey = (n: JNode | undefined, key: string): JNode | undefined =>
  n?.t === 'o' ? n.v.find(([k]) => k === key)?.[1] : undefined;

function findSigned(n: JNode | undefined): JNode | null {
  if (n?.t !== 'o') return null;
  if (getKey(n, 'receipt_signature')) return n;
  for (const [, v] of n.v) {
    const hit = findSigned(v);
    if (hit) return hit;
  }
  return null;
}

const EXCLUDED = new Set(['receipt_signature', 'receipt_signed_at', 'receipt_signing_key_id']);

function encodeString(s: string): string {
  // Python json.dumps default (ensure_ascii=True): non-ASCII as lowercase \uXXXX, UTF-16 units.
  return JSON.stringify(s).replace(/[\u0080-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

function canonicalNode(n: JNode, top: boolean): string {
  switch (n.t) {
    case 'o':
      return (
        '{' +
        n.v
          .filter(([k]) => !(top && EXCLUDED.has(k)))
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => encodeString(k) + ':' + canonicalNode(v, false))
          .join(',') +
        '}'
      );
    case 'a':
      return '[' + n.v.map((v) => canonicalNode(v, false)).join(',') + ']';
    case 's':
      return encodeString(n.v);
    default:
      return n.v; // number / literal tokens exactly as the server wrote them
  }
}

/** The exact text Prune signed, rebuilt from the receipt's raw bytes. */
export const canonicalForSigning = (rawReceipt: string): string => canonicalNode(parseLossless(rawReceipt), true);

export interface ParsedReceipt {
  /** Exact bytes of the receipt object as it appeared in the response. */
  raw: string;
  fields: Record<string, unknown>;
  costMicro: number | null;
  costWithoutMicro: number | null;
  cacheHit: boolean | null;
  /** The model that actually served the call: routed_model when Prune re-routed, else the requested one. */
  model: string | null;
  /** Prune's output-cap mechanism shortened our max_tokens for this call. */
  outputCapApplied: boolean | null;
  /** Completion tokens as billed (for Gemini this includes hidden thinking tokens). */
  completionTokens: number | null;
}

const COST_KEYS = ['cost_with_prune_usd', 'actual_cost_usd', 'total_cost_usd', 'cost_usd'];
const COST_WITHOUT_KEYS = ['cost_without_prune_usd', 'counterfactual_cost_usd'];

function usdField(fields: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = fields[k];
    if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v * 1e6);
  }
  return null;
}

/** Locate the signed receipt in `prune_metadata` and slice its exact bytes out of the response body. */
export function extractReceipt(responseBody: string): ParsedReceipt | null {
  let root: JNode;
  try {
    root = parseLossless(responseBody);
  } catch {
    return null;
  }
  const meta = getKey(root, 'prune_metadata');
  const node = findSigned(meta);
  if (!node) return null;
  const raw = responseBody.slice(node.s, node.e);
  let fields: Record<string, unknown>;
  try {
    fields = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  // Real receipts (checked 2026-10-31) carry original_model and routed_model (null when not re-routed), not `model`.
  const model = [fields['routed_model'], fields['model_used'], fields['model'], fields['original_model']].find((m) => typeof m === 'string' && m !== '');
  const completion = fields['completion_tokens'];
  return {
    raw,
    fields,
    costMicro: usdField(fields, COST_KEYS),
    costWithoutMicro: usdField(fields, COST_WITHOUT_KEYS),
    cacheHit: typeof fields['cache_hit'] === 'boolean' ? (fields['cache_hit'] as boolean) : null,
    model: (model as string | undefined) ?? null,
    outputCapApplied: typeof fields['output_cap_applied'] === 'boolean' ? (fields['output_cap_applied'] as boolean) : null,
    completionTokens: typeof completion === 'number' && Number.isFinite(completion) ? completion : null,
  };
}

/* ---------------------------------- verification ---------------------------------- */

export type VerifyStatus = 'verified' | 'failed' | 'unverified' | 'missing';

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Accepts PEM, a JSON object with public_key/pem, or bare base64 DER. */
function keyToDer(text: string): Uint8Array | null {
  let t = text.trim();
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t) as Record<string, unknown>;
      const k = j['public_key'] ?? j['pem'] ?? j['key'];
      if (typeof k === 'string') t = k;
    } catch {
      return null;
    }
  }
  try {
    return b64ToBytes(t.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, ''));
  } catch {
    return null;
  }
}

export async function verifyLocal(rawReceipt: string, keyText: string): Promise<boolean> {
  const der = keyToDer(keyText);
  if (!der) return false;
  const fields = JSON.parse(rawReceipt) as Record<string, unknown>;
  const sig = fields['receipt_signature'];
  if (typeof sig !== 'string') return false;
  const key = await crypto.subtle.importKey('spki', der, { name: 'Ed25519' }, false, ['verify']);
  const data = new TextEncoder().encode(canonicalForSigning(rawReceipt));
  return crypto.subtle.verify({ name: 'Ed25519' }, key, b64ToBytes(sig), data);
}

const baseUrl = (env: Pick<Env, 'PRUNE_BASE_URL'>) => env.PRUNE_BASE_URL.replace(/\/$/, '');

async function fetchPublicKey(env: Env, fetchFn: Fetcher): Promise<string | null> {
  try {
    const r = await fetchFn(`${baseUrl(env)}/public-key`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const t = await r.text();
    await env.DB.prepare(
      `INSERT INTO settings(key, value, updated_at) VALUES ('prune_public_key', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
      .bind(t, nowSec())
      .run();
    return t;
  } catch {
    return null;
  }
}

async function cachedPublicKey(env: Env): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'prune_public_key'").first<{ value: string }>();
  return row?.value ?? null;
}

/** Prune's hosted check. Request/response shape is unconfirmed (Phase 0); read common field names. */
async function hostedVerify(env: Env, raw: string, fetchFn: Fetcher): Promise<boolean | null> {
  try {
    const r = await fetchFn(`${baseUrl(env)}/receipts/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: `{"receipt":${raw}}`, // raw bytes preserved
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as Record<string, unknown>;
    for (const k of ['valid', 'verified', 'ok']) if (typeof j[k] === 'boolean') return j[k] as boolean;
    return null;
  } catch {
    return null;
  }
}

/**
 * Local Ed25519 check first; on mismatch, refetch the key once (rotation), then ask Prune's hosted
 * check before showing 'failed'. 'unverified' means we could not check (never silently 'verified').
 */
export async function verifyReceipt(env: Env, raw: string, fetchFn: Fetcher = fetch): Promise<VerifyStatus> {
  let key = (await cachedPublicKey(env)) ?? (await fetchPublicKey(env, fetchFn));
  if (key) {
    try {
      if (await verifyLocal(raw, key)) return 'verified';
      const fresh = await fetchPublicKey(env, fetchFn);
      if (fresh && fresh !== key) {
        key = fresh;
        if (await verifyLocal(raw, key)) return 'verified';
      }
    } catch {
      /* fall through to the hosted check */
    }
    const hosted = await hostedVerify(env, raw, fetchFn);
    return hosted === true ? 'verified' : 'failed';
  }
  const hosted = await hostedVerify(env, raw, fetchFn);
  if (hosted === true) return 'verified';
  if (hosted === false) return 'failed';
  return 'unverified';
}
