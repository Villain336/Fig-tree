import fc from "fast-check";
import { Path, flattenPath } from "@fig-tree/geometry";
import { describe, expect, it } from "vitest";
import { RangeAllocator } from "../src/arena";
import { polylinesToSegments, requiredLevel } from "../src/geometry-cache";
import { PaintKind, encodePaint, sampleStops } from "../src/paint";
import { hexColor, rgba } from "../src/types";

describe("RangeAllocator", () => {
  it("never hands out overlapping ranges and reuses freed space", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.boolean(), fc.integer({ min: 1, max: 50 })), { maxLength: 200 }), (ops) => {
        const alloc = new RangeAllocator(64);
        const live: { offset: number; size: number }[] = [];
        for (const [isAlloc, size] of ops) {
          if (isAlloc || live.length === 0) {
            let r = alloc.allocate(size);
            if (!r) {
              alloc.grow(Math.max(alloc.capacity * 2, alloc.used + size));
              r = alloc.allocate(size);
            }
            if (!r) return false;
            for (const o of live) if (r.offset < o.offset + o.size && o.offset < r.offset + r.size) return false;
            if (r.offset + r.size > alloc.capacity) return false;
            live.push(r);
          } else {
            alloc.release(live.splice(size % live.length, 1)[0]!);
          }
        }
        return alloc.used === live.reduce((s, r) => s + r.size, 0);
      }),
    );
  });

  it("coalesces neighbours so a full release restores one free block", () => {
    const alloc = new RangeAllocator(30);
    const rs = [alloc.allocate(10)!, alloc.allocate(10)!, alloc.allocate(10)!];
    expect(alloc.allocate(1)).toBeNull();
    alloc.release(rs[0]!);
    alloc.release(rs[2]!);
    alloc.release(rs[1]!);
    expect(alloc.allocate(30)).toEqual({ offset: 0, size: 30 });
  });
});

describe("geometry levels", () => {
  it("picks the smallest power of two at least the scale", () => {
    expect(requiredLevel(1)).toBe(0);
    expect(requiredLevel(1.01)).toBe(1);
    expect(requiredLevel(4)).toBe(2);
    expect(requiredLevel(0.3)).toBe(-1);
    expect(requiredLevel(0)).toBe(0);
  });

  it("closes contours and drops zero-length edges", () => {
    const p = flattenPath(new Path().moveTo(0, 0).lineTo(10, 0).lineTo(10, 0).lineTo(10, 10).close().moveTo(50, 50));
    expect(Array.from(polylinesToSegments(p))).toEqual([0, 0, 10, 0, 10, 0, 10, 10, 10, 10, 0, 0]);
  });
});

describe("paint encoding", () => {
  const stops = [
    { offset: 1, color: hexColor("#00ff00") },
    { offset: 0, color: hexColor("#ff0000") },
  ];

  it("premultiplies solid colors", () => {
    const p = encodePaint({ type: "solid", color: rgba(1, 0.5, 0, 0.5) });
    expect(p.kind).toBe(PaintKind.Solid);
    expect(p.color).toEqual([0.5, 0.25, 0, 0.5]);
  });

  it("maps linear gradients so start is t=0 and end is t=1", () => {
    const p = encodePaint({ type: "linear-gradient", start: { x: 10, y: 10 }, end: { x: 10, y: 50 }, stops });
    const m = p.matrix;
    const t = (x: number, y: number): number => m[0] * x + m[2] * y + m[4];
    expect(t(10, 10)).toBeCloseTo(0);
    expect(t(99, 50)).toBeCloseTo(1);
    expect(t(0, 30)).toBeCloseTo(0.5);
    expect(Array.from(p.stops.slice(0, 5))).toEqual([0, 1, 0, 0, 1]); // sorted by offset
  });

  it("maps radial gradients by distance over radius, including transforms", () => {
    const p = encodePaint({ type: "radial-gradient", center: { x: 0, y: 0 }, radius: 10, stops, transform: [2, 0, 0, 1, 0, 0] });
    const m = p.matrix;
    const at = (x: number, y: number): number => Math.hypot(m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]);
    expect(at(20, 0)).toBeCloseTo(1);
    expect(at(0, 10)).toBeCloseTo(1);
  });

  it("falls back to the last stop for degenerate gradients", () => {
    const p = encodePaint({ type: "radial-gradient", center: { x: 0, y: 0 }, radius: 0, stops });
    expect(p.kind).toBe(PaintKind.Solid);
    expect(p.color).toEqual([0, 1, 0, 1]);
  });

  it("interpolates stops unpremultiplied and pads beyond the ends", () => {
    const s = encodePaint({
      type: "linear-gradient", start: { x: 0, y: 0 }, end: { x: 1, y: 0 },
      stops: [{ offset: 0.2, color: rgba(1, 0, 0, 1) }, { offset: 0.8, color: rgba(0, 0, 1, 0) }],
    }).stops;
    expect(sampleStops(s, 0)).toEqual([1, 0, 0, 1]);
    expect(sampleStops(s, 1)).toEqual([0, 0, 0, 0]);
    const mid = sampleStops(s, 0.5);
    expect(mid[3]).toBeCloseTo(0.5);
    expect(mid[0]).toBeCloseTo(0.25);
    expect(mid[2]).toBeCloseTo(0.25);
  });
});
