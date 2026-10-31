export const nowSec = (): number => Math.floor(Date.now() / 1000);

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function randomToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Rough token estimate. Prices are estimates; the receipt is the source of truth. */
export const estTokens = (s: string): number => Math.ceil(s.length / 4);

export const usdToMicro = (usd: number): number => Math.round(usd * 1e6);
export const microToUsd = (micro: number): number => Number((micro / 1e6).toFixed(6));

/** Strip control, zero-width and bidi-control characters from untrusted text. */
export function sanitizeText(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g, '');
}

export function parseJsonSafe<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export function numEnv(v: string | undefined, fallback: number): number {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}
