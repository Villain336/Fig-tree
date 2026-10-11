import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Verb, ellipseArcPath, flattenPath, polygonPath, roundedPolygonPath, roundedRectPath, starPath, type Path } from "../src";
import { signedArea } from "./helpers";

const area = (p: Path, tol = 0.0005): number => signedArea(flattenPath(p, undefined, tol));

/** Tangent directions entering and leaving every joint between consecutive segments. */
function jointTangents(p: Path): { into: [number, number]; out: [number, number] }[] {
  const segs: { start: [number, number]; d0: [number, number]; d1: [number, number]; end: [number, number] }[] = [];
  let cx = 0, cy = 0, sx = 0, sy = 0;
  for (const c of p.commands()) {
    if (c.verb === Verb.MoveTo) {
      cx = sx = c.x;
      cy = sy = c.y;
    } else if (c.verb === Verb.LineTo) {
      if (c.x !== cx || c.y !== cy) segs.push({ start: [cx, cy], d0: [c.x - cx, c.y - cy], d1: [c.x - cx, c.y - cy], end: [c.x, c.y] });
      cx = c.x;
      cy = c.y;
    } else if (c.verb === Verb.CubicTo) {
      segs.push({ start: [cx, cy], d0: [c.x1 - cx, c.y1 - cy], d1: [c.x - c.x2, c.y - c.y2], end: [c.x, c.y] });
      cx = c.x;
      cy = c.y;
    } else if (c.verb === Verb.Close) {
      if (cx !== sx || cy !== sy) segs.push({ start: [cx, cy], d0: [sx - cx, sy - cy], d1: [sx - cx, sy - cy], end: [sx, sy] });
      cx = sx;
      cy = sy;
    }
  }
  const out: { into: [number, number]; out: [number, number] }[] = [];
  for (let i = 0; i < segs.length; i++) out.push({ into: segs[i]!.d1, out: segs[(i + 1) % segs.length]!.d0 });
  return out;
}

const angleBetween = (a: [number, number], b: [number, number]): number =>
  Math.abs(Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]));

describe("ellipseArcPath", () => {
  it("is a full ellipse without arc data", () => {
    expect(area(ellipseArcPath(0, 0, 200, 100))).toBeCloseTo(Math.PI * 100 * 50, -1);
  });

  it("draws pies whose area is proportional to the sweep", () => {
    fc.assert(
      fc.property(fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }), fc.double({ min: 0.05, max: 6.2, noNaN: true }), (start, sweep) => {
        const a = Math.abs(area(ellipseArcPath(0, 0, 100, 100, start, sweep)));
        const want = (sweep / 2) * 50 * 50;
        expect(Math.abs(a - want)).toBeLessThan(want * 0.002 + 0.5);
      }),
    );
  });

  it("draws donuts and ring segments", () => {
    const donut = ellipseArcPath(0, 0, 100, 100, 0, Math.PI * 2, 0.5);
    expect(Math.abs(area(donut))).toBeCloseTo(Math.PI * (2500 - 625), -1);
    const ring = ellipseArcPath(0, 0, 100, 100, 0, Math.PI, 0.5);
    expect(Math.abs(area(ring))).toBeCloseTo((Math.PI / 2) * (2500 - 625), -1);
    expect(ellipseArcPath(0, 0, 100, 100, 1, 0).isEmpty()).toBe(true);
  });

  it("winds the inner contour of a donut opposite to the outer one", () => {
    const lines = flattenPath(ellipseArcPath(0, 0, 100, 100, 0, Math.PI * 2, 0.4), undefined, 0.01);
    expect(lines.contourStarts.length).toBe(3);
    const sub = (c: number): number => {
      const s = lines.contourStarts[c]!, e = lines.contourStarts[c + 1]!;
      return signedArea({ points: lines.points.slice(s * 2, e * 2), contourStarts: new Uint32Array([0, e - s]), closed: new Uint8Array([1]) });
    };
    expect(Math.sign(sub(0))).toBe(-Math.sign(sub(1)));
  });
});

describe("polygonPath and starPath", () => {
  it("fill their box exactly", () => {
    for (const sides of [3, 4, 5, 6, 7, 12]) {
      expect(polygonPath(10, 20, 300, 200, sides).bounds()).toEqual({ minX: 10, minY: 20, maxX: 310, maxY: 220 });
      const b = starPath(10, 20, 300, 200, sides, 0.4).bounds();
      for (const [got, want] of [[b.minX, 10], [b.minY, 20], [b.maxX, 310], [b.maxY, 220]] as const) expect(got).toBeCloseTo(want, 9);
    }
  });

  it("have the area of the stretched regular figure", () => {
    // A square polygon (diamond) filling a 100x100 box covers half of it.
    expect(Math.abs(area(polygonPath(0, 0, 100, 100, 4)))).toBeCloseTo(5000, 6);
    // Equilateral-ish triangle filling the box covers half of it.
    expect(Math.abs(area(polygonPath(0, 0, 100, 80, 3)))).toBeCloseTo(4000, 6);
    // A star with inner ratio 1 is a regular 2n-gon.
    const flat = starPath(0, 0, 100, 100, 5, 1);
    const decagon = (() => {
      const pts: [number, number][] = [];
      for (let i = 0; i < 10; i++) pts.push([Math.cos(-Math.PI / 2 + (i * Math.PI) / 5), Math.sin(-Math.PI / 2 + (i * Math.PI) / 5)]);
      return pts;
    })();
    const rawArea = Math.abs(decagon.reduce((s, p, i) => s + p[0] * decagon[(i + 1) % 10]![1] - decagon[(i + 1) % 10]![0] * p[1], 0) / 2);
    const xs = decagon.map((p) => p[0]), ys = decagon.map((p) => p[1]);
    const boxArea = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
    expect(Math.abs(area(flat))).toBeCloseTo((rawArea / boxArea) * 10000, 6);
  });
});

describe("roundedPolygonPath", () => {
  it("matches a rounded rectangle for a rectangle", () => {
    const rect = roundedPolygonPath([[0, 0], [100, 0], [100, 60], [0, 60]], 12);
    expect(area(rect)).toBeCloseTo(area(roundedRectPath(0, 0, 100, 60, 12)), 2);
  });

  it("is tangent-continuous at every joint, and rounding a convex polygon only removes area", () => {
    fc.assert(
      fc.property(fc.integer({ min: 3, max: 9 }), fc.double({ min: 0.1, max: 0.9, noNaN: true }), fc.double({ min: 0.5, max: 80, noNaN: true }), (n, inner, r) => {
        const convex = Math.abs(area(polygonPath(0, 0, 200, 160, n, r)));
        expect(convex).toBeLessThan(Math.abs(area(polygonPath(0, 0, 200, 160, n))));
        // Star tips are convex and lose area; inner corners are concave and gain it.
        const round = starPath(0, 0, 200, 160, n, inner, r);
        for (const j of jointTangents(round)) {
          const l1 = Math.hypot(...j.into), l2 = Math.hypot(...j.out);
          if (l1 < 1e-9 || l2 < 1e-9) continue;
          expect(angleBetween(j.into, j.out)).toBeLessThan(1e-6);
        }
      }),
    );
  });

  it("clamps the radius so corners never overlap", () => {
    const tri = roundedPolygonPath([[0, 0], [10, 0], [5, 8]], 1000);
    const b = tri.bounds();
    expect(b.minX).toBeGreaterThanOrEqual(-1e-9);
    expect(b.maxX).toBeLessThanOrEqual(10 + 1e-9);
    expect(Math.abs(area(tri))).toBeGreaterThan(0);
  });
});
