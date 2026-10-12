import type { Command, FigDocument } from "@fig-tree/document";
import { networkFaces, segmentCubic, validateNetwork, type VectorNetwork } from "@fig-tree/geometry";
import { describe, expect, it } from "vitest";
import { buildOverlay, vectorSession, type Editor } from "../src";
import { click, drag, frame, key, rect, setup } from "./helpers";

/** The world (page) positions of a vector's vertices. */
function worldVertices(editor: Editor, id: string): { x: number; y: number }[] {
  const m = editor.geometry.worldMatrix(id);
  return net(editor.doc, id).vertices.map((v) => ({ x: round(m[0] * v.x + m[2] * v.y + m[4]), y: round(m[1] * v.x + m[3] * v.y + m[5]) }));
}

const round = (v: number): number => Math.round(v * 1000) / 1000;
const net = (doc: FigDocument, id: string): VectorNetwork => doc.get<VectorNetwork>(id, "vectorNetwork");

function undoSteps(editor: Editor): number {
  return editor.history.undoDepth;
}

/** Records the commands the user applied (to check they are editVector batches). */
function recordCommands(editor: Editor): Command[][] {
  const batches: Command[][] = [];
  const apply = editor.history.apply.bind(editor.history);
  editor.history.apply = (cmds, options) => {
    batches.push([...(cmds as Command[])]);
    return apply(cmds, options);
  };
  return batches;
}

