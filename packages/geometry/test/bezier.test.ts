import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  arcLength,
  areaContribution,
  closestParam,
  cubic,
  cubicBounds,
  intersectCurves,
  lineCubic,
  monotonicSplits,
  paramAtLength,
  pointAt,
  solveCubic,
  splitAt,
  subCurve,
  tangentAt,
  type Cubic,
} from "../src";

const coord = fc.double({ min: -200, max: 200, noNaN: true, noDefaultInfinity: true });
const arbCubic = fc.tuple(coord, coord, coord, coord, coord, coord, coord, coord).map(([a, b, c, d, e, f, g, h]) => cubic(a, b, c, d, e, f, g, h));

function dist(p: { x: number; y: number }, q: { x: number; y: number }): number {
  return Math.hypot(p.x - q.x, p.y - q.y);
}

/** The larger side of a curve's tight bounding box. */
function extent(c: Cubic): number {
  const b = cubicBounds(c);
  return Math.max(b.maxX - b.minX, b.maxY - b.minY);
}

describe("cubic primitives", () => {
  it("splits and sub-curves reproduce the curve", () => {
    fc.assert(
      fc.property(arbCubic, fc.double({ min: 0.01, max: 0.99, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }), (c, t, s) => {
        const [l, r] = splitAt(c, t);
        expect(dist(pointAt(l, s), pointAt(c, s * t))).toBeLessThan(1e-9);
        expect(dist(pointAt(r, s), pointAt(c, t + s * (1 - t)))).toBeLessThan(1e-9);
        const a = Math.min(t, s), b = Math.max(t, s);
        if (b - a > 1e-6) {
          const sub = subCurve(c, a, b);
          expect(dist(pointAt(sub, 0.5), pointAt(c, (a + b) / 2))).toBeLessThan(1e-9);
          const rev = subCurve(c, b, a);
          expect(dist(pointAt(rev, 0.25), pointAt(c, b - 0.25 * (b - a)))).toBeLessThan(1e-9);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("tight bounds contain every point and touch the extrema", () => {
    fc.assert(
      fc.property(arbCubic, (c) => {
        const b = cubicBounds(c);
        let minX = Infinity, maxX = -Infinity;
        for (let i = 0; i <= 400; i++) {
          const p = pointAt(c, i / 400);
          expect(p.x).toBeGreaterThanOrEqual(b.minX - 1e-9);
          expect(p.x).toBeLessThanOrEqual(b.maxX + 1e-9);
          expect(p.y).toBeGreaterThanOrEqual(b.minY - 1e-9);
          expect(p.y).toBeLessThanOrEqual(b.maxY + 1e-9);
          minX = Math.min(minX, p.x);
          maxX = Math.max(maxX, p.x);
        }
        expect(minX - b.minX).toBeLessThan(0.01 * (1 + b.maxX - b.minX));
        expect(b.maxX - maxX).toBeLessThan(0.01 * (1 + b.maxX - b.minX));
      }),
      { numRuns: 200 },
    );
  });

  it("monotonic splits make pieces monotonic in x and y", () => {
    fc.assert(
      fc.property(arbCubic, (c) => {
        const ts = [0, ...monotonicSplits(c), 1];
        for (let i = 0; i + 1 < ts.length; i++) {
          const piece = subCurve(c, ts[i]!, ts[i + 1]!);
          let sx = 0, sy = 0;
          let prev = pointAt(piece, 0);
          for (let k = 1; k <= 50; k++) {
            const p = pointAt(piece, k / 50);
            const dx = p.x - prev.x, dy = p.y - prev.y;
            if (Math.abs(dx) > 1e-7) {
              if (sx !== 0) expect(Math.sign(dx)).toBe(sx);
              sx = Math.sign(dx);
            }
            if (Math.abs(dy) > 1e-7) {
              if (sy !== 0) expect(Math.sign(dy)).toBe(sy);
              sy = Math.sign(dy);
            }
            prev = p;
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it("computes the exact area of a closed contour of cubics", () => {
    // A circle from four quarter arcs: area within the known cubic-approximation error.
    const k = 0.5522847498307936 * 10;
    const quarters = [
      cubic(10, 0, 10, k, k, 10, 0, 10),
      cubic(0, 10, -k, 10, -10, k, -10, 0),
      cubic(-10, 0, -10, -k, -k, -10, 0, -10),
      cubic(0, -10, k, -10, 10, -k, 10, 0),
    ];
    const area = quarters.reduce((s, c) => s + areaContribution(c), 0);
    expect(Math.abs(area - Math.PI * 100) / (Math.PI * 100)).toBeLessThan(5e-4);
    // Against fine polygon integration.
    let poly = 0;
    for (const c of quarters) {
      for (let i = 0; i < 2000; i++) {
        const p = pointAt(c, i / 2000), q = pointAt(c, (i + 1) / 2000);
        poly += (p.x * q.y - q.x * p.y) / 2;
      }
    }
    expect(area).toBeCloseTo(poly, 3);
  });

  it("measures arc length and inverts it", () => {
    const line = lineCubic(0, 0, 30, 40);
    expect(arcLength(line)).toBeCloseTo(50, 12);
    const c = cubic(0, 0, 100, 0, 100, 100, 0, 100);
    let poly = 0;
    for (let i = 0; i < 20000; i++) poly += dist(pointAt(c, i / 20000), pointAt(c, (i + 1) / 20000));
    expect(arcLength(c)).toBeCloseTo(poly, 4);
    for (const f of [0.1, 0.37, 0.5, 0.9]) {
      const t = paramAtLength(c, poly * f);
      expect(arcLength(c, 0, t)).toBeCloseTo(poly * f, 6);
    }
  });

  it("finds the closest point", () => {
    fc.assert(
      fc.property(arbCubic, coord, coord, (c, x, y) => {
        const q = closestParam(c, x, y);
        for (let i = 0; i <= 200; i++) {
          const p = pointAt(c, i / 200);
          expect(Math.sqrt(q.dist2)).toBeLessThanOrEqual(Math.hypot(p.x - x, p.y - y) + 1e-6);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("solves cubics", () => {
    // (t − 1)(t − 2)(t − 3)
    expect(solveCubic(1, -6, 11, -6).map((r) => Math.round(r * 1e9) / 1e9)).toEqual([1, 2, 3]);
    // Double root at 1 plus 4: (t−1)²(t−4)
    const r = solveCubic(1, -6, 9, -4);
    expect(r[0]).toBeCloseTo(1, 6);
    expect(r[r.length - 1]).toBeCloseTo(4, 9);
    expect(solveCubic(0, 1, -3, 2)).toEqual([1, 2]);
  });

  it("gives tangents for degenerate handles", () => {
    const c = cubic(0, 0, 0, 0, 10, 10, 10, 0);
    const t = tangentAt(c, 0);
    expect(Math.hypot(t.x, t.y)).toBeCloseTo(1, 12);
    expect(t.x).toBeGreaterThan(0.5);
  });
});

describe("curve intersection", () => {
  it("line × circle quarter: exact roots", () => {
    const k = 0.5522847498307936 * 50;
    const arc = cubic(50, 0, 50, k, k, 50, 0, 50);
    const line = lineCubic(0, 0, 60, 60);
    const r = intersectCurves(line, arc, 1e-9);
    expect(r.hits).toHaveLength(1);
    const h = r.hits[0]!;
    expect(dist(pointAt(line, h.t), pointAt(arc, h.u))).toBeLessThan(1e-9);
    expect(Math.hypot(h.x, h.y)).toBeCloseTo(50, 2);
  });

  it("finds every crossing of random cubic pairs, accurately", () => {
    let total = 0;
    fc.assert(
      fc.property(arbCubic, arbCubic, (a, b) => {
        // A curve no bigger than a few tolerances is a point as far as the
        // intersector is concerned, so its "crossings" are not well defined
        // (seed 11 found one 4e-7 tall dipping across a line).
        fc.pre(extent(a) > 1e-4 && extent(b) > 1e-4);
        const r = intersectCurves(a, b, 1e-7);
        if (r.overlaps.length) return;
        for (const h of r.hits) {
          expect(dist(pointAt(a, h.t), pointAt(b, h.u))).toBeLessThan(1e-5);
        }
        total += r.hits.length;
        // Every sign change of a's signed distance to b's polyline must be near a hit (coarse completeness check).
        const N = 400;
        const pb: { x: number; y: number }[] = [];
        for (let i = 0; i <= N; i++) pb.push(pointAt(b, i / N));
        for (let i = 0; i < N; i++) {
          const p0 = pointAt(a, i / N), p1 = pointAt(a, (i + 1) / N);
          for (let j = 0; j < N; j++) {
            if (segmentsCross(p0, p1, pb[j]!, pb[j + 1]!)) {
              const near = r.hits.some((h) => dist(h, p0) < dist(p0, p1) + 3 * dist(pb[j]!, pb[j + 1]!) + 1);
              expect(near).toBe(true);
            }
          }
        }
      }),
      { numRuns: 60 },
    );
    expect(total).toBeGreaterThan(0);
  });

  it("finds line crossings of nearly quadratic cubics (vanishing cubic term)", () => {
    // Regression: Cardano's formula lost two of three real roots when the cubic coefficient was ~1e-4 of the others.
    const piece = cubic(155.6514539436105, 500.68019582712503, 156.4030331666686, 499.078959923655, 157.9175649264414, 498.27834197192, 159.4320966862142, 498.27834197192);
    const r0 = intersectCurves(piece, lineCubic(158.46836424814538, 499.01845829791444, 156.7531973364763, 499.01845829791444), 5e-6);
    expect(r0.hits).toHaveLength(1);
    fc.assert(
      fc.property(coord, coord, coord, coord, coord, coord, fc.double({ min: -1e-3, max: 1e-3, noNaN: true }), coord, coord, coord, coord, (x0, y0, qx, qy, x3, y3, wobble, lx0, ly0, lx1, ly1) => {
        // A quadratic elevated to a cubic, perturbed slightly: the cubic term is tiny.
        const c = cubic(x0, y0, x0 + (2 / 3) * (qx - x0), y0 + (2 / 3) * (qy - y0) + wobble, x3 + (2 / 3) * (qx - x3), y3 + (2 / 3) * (qy - y3), x3, y3);
        const line = lineCubic(lx0, ly0, lx1, ly1);
        const r = intersectCurves(line, c, 1e-9);
        if (r.overlaps.length) return;
        const N = 2000;
        let prev = pointAt(c, 0);
        for (let i = 1; i <= N; i++) {
          const p = pointAt(c, i / N);
          if (segmentsCross(prev, p, { x: lx0, y: ly0 }, { x: lx1, y: ly1 })) {
            expect(r.hits.some((h) => dist(h, p) <= dist(prev, p) + 1e-6)).toBe(true);
          }
          prev = p;
        }
      }),
      { numRuns: 300 },
    );
  });

  it("reports overlaps of coincident curves instead of points", () => {
    const c = cubic(0, 0, 30, 60, 70, -60, 100, 0);
    const sub = subCurve(c, 0.25, 0.75);
    const r = intersectCurves(c, sub, 1e-9);
    expect(r.overlaps).toHaveLength(1);
    expect(r.overlaps[0]!.t0).toBeCloseTo(0.25, 6);
    expect(r.overlaps[0]!.t1).toBeCloseTo(0.75, 6);
    // Reversed and identical.
    const rev = subCurve(c, 1, 0);
    const r2 = intersectCurves(c, rev, 1e-9);
    expect(r2.overlaps).toHaveLength(1);
    expect(r2.overlaps[0]!.u0).toBeCloseTo(1, 9);
    // Collinear lines.
    const r3 = intersectCurves(lineCubic(0, 0, 10, 0), lineCubic(5, 0, 20, 0), 1e-9);
    expect(r3.overlaps).toHaveLength(1);
    expect(r3.overlaps[0]!.t0).toBeCloseTo(0.5, 12);
  });

  it("reports tangential touches once", () => {
    const k = 0.5522847498307936 * 10;
    const top = cubic(-10, 0, -10, -k, -k, -10, 0, -10); // arc reaching y = −10 at x = 0
    const line = lineCubic(-20, -10, 20, -10);
    const r = intersectCurves(line, top, 1e-7);
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]!.y).toBeCloseTo(-10, 6);
    // Two arcs touching externally.
    const other = cubic(0, -10, k, -10, 10, -10 - k, 10, -20);
    const r2 = intersectCurves(top, other, 1e-7);
    expect(r2.hits.length).toBe(1);
  });

  it("finds endpoint contacts (T-junctions)", () => {
    const r = intersectCurves(lineCubic(0, 0, 10, 0), lineCubic(5, 0, 5, 10), 1e-9);
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]!.t).toBeCloseTo(0.5, 12);
    expect(r.hits[0]!.u).toBe(0);
  });
});

function segmentsCross(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }, d: { x: number; y: number }): boolean {
  const o = (p: typeof a, q: typeof a, r: typeof a): number => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}

void ({} as Cubic);
