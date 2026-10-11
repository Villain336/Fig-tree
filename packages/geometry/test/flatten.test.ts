import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Path, containsPoint, ellipsePath, flattenPath, multiply, scaling, transformPoint, translation, wangSegmentCount, windingNumber } from "../src";
import { affine, contourPoints, coord, cubicPoint, distanceToPolyline, signedArea } from "./helpers";

const cubicArb = fc.array(coord, { minLength: 8, maxLength: 8 });
const tolArb = fc.double({ min: 0.01, max: 2, noNaN: true });

describe("flattenPath", () => {
  it("keeps every point of a cubic within tolerance of the polyline", () => {
    fc.assert(
      fc.property(cubicArb, tolArb, (p, tol) => {
        const path = new Path().moveTo(p[0]!, p[1]!).cubicTo(p[2]!, p[3]!, p[4]!, p[5]!, p[6]!, p[7]!);
        const { xs, ys } = contourPoints(flattenPath(path, undefined, tol), 0);
        for (let i = 0; i <= 64; i++) {
          const [x, y] = cubicPoint(i / 64, p);
          if (distanceToPolyline(x, y, xs, ys) > tol * (1 + 1e-9) + 1e-9) return false;
        }
        return true;
      }),
      { numRuns: 300 },
    );
  });

  it("emits vertices that lie on the curve and exact endpoints", () => {
    fc.assert(
      fc.property(cubicArb, tolArb, (p, tol) => {
        const path = new Path().moveTo(p[0]!, p[1]!).cubicTo(p[2]!, p[3]!, p[4]!, p[5]!, p[6]!, p[7]!);
        const { xs, ys } = contourPoints(flattenPath(path, undefined, tol), 0);
        const n = xs.length - 1;
        if (xs[0] !== p[0] || ys[0] !== p[1] || xs[n] !== p[6] || ys[n] !== p[7]) return false;
        return xs.every((x, i) => {
          const [cx, cy] = cubicPoint(i / n, p);
          return Math.abs(cx - x) < 1e-9 && Math.abs(cy - ys[i]!) < 1e-9;
        });
      }),
    );
  });

  it("uses more segments for tighter tolerances and none for straight curves", () => {
    const path = new Path().moveTo(0, 0).cubicTo(100, 0, 100, 100, 0, 100);
    const counts = [2, 1, 0.5, 0.25, 0.1, 0.01].map((t) => flattenPath(path, undefined, t).points.length);
    for (let i = 1; i < counts.length; i++) expect(counts[i]!).toBeGreaterThanOrEqual(counts[i - 1]!);
    expect(wangSegmentCount(3, 0, 0.25)).toBe(1);
    const flat = new Path().moveTo(0, 0).quadTo(5, 5, 10, 10);
    expect(flattenPath(flat).points.length).toBe(4);
  });

  it("scales segment count with the transform (screen-space tolerance)", () => {
    const circle = ellipsePath(0, 0, 10, 10);
    const small = flattenPath(circle, undefined, 0.25).points.length;
    const zoomed = flattenPath(circle, scaling(16), 0.25).points.length;
    expect(zoomed).toBeGreaterThan(small * 3);
  });

  it("flattening with a transform equals flattening the transformed path", () => {
    fc.assert(
      fc.property(cubicArb, affine, (p, m) => {
        const path = new Path().moveTo(p[0]!, p[1]!).cubicTo(p[2]!, p[3]!, p[4]!, p[5]!, p[6]!, p[7]!).close();
        const a = flattenPath(path, m, 0.3);
        const b = flattenPath(path.transform(m), undefined, 0.3);
        if (a.points.length !== b.points.length) return false;
        return a.points.every((v, i) => Math.abs(v - b.points[i]!) < 1e-6 * (1 + Math.abs(v)));
      }),
    );
  });

  it("stays within the tight path bounds and reaches them", () => {
    fc.assert(
      fc.property(cubicArb, (p) => {
        const path = new Path().moveTo(p[0]!, p[1]!).cubicTo(p[2]!, p[3]!, p[4]!, p[5]!, p[6]!, p[7]!);
        const b = path.bounds();
        const pts = flattenPath(path, undefined, 0.01).points;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (let i = 0; i < pts.length; i += 2) {
          minX = Math.min(minX, pts[i]!); maxX = Math.max(maxX, pts[i]!);
          minY = Math.min(minY, pts[i + 1]!); maxY = Math.max(maxY, pts[i + 1]!);
        }
        const eps = 1e-7;
        const inside = minX >= b.minX - eps && maxX <= b.maxX + eps && minY >= b.minY - eps && maxY <= b.maxY + eps;
        const tight = b.minX > minX - 0.02 && b.maxX < maxX + 0.02 && b.minY > minY - 0.02 && b.maxY < maxY + 0.02;
        return inside && tight;
      }),
    );
  });

  it("tracks contours and closed flags", () => {
    const path = new Path().moveTo(0, 0).lineTo(10, 0).lineTo(10, 10).close().moveTo(20, 20).lineTo(30, 20);
    const f = flattenPath(path);
    expect(Array.from(f.contourStarts)).toEqual([0, 3, 5]);
    expect(Array.from(f.closed)).toEqual([1, 0]);
  });

  it("starts a new contour at the close point when drawing continues after close", () => {
    const path = new Path().moveTo(5, 5).lineTo(10, 5).close().lineTo(5, 10);
    const f = flattenPath(path);
    expect(Array.from(f.contourStarts)).toEqual([0, 2, 4]);
    expect(Array.from(f.points.slice(4))).toEqual([5, 5, 5, 10]);
  });

  it("approximates circle area and winding", () => {
    const f = flattenPath(ellipsePath(0, 0, 50, 50), undefined, 0.01);
    expect(Math.abs(signedArea(f)) / (Math.PI * 2500)).toBeCloseTo(1, 3);
    expect(Math.abs(windingNumber(f, 0, 0))).toBe(1);
    expect(windingNumber(f, 60, 0)).toBe(0);
  });

  it("implements nonzero and even-odd containment", () => {
    // Two nested squares wound the same way: nonzero fills the hole, even-odd does not.
    const path = new Path()
      .moveTo(0, 0).lineTo(100, 0).lineTo(100, 100).lineTo(0, 100).close()
      .moveTo(25, 25).lineTo(75, 25).lineTo(75, 75).lineTo(25, 75).close();
    const f = flattenPath(path);
    expect(containsPoint(f, 50, 50, "nonzero")).toBe(true);
    expect(containsPoint(f, 50, 50, "evenodd")).toBe(false);
    expect(containsPoint(f, 10, 10, "evenodd")).toBe(true);
  });

  it("rejects non-positive tolerance", () => {
    expect(() => flattenPath(new Path().moveTo(0, 0), undefined, 0)).toThrow(RangeError);
  });

  it("maps points through a translation", () => {
    const f = flattenPath(new Path().moveTo(1, 2).lineTo(3, 4), multiply(translation(10, 20), scaling(2)));
    const p = transformPoint(multiply(translation(10, 20), scaling(2)), 3, 4);
    expect(Array.from(f.points)).toEqual([12, 24, p.x, p.y]);
  });
});
