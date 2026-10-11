import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { intersectRect, isEmptyRect, rectContainsPoint, rectFromXYWH, rectsIntersect, transformPoint, transformRect, unionRect } from "../src";
import { affine, coord } from "./helpers";

const rect = fc.tuple(coord, coord, fc.double({ min: 0, max: 300, noNaN: true }), fc.double({ min: 0, max: 300, noNaN: true }))
  .map(([x, y, w, h]) => rectFromXYWH(x, y, w, h));

describe("Rect", () => {
  it("transformRect contains every transformed corner and is tight", () => {
    fc.assert(
      fc.property(affine, rect, (m, r) => {
        const t = transformRect(m, r);
        const corners = [
          transformPoint(m, r.minX, r.minY), transformPoint(m, r.maxX, r.minY),
          transformPoint(m, r.maxX, r.maxY), transformPoint(m, r.minX, r.maxY),
        ];
        const eps = 1e-6 * (1 + Math.abs(t.maxX) + Math.abs(t.maxY) + Math.abs(t.minX) + Math.abs(t.minY));
        const inside = corners.every((p) => p.x >= t.minX - eps && p.x <= t.maxX + eps && p.y >= t.minY - eps && p.y <= t.maxY + eps);
        const tight =
          Math.abs(Math.min(...corners.map((p) => p.x)) - t.minX) < eps &&
          Math.abs(Math.max(...corners.map((p) => p.y)) - t.maxY) < eps;
        return inside && tight;
      }),
    );
  });

  it("union contains both and intersection is contained in both", () => {
    fc.assert(
      fc.property(rect, rect, (a, b) => {
        const u = unionRect(a, b);
        const ok = u.minX <= a.minX && u.maxX >= b.maxX && u.minY <= b.minY && u.maxY >= a.maxY;
        const i = intersectRect(a, b);
        if (rectsIntersect(a, b)) return ok && !isEmptyRect(i) && rectContainsPoint(a, i.minX, i.minY) && rectContainsPoint(b, i.maxX, i.maxY);
        return ok && isEmptyRect(i);
      }),
    );
  });

  it("normalizes negative sizes", () => {
    expect(rectFromXYWH(10, 10, -5, -5)).toEqual({ minX: 5, minY: 5, maxX: 10, maxY: 10 });
  });
});
