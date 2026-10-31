// CI guard for "every model call goes through Prune": only src/llm.ts (model calls) and src/receipts.ts
// (Prune's public key and hosted verify endpoint) may call fetch, and no provider host or SDK may appear anywhere.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const ALLOWED_FETCH = new Set(['src/llm.ts', 'src/receipts.ts']);
const FORBIDDEN = [
  /api\.openai\.com/i,
  /api\.anthropic\.com/i,
  /generativelanguage\.googleapis\.com/i,
  /bedrock-runtime/i,
  /from\s+['"]openai['"]/,
  /from\s+['"]@anthropic-ai\//,
  /from\s+['"]@google\/generative-ai['"]/,
  /\b(sk-[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,})\b/,
];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|mjs|js|json|jsonc|sql|md)$/.test(name)) yield p;
  }
}

const problems = [];
for (const file of walk(root)) {
  const rel = relative(root, file).replaceAll('\\', '/');
  if (rel === 'package-lock.json' || rel === 'scripts/check-single-caller.mjs') continue;
  const text = readFileSync(file, 'utf8');
  for (const re of FORBIDDEN) if (re.test(text)) problems.push(`${rel}: forbidden pattern ${re}`);
  if (rel.startsWith('src/') && /\bfetch\s*\(/.test(text.replace(/\/\/.*$/gm, '')) && !ALLOWED_FETCH.has(rel)) {
    problems.push(`${rel}: calls fetch outside llm.ts / receipts.ts`);
  }
}

if (problems.length) {
  console.error('single-caller check FAILED:\n' + problems.map((p) => '  ' + p).join('\n'));
  process.exit(1);
}
console.log('single-caller check passed: no provider hosts, SDKs or keys; fetch only in llm.ts and receipts.ts');
