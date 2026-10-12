import { describe, expect, it } from "vitest";
import { snapBox, snapValue, type SnapTarget } from "../src";

const sib = (x: number, y: number, width: number, height: number): SnapTarget => ({ box: { x, y, width, height }, kind: "sibling" });

describe("snapping", () => {
  it("snaps edges and centers to the nearest target line within the threshold", () => {
    const targets = [sib(100, 0, 50, 50)];
    // Left edge 3 px from the target's right edge.
    let r = snapBox({ x: 153, y: 200, width: 20, height: 20 }, targets, { threshold: 5 });
    expect(r.dx).toBe(-3);
    expect(r.dy).toBe(0);
    expect(r.guides).toEqual([{ axis: "x", at: 150, from: 0, to: 220 }]);
    // Centers: a 20-wide box centered 2 px off the target's center.
    r = snapBox({ x: 117, y: 200, width: 20, height: 20 }, targets, { threshold: 5 });
    expect(r.dx).toBe(-2);
    // Out of reach: nothing.
    r = snapBox({ x: 160, y: 200, width: 20, height: 20 }, targets, { threshold: 5 });
    expect(r.dx).toBe(0);
    expect(r.guides).toEqual([]);
  });

  it("picks the smallest correction and reports every coinciding line", () => {
    const targets = [sib(0, 0, 10, 10), sib(0, 100, 30, 10)];
    const r = snapBox({ x: 1, y: 50, width: 20, height: 10 }, targets, { threshold: 5 });
    expect(r.dx).toBe(-1);
    // The left edge at 0 lines up with both targets (one guide spanning all three boxes),
    // and the center (10) with the first target's right edge.
    expect(r.guides.filter((g) => g.axis === "x")).toEqual([
      { axis: "x", at: 0, from: 0, to: 110 },
      { axis: "x", at: 10, from: 0, to: 60 },
    ]);
  });

  it("snaps to equal spacing between siblings in a row", () => {
    // Two boxes 20 apart; a third placed after them snaps to the same gap.
    const targets = [sib(0, 0, 40, 40), sib(60, 0, 40, 40)];
    const r = snapBox({ x: 123, y: 0, width: 40, height: 40 }, targets, { threshold: 5, edges: { x: ["start", "center", "end"], y: [] } });
    expect(r.dx).toBe(-3);
    expect(r.spacing).toEqual([
      { axis: "x", start: 40, end: 60, cross: 20 },
      { axis: "x", start: 100, end: 120, cross: 20 },
    ]);
  });

  it("centers a box between two neighbors", () => {
    const targets = [sib(0, 0, 40, 40), sib(140, 0, 40, 40)];
    // 40-wide box between 40 and 140: equal gaps of 30 at x = 70.
    const r = snapBox({ x: 73, y: 0, width: 40, height: 40 }, targets, { threshold: 5, edges: { x: ["start", "center", "end"], y: [] } });
    expect(r.dx).toBe(-3);
    expect(r.spacing.map((s) => s.end - s.start)).toEqual([30, 30]);
  });

  it("places a box before a pair with their gap, vertically too", () => {
    const targets = [sib(0, 100, 40, 40), sib(0, 160, 40, 40)];
    const r = snapBox({ x: 0, y: 38, width: 40, height: 40 }, targets, { threshold: 5, edges: { x: [], y: ["start", "center", "end"] } });
    expect(r.dy).toBe(2);
    expect(r.spacing[0]).toEqual({ axis: "y", start: 80, end: 100, cross: 20 });
  });

  it("ignores siblings that are not in the same row", () => {
    const targets = [sib(0, 500, 40, 40), sib(60, 500, 40, 40)];
    const r = snapBox({ x: 123, y: 0, width: 40, height: 40 }, targets, { threshold: 5, edges: { x: ["start", "center", "end"], y: [] } });
    expect(r.spacing).toEqual([]);
  });

  it("snaps to the parent's edges, center and padding box", () => {
    const targets: SnapTarget[] = [
      { kind: "parent", box: { x: 0, y: 0, width: 200, height: 100 } },
      { kind: "padding", box: { x: 16, y: 16, width: 168, height: 68 } },
    ];
    expect(snapBox({ x: 18, y: 50, width: 10, height: 10 }, targets, { threshold: 5 }).dx).toBe(-2);
    expect(snapBox({ x: 96, y: 50, width: 10, height: 10 }, targets, { threshold: 5 }).dx).toBe(-1);
    // The padding box offers no center line.
    expect(snapValue(102, targets.slice(1), "x", 5)).toBe(102);
    expect(snapValue(182, targets.slice(1), "x", 5)).toBe(184);
  });
});
