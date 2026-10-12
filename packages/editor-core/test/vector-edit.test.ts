import type { Command, FigDocument } from "@fig-tree/document";
import { networkFaces, segmentCubic, validateNetwork, type VectorNetwork } from "@fig-tree/geometry";
import { describe, expect, it } from "vitest";
import { buildOverlay, vectorSession, type Editor, type VectorEditSession } from "../src";
import { click, doubleClick, drag, key, rect, setup } from "./helpers";

const GRAY = { type: "solid" as const, color: { r: 0.5, g: 0.5, b: 0.5, a: 1 } };
const INK = { type: "solid" as const, color: { r: 0, g: 0, b: 0, a: 1 } };
const net = (doc: FigDocument, id: string): VectorNetwork => doc.get<VectorNetwork>(id, "vectorNetwork");
const round = (v: number): number => Math.round(v * 1000) / 1000;

/** A 200×200 square vector at (100, 100) with an inner square (a hole), the outer ring filled even-odd. */
function squareWithHole(page: string): Command[] {
  return [
    {
      type: "createNode",
      node: {
        id: "v",
        type: "vector",
        props: {
          x: 100,
          y: 100,
          width: 200,
          height: 200,
          fills: [GRAY],
          strokes: [INK],
          vectorNetwork: {
            vertices: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }, { x: 0, y: 200 }, { x: 50, y: 50 }, { x: 150, y: 50 }, { x: 150, y: 150 }, { x: 50, y: 150 }],
            segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 0 }, { start: 4, end: 5 }, { start: 5, end: 6 }, { start: 6, end: 7 }, { start: 7, end: 4 }],
            regions: [],
          },
        },
      },
      parent: page,
    },
  ];
}

/** An open path with a smooth middle point: (0,0) → (100,0) smooth → (200,0), at (100, 300). */
function smoothPath(page: string): Command[] {
  return [
    {
      type: "createNode",
      node: {
        id: "p",
        type: "vector",
        props: {
          x: 100,
          y: 260,
          width: 200,
          height: 80,
          strokes: [INK],
          vectorNetwork: {
            vertices: [{ x: 0, y: 40 }, { x: 100, y: 40, handleMirroring: "angle-length" }, { x: 200, y: 40 }],
            segments: [
              { start: 0, end: 1, tangentEnd: { x: -30, y: -40 } },
              { start: 1, end: 2, tangentStart: { x: 30, y: 40 } },
            ],
            regions: [],
          },
        },
      },
      parent: page,
    },
  ];
}

function worldVertices(editor: Editor, id: string): { x: number; y: number }[] {
  const m = editor.geometry.worldMatrix(id);
  return net(editor.doc, id).vertices.map((v) => ({ x: round(m[0] * v.x + m[2] * v.y + m[4]), y: round(m[1] * v.x + m[3] * v.y + m[5]) }));
}

function enter(editor: Editor, id: string): VectorEditSession {
  editor.select([id]);
  key(editor, "Enter");
  const s = vectorSession(editor);
  if (!s) throw new Error("not in vector edit mode");
  return s;
}

const depth = (e: Editor): number => e.history.undoDepth;

function expectVec(got: { x: number; y: number } | undefined, want: { x: number; y: number }): void {
  expect(got).toBeDefined();
  expect(got!.x).toBeCloseTo(want.x, 9);
  expect(got!.y).toBeCloseTo(want.y, 9);
}

