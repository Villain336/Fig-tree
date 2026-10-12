import type { Command } from "@fig-tree/document";
import { boxMatrix } from "@fig-tree/document";
import { describe, expect, it } from "vitest";
import { selectionHandles, transformPoint } from "../src";
import { click, drag, frame, key, props, rect, setup } from "./helpers";

/** Screen center of a named handle of the current selection. */
function handle(editor: Parameters<typeof selectionHandles>[0], name: string): [number, number] {
  const h = selectionHandles(editor).find((x) => x.id === name);
  if (!h) throw new Error(`no handle ${name}`);
  return [h.center.x, h.center.y];
}

function undoSteps(s: ReturnType<typeof setup>): number {
  return s.doc.undoManager(s.editor.history.actor).undoStack.length;
}

describe("moving", () => {
  const scene = (page: string): Command[] => [rect("a", page, 100, 100, 50, 50), rect("b", page, 300, 100, 50, 50), frame("f", page, 0, 400, 300, 200), rect("c", "f", 20, 20, 40, 40)];

  it("drags the selection as one undo step", () => {
    const s = setup(scene);
    s.editor.updateSettings({ snapping: false });
    drag(s.editor, [120, 120], [150, 140]);
    expect(props(s.doc, "a", "x", "y")).toEqual({ x: 130, y: 120 });
    expect(undoSteps(s)).toBe(1);
    s.editor.run("edit.undo");
    expect(props(s.doc, "a", "x", "y")).toEqual({ x: 100, y: 100 });
    s.editor.run("edit.redo");
    expect(props(s.doc, "a", "x", "y")).toEqual({ x: 130, y: 120 });
  });

  it("constrains to an axis with Shift and moves whole pixels", () => {
    const s = setup(scene);
    s.editor.updateSettings({ snapping: false });
    drag(s.editor, [120, 120], [160.4, 127], { shift: true });
    expect(props(s.doc, "a", "x", "y")).toEqual({ x: 140, y: 100 });
  });

  it("snaps to sibling edges", () => {
    const s = setup(scene);
    // a's top edge 3 px below b's top edge: snaps to 100. Its right edge (150 + 147) lands near b's left (300): snaps.
    drag(s.editor, [120, 120], [267, 123]);
    expect(props(s.doc, "a", "x", "y")).toEqual({ x: 250, y: 100 });
    // Cmd/Ctrl disables snapping.
    drag(s.editor, [270, 120], [272, 123], { mod: true });
    expect(props(s.doc, "a", "x", "y")).toEqual({ x: 252, y: 103 });
  });

  it("duplicates with Alt-drag, leaving the original", () => {
    const s = setup(scene);
    click(s.editor, 120, 120);
    drag(s.editor, [120, 120], [120, 220], { alt: true });
    const [copy] = s.editor.selection;
    expect(copy).not.toBe("a");
    expect(props(s.doc, "a", "x", "y")).toEqual({ x: 100, y: 100 });
    expect(props(s.doc, copy!, "x", "y", "width")).toEqual({ x: 100, y: 200, width: 50 });
    s.editor.run("edit.undo");
    expect(s.doc.has(copy!)).toBe(false);
  });

  it("drops nodes into frames and out onto the canvas, keeping them in place", () => {
    const s = setup(scene);
    drag(s.editor, [120, 120], [120, 520]);
    expect(s.doc.tree.parentOf("a")).toBe("f");
    expect(props(s.doc, "a", "x", "y")).toEqual({ x: 100, y: 100 });
    expect(s.editor.geometry.bounds("a")).toEqual({ x: 100, y: 500, width: 50, height: 50 });
    // Child of a board: dragged out onto the empty canvas.
    click(s.editor, 30, 430);
    drag(s.editor, [30, 430], [30, 330]);
    expect(s.doc.tree.parentOf("c")).toBe(s.page);
    expect(props(s.doc, "c", "x", "y")).toEqual({ x: 20, y: 320 });
    expect(undoSteps(s)).toBe(2);
  });

  it("reorders children inside a flex frame", () => {
    const s = setup((page) => [
      frame("row", page, 0, 0, 400, 100, { display: "flex", flexDirection: "row", columnGap: 10 }),
      rect("i1", "row", 0, 0, 50, 50, { position: "relative" }),
      rect("i2", "row", 0, 0, 50, 50, { position: "relative" }),
      rect("i3", "row", 0, 0, 50, 50, { position: "relative" }),
    ]);
    expect(s.editor.geometry.bounds("i3").x).toBe(120);
    // Drag i1 past i3's center.
    drag(s.editor, [25, 25], [160, 25]);
    expect(s.doc.tree.childrenOf("row")).toEqual(["i2", "i3", "i1"]);
    expect(s.doc.stored("i1", "x")).toBe(0);
    // Arrow keys reorder in the flow too.
    key(s.editor, "ArrowLeft");
    expect(s.doc.tree.childrenOf("row")).toEqual(["i2", "i1", "i3"]);
  });

  it("nudges with arrow keys by 1 or 10 px", () => {
    const s = setup(scene);
    click(s.editor, 120, 120);
    key(s.editor, "ArrowRight");
    key(s.editor, "ArrowDown", { shift: true });
    expect(props(s.doc, "a", "x", "y")).toEqual({ x: 101, y: 110 });
  });

  it("cancels a drag with Escape, leaving nothing to redo", () => {
    const s = setup(scene);
    s.editor.pointerDown({ x: 120, y: 120 });
    s.editor.pointerMove({ x: 160, y: 160 });
    s.editor.pointerMove({ x: 200, y: 160 });
    expect(props(s.doc, "a", "x")).toEqual({ x: 180 });
    expect(key(s.editor, "Escape")).toBe(true);
    s.editor.pointerUp({ x: 200, y: 160 });
    expect(props(s.doc, "a", "x", "y")).toEqual({ x: 100, y: 100 });
    expect(s.editor.history.canRedo()).toBe(false);
    expect(s.editor.history.canUndo()).toBe(false);
  });
});

