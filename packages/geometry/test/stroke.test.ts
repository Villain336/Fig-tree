import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  Path, containsPoint, dashPolylines, flattenPath, scaling, strokePath, strokePolylines, type LineCap, type LineJoin,
  type Polylines,
} from "../src";
import { contourPoints, distanceToPolyline, signedArea } from "./helpers";

const TOL = 0.05;
const inside = (p: Polylines, x: number, y: number): boolean => containsPoint(p, x, y, "nonzero");

function polyPath(xs: number[], ys: number[], closed: boolean): Path {
  const p = new Path().moveTo(xs[0]!, ys[0]!);
  for (let i = 1; i < xs.length; i++) p.lineTo(xs[i]!, ys[i]!);
  return closed ? p.close() : p;
}

const pointArb = fc.tuple(fc.integer({ min: 0, max: 100 }), fc.integer({ min: 0, max: 100 }));
const polylineArb = fc.array(pointArb, { minLength: 2, maxLength: 7 });

describe("strokePath", () => {
  it("round joins and caps cover exactly the points within width/2 of an open polyline", () => {
    fc.assert(
      fc.property(polylineArb, fc.double({ min: 1, max: 30, noNaN: true }), fc.array(pointArb, { minLength: 40, maxLength: 40 }), (pts, width, probes) => {
        const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
        const outline = strokePath(polyPath(xs, ys, false), { width, join: "round", cap: "round" }, undefined, TOL);
        const h = width / 2;
        return probes.every(([px, py]) => {
          const d = distanceToPolyline(px + 0.37, py + 0.21, xs, ys);
          if (d < h - 2 * TOL) return inside(outline, px + 0.37, py + 0.21);
          if (d > h + 2 * TOL) return !inside(outline, px + 0.37, py + 0.21);
          return true;
        });
      }),
      { numRuns: 300 },
    );
  });

  it("round joins cover exactly the points within width/2 of a closed polyline", () => {
    fc.assert(
      fc.property(fc.array(pointArb, { minLength: 3, maxLength: 7 }), fc.double({ min: 1, max: 30, noNaN: true }), fc.array(pointArb, { minLength: 40, maxLength: 40 }), (pts, width, probes) => {
        const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
        const outline = strokePath(polyPath(xs, ys, true), { width, join: "round" }, undefined, TOL);
        const h = width / 2;
        return probes.every(([px, py]) => {
          const d = distanceToPolyline(px + 0.37, py + 0.21, xs, ys, true);
          if (d < h - 2 * TOL) return inside(outline, px + 0.37, py + 0.21);
          if (d > h + 2 * TOL) return !inside(outline, px + 0.37, py + 0.21);
          return true;
        });
      }),
      { numRuns: 300 },
    );
  });

  it("never leaves holes along the spine for any join or cap", () => {
    const joins: LineJoin[] = ["miter", "round", "bevel"];
    const caps: LineCap[] = ["butt", "round", "square"];
    fc.assert(
      fc.property(polylineArb, fc.constantFrom(...joins), fc.constantFrom(...caps), fc.double({ min: 1, max: 30, noNaN: true }), (pts, join, cap, width) => {
        const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
        const outline = strokePath(polyPath(xs, ys, false), { width, join, cap }, undefined, TOL);
        // Points within h/2 of a segment's interior must be covered.
        for (let i = 0; i + 1 < xs.length; i++) {
          const dx = xs[i + 1]! - xs[i]!, dy = ys[i + 1]! - ys[i]!;
          const len = Math.hypot(dx, dy);
          if (len === 0) continue;
          for (const t of [0.25, 0.5, 0.75]) {
            for (const o of [-0.4, 0, 0.4]) {
              const x = xs[i]! + dx * t - (dy / len) * o * width;
              const y = ys[i]! + dy * t + (dx / len) * o * width;
              if (!inside(outline, x, y)) return false;
            }
          }
        }
        return true;
      }),
      { numRuns: 300 },
    );
  });

  it("produces the expected area for each cap", () => {
    const line = new Path().moveTo(0, 0).lineTo(100, 0);
    const area = (cap: LineCap): number => Math.abs(signedArea(strokePath(line, { width: 10, cap }, undefined, 0.001)));
    expect(area("butt")).toBeCloseTo(1000, 6);
    expect(area("square")).toBeCloseTo(1100, 6);
    expect(area("round")).toBeCloseTo(1000 + Math.PI * 25, 1);
  });

  it("applies miter, bevel and the miter limit at the outer corner", () => {
    const corner = new Path().moveTo(0, 0).lineTo(100, 0).lineTo(100, 100);
    const miter = strokePath(corner, { width: 10, join: "miter" });
    const bevel = strokePath(corner, { width: 10, join: "bevel" });
    const round = strokePath(corner, { width: 10, join: "round" });
    // Outer corner of the turn is at (105, -5) for a right turn in y-down space.
    expect(inside(miter, 104.5, -4.5)).toBe(true);
    expect(inside(bevel, 104.5, -4.5)).toBe(false);
    expect(inside(round, 104.5, -4.5)).toBe(false);
    expect(inside(round, 103, -3)).toBe(true);
    // A 90° miter has ratio sqrt(2); a limit below that bevels.
    const limited = strokePath(corner, { width: 10, join: "miter", miterLimit: 1.4 });
    expect(inside(limited, 104.5, -4.5)).toBe(false);
    expect(Math.abs(signedArea(limited))).toBeCloseTo(Math.abs(signedArea(bevel)), 9);
  });

  it("strokes a closed contour as a ring with a hole", () => {
    const square = new Path().moveTo(0, 0).lineTo(100, 0).lineTo(100, 100).lineTo(0, 100).close();
    const ring = strokePath(square, { width: 10 });
    expect(inside(ring, 50, 50)).toBe(false);
    expect(inside(ring, 50, 2)).toBe(true);
    expect(inside(ring, -4, -4)).toBe(true);
    expect(Math.abs(signedArea(ring))).toBeCloseTo(110 * 110 - 90 * 90, 6);
  });

  it("draws dots for zero-length subpaths with round or square caps only", () => {
    const dot = new Path().moveTo(10, 10).lineTo(10, 10);
    expect(Math.abs(signedArea(strokePath(dot, { width: 8, cap: "round" }, undefined, 0.001)))).toBeCloseTo(Math.PI * 16, 1);
    expect(Math.abs(signedArea(strokePath(dot, { width: 8, cap: "square" })))).toBeCloseTo(64, 9);
    expect(strokePath(dot, { width: 8, cap: "butt" }).points.length).toBe(0);
  });

  it("strokes in local space so non-uniform scale distorts the pen", () => {
    const line = new Path().moveTo(0, 0).lineTo(0, 10);
    const outline = strokePath(line, { width: 2 }, scaling(5, 1));
    // Width 2 in local x becomes 10 in output x.
    expect(inside(outline, 4.9, 5)).toBe(true);
    expect(inside(outline, 5.1, 5)).toBe(false);
  });

  it("returns nothing for non-positive widths", () => {
    expect(strokePath(new Path().moveTo(0, 0).lineTo(5, 5), { width: 0 }).points.length).toBe(0);
  });
});

