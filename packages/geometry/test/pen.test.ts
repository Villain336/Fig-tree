import { describe, expect, it } from "vitest";
import { PenTool, constrainAngle, networkFaces, pointAt, segmentCubic, validateNetwork, type VectorNetwork } from "../src";

const empty: VectorNetwork = { vertices: [], segments: [], regions: [] };

function click(pen: PenTool<VectorNetwork>, x: number, y: number, mods = {}) {
  pen.pointerDown({ x, y }, mods);
  return pen.pointerUp({ x, y }, mods);
}

function drag(pen: PenTool<VectorNetwork>, x: number, y: number, dx: number, dy: number, mods: { shift?: boolean; alt?: boolean } = {}, altAt?: number) {
  pen.pointerDown({ x, y });
  const steps = 5;
  for (let i = 1; i <= steps; i++) pen.pointerMove({ x: x + (dx * i) / steps, y: y + (dy * i) / steps }, { ...mods, alt: altAt !== undefined && i >= altAt ? true : mods.alt === true });
  return pen.pointerUp({ x: x + dx, y: y + dy }, mods);
}

describe("pen tool", () => {
  it("clicks add corner points joined by straight segments", () => {
    const pen = new PenTool(empty, { hitRadius: 4 });
    click(pen, 0, 0);
    click(pen, 100, 0);
    const r = click(pen, 100, 100);
    expect(r.network.vertices).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]);
    expect(r.network.segments).toEqual([{ start: 0, end: 1 }, { start: 1, end: 2 }]);
    expect(pen.activeVertex).toBe(2);
    expect(validateNetwork(r.network)).toEqual([]);
  });

  it("dragging pulls out mirrored smooth handles", () => {
    const pen = new PenTool(empty, { hitRadius: 4 });
    click(pen, 0, 0);
    drag(pen, 100, 0, 0, 40);
    // The segment into the dragged vertex ends with the mirrored handle.
    expect(pen.network.segments[0]!.tangentEnd).toEqual({ x: -0, y: -40 });
    expect(pen.network.vertices[1]!.handleMirroring).toBe("angle-length");
    click(pen, 200, 0);
    // The next segment starts with the drag as its handle.
    expect(pen.network.segments[1]!.tangentStart).toEqual({ x: 0, y: 40 });
    // A smooth vertex: handles opposite and equal.
    const a = segmentCubic(pen.network, 0), b = segmentCubic(pen.network, 1);
    expect(a.x3 - a.x2).toBeCloseTo(b.x1 - b.x0, 12);
    expect(a.y3 - a.y2).toBeCloseTo(b.y1 - b.y0, 12);
  });

  it("Alt breaks the handles while dragging", () => {
    const pen = new PenTool(empty, { hitRadius: 4 });
    click(pen, 0, 0);
    drag(pen, 100, 0, 30, 30, {}, 3);
    // The incoming handle froze when Alt was pressed (after the second step: 12, 12 mirrored); the outgoing kept following.
    const incoming = pen.network.segments[0]!.tangentEnd!;
    expect(incoming.x).toBeCloseTo(-12, 9);
    expect(incoming.y).toBeCloseTo(-12, 9);
    expect(pen.network.vertices[1]!.handleMirroring).toBeUndefined();
    click(pen, 200, 0);
    expect(pen.network.segments[1]!.tangentStart).toEqual({ x: 30, y: 30 });
  });

  it("clicking the first point closes the path and fills it", () => {
    const pen = new PenTool(empty, { hitRadius: 4 });
    click(pen, 0, 0);
    click(pen, 100, 0);
    click(pen, 100, 100);
    pen.pointerMove({ x: 1, y: 1 });
    expect(pen.preview().closes).toBe(true);
    const r = click(pen, 1, 1);
    expect(r.ended).toBe(true);
    expect(pen.activeVertex).toBeNull();
    expect(r.network.segments).toHaveLength(3);
    expect(r.network.regions).toHaveLength(1);
    expect(validateNetwork(r.network)).toEqual([]);
  });

  it("branches: clicking an existing vertex or segment connects to it (networks, not just paths)", () => {
    const pen = new PenTool(empty, { hitRadius: 4 });
    click(pen, 0, 0);
    click(pen, 100, 0);
    pen.keyDown("Escape");
    // Start a new path from the middle of the first segment.
    click(pen, 50, 1);
    expect(pen.network.vertices).toHaveLength(3);
    expect(pen.network.segments).toHaveLength(2);
    // ...go down, then connect back to vertex 0: a network with junctions.
    click(pen, 50, 80);
    const r = click(pen, 0, 0);
    expect(r.ended).toBe(true);
    const degree = new Map<number, number>();
    for (const s of r.network.segments) for (const v of [s.start, s.end]) degree.set(v, (degree.get(v) ?? 0) + 1);
    expect(degree.get(2)).toBe(3);
    expect(validateNetwork(r.network)).toEqual([]);
    // The two faces of the network: the triangle 0–2–3 is enclosed.
    expect(networkFaces(r.network).length).toBe(1);
  });

  it("Shift constrains segments to 15° steps", () => {
    const pen = new PenTool(empty, { hitRadius: 4 });
    click(pen, 0, 0);
    click(pen, 100, 7, { shift: true });
    expect(pen.network.vertices[1]!.y).toBe(0);
    click(pen, 160, 63, { shift: true });
    const v = pen.network.vertices[2]!;
    const angle = (Math.atan2(v.y - 0, v.x - 100) * 180) / Math.PI;
    expect(Math.abs(angle - 45)).toBeLessThan(1e-9);
    expect(constrainAngle({ x: 10, y: 1 }, 15)).toEqual({ x: 10, y: 0 });
  });

  it("calls the snapping hook for new points", () => {
    const pen = new PenTool(empty, { hitRadius: 4, snap: (p) => ({ x: Math.round(p.x / 10) * 10, y: Math.round(p.y / 10) * 10 }) });
    click(pen, 3, 4);
    click(pen, 47, 52);
    expect(pen.network.vertices).toEqual([{ x: 0, y: 0 }, { x: 50, y: 50 }]);
  });

  it("Backspace removes the last vertex, Escape and Enter end the path", () => {
    const pen = new PenTool(empty, { hitRadius: 4 });
    click(pen, 0, 0);
    click(pen, 100, 0);
    click(pen, 100, 100);
    pen.keyDown("Backspace");
    expect(pen.network.vertices).toHaveLength(2);
    expect(pen.activeVertex).toBe(1);
    const r = pen.keyDown("Enter");
    expect(r.ended).toBe(true);
    expect(pen.activeVertex).toBeNull();
    // The next click starts a separate path.
    click(pen, 300, 300);
    expect(pen.network.segments).toHaveLength(1);
  });

  it("previews the next segment from the active vertex, curved by the pending handle", () => {
    const pen = new PenTool(empty, { hitRadius: 4 });
    click(pen, 0, 0);
    drag(pen, 100, 0, 50, 0);
    pen.pointerMove({ x: 200, y: 100 });
    const p = pen.preview();
    expect(p.segment).not.toBeNull();
    expect(p.segment!.x0).toBe(100);
    expect(p.segment!.x1).toBe(150);
    expect(p.segment!.x3).toBe(200);
    expect(pointAt(p.segment!, 1)).toEqual({ x: 200, y: 100 });
  });

  it("dragging the last vertex reshapes its outgoing handle", () => {
    const pen = new PenTool(empty, { hitRadius: 4 });
    click(pen, 0, 0);
    click(pen, 100, 0);
    drag(pen, 100, 0, 0, -30);
    click(pen, 200, 0);
    expect(pen.network.segments).toHaveLength(2);
    expect(pen.network.segments[1]!.tangentStart).toEqual({ x: 0, y: -30 });
    // The incoming segment was not changed.
    expect(pen.network.segments[0]!.tangentEnd).toBeUndefined();
  });
});
