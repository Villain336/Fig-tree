import type { Command } from "@fig-tree/document";
import { describe, expect, it } from "vitest";
import { contextMenu, FRAME_PRESETS, type ShapeTool } from "../src";
import { click, drag, frame, key, props, rect, setup } from "./helpers";

describe("creation tools", () => {
  it("creates a default-sized shape with a click, inside the frame under the pointer", () => {
    const s = setup((page) => [frame("f", page, 100, 100, 300, 300)]);
    s.editor.run("tool.rectangle");
    expect(s.editor.tool.id).toBe("rectangle");
    click(s.editor, 150, 160);
    const [id] = s.editor.selection;
    expect(s.doc.tree.parentOf(id!)).toBe("f");
    expect(props(s.doc, id!, "x", "y", "width", "height", "name")).toEqual({ x: 50, y: 60, width: 100, height: 100, name: "Rectangle 1" });
    expect(s.editor.tool.id).toBe("select");
    // One undo step removes it.
    s.editor.run("edit.undo");
    expect(s.doc.has(id!)).toBe(false);
  });

  it("draws by dragging; Shift makes a square, Alt draws from the center", () => {
    const s = setup();
    s.editor.run("tool.ellipse");
    drag(s.editor, [10, 10], [70, 40]);
    let id = s.editor.selection[0]!;
    expect(props(s.doc, id, "x", "y", "width", "height")).toEqual({ x: 10, y: 10, width: 60, height: 30 });
    s.editor.run("tool.rectangle");
    drag(s.editor, [100, 100], [160, 130], { shift: true });
    id = s.editor.selection[0]!;
    expect(props(s.doc, id, "width", "height")).toEqual({ width: 60, height: 60 });
    s.editor.run("tool.rectangle");
    drag(s.editor, [300, 300], [320, 310], { alt: true });
    id = s.editor.selection[0]!;
    expect(props(s.doc, id, "x", "y", "width", "height")).toEqual({ x: 280, y: 290, width: 40, height: 20 });
  });

  it("draws lines at 45° steps with Shift", () => {
    const s = setup();
    s.editor.run("tool.line");
    drag(s.editor, [0, 0], [100, 90], { shift: true });
    const id = s.editor.selection[0]!;
    expect(s.doc.get<number>(id, "rotation")).toBeCloseTo(45, 6);
    expect(s.doc.get<number>(id, "height")).toBe(0);
  });

  it("makes frames from presets, and a drawn frame adopts what it encloses", () => {
    const s = setup((page) => [rect("a", page, 20, 20, 30, 30), rect("b", page, 500, 20, 30, 30)]);
    const tool = s.editor.tools.get("frame") as ShapeTool;
    tool.preset = FRAME_PRESETS.find((p) => p.name === "Phone")!;
    s.editor.setTool("frame");
    click(s.editor, 600, 300);
    const phone = s.editor.selection[0]!;
    expect(props(s.doc, phone, "width", "height", "name")).toEqual({ width: 393, height: 852, name: "Phone" });
    tool.preset = null;
    s.editor.setTool("frame");
    drag(s.editor, [10, 10], [100, 100]);
    const f = s.editor.selection[0]!;
    expect(s.doc.tree.childrenOf(f)).toEqual(["a"]);
    expect(props(s.doc, "a", "x", "y")).toEqual({ x: 10, y: 10 });
    expect(s.doc.tree.parentOf("b")).toBe(s.page);
  });

  it("frame tool shortcuts and Escape", () => {
    const s = setup();
    key(s.editor, "f");
    expect(s.editor.tool.id).toBe("frame");
    key(s.editor, "Escape");
    expect(s.editor.tool.id).toBe("select");
    key(s.editor, "t");
    expect(s.editor.tool.id).toBe("text");
  });
});

