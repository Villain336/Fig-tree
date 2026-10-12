import fc from "fast-check";
import type { Mat2D, Polylines } from "../src";

/** Total signed area (shoelace) of all contours, each treated as closed. */
export function signedArea(p: Polylines): number {
  let area = 0;
  for (let c = 0; c + 1 < p.contourStarts.length; c++) {
    const s = p.contourStarts[c]!;
    const e = p.contourStarts[c + 1]!;
    for (let i = s; i < e; i++) {
      const j = i + 1 < e ? i + 1 : s;
      area += p.points[i * 2]! * p.points[j * 2 + 1]! - p.points[j * 2]! * p.points[i * 2 + 1]!;
    }
  }
  return area / 2;
}

export function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax, vy = by - ay;
  const l2 = vx * vx + vy * vy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / l2));
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
}

/** Distance from a point to an open (or closed) polyline given as flat x,y arrays. */
export function distanceToPolyline(px: number, py: number, xs: number[], ys: number[], closed = false): number {
  let best = Infinity;
  const n = xs.length;
  if (n === 1) return Math.hypot(px - xs[0]!, py - ys[0]!);
  const count = closed ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % n;
    best = Math.min(best, distanceToSegment(px, py, xs[i]!, ys[i]!, xs[j]!, ys[j]!));
  }
  return best;
}

export function cubicPoint(t: number, p: readonly number[]): [number, number] {
  const mt = 1 - t;
  const w0 = mt * mt * mt, w1 = 3 * mt * mt * t, w2 = 3 * mt * t * t, w3 = t * t * t;
  return [
    w0 * p[0]! + w1 * p[2]! + w2 * p[4]! + w3 * p[6]!,
    w0 * p[1]! + w1 * p[3]! + w2 * p[5]! + w3 * p[7]!,
  ];
}

export const coord = fc.double({ min: -500, max: 500, noNaN: true, noDefaultInfinity: true });

export const affine: fc.Arbitrary<Mat2D> = fc
  .tuple(
    fc.double({ min: -4, max: 4, noNaN: true }),
    fc.double({ min: -4, max: 4, noNaN: true }),
    fc.double({ min: -4, max: 4, noNaN: true }),
    fc.double({ min: -4, max: 4, noNaN: true }),
    coord,
    coord,
  )
  .filter(([a, b, c, d]) => Math.abs(a * d - b * c) > 0.05);

export function contourPoints(p: Polylines, c: number): { xs: number[]; ys: number[] } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = p.contourStarts[c]!; i < p.contourStarts[c + 1]!; i++) {
    xs.push(p.points[i * 2]!);
    ys.push(p.points[i * 2 + 1]!);
  }
  return { xs, ys };
}

/** A small seeded PRNG (mulberry32), for reproducible random tests. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