describe("vector edit mode", () => {
  it("is entered with Enter or a double-click, and left with Escape or Enter", () => {
    const s = setup(squareWithHole);
    // Without fills, the vector is picked by its strokes.
    click(s.editor, 100, 150);
    expect(s.editor.selection).toEqual(["v"]);
    doubleClick(s.editor, 100, 150);
    expect(vectorSession(s.editor)?.nodeId).toBe("v");
    key(s.editor, "Escape");
    expect(s.editor.session).toBeNull();
    expect(s.editor.selection).toEqual(["v"]);
    enter(s.editor, "v");
    key(s.editor, "Enter");
    expect(s.editor.session).toBeNull();
    // The overlay draws every segment, and every vertex as a handle.
    enter(s.editor, "v");
    const o = buildOverlay(s.editor);
    expect(o.filter((x) => x.kind === "handle" && x.id.startsWith("canvas.vector.vertex.")).length).toBe(8);
    expect(o.some((x) => x.kind === "path" && x.role === "vector")).toBe(true);
  });

  it("selects vertices and segments with clicks, Shift and a marquee", () => {
    const s = setup(squareWithHole);
    const v = enter(s.editor, "v");
    click(s.editor, 100, 100);
    expect(v.selectedVertices).toEqual([0]);
    click(s.editor, 300, 100, { shift: true });
    expect(v.selectedVertices).toEqual([0, 1]);
    click(s.editor, 300, 100, { shift: true });
    expect(v.selectedVertices).toEqual([0]);
    // A segment: the top edge of the inner square.
    click(s.editor, 200, 150);
    expect(v.selectedSegments).toEqual([4]);
    expect(v.selectedVertices).toEqual([]);
    // Empty space inside the ring clears; a marquee around the inner square selects its points and segments.
    click(s.editor, 120, 200);
    expect(v.selectedSegments).toEqual([]);
    drag(s.editor, [130, 130], [270, 270]);
    expect(v.selectedVertices).toEqual([4, 5, 6, 7]);
    expect(v.selectedSegments).toEqual([4, 5, 6, 7]);
    // Cmd/Ctrl+A selects every point.
    key(s.editor, "a", { mod: true });
    expect(v.selectedVertices).toHaveLength(8);
  });

  it("moves points with snapping, as one undo step, and nudges them with the arrows", () => {
    const s = setup(squareWithHole);
    const v = enter(s.editor, "v");
    const before = depth(s.editor);
    // Drag the inner square's top-left corner (150, 150) near the outer top edge's y (100): snaps there.
    click(s.editor, 150, 150);
    drag(s.editor, [150, 150], [163, 104]);
    expect(worldVertices(s.editor, "v")[4]).toEqual({ x: 163, y: 100 });
    expect(depth(s.editor)).toBe(before + 1);
    // Cmd/Ctrl moves without snapping (pixel snapping still rounds).
    drag(s.editor, [163, 100], [170, 104], { mod: false });
    // Arrow keys nudge (Shift ×10).
    v.selectPoints([4]);
    const at = worldVertices(s.editor, "v")[4]!;
    key(s.editor, "ArrowRight", { shift: true });
    key(s.editor, "ArrowDown");
    expect(worldVertices(s.editor, "v")[4]).toEqual({ x: at.x + 10, y: at.y + 1 });
    // Moving every point moves the vector: its box follows, its network stays at the origin.
    key(s.editor, "a", { mod: true });
    key(s.editor, "ArrowLeft", { shift: true });
    expect(s.doc.get("v", "x")).toBe(90);
    expect(Math.min(...net(s.doc, "v").vertices.map((p) => p.x))).toBe(0);
    s.editor.run("edit.undo");
    expect(s.doc.get("v", "x")).toBe(100);
  });

  it("moves an outer corner past the box: the box follows and nothing else moves on the canvas", () => {
    const s = setup(squareWithHole);
    enter(s.editor, "v");
    s.editor.updateSettings({ snapping: false });
    const before = worldVertices(s.editor, "v");
    click(s.editor, 100, 100);
    drag(s.editor, [100, 100], [60, 70]);
    const after = worldVertices(s.editor, "v");
    expect(after[0]).toEqual({ x: 60, y: 70 });
    for (let i = 1; i < 8; i++) expect(after[i]).toEqual(before[i]);
    expect([s.doc.get("v", "x"), s.doc.get("v", "y"), s.doc.get("v", "width"), s.doc.get("v", "height")]).toEqual([60, 70, 240, 230]);
  });

  it("drags handles with the vertex's mirroring, alone with Alt, and the mode set in the panel", () => {
    const s = setup(smoothPath);
    const v = enter(s.editor, "p");
    click(s.editor, 200, 300);
    expect(v.selectedVertices).toEqual([1]);
    expect(v.mirroring).toBe("angle-length");
    // Handles show for the selected point.
    const handles = buildOverlay(s.editor).filter((o) => o.kind === "handle" && o.id.startsWith("canvas.vector.handle."));
    expect(handles.map((h) => (h as { id: string }).id).sort()).toEqual(["canvas.vector.handle.0.end", "canvas.vector.handle.1.start"]);
    // The outgoing handle is at (230, 340); drag it to (260, 300): the incoming one mirrors (angle and length).
    const d0 = depth(s.editor);
    drag(s.editor, [230, 340], [260, 300]);
    let n = net(s.doc, "p");
    expectVec(n.segments[1]!.tangentStart, { x: 60, y: 0 });
    expectVec(n.segments[0]!.tangentEnd, { x: -60, y: 0 });
    expect(depth(s.editor)).toBe(d0 + 1);
    // Alt: only the dragged handle moves.
    drag(s.editor, [260, 300], [260, 330], { alt: true });
    n = net(s.doc, "p");
    expectVec(n.segments[1]!.tangentStart, { x: 60, y: 30 });
    expectVec(n.segments[0]!.tangentEnd, { x: -60, y: 0 });
    // Angle mirroring (panel): the opposite handle turns to stay collinear, keeping its length.
    v.setMirroring("angle");
    expect(net(s.doc, "p").vertices[1]!.handleMirroring).toBe("angle");
    const t = net(s.doc, "p").segments[1]!.tangentStart!;
    const h = { x: 200 + t.x, y: 300 + t.y };
    drag(s.editor, [round(h.x), round(h.y)], [200, 380]);
    n = net(s.doc, "p");
    const lead = n.segments[1]!.tangentStart!;
    const other = n.segments[0]!.tangentEnd!;
    expect(Math.abs(lead.x * other.y - lead.y * other.x)).toBeLessThan(1e-6);
    expect(lead.x * other.x + lead.y * other.y).toBeLessThan(0);
    expect(Math.hypot(other.x, other.y)).toBeCloseTo(Math.hypot(60, 0), 0);
    // None: independent.
    v.setMirroring("none");
    expect(v.mirroring).toBe("none");
    // Shift snaps a handle's angle to 15°.
    const ts = net(s.doc, "p").segments[1]!.tangentStart!;
    drag(s.editor, [round(200 + ts.x), round(300 + ts.y)], [260, 304], { shift: true });
    expect(net(s.doc, "p").segments[1]!.tangentStart!.y).toBeCloseTo(0, 9);
  });

  it("bends segments with Cmd/Ctrl-drag and the bend tool, pulls handles from corners, toggles smooth and sharp", () => {
    const s = setup(squareWithHole);
    const v = enter(s.editor, "v");
    const d0 = depth(s.editor);
    // Cmd/Ctrl-drag the middle of the top outer edge up by 40.
    drag(s.editor, [200, 100], [200, 60], { mod: true });
    let n = net(s.doc, "v");
    const c = segmentCubic(n, 0);
    const m = s.editor.geometry.worldMatrix("v");
    const mid = { x: (c.x0 + 3 * c.x1 + 3 * c.x2 + c.x3) / 8 + m[4], y: (c.y0 + 3 * c.y1 + 3 * c.y2 + c.y3) / 8 + m[5] };
    expect(round(mid.x)).toBe(200);
    expect(round(mid.y)).toBe(60);
    expect(depth(s.editor)).toBe(d0 + 1);
    // The bend tool does the same without the modifier.
    v.setSubTool("bend");
    drag(s.editor, [300, 200], [330, 200]);
    n = net(s.doc, "v");
    expect(n.segments[1]!.tangentStart).toBeDefined();
    v.setSubTool("select");
    // Cmd/Ctrl-drag from a sharp corner pulls out mirrored handles.
    drag(s.editor, [150, 250], [190, 250], { mod: true });
    n = net(s.doc, "v");
    expect(n.vertices[7]!.handleMirroring).toBe("angle-length");
    const h1 = n.segments[7]!.tangentStart!, h2 = n.segments[6]!.tangentEnd!;
    expect(h1.x).toBeCloseTo(-h2.x, 9);
    expect(Math.abs(h1.x)).toBeCloseTo(40, 6);
    // Cmd/Ctrl-click toggles it back to sharp.
    click(s.editor, 150, 250, { mod: true });
    n = net(s.doc, "v");
    expect(n.segments[7]!.tangentStart).toBeUndefined();
    expect(n.segments[6]!.tangentEnd).toBeUndefined();
    // ...and to smooth again.
    click(s.editor, 150, 250, { mod: true });
    expect(net(s.doc, "v").vertices[7]!.handleMirroring).toBe("angle");
  });

  it("adds a vertex on a segment with a double-click, and with the pen", () => {
    const s = setup(squareWithHole);
    const v = enter(s.editor, "v");
    doubleClick(s.editor, 200, 300);
    let n = net(s.doc, "v");
    expect(n.vertices).toHaveLength(9);
    expect(v.selectedVertices).toEqual([8]);
    expect(worldVertices(s.editor, "v")[8]).toEqual({ x: 200, y: 300 });
    // The pen adds points to the same network.
    key(s.editor, "p");
    expect(v.subTool).toBe("pen");
    click(s.editor, 100, 200);
    key(s.editor, "Escape");
    n = net(s.doc, "v");
    expect(n.vertices).toHaveLength(10);
    expect(validateNetwork(n)).toEqual([]);
    // Still in the mode after ending the pen path; V returns to selecting.
    expect(vectorSession(s.editor)).toBe(v);
    key(s.editor, "v");
    expect(v.subTool).toBe("select");
  });

  it("deletes a vertex keeping the shape, or leaving a gap", () => {
    const s = setup(smoothPath);
    const v = enter(s.editor, "p");
    click(s.editor, 200, 300);
    const d0 = depth(s.editor);
    key(s.editor, "Delete");
    let n = net(s.doc, "p");
    expect(n.vertices).toHaveLength(2);
    expect(n.segments).toHaveLength(1);
    // The joined curve still passes near where the deleted point was (the shape is kept).
    expect(n.segments[0]!.tangentStart).toBeDefined();
    expect(depth(s.editor)).toBe(d0 + 1);
    s.editor.run("edit.undo");
    expect(net(s.doc, "p").vertices).toHaveLength(3);
    // Shift+Delete removes the point and its segments: a gap.
    v.selectPoints([1]);
    key(s.editor, "Delete", { shift: true });
    n = net(s.doc, "p");
    expect(n.vertices).toHaveLength(2);
    expect(n.segments).toHaveLength(0);
  });

  it("fills and unfills areas with the paint bucket, holes included", () => {
    const s = setup(squareWithHole);
    const v = enter(s.editor, "v");
    key(s.editor, "b");
    expect(v.subTool).toBe("bucket");
    // Hovering the ring shows the face it would fill (with its hole).
    s.editor.pointerMove({ x: 120, y: 200 });
    const region = buildOverlay(s.editor).find((o) => o.kind === "region");
    expect(region && region.kind === "region" ? region.contours.length : 0).toBe(2);
    click(s.editor, 120, 200);
    let n = net(s.doc, "v");
    expect(n.regions).toHaveLength(1);
    expect(n.regions[0]!.loops).toHaveLength(2);
    // The inner square is its own face.
    click(s.editor, 200, 200);
    n = net(s.doc, "v");
    expect(n.regions).toHaveLength(2);
    // Clicking a filled face unfills it.
    click(s.editor, 120, 200);
    expect(net(s.doc, "v").regions).toHaveLength(1);
    expect(networkFaces(net(s.doc, "v"))).toHaveLength(2);
    expect(s.editor.history.undoDepth).toBe(3);
  });

  it("sets per-vertex corner radius, joins and disconnects, flips points", () => {
    const s = setup(squareWithHole);
    const v = enter(s.editor, "v");
    v.selectPoints([0, 1]);
    expect(v.cornerRadius).toBe(0);
    v.setCornerRadius(() => 24);
    expect(net(s.doc, "v").vertices.slice(0, 2).map((p) => p.cornerRadius)).toEqual([24, 24]);
    expect(v.cornerRadius).toBe(24);
    // Disconnect vertex 0: its two segments get separate ends.
    v.selectPoints([0]);
    key(s.editor, "j", { mod: true, shift: true });
    let n = net(s.doc, "v");
    expect(n.vertices).toHaveLength(9);
    // Join them back: they coincide, so they merge into one point.
    v.selectPoints([0, 8]);
    key(s.editor, "j", { mod: true });
    n = net(s.doc, "v");
    expect(n.vertices).toHaveLength(8);
    expect(validateNetwork(n)).toEqual([]);
    // Joining two distant points adds a segment.
    v.selectPoints([4, 6]);
    key(s.editor, "j", { mod: true });
    expect(net(s.doc, "v").segments).toHaveLength(9);
    // Flip the inner square's points horizontally about their center.
    v.selectPoints([4, 5, 6, 7]);
    const before = worldVertices(s.editor, "v");
    key(s.editor, "h", { shift: true });
    const after = worldVertices(s.editor, "v");
    expect(after[4]).toEqual({ x: before[5]!.x, y: before[4]!.y });
    expect(after[5]).toEqual({ x: before[4]!.x, y: before[5]!.y });
  });

  it("shows and edits the selected points' position in the panel API", () => {
    const s = setup(squareWithHole);
    const v = enter(s.editor, "v");
    v.selectPoints([4, 5]);
    expect(v.pointPosition()).toEqual({ x: 150, y: 150 });
    v.setPointPosition("x", 170);
    expect(worldVertices(s.editor, "v").slice(4, 6)).toEqual([{ x: 170, y: 150 }, { x: 270, y: 150 }]);
  });

  it("converts a shape to a vector on its first edit, in the same undo step", () => {
    const s = setup((page) => [rect("r", page, 100, 100, 200, 100, { cornerRadius: 0 })]);
    const v = enter(s.editor, "r");
    expect(v.convertsOnEdit).toBe(true);
    // The overlay explains what will happen.
    expect(buildOverlay(s.editor).some((o) => o.kind === "label" && /turns this rectangle into a vector/.test(o.text))).toBe(true);
    // Four corner points, as the rectangle is drawn.
    expect(buildOverlay(s.editor).filter((o) => o.kind === "handle" && o.id.startsWith("canvas.vector.vertex")).length).toBe(4);
    const d0 = depth(s.editor);
    click(s.editor, 300, 200);
    drag(s.editor, [300, 200], [340, 240]);
    const id = v.nodeId;
    expect(id).not.toBe("r");
    expect(s.doc.has("r")).toBe(false);
    expect(s.doc.typeOf(id)).toBe("vector");
    expect(s.editor.selection).toEqual([id]);
    expect(vectorSession(s.editor)).toBe(v);
    expect(depth(s.editor)).toBe(d0 + 1);
    expect(worldVertices(s.editor, id)).toContainEqual({ x: 340, y: 240 });
    // Undo restores the rectangle (and leaves the mode: the vector is gone).
    s.editor.run("edit.undo");
    expect(s.doc.typeOf("r")).toBe("rectangle");
    expect(s.editor.session).toBeNull();
  });

  it("leaves the mode when another layer is clicked", () => {
    const s = setup((page) => [...squareWithHole(page), rect("r", page, 500, 100, 50, 50)]);
    enter(s.editor, "v");
    click(s.editor, 520, 120);
    expect(s.editor.session).toBeNull();
    expect(s.editor.selection).toEqual(["r"]);
  });

  it("registers its canvas controls as anchors", () => {
    const s = setup(smoothPath);
    const v = enter(s.editor, "p");
    v.selectPoints([1]);
    buildOverlay(s.editor);
    const ids = s.editor.anchors.list("canvas.vector").map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining(["canvas.vector.vertex.0", "canvas.vector.vertex.2", "canvas.vector.segment.1", "canvas.vector.handle.1.start", "canvas.vector.handle.0.end"]));
    expect(s.editor.anchors.rect("canvas.vector.vertex.2")).toEqual({ x: 295, y: 295, width: 10, height: 10 });
    key(s.editor, "Escape");
    expect(s.editor.anchors.list("canvas.vector")).toEqual([]);
  });
});

describe("resizing vectors", () => {
  it("scales the network with the box", () => {
    const s = setup(squareWithHole);
    s.editor.select(["v"]);
    s.editor.updateSettings({ snapping: false });
    // The bottom-right resize handle at (300, 300): drag to (400, 350).
    drag(s.editor, [300, 300], [400, 350]);
    expect([s.doc.get("v", "width"), s.doc.get("v", "height")]).toEqual([300, 250]);
    expect(worldVertices(s.editor, "v")[2]).toEqual({ x: 400, y: 350 });
    expect(worldVertices(s.editor, "v")[4]).toEqual({ x: 175, y: 162.5 });
  });
});
