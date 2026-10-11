import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  IDENTITY, determinant, invert, maxScale, multiply, rotation, scaling, transformPoint, translation,
} from "../src";
import { affine, coord } from "./helpers";

const close = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps * (1 + Math.abs(a) + Math.abs(b));

describe("Mat2D", () => {
  it("multiply applies the right operand first", () => {
    const m = multiply(translation(10, 0), scaling(2));
    expect(transformPoint(m, 1, 1)).toEqual({ x: 12, y: 2 });
  });

  it("multiplication is associative", () => {
    fc.assert(
      fc.property(affine, affine, affine, coord, coord, (a, b, c, x, y) => {
        const p = transformPoint(multiply(multiply(a, b), c), x, y);
        const q = transformPoint(multiply(a, multiply(b, c)), x, y);
        return close(p.x, q.x, 1e-9) && close(p.y, q.y, 1e-9);
      }),
    );
  });

  it("invert round-trips points", () => {
    fc.assert(
      fc.property(affine, coord, coord, (m, x, y) => {
        const inv = invert(m)!;
        const p = transformPoint(m, x, y);
        const q = transformPoint(inv, p.x, p.y);
        return close(q.x, x, 1e-7) && close(q.y, y, 1e-7);
      }),
    );
  });

  it("invert returns null for singular matrices", () => {
    expect(invert([1, 2, 2, 4, 5, 6])).toBeNull();
    expect(invert(scaling(0))).toBeNull();
  });

  it("determinant is multiplicative", () => {
    fc.assert(
      fc.property(affine, affine, (a, b) => close(determinant(multiply(a, b)), determinant(a) * determinant(b), 1e-9)),
    );
  });

  it("maxScale bounds the stretch of every vector", () => {
    fc.assert(
      fc.property(affine, fc.double({ min: 0, max: 2 * Math.PI, noNaN: true }), (m, angle) => {
        const s = maxScale(m);
        const vx = Math.cos(angle), vy = Math.sin(angle);
        const len = Math.hypot(m[0] * vx + m[2] * vy, m[1] * vx + m[3] * vy);
        return len <= s * (1 + 1e-9);
      }),
    );
    expect(maxScale(multiply(rotation(0.7), scaling(3, 0.5)))).toBeCloseTo(3, 12);
    expect(maxScale(IDENTITY)).toBe(1);
  });
});
