// Generative artwork drawn on canvas (value-noise terrain with contour lines, and vertical streaks).
// Original artwork: nothing here is copied from any other site.

function hash(x: number, y: number, s: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function vnoise(x: number, y: number, s: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi, s);
  const b = hash(xi + 1, yi, s);
  const c = hash(xi, yi + 1, s);
  const d = hash(xi + 1, yi + 1, s);
  const top = a + (b - a) * u;
  return top + (c + (d - c) * u - top) * v;
}

function fbm(x: number, y: number, s: number, octaves: number): number {
  let t = 0;
  let amp = 0.5;
  let f = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    t += amp * vnoise(x * f, y * f, s + i * 17);
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return t / norm;
}

type Stop = [number, number, number, number];

function ramp(stops: Stop[], t: number): [number, number, number] {
  const c = Math.max(0, Math.min(1, t));
  for (let i = 1; i < stops.length; i++) {
    if (c <= stops[i]![0]) {
      const a = stops[i - 1]!;
      const b = stops[i]!;
      const k = (c - a[0]) / (b[0] - a[0] || 1);
      return [a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, a[3] + (b[3] - a[3]) * k];
    }
  }
  const l = stops[stops.length - 1]!;
  return [l[1], l[2], l[3]];
}

const TERRAIN: Stop[] = [[0, 38, 14, 22], [0.35, 112, 44, 48], [0.58, 178, 86, 64], [0.78, 224, 150, 104], [1, 244, 214, 176]];
const STREAKS: Stop[] = [[0, 28, 38, 14], [0.4, 92, 98, 24], [0.62, 168, 112, 24], [0.82, 222, 120, 36], [1, 246, 188, 92]];

export function paint(canvas: HTMLCanvasElement, kind: 'terrain' | 'streaks'): void {
  const W = kind === 'terrain' ? 480 : 300;
  const H = kind === 'terrain' ? 270 : 330;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (kind === 'terrain') {
        const wx = fbm(x / 120, y / 120, 3, 3);
        const wy = fbm(x / 120 + 9, y / 120 + 4, 5, 3);
        const n = fbm(x / 95 + wx * 2.2, y / 95 + wy * 2.2, 11, 5);
        const band = Math.abs(((n * 16) % 1) - 0.5);
        const c = ramp(TERRAIN, (n - 0.2) * 1.9);
        const k = band < 0.035 ? 0.78 : 1;
        img.data[i] = c[0] * k;
        img.data[i + 1] = c[1] * k;
        img.data[i + 2] = c[2] * k;
      } else {
        const n = fbm(x / 9, y / 260, 21, 4) * 0.7 + fbm(x / 40, y / 90, 8, 3) * 0.3;
        const c = ramp(STREAKS, (n - 0.15) * 1.8);
        img.data[i] = c[0];
        img.data[i + 1] = c[1];
        img.data[i + 2] = c[2];
      }
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}
