// Output guardrail (athena.md 2.9): model output is untrusted too. A poisoned document can try to make the
// model emit a secret, a link that exfiltrates data, or a shell one-liner. Scan before anything is shown or stored.

export interface ScanResult {
  text: string;
  /** Short reasons, safe to show in the activity timeline (never the matched text itself). */
  flags: string[];
}

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];

const DANGEROUS_LINE = [
  /\b(?:curl|wget)\b[^\n]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/i,
  /\brm\s+-rf\s+(?:\/|~|\*)/i,
  /\bpowershell(?:\.exe)?\b[^\n]*\s-(?:enc|encodedcommand|e)\b/i,
  /\bnc\s+-e\b|\bbash\s+-i\s+>&/i,
  /\bchmod\s+\+x\b[^\n]*&&[^\n]*\.\/\S+/i,
];

const URL_RE = /https?:\/\/[^\s)\]>"'`]+/gi;

export function scanOutput(text: string, opts: { context: string; secrets?: (string | undefined)[] }): ScanResult {
  const flags = new Set<string>();
  let out = text;

  // 1. Exact secrets we hold (the Prune key, the admin token).
  for (const s of opts.secrets ?? []) {
    if (s && s.length >= 8 && out.includes(s)) {
      out = out.split(s).join('[redacted secret]');
      flags.add('secret');
    }
  }

  // 2. Anything shaped like a credential.
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, () => {
      flags.add('secret');
      return '[redacted secret]';
    });
  }

  // 3. Links the document did not contain (a classic exfiltration channel, e.g. a markdown image URL).
  const ctx = opts.context.toLowerCase();
  out = out.replace(URL_RE, (url) => {
    const bare = url.replace(/[.,;:!?]+$/, '').toLowerCase();
    if (ctx.includes(bare)) return url;
    flags.add('link');
    return '[link removed]';
  });

  // 4. Shell one-liners that download-and-run or destroy.
  out = out
    .split('\n')
    .map((line) => {
      if (DANGEROUS_LINE.some((re) => re.test(line))) {
        flags.add('shell');
        return '[command removed]';
      }
      return line;
    })
    .join('\n');

  return { text: out, flags: [...flags] };
}