describe("resizing", () => {
  it("resizes with a corner handle; Shift keeps the ratio, Alt resizes from the center", () => {
    const s = setup((page) => [rect("a", page, 100, 100, 100, 50)]);
    click(s.editor, 120, 120);
    drag(s.editor, handle(s.editor, "canvas.handle.resize.se"), [230, 180]);
    expect(props(s.doc, "a", "x", "y", "width", "height")).toEqual({ x: 100, y: 100, width: 130, height: 80 });
    s.editor.run("edit.undo");
    drag(s.editor, handle(s.editor, "canvas.handle.resize.se"), [300, 110], { shift: true });
    expect(props(s.doc, "a", "width", "height")).toEqual({ width: 200, height: 100 });
    s.editor.run("edit.undo");
    drag(s.editor, handle(s.editor, "canvas.handle.resize.e"), [220, 125], { alt: true });
    expect(props(s.doc, "a", "x", "width", "height")).toEqual({ x: 80, width: 140, height: 50 });
  });

  it("resizes from any point along an edge", () => {
    const s = setup((page) => [rect("a", page, 100, 100, 100, 50)]);
    click(s.editor, 120, 120);
    drag(s.editor, [130, 150], [130, 170]);
    expect(props(s.doc, "a", "y", "height")).toEqual({ y: 100, height: 70 });
  });

  it("resizes rotated nodes along their own axes", () => {
    const s = setup((page) => [rect("a", page, 100, 100, 100, 50, { rotation: 90 })]);
    click(s.editor, 150, 125);
    const fixed = transformPoint(s.editor.geometry.worldMatrix("a"), 0, 0);
    const se = handle(s.editor, "canvas.handle.resize.se");
    // The local +x axis points down: dragging the se corner 20 px further down widens the box.
    drag(s.editor, se, [se[0], se[1] + 20]);
    expect(props(s.doc, "a", "width", "height", "rotation")).toEqual({ width: 120, height: 50, rotation: 90 });
    const after = transformPoint(s.editor.geometry.worldMatrix("a"), 0, 0);
    expect(after.x).toBeCloseTo(fixed.x, 6);
    expect(after.y).toBeCloseTo(fixed.y, 6);
  });

  it("applies children's constraints when a frame is resized (Cmd/Ctrl ignores them)", () => {
    const s = setup((page) => [
      frame("f", page, 0, 0, 200, 100),
      rect("end", "f", 150, 10, 40, 40, { constraints: { horizontal: "end", vertical: "start" } }),
      rect("stretch", "f", 10, 60, 180, 30, { constraints: { horizontal: "start-end", vertical: "start" } }),
    ]);
    click(s.editor, 4, -9);
    expect(s.editor.selection).toEqual(["f"]);
    drag(s.editor, handle(s.editor, "canvas.handle.resize.e"), [300, 50]);
    expect(props(s.doc, "f", "width")).toEqual({ width: 300 });
    expect(props(s.doc, "end", "x")).toEqual({ x: 250 });
    expect(props(s.doc, "stretch", "width")).toEqual({ width: 280 });
    s.editor.run("edit.undo");
    expect(props(s.doc, "end", "x")).toEqual({ x: 150 });
    drag(s.editor, handle(s.editor, "canvas.handle.resize.e"), [300, 50], { mod: true });
    expect(props(s.doc, "end", "x")).toEqual({ x: 150 });
    expect(props(s.doc, "stretch", "width")).toEqual({ width: 180 });
  });

  it("scales a multi-selection as one box", () => {
    const s = setup((page) => [rect("a", page, 0, 0, 50, 50), rect("b", page, 100, 0, 50, 50)]);
    s.editor.select(["a", "b"]);
    drag(s.editor, handle(s.editor, "canvas.handle.resize.se"), [300, 100]);
    expect(props(s.doc, "a", "x", "width", "height")).toEqual({ x: 0, width: 100, height: 100 });
    expect(props(s.doc, "b", "x", "width")).toEqual({ x: 200, width: 100 });
  });

  it("switches text to a fixed width with auto height when its width is dragged", () => {
    const s = setup((page) => [{ type: "createNode", node: { id: "t", type: "text", props: { x: 0, y: 0, width: 80, height: 20 }, text: { content: "Hello", runs: [] } }, parent: page }]);
    s.editor.select(["t"]);
    // Too short for edge handles: the right edge itself resizes.
    expect(selectionHandles(s.editor).some((h) => h.id === "canvas.handle.resize.e")).toBe(false);
    drag(s.editor, [80, 10], [120, 10]);
    expect(props(s.doc, "t", "width", "widthMode", "heightMode")).toEqual({ width: 120, widthMode: "fixed", heightMode: "hug" });
  });

  it("drags line endpoints", () => {
    const s = setup((page) => [{ type: "createNode", node: { id: "l", type: "line", props: { x: 0, y: 100, width: 100, strokes: [{ type: "solid", color: { r: 0, g: 0, b: 0, a: 1 } }] } }, parent: page }]);
    s.editor.select(["l"]);
    drag(s.editor, handle(s.editor, "canvas.handle.endpoint.end"), [0, 200]);
    const m = s.editor.geometry.worldMatrix("l");
    const w = s.doc.get<number>("l", "width");
    const a = transformPoint(m, 0, 0);
    const b = transformPoint(m, w, 0);
    expect([a.x, a.y].map((v) => Math.round(v * 1e6) / 1e6 + 0)).toEqual([0, 100]);
    expect([b.x, b.y].map((v) => Math.round(v * 1e6) / 1e6 + 0)).toEqual([0, 200]);
  });
});

