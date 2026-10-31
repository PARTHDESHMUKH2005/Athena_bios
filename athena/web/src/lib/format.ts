export function usd(n: number | null | undefined, digits?: number): string {
  if (n === null || n === undefined || Number.isNaN(n)) return 'n/a';
  const d = digits ?? (n === 0 ? 2 : n < 0.01 ? 6 : n < 1 ? 4 : 2);
  return `$${n.toFixed(d)}`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function timeAgo(unixSeconds: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export const ms = (n: number): string => (n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`);

/** Plain-language copy for each API error code (matches athena-content.md section 4). */
export const ERROR_COPY: Record<string, { title: string; text: string }> = {
  unauthorized: { title: 'Session expired', text: 'Start a new workspace to continue.' },
  forbidden: { title: 'No access', text: "You don't have access to this item." },
  not_found: { title: 'Not found', text: 'That item may have been deleted.' },
  validation_failed: { title: "That didn't look right", text: 'Check the file or message and try again.' },
  conflict: { title: 'Not available right now', text: 'Refresh and try again.' },
  payload_too_large: { title: 'File too large', text: 'Files can be up to 25 MB and 150 pages.' },
  rate_limited: { title: 'Slow down a little', text: 'Too many requests in a short time. Wait a moment, then try again.' },
  kill_switch_on: { title: 'Athena is paused', text: 'Model calls are turned off for now. Nothing was sent.' },
  budget_exhausted: { title: 'Spending limit reached', text: 'Not enough allowance for this answer.' },
  document_not_ready: { title: 'Still indexing', text: "This document isn't ready yet. Try again in a moment." },
  shield_blocked: { title: 'Request blocked', text: "Prune's safety checks blocked this. Try rephrasing, or remove the flagged content." },
  provider_auth_failed: { title: 'Service unavailable', text: "We couldn't authenticate with the AI service. This isn't something you can fix, and we stopped instead of retrying." },
  provider_unavailable: { title: 'AI service is down', text: 'We tried three times and stopped. Your documents and chats are saved.' },
  billing_uncertain: { title: "We can't tell if this was billed", text: 'The connection dropped after your question was sent, so no receipt came back. The estimated cost was counted against your allowance to be safe.' },
  receipt_missing: { title: 'Answer without a receipt', text: "We got a reply but no receipt, so we won't show it as verified. The estimated cost was counted." },
  internal: { title: 'Something went wrong', text: "That one's on us. Your documents are saved." },
  network: { title: "Can't reach Athena", text: 'Check your connection and try again.' },
};

export const errorCopy = (code: string) => ERROR_COPY[code] ?? ERROR_COPY['internal']!;

/** Error codes where the user can safely press "Retry once" (E25). */
export const RETRYABLE_AFTER_FAIL = new Set(['billing_uncertain', 'receipt_missing', 'provider_unavailable', 'rate_limited']);
