// Small, dependency-free statistics for the benchmark. Everything here is deterministic given a seed.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function percentile(xs, p) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
}

/** Lowercase, drop thousands separators and extra whitespace, so "$250,000" matches "250000". */
export function normalize(s) {
  return String(s).toLowerCase().replace(/(\d),(\d)/g, '$1$2').replace(/\s+/g, ' ').trim();
}

export const hasAny = (answer, needles) => {
  const a = normalize(answer);
  return needles.some((n) => a.includes(normalize(n)));
};

/** Pages cited as [p.3] or [p.3-5], expanded. */
export function citedPages(text) {
  const pages = new Set();
  for (const m of String(text).matchAll(/\[p\.\s*(\d+)(?:\s*[-–]\s*(\d+))?\]/g)) {
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let p = a; p <= Math.min(b, a + 50); p++) pages.add(p);
  }
  return pages;
}

/**
 * Paired bootstrap of mean(a) - mean(b) over per-question 0/1 scores. 95% interval.
 * `a` and `b` must be aligned by question.
 */
export function pairedBootstrap(a, b, { iters = 2000, seed = 1 } = {}) {
  if (a.length !== b.length || !a.length) return { diff: 0, lo: 0, hi: 0, n: a.length };
  const rnd = mulberry32(seed);
  const n = a.length;
  const diffs = [];
  for (let k = 0; k < iters; k++) {
    let s = 0;
    for (let i = 0; i < n; i++) {
      const j = Math.floor(rnd() * n);
      s += a[j] - b[j];
    }
    diffs.push(s / n);
  }
  diffs.sort((x, y) => x - y);
  return { diff: mean(a) - mean(b), lo: diffs[Math.floor(0.025 * iters)], hi: diffs[Math.ceil(0.975 * iters) - 1], n };
}

/**
 * Non-inferiority verdict for "Athena is not worse than the baseline by more than `margin`".
 * pass: even the pessimistic end of the interval is above -margin. fail: the optimistic end is below it.
 * inconclusive: the interval straddles it (too few questions to tell).
 */
export function nonInferiority(ci, margin = 0.02) {
  if (ci.lo >= -margin) return 'pass';
  if (ci.hi < -margin) return 'fail';
  return 'inconclusive';
}