describe("dashPolylines", () => {
  const lengthOf = (p: Polylines): number => {
    let total = 0;
    for (let c = 0; c + 1 < p.contourStarts.length; c++) {
      const { xs, ys } = contourPoints(p, c);
      for (let i = 0; i + 1 < xs.length; i++) total += Math.hypot(xs[i + 1]! - xs[i]!, ys[i + 1]! - ys[i]!);
      if (p.closed[c]) total += Math.hypot(xs[0]! - xs[xs.length - 1]!, ys[0]! - ys[ys.length - 1]!);
    }
    return total;
  };

  it("preserves the on-length of the pattern", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 20, noNaN: true }),
        fc.double({ min: 1, max: 20, noNaN: true }),
        fc.double({ min: -50, max: 50, noNaN: true }),
        (on, off, offset) => {
          const line = flattenPath(new Path().moveTo(0, 0).lineTo(60, 0).lineTo(60, 40));
          const dashed = dashPolylines(line, [on, off], offset);
          // Expected on-length by integrating the pattern along the 100-unit path.
          const period = on + off;
          let expected = 0;
          const steps = 20000;
          for (let i = 0; i < steps; i++) {
            const s = ((((i + 0.5) / steps) * 100 + offset) % period + period) % period;
            if (s < on) expected += 100 / steps;
          }
          return Math.abs(lengthOf(dashed) - expected) < 0.05;
        },
      ),
    );
  });

  it("repeats odd patterns and ignores invalid ones", () => {
    const line = flattenPath(new Path().moveTo(0, 0).lineTo(30, 0));
    expect(dashPolylines(line, [5]).contourStarts.length - 1).toBe(3);
    expect(dashPolylines(line, [0, 0])).toBe(line);
    expect(dashPolylines(line, [5, -1])).toBe(line);
  });

  it("joins the dash that wraps around the start of a closed contour", () => {
    const square = flattenPath(new Path().moveTo(0, 0).lineTo(40, 0).lineTo(40, 40).lineTo(0, 40).close());
    // Period 20 over perimeter 160 starting "on": 8 dashes, the first and last merged into one.
    const dashed = dashPolylines(square, [10, 10], 5);
    expect(dashed.contourStarts.length - 1).toBe(8);
    const solid = dashPolylines(square, [1000, 1]);
    expect(Array.from(solid.closed)).toEqual([1]);
  });

  it("turns zero-length dashes into dots with round caps", () => {
    // Dashes start at arc lengths in [0, length): dots at 0, 10, 20 and 30.
    const line = flattenPath(new Path().moveTo(0, 0).lineTo(40, 0));
    const dots = strokePolylines(dashPolylines(line, [0, 10]), { width: 4, cap: "round" }, 0.001);
    expect(dots.contourStarts.length - 1).toBe(4);
    expect(Math.abs(signedArea(dots))).toBeCloseTo(4 * Math.PI * 4, 1);
  });
});