describe("rotating", () => {
  it("rotates outside a corner, snapping to 15° with Shift", () => {
    const s = setup((page) => [rect("a", page, 100, 100, 100, 100)]);
    click(s.editor, 150, 150);
    const zone = handle(s.editor, "canvas.handle.rotate.ne");
    // From the ne zone (up-right of the center) to the mirrored point below: a quarter turn clockwise.
    drag(s.editor, zone, [150 + (zone[0] - 150), 150 + (zone[0] - 150)]);
    expect(s.doc.get<number>("a", "rotation")).toBeCloseTo(90, 6);
    s.editor.run("edit.undo");
    drag(s.editor, handle(s.editor, "canvas.handle.rotate.ne"), [260, 170], { shift: true });
    const r = s.doc.get<number>("a", "rotation");
    expect(r % 15).toBe(0);
    // Rotation is about the center: the center stays.
    const m = boxMatrix({ x: s.doc.get("a", "x"), y: s.doc.get("a", "y"), width: 100, height: 100, rotation: r, flipX: false, flipY: false });
    const c = transformPoint(m, 50, 50);
    expect(c.x).toBeCloseTo(150, 6);
    expect(c.y).toBeCloseTo(150, 6);
  });

  it("rotates a multi-selection about its center", () => {
    const s = setup((page) => [rect("a", page, 0, 0, 20, 20), rect("b", page, 80, 0, 20, 20)]);
    s.editor.select(["a", "b"]);
    const zone = handle(s.editor, "canvas.handle.rotate.se");
    // Half a turn around the selection's center (50, 10).
    drag(s.editor, zone, [100 - zone[0], 20 - zone[1]], {}, 12);
    expect(Math.abs(s.doc.get<number>("a", "rotation"))).toBeCloseTo(180, 4);
    expect(s.editor.geometry.bounds("a").x).toBeCloseTo(80, 4);
    expect(s.editor.geometry.bounds("b").x).toBeCloseTo(0, 4);
  });
});