describe("pen tool", () => {
  it("clicks corners into a new vector through editVector, one undo step per click, and closes on the first point", () => {
    const s = setup();
    s.editor.updateSettings({ snapping: false });
    const batches = recordCommands(s.editor);
    key(s.editor, "p");
    expect(s.editor.tool.id).toBe("pen");
    click(s.editor, 100, 100);
    const id = s.editor.selection[0]!;
    expect(s.doc.typeOf(id)).toBe("vector");
    expect(vectorSession(s.editor)?.nodeId).toBe(id);
    click(s.editor, 200, 100);
    click(s.editor, 200, 200);
    expect(undoSteps(s.editor)).toBe(3);
    // The box hugs the network; the points stay where they were clicked.
    expect(worldVertices(s.editor, id)).toEqual([{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 200 }]);
    expect(s.doc.get(id, "x")).toBe(100);
    expect(s.doc.get(id, "width")).toBe(100);
    expect(s.doc.get(id, "height")).toBe(100);
    // Close on the first point: a filled triangle, and the path ends.
    click(s.editor, 101, 101);
    const n = net(s.doc, id);
    expect(n.segments).toHaveLength(3);
    expect(n.regions).toHaveLength(1);
    expect(validateNetwork(n)).toEqual([]);
    expect(vectorSession(s.editor)!.penActive).toBe(false);
    expect(undoSteps(s.editor)).toBe(4);
    // Every edit after creation is an editVector command (plus the box update).
    const kinds = batches.slice(1).map((b) => b.map((c) => c.type));
    for (const k of kinds) expect(k[0]).toBe("editVector");
    // Escape leaves the mode and the pen tool, with the vector selected.
    key(s.editor, "Escape");
    expect(s.editor.session).toBeNull();
    expect(s.editor.tool.id).toBe("select");
    expect(s.editor.selection).toEqual([id]);
    // Undo takes the points back one click at a time.
    s.editor.run("edit.undo");
    expect(net(s.doc, id).segments).toHaveLength(2);
    s.editor.run("edit.undo");
    s.editor.run("edit.undo");
    s.editor.run("edit.undo");
    expect(s.doc.has(id)).toBe(false);
    for (let i = 0; i < 4; i++) s.editor.run("edit.redo");
    expect(net(s.doc, id).regions).toHaveLength(1);
  });

  it("drags smooth points with mirrored handles; Alt breaks them; Shift snaps to 15°", () => {
    const s = setup();
    s.editor.updateSettings({ snapping: false });
    key(s.editor, "p");
    click(s.editor, 100, 300);
    const id = s.editor.selection[0]!;
    // A smooth point: drag from (300, 300) down by 60.
    drag(s.editor, [300, 300], [300, 360]);
    let n = net(s.doc, id);
    expect(n.vertices[1]!.handleMirroring).toBe("angle-length");
    expect(n.segments[0]!.tangentEnd).toEqual({ x: -0, y: -60 });
    // The next segment starts with the outgoing handle (the drag).
    click(s.editor, 500, 300);
    n = net(s.doc, id);
    expect(n.segments[1]!.tangentStart).toEqual({ x: 0, y: 60 });
    // One undo step for the whole drag.
    expect(undoSteps(s.editor)).toBe(3);
    // Alt pressed during the drag freezes the incoming handle.
    s.editor.pointerDown({ x: 700, y: 300 });
    s.editor.pointerMove({ x: 720, y: 300 });
    s.editor.pointerMove({ x: 740, y: 300, alt: true });
    s.editor.pointerMove({ x: 760, y: 340, alt: true });
    s.editor.pointerUp({ x: 760, y: 340, alt: true });
    n = net(s.doc, id);
    expect(n.segments[2]!.tangentEnd).toEqual({ x: -20, y: -0 });
    expect(n.vertices[3]!.handleMirroring).toBeUndefined();
    // Shift constrains the next segment to 15° steps.
    click(s.editor, 860, 307, { shift: true });
    const w = worldVertices(s.editor, id);
    expect(w[4]).toEqual({ x: 860, y: 300 });
  });

  it("branches from existing vertices and segments, Backspace removes the last point, Enter finishes", () => {
    const s = setup();
    s.editor.updateSettings({ snapping: false });
    key(s.editor, "p");
    click(s.editor, 100, 100);
    const id = s.editor.selection[0]!;
    click(s.editor, 300, 100);
    click(s.editor, 300, 300);
    // Backspace takes the last point back, leaving no redo.
    key(s.editor, "Backspace");
    expect(net(s.doc, id).vertices).toHaveLength(2);
    expect(s.editor.history.canRedo()).toBe(false);
    expect(worldVertices(s.editor, id)).toEqual([{ x: 100, y: 100 }, { x: 300, y: 100 }]);
    click(s.editor, 300, 250);
    key(s.editor, "Enter");
    expect(vectorSession(s.editor)?.penActive).toBe(false);
    // A new path from the middle of the first segment: a branch (the vertex splits the segment).
    click(s.editor, 200, 101);
    click(s.editor, 200, 200);
    // ... connecting to an existing vertex ends the path.
    click(s.editor, 300, 250);
    const n = net(s.doc, id);
    expect(validateNetwork(n)).toEqual([]);
    const degree = new Map<number, number>();
    for (const sg of n.segments) for (const v of [sg.start, sg.end]) degree.set(v, (degree.get(v) ?? 0) + 1);
    // The split vertex is a junction of three segments.
    expect([...degree.values()].filter((d) => d === 3)).toHaveLength(1);
    // The closed area (200,100) · (300,100) · (300,250) · (200,200) is a face of the network.
    expect(networkFaces(n).length).toBe(1);
    expect(vectorSession(s.editor)?.penActive).toBe(false);
  });

  it("snaps new points to other vertices, layers and the pixel grid", () => {
    const s = setup((page) => [rect("r", page, 400, 400, 100, 100)]);
    key(s.editor, "p");
    click(s.editor, 100.4, 100.3);
    const id = s.editor.selection[0]!;
    // Pixel grid.
    expect(worldVertices(s.editor, id)).toEqual([{ x: 100, y: 100 }]);
    // Aligns with the rectangle's left edge (x 400) and the first point's y (100), within 6 px.
    click(s.editor, 403, 104);
    expect(worldVertices(s.editor, id)[1]).toEqual({ x: 400, y: 100 });
    // The overlay shows the guides while hovering.
    s.editor.pointerMove({ x: 497, y: 210 });
    const guides = buildOverlay(s.editor).filter((o) => o.kind === "line" && o.role === "snap");
    expect(guides.length).toBeGreaterThan(0);
    // Cmd/Ctrl turns snapping off.
    click(s.editor, 497.4, 210.2, { mod: true });
    expect(worldVertices(s.editor, id)[2]).toEqual({ x: 497.4, y: 210.2 });
  });

  it("draws a live preview: the rubber band and the handles being pulled", () => {
    const s = setup();
    s.editor.updateSettings({ snapping: false });
    key(s.editor, "p");
    click(s.editor, 100, 100);
    s.editor.pointerMove({ x: 250, y: 180 });
    let o = buildOverlay(s.editor);
    const band = o.find((x) => x.kind === "path" && x.role === "pen-preview");
    expect(band).toBeDefined();
    const pts = (band as { contours: readonly (readonly { x: number; y: number }[])[] }).contours[0]!;
    expect(pts[0]).toEqual({ x: 100, y: 100 });
    expect(pts[pts.length - 1]).toEqual({ x: 250, y: 180 });
    s.editor.pointerDown({ x: 250, y: 180 });
    s.editor.pointerMove({ x: 280, y: 180 });
    o = buildOverlay(s.editor);
    expect(o.filter((x) => x.kind === "line" && x.role === "handle").length).toBeGreaterThanOrEqual(2);
    s.editor.pointerUp({ x: 280, y: 180 });
    // The hover over the first point shows the close cursor.
    s.editor.pointerMove({ x: 101, y: 100 });
    expect(s.editor.cursor).toBe("pen-close");
  });

  it("creates the vector inside the frame under the first click, and removes a vector left without segments", () => {
    const s = setup((page) => [frame("f", page, 50, 50, 400, 400)]);
    s.editor.updateSettings({ snapping: false });
    key(s.editor, "p");
    click(s.editor, 100, 100);
    const id = s.editor.selection[0]!;
    expect(s.doc.tree.parentOf(id)).toBe("f");
    expect(s.doc.get(id, "x")).toBe(50);
    // Leaving with a single point: the vector disappears without an undo step.
    const depth = undoSteps(s.editor);
    key(s.editor, "Escape");
    // The first Escape ends the path, the second leaves.
    expect(s.doc.has(id)).toBe(true);
    key(s.editor, "Escape");
    expect(s.doc.has(id)).toBe(false);
    expect(undoSteps(s.editor)).toBe(depth - 1);
    expect(s.editor.history.canRedo()).toBe(false);
    // In the frame: a path whose points are relative to the frame.
    key(s.editor, "p");
    click(s.editor, 100, 100);
    click(s.editor, 200, 150);
    const v = s.editor.selection[0]!;
    key(s.editor, "Enter");
    key(s.editor, "Enter");
    expect(s.doc.tree.parentOf(v)).toBe("f");
    expect(worldVertices(s.editor, v)).toEqual([{ x: 100, y: 100 }, { x: 200, y: 150 }]);
    expect(s.editor.session).toBeNull();
  });

  it("keeps segments' geometry exact through box normalization", () => {
    const s = setup();
    s.editor.updateSettings({ snapping: false, pixelSnap: false });
    key(s.editor, "p");
    click(s.editor, 300, 300);
    const id = s.editor.selection[0]!;
    drag(s.editor, [200, 400], [150, 450]);
    drag(s.editor, [400, 500], [450, 520]);
    click(s.editor, 300, 300);
    const n = net(s.doc, id);
    const m = s.editor.geometry.worldMatrix(id);
    // Bounds of the network start at (0, 0) and the box matches them.
    const xs = n.vertices.map((v) => v.x);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(-1e-9);
    const c = segmentCubic(n, 0);
    expect(round(m[4] + c.x0)).toBe(300);
    expect(round(m[5] + c.y0)).toBe(300);
  });
});