describe("arrange actions", () => {
  const scene = (page: string): Command[] => [rect("a", page, 0, 0, 50, 50), rect("b", page, 100, 20, 50, 50), rect("c", page, 300, 40, 50, 50)];

  it("groups, ungroups and frames the selection, each one undo step", () => {
    const s = setup(scene);
    s.editor.select(["a", "b"]);
    key(s.editor, "g", { mod: true });
    const g = s.editor.selection[0]!;
    expect(s.doc.typeOf(g)).toBe("group");
    expect(s.doc.tree.childrenOf(g)).toEqual(["a", "b"]);
    key(s.editor, "g", { mod: true, shift: true });
    expect(s.doc.has(g)).toBe(false);
    expect(s.editor.selection).toEqual(["a", "b"]);
    key(s.editor, "g", { mod: true, alt: true });
    const f = s.editor.selection[0]!;
    expect(s.doc.typeOf(f)).toBe("frame");
    expect(props(s.doc, f, "x", "y", "width", "height")).toEqual({ x: 0, y: 0, width: 150, height: 70 });
    expect(s.editor.geometry.bounds("b")).toEqual({ x: 100, y: 20, width: 50, height: 50 });
    s.editor.run("edit.undo");
    expect(s.doc.has(f)).toBe(false);
    expect(s.doc.tree.parentOf("a")).toBe(s.page);
  });

  it("changes stacking order", () => {
    const s = setup(scene);
    s.editor.select(["a"]);
    key(s.editor, "]", { mod: true });
    expect(s.doc.tree.childrenOf(s.page)).toEqual(["b", "a", "c"]);
    key(s.editor, "]");
    expect(s.doc.tree.childrenOf(s.page)).toEqual(["b", "c", "a"]);
    key(s.editor, "[", { mod: true });
    expect(s.doc.tree.childrenOf(s.page)).toEqual(["b", "a", "c"]);
    key(s.editor, "[");
    expect(s.doc.tree.childrenOf(s.page)).toEqual(["a", "b", "c"]);
  });

  it("aligns and distributes", () => {
    const s = setup(scene);
    s.editor.select(["a", "b", "c"]);
    s.editor.run("align.top");
    expect([0, 0, 0]).toEqual(["a", "b", "c"].map((id) => s.doc.get<number>(id, "y")));
    s.editor.run("align.right");
    expect(["a", "b", "c"].map((id) => s.doc.get<number>(id, "x"))).toEqual([300, 300, 300]);
    s.editor.run("edit.undo");
    s.editor.run("distribute.x");
    // Span 0..350 with 150 of widths: gaps of 100.
    expect(["a", "b", "c"].map((id) => s.doc.get<number>(id, "x"))).toEqual([0, 150, 300]);
    // A single node aligns within its parent frame.
    const t = setup((page) => [frame("f", page, 0, 0, 200, 100), rect("r", "f", 10, 10, 20, 20)]);
    t.editor.select(["r"]);
    t.editor.run("align.centerX");
    t.editor.run("align.bottom");
    expect(props(t.doc, "r", "x", "y")).toEqual({ x: 90, y: 80 });
  });

  it("deletes, duplicates, locks, hides and flips", () => {
    const s = setup(scene);
    s.editor.select(["a"]);
    key(s.editor, "d", { mod: true });
    const copy = s.editor.selection[0]!;
    expect(props(s.doc, copy, "x", "y")).toEqual({ x: 10, y: 10 });
    key(s.editor, "Delete");
    expect(s.doc.has(copy)).toBe(false);
    s.editor.select(["a"]);
    key(s.editor, "h", { shift: true });
    expect(props(s.doc, "a", "flipX", "x")).toEqual({ flipX: true, x: 0 });
    key(s.editor, "v", { shift: true });
    expect(props(s.doc, "a", "flipY", "rotation")).toEqual({ flipY: true, rotation: 0 });
    key(s.editor, "l", { mod: true, shift: true });
    expect(s.doc.get("a", "locked")).toBe(true);
    // Locked nodes do not move or get deleted.
    key(s.editor, "ArrowRight");
    key(s.editor, "Backspace");
    expect(props(s.doc, "a", "x")).toEqual({ x: 0 });
    expect(s.doc.has("a")).toBe(true);
    key(s.editor, "h", { mod: true, shift: true });
    expect(s.doc.get("a", "visible")).toBe(false);
  });

  it("adds auto layout to a frame, guessing direction, gap and padding from its children", () => {
    const s = setup((page) => [frame("f", page, 0, 0, 300, 100), rect("x2", "f", 130, 20, 50, 50), rect("x1", "f", 20, 20, 100, 50)]);
    s.editor.select(["f"]);
    key(s.editor, "a", { shift: true });
    expect(props(s.doc, "f", "display", "flexDirection", "columnGap", "padding", "widthMode", "heightMode")).toEqual({
      display: "flex",
      flexDirection: "row",
      columnGap: 10,
      padding: { top: 20, right: 120, bottom: 30, left: 20 },
      widthMode: "hug",
      heightMode: "hug",
    });
    // Children join the flow in visual order: the layout reproduces where they were.
    expect(s.doc.tree.childrenOf("f")).toEqual(["x1", "x2"]);
    expect(s.editor.geometry.bounds("x2")).toEqual({ x: 130, y: 20, width: 50, height: 50 });
    // Back to a plain frame: everything stays put.
    s.editor.run("layout.remove");
    expect(props(s.doc, "x2", "position", "x", "y")).toEqual({ position: "absolute", x: 130, y: 20 });
    expect(s.editor.geometry.bounds("x2")).toEqual({ x: 130, y: 20, width: 50, height: 50 });
  });

  it("wraps loose nodes in a new auto layout frame as one step", () => {
    const s = setup((page) => [rect("p", page, 0, 0, 40, 40), rect("q", page, 0, 60, 40, 40)]);
    s.editor.select(["p", "q"]);
    s.editor.run("layout.add");
    const f = s.editor.selection[0]!;
    expect(props(s.doc, f, "display", "flexDirection", "rowGap")).toEqual({ display: "flex", flexDirection: "column", rowGap: 20 });
    expect(s.editor.geometry.bounds("q")).toEqual({ x: 0, y: 60, width: 40, height: 40 });
    s.editor.run("edit.undo");
    expect(s.doc.has(f)).toBe(false);
    expect(s.doc.tree.parentOf("p")).toBe(s.page);
  });

  it("builds context menus with enabled states", () => {
    const s = setup(scene);
    let menu = contextMenu(s.editor, "canvas");
    expect(menu.find((m) => m !== "separator" && m.action === "edit.delete")).toMatchObject({ enabled: false });
    s.editor.select(["a"]);
    menu = contextMenu(s.editor, "canvas");
    expect(menu.find((m) => m !== "separator" && m.action === "edit.delete")).toMatchObject({ enabled: true, shortcut: "Del" });
    expect(menu.find((m) => m !== "separator" && m.action === "arrange.ungroup")).toMatchObject({ enabled: false });
  });
});

describe("history", () => {
  it("keeps each user's undo separate from other actors", () => {
    const s = setup((page) => [rect("a", page, 0, 0, 10, 10)]);
    s.editor.history.apply([{ type: "updateProps", id: "a", props: { x: 5 } }]);
    s.doc.apply([{ type: "updateProps", id: "a", props: { y: 7 } }], s.doc.actor("someone-else"));
    s.editor.run("edit.undo");
    expect(props(s.doc, "a", "x", "y")).toEqual({ x: 0, y: 7 });
  });

  it("merges a typing run (soft group) until another edit closes it", () => {
    const s = setup((page) => [rect("a", page, 0, 0, 10, 10)]);
    const h = s.editor.history;
    h.apply([{ type: "updateProps", id: "a", props: { x: 1 } }], { group: "g" });
    h.apply([{ type: "updateProps", id: "a", props: { x: 2 } }], { group: "g" });
    h.apply([{ type: "updateProps", id: "a", props: { y: 3 } }]);
    h.undo();
    expect(props(s.doc, "a", "x", "y")).toEqual({ x: 2, y: 0 });
    h.undo();
    expect(props(s.doc, "a", "x")).toEqual({ x: 0 });
  });
});
