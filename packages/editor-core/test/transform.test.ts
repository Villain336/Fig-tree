import { boxMatrix } from "@fig-tree/document";
import { describe, expect, it } from "vitest";
import { constrainChild, HANDLES, placementProps, resizeRect, rotateProps, scaleProps, snapAngle, type Captured } from "../src";
import { quad, transformPoint } from "../src/math";
import { resizeProps } from "../src/transform";

/** A captured top-level node (parent space = world) from stored props. */
function captured(x: number, y: number, width: number, height: number, rotation = 0, flipX = false, flipY = false): Captured {
  return {
    id: "n",
    world: boxMatrix({ x, y, width, height, rotation, flipX, flipY }),
    parentSpace: [1, 0, 0, 1, 0, 0],
    width,
    height,
    stored: { x, y, rotation, flipX, flipY },
    inFlow: false,
  };
}

const close = (a: number, b: number, eps = 1e-6): void => expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThan(eps);

describe("resizeRect", () => {
  const plain = { aspect: false, fromCenter: false };
  it("moves only the dragged edge or corner; the opposite one stays", () => {
    expect(resizeRect(100, 50, HANDLES.se!, { x: 130, y: 70 }, plain)).toEqual({ x: 0, y: 0, width: 130, height: 70 });
    expect(resizeRect(100, 50, HANDLES.nw!, { x: -10, y: 20 }, plain)).toEqual({ x: -10, y: 20, width: 110, height: 30 });
    expect(resizeRect(100, 50, HANDLES.e!, { x: 80, y: 999 }, plain)).toEqual({ x: 0, y: 0, width: 80, height: 50 });
    expect(resizeRect(100, 50, HANDLES.n!, { x: 999, y: -5 }, plain)).toEqual({ x: 0, y: -5, width: 100, height: 55 });
  });

  it("resizes symmetrically from the center with Alt", () => {
    expect(resizeRect(100, 50, HANDLES.e!, { x: 120, y: 0 }, { aspect: false, fromCenter: true })).toEqual({ x: -20, y: 0, width: 140, height: 50 });
    expect(resizeRect(100, 50, HANDLES.se!, { x: 110, y: 60 }, { aspect: false, fromCenter: true })).toEqual({ x: -10, y: -10, width: 120, height: 70 });
  });

  it("keeps the aspect ratio with Shift, following the larger relative change", () => {
    const r = resizeRect(100, 50, HANDLES.se!, { x: 200, y: 60 }, { aspect: true, fromCenter: false });
    expect(r).toEqual({ x: 0, y: 0, width: 200, height: 100 });
    // An edge drag scales the other axis about its center.
    const e = resizeRect(100, 50, HANDLES.e!, { x: 200, y: 0 }, { aspect: true, fromCenter: false });
    expect(e).toEqual({ x: 0, y: -25, width: 200, height: 100 });
    // The west corner keeps the east edge fixed.
    const w = resizeRect(100, 50, HANDLES.nw!, { x: -100, y: 0 }, { aspect: true, fromCenter: false });
    expect(w).toEqual({ x: -100, y: -50, width: 200, height: 100 });
    // Aspect and center together.
    const c = resizeRect(100, 50, HANDLES.se!, { x: 150, y: 50 }, { aspect: true, fromCenter: true });
    expect(c).toEqual({ x: -50, y: -25, width: 200, height: 100 });
  });

  it("gives negative sizes when dragged past the anchor (a mirror)", () => {
    expect(resizeRect(100, 50, HANDLES.e!, { x: -30, y: 0 }, plain)).toEqual({ x: 0, y: 0, width: -30, height: 50 });
    const a = resizeRect(100, 50, HANDLES.e!, { x: -200, y: 0 }, { aspect: true, fromCenter: false });
    expect(a.width).toBe(-200);
    expect(a.height).toBe(100);
  });
});

