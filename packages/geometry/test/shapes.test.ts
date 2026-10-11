import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Verb, ellipsePath, flattenPath, roundedRectPath, type Path } from "../src";
import { signedArea } from "./helpers";

const area = (p: Path, tol = 0.001): number => Math.abs(signedArea(flattenPath(p, undefined, tol)));

/** Cubic quarter circles deviate from the true circle by ~0.03% of r, so compare corner cut-outs relatively. */
function expectCornerCut(actual: number, full: number, expected: number): void {
  const cut = full - expected;
  expect(Math.abs(actual - expected)).toBeLessThan(cut * 0.005);
}

/** Curvature of a cubic at t in {0, 1}. */
function endCurvature(p: number[], atEnd: boolean): number {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = p as [number, number, number, number, number, number, number, number];
  const [ax, ay, bx, by, cx, cy] = atEnd ? [x3, y3, x2, y2, x1, y1] : [x0, y0, x1, y1, x2, y2];
  const d1x = bx - ax, d1y = by - ay;
  const d2x = cx - bx, d2y = cy - by;
  const l = Math.hypot(d1x, d1y);
  return ((2 / 3) * Math.abs(d1x * d2y - d1y * d2x)) / (l * l * l);
}

function cubics(p: Path): number[][] {
  const out: number[][] = [];
  let cx = 0, cy = 0;
  for (const c of p.commands()) {
    if (c.verb === Verb.CubicTo) out.push([cx, cy, c.x1, c.y1, c.x2, c.y2, c.x, c.y]);
    if (c.verb !== Verb.Close) {
      cx = c.x;
      cy = c.y;
    }
  }
  return out;
}

describe("roundedRectPath", () => {
  it("is a plain rectangle with zero radii", () => {
    expect(area(roundedRectPath(10, 20, 30, 40))).toBeCloseTo(1200, 9);
    expect(roundedRectPath(10, 20, 30, 40).bounds()).toEqual({ minX: 10, minY: 20, maxX: 40, maxY: 60 });
  });

  it("matches the circular-corner area without smoothing", () => {
    const r = 12;
    expectCornerCut(area(roundedRectPath(0, 0, 100, 80, r)), 8000, 8000 - (4 - Math.PI) * r * r);
  });

  it("supports distinct per-corner radii", () => {
    const p = roundedRectPath(0, 0, 100, 100, [0, 10, 20, 30]);
    const expected = 10000 - (4 - Math.PI) * (100 + 400 + 900) / 4;
    expectCornerCut(area(p), 10000, expected);
  });

  it("clamps oversized radii like CSS", () => {
    // 100x50 with r=100 clamps to r=25: a stadium.
    expectCornerCut(area(roundedRectPath(0, 0, 100, 50, 100)), 5000, 50 * 50 + Math.PI * 625);
  });

  it("stays inside its rectangle, keeps tight bounds and positive area for any radii and smoothing", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 300, noNaN: true }),
        fc.double({ min: 1, max: 300, noNaN: true }),
        fc.array(fc.double({ min: 0, max: 400, noNaN: true }), { minLength: 4, maxLength: 4 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (w, h, radii, s) => {
          const p = roundedRectPath(5, 7, w, h, radii as [number, number, number, number], s);
          const b = p.bounds();
          const eps = 1e-9 * (w + h);
          const tight = Math.abs(b.minX - 5) < eps + 1e-9 && Math.abs(b.maxX - 5 - w) < eps + 1e-9 &&
            Math.abs(b.minY - 7) < eps + 1e-9 && Math.abs(b.maxY - 7 - h) < eps + 1e-9;
          const a = area(p, 0.01);
          return tight && a > 0 && a <= w * h * (1 + 1e-9);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("smoothing removes area monotonically and extends the corner to r(1+s)", () => {
    let prev = Infinity;
    for (const s of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
      const p = roundedRectPath(0, 0, 200, 200, 30, s);
      const a = area(p);
      expect(a).toBeLessThan(prev + 1e-9);
      prev = a;
      const first = p.commands().next().value!;
      expect(first.verb).toBe(Verb.MoveTo);
      if (first.verb === Verb.MoveTo) expect(first.x).toBeCloseTo(30 * (1 + s), 9);
    }
  });

  it("is curvature-continuous: 0 at the edges, 1/r into the circular core", () => {
    const r = 40;
    const p = roundedRectPath(0, 0, 400, 400, r, 0.6);
    const cs = cubics(p);
    expect(cs.length).toBe(12);
    for (let corner = 0; corner < 4; corner++) {
      const [t1, arc, t2] = [cs[corner * 3]!, cs[corner * 3 + 1]!, cs[corner * 3 + 2]!];
      expect(endCurvature(t1, false)).toBeCloseTo(0, 9);
      expect(endCurvature(t1, true)).toBeCloseTo(1 / r, 9);
      expect(endCurvature(arc, false)).toBeCloseTo(1 / r, 3);
      expect(endCurvature(t2, false)).toBeCloseTo(1 / r, 9);
      expect(endCurvature(t2, true)).toBeCloseTo(0, 9);
    }
  });

  it("is tangent-continuous at every joint", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 1, max: 60, noNaN: true }), (s, r) => {
        const cs = cubics(roundedRectPath(0, 0, 300, 200, r, s));
        for (let i = 0; i < cs.length; i++) {
          const a = cs[i]!;
          const b = cs[(i + 1) % cs.length]!;
          if (Math.hypot(a[6]! - b[0]!, a[7]! - b[1]!) > 1e-9) continue; // separated by a straight edge
          const ox = a[6]! - a[4]!, oy = a[7]! - a[5]!;
          const ix = b[2]! - b[0]!, iy = b[3]! - b[1]!;
          const cross = (ox * iy - oy * ix) / (Math.hypot(ox, oy) * Math.hypot(ix, iy));
          if (Math.abs(cross) > 1e-6) return false;
        }
        return true;
      }),
    );
  });

  it("reduces smoothing, not radius, when an edge is too short", () => {
    const p = roundedRectPath(0, 0, 100, 100, 40, 1);
    const first = p.commands().next().value!;
    // Share per corner is 50, so the corner extent is capped at 50 = r(1 + 0.25).
    if (first.verb === Verb.MoveTo) expect(first.x).toBeCloseTo(50, 9);
  });

  it("normalizes negative sizes", () => {
    expect(roundedRectPath(10, 10, -10, -10, 2).bounds()).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
  });
});

describe("ellipsePath", () => {
  it("approximates the true ellipse area", () => {
    expect(area(ellipsePath(0, 0, 80, 30)) / (Math.PI * 80 * 30)).toBeCloseTo(1, 3);
  });

  it("has exact bounds", () => {
    expect(ellipsePath(10, 20, 5, 7).bounds()).toEqual({ minX: 5, minY: 13, maxX: 15, maxY: 27 });
  });
});