describe("resizeProps", () => {
  it("keeps the opposite corner of a rotated box fixed in the parent", () => {
    const c = captured(100, 100, 80, 40, 30);
    const fixed = transformPoint(c.world, 0, 0);
    const props = resizeProps(c, resizeRect(80, 40, HANDLES.se!, { x: 120, y: 60 }, { aspect: false, fromCenter: false }));
    expect(props.width).toBe(120);
    expect(props.height).toBe(60);
    expect(props.rotation).toBeUndefined();
    const after = boxMatrix({ x: props.x!, y: props.y!, width: 120, height: 60, rotation: 30, flipX: false, flipY: false });
    const p = transformPoint(after, 0, 0);
    close(p.x, fixed.x);
    close(p.y, fixed.y);
  });

  it("keeps the center fixed when resizing from the center", () => {
    const c = captured(10, 20, 100, 50, -45);
    const center = transformPoint(c.world, 50, 25);
    const props = resizeProps(c, resizeRect(100, 50, HANDLES.se!, { x: 130, y: 70 }, { aspect: false, fromCenter: true }));
    const after = boxMatrix({ x: props.x!, y: props.y!, width: props.width!, height: props.height!, rotation: -45, flipX: false, flipY: false });
    const p = transformPoint(after, props.width! / 2, props.height! / 2);
    close(p.x, center.x);
    close(p.y, center.y);
  });

  it("flips the box when dragged past its anchor, mirroring it in place", () => {
    const c = captured(0, 0, 100, 50);
    const props = resizeProps(c, resizeRect(100, 50, HANDLES.e!, { x: -40, y: 25 }, { aspect: false, fromCenter: false }));
    expect(props.flipX).toBe(true);
    expect(props.width).toBe(40);
    expect(props.x).toBe(-40);
    expect(props.y).toBeUndefined();
    // The mirrored box covers x ∈ [-40, 0] and its local x axis points left.
    const m = boxMatrix({ x: -40, y: 0, width: 40, height: 50, rotation: 0, flipX: true, flipY: false });
    expect(transformPoint(m, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(quad(m, 40, 50).map((p) => p.x).sort((a, b) => a - b)).toEqual([-40, -40, 0, 0]);
  });

  it("writes deltas of the stored position (constraints and hug parents keep their meaning)", () => {
    // A node whose stored x differs from its laid-out x (e.g. right-constrained in a hug frame).
    const c: Captured = { ...captured(50, 0, 10, 10), stored: { x: 7, y: 3, rotation: 0, flipX: false, flipY: false } };
    const props = resizeProps(c, resizeRect(10, 10, HANDLES.w!, { x: -5, y: 0 }, { aspect: false, fromCenter: false }));
    expect(props.x).toBe(2);
    expect(props.width).toBe(15);
  });
});

describe("rotate and scale", () => {
  it("rotates a node about a pivot, keeping its size", () => {
    const c = captured(0, 0, 100, 20);
    const props = rotateProps(c, 90, { x: 50, y: 10 });
    expect(props.rotation).toBe(90);
    expect(props.x).toBeUndefined();
    // About an outside pivot the box center orbits it.
    const p2 = rotateProps(c, 90, { x: 0, y: 0 });
    const m = boxMatrix({ x: p2.x!, y: p2.y!, width: 100, height: 20, rotation: 90, flipX: false, flipY: false });
    const center = transformPoint(m, 50, 10);
    close(center.x, -10);
    close(center.y, 50);
  });

  it("snaps angles", () => {
    expect(snapAngle(22)).toBe(15);
    expect(snapAngle(23)).toBe(30);
    expect(snapAngle(-44, 45)).toBe(-45);
  });

  it("scales several boxes as one", () => {
    const a = captured(0, 0, 50, 50);
    const b = captured(100, 0, 50, 50);
    const from = { x: 0, y: 0, width: 150, height: 50 };
    const to = { x: 0, y: 0, width: 300, height: 100 };
    expect(scaleProps(a, from, to)).toEqual({ width: 100, height: 100 });
    expect(scaleProps(b, from, to)).toEqual({ x: 200, width: 100, height: 100 });
  });

  it("re-expresses a placement with a reflection as a flip", () => {
    const c = captured(0, 0, 10, 10);
    const props = placementProps(c, [-1, 0, 0, 1, 10, 0], 10, 10);
    expect(props.flipX).toBe(true);
    expect(props.x).toBeUndefined();
  });
});

describe("constraints", () => {
  const child = { x: 10, y: 20, width: 30, height: 40 };
  const before = { width: 100, height: 100 };
  const after = { width: 200, height: 150 };
  it("follows each constraint kind when the parent grows", () => {
    expect(constrainChild(child, { horizontal: "start", vertical: "start" }, before, after)).toEqual(child);
    expect(constrainChild(child, { horizontal: "end", vertical: "end" }, before, after)).toEqual({ x: 110, y: 70, width: 30, height: 40 });
    expect(constrainChild(child, { horizontal: "start-end", vertical: "start-end" }, before, after)).toEqual({ x: 10, y: 20, width: 130, height: 90 });
    expect(constrainChild(child, { horizontal: "center", vertical: "center" }, before, after)).toEqual({ x: 60, y: 45, width: 30, height: 40 });
    expect(constrainChild(child, { horizontal: "scale", vertical: "scale" }, before, after)).toEqual({ x: 20, y: 30, width: 60, height: 60 });
  });
});
