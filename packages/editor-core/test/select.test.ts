import { describe, expect, it } from "vitest";
import { click, doubleClick, drag, frame, key, rect, setup } from "./helpers";
import type { Command } from "@fig-tree/document";

/**
 * The scene (world coordinates; the view is offset by 50 px so frame labels
 * are on screen):
 *
 *   board b (0,0 400×300): r1 (20,20 50×50), group g [r2 (100,20), r3 (160,20)],
 *     nested frame f2 (20,150 200×100) with r4 (10,10 40×40 → world 30,160)
 *   top-level: t (500,50 60×60), ellipse e (600,200 100×100)
 */
function scene(page: string): Command[] {
  return [
    frame("b", page, 0, 0, 400, 300, { name: "Board" }),
    rect("r1", "b", 20, 20, 50, 50),
    { type: "createNode", node: { id: "g", type: "group", props: { name: "G" } }, parent: "b" },
    rect("r2", "g", 100, 20, 50, 50),
    rect("r3", "g", 160, 20, 50, 50),
    frame("f2", "b", 20, 150, 200, 100),
    rect("r4", "f2", 10, 10, 40, 40),
    rect("t", page, 500, 50, 60, 60),
    { type: "createNode", node: { id: "e", type: "ellipse", props: { x: 600, y: 200, width: 100, height: 100, fills: [{ type: "solid", color: { r: 0, g: 0, b: 1, a: 1 } }] } }, parent: page },
  ];
}

function open() {
  const s = setup(scene);
  s.editor.viewport.set(1, 50, 50);
  const at = (x: number, y: number): [number, number] => [x + 50, y + 50];
  return { ...s, at };
}

describe("click selection", () => {
  it("selects children of boards directly, and groups as a whole", () => {
    const { editor, at } = open();
    click(editor, ...at(30, 30));
    expect(editor.selection).toEqual(["r1"]);
    click(editor, ...at(110, 30));
    expect(editor.selection).toEqual(["g"]);
    click(editor, ...at(30, 160));
    expect(editor.selection).toEqual(["f2"]);
    click(editor, ...at(520, 70));
    expect(editor.selection).toEqual(["t"]);
  });

  it("does not select a board by its background, but by its name label", () => {
    const { editor, at } = open();
    click(editor, ...at(300, 280));
    expect(editor.selection).toEqual([]);
    // The label sits just above the board's top-left corner.
    click(editor, ...at(4, -9));
    expect(editor.selection).toEqual(["b"]);
    // Once selected, the board's background is part of it.
    click(editor, ...at(300, 280));
    expect(editor.selection).toEqual(["b"]);
  });

  it("deep selects with Cmd/Ctrl", () => {
    const { editor, at } = open();
    click(editor, ...at(30, 160), { mod: true });
    expect(editor.selection).toEqual(["r4"]);
    click(editor, ...at(110, 30), { mod: true });
    expect(editor.selection).toEqual(["r2"]);
  });

  it("selects through groups and frames with a double-click, then picks siblings directly", () => {
    const { editor, at } = open();
    doubleClick(editor, ...at(110, 30));
    expect(editor.selection).toEqual(["r2"]);
    click(editor, ...at(170, 30));
    expect(editor.selection).toEqual(["r3"]);
    doubleClick(editor, ...at(30, 160));
    expect(editor.selection).toEqual(["r4"]);
  });

  it("adds and removes with Shift", () => {
    const { editor, at } = open();
    click(editor, ...at(30, 30));
    click(editor, ...at(520, 70), { shift: true });
    expect(editor.selection).toEqual(["r1", "t"]);
    click(editor, ...at(30, 30), { shift: true });
    expect(editor.selection).toEqual(["t"]);
    // A plain click on empty canvas clears the selection.
    click(editor, ...at(800, 500));
    expect(editor.selection).toEqual([]);
  });

  it("hits shapes by their geometry", () => {
    const { editor, at } = open();
    click(editor, ...at(603, 203));
    expect(editor.selection).toEqual([]);
    click(editor, ...at(650, 250));
    expect(editor.selection).toEqual(["e"]);
  });

  it("skips locked and hidden nodes", () => {
    const { editor, doc, at } = open();
    doc.apply([{ type: "updateProps", id: "t", props: { locked: true } }, { type: "updateProps", id: "r1", props: { visible: false } }], doc.actor("x"));
    click(editor, ...at(520, 70));
    expect(editor.selection).toEqual([]);
    click(editor, ...at(30, 30));
    expect(editor.selection).toEqual([]);
  });

  it("shows hover for what a click would select", () => {
    const { editor, at } = open();
    editor.pointerMove({ x: at(110, 30)[0], y: at(110, 30)[1] });
    expect(editor.hover).toBe("g");
    editor.pointerMove({ x: at(110, 30)[0], y: at(110, 30)[1], mod: true });
    expect(editor.hover).toBe("r2");
    editor.pointerMove({ x: at(900, 500)[0], y: at(900, 500)[1] });
    expect(editor.hover).toBeNull();
  });
});

describe("marquee", () => {
  it("selects what it intersects", () => {
    const { editor, at } = open();
    drag(editor, at(450, 0), at(610, 210));
    expect(editor.selection).toEqual(["t", "e"]);
  });

  it("selects a board's children when it crosses the board, and the board when it contains it", () => {
    const { editor, at } = open();
    drag(editor, at(-10, -10), at(80, 80));
    expect(editor.selection).toEqual(["r1"]);
    drag(editor, at(-10, -10), at(410, 310));
    expect(editor.selection).toEqual(["b"]);
  });

  it("starts on a board's background and selects deep with Cmd/Ctrl", () => {
    const { editor, at } = open();
    drag(editor, at(390, 10), at(105, 60));
    expect(editor.selection).toEqual(["g"]);
    drag(editor, at(390, 10), at(105, 60), { mod: true });
    expect(editor.selection).toEqual(["r2", "r3"]);
  });

  it("adds to the selection with Shift", () => {
    const { editor, at } = open();
    click(editor, ...at(30, 30));
    drag(editor, at(450, 0), at(560, 120), { shift: true });
    expect(editor.selection).toEqual(["r1", "t"]);
  });
});

describe("keyboard selection", () => {
  it("selects all siblings, children, parents and steps through siblings", () => {
    const { editor, at } = open();
    click(editor, ...at(30, 30));
    key(editor, "a", { mod: true });
    expect(editor.selection).toEqual(["r1", "g", "f2"]);
    click(editor, ...at(110, 30));
    key(editor, "Enter");
    expect(editor.selection).toEqual(["r2", "r3"]);
    key(editor, "Enter", { shift: true });
    expect(editor.selection).toEqual(["g"]);
    key(editor, "Tab");
    expect(editor.selection).toEqual(["r1"]);
    key(editor, "Tab", { shift: true });
    expect(editor.selection).toEqual(["g"]);
    // Escape: up to the parent, then nothing at the board level.
    click(editor, ...at(30, 160), { mod: true });
    key(editor, "Escape");
    expect(editor.selection).toEqual(["f2"]);
    key(editor, "Escape");
    expect(editor.selection).toEqual([]);
  });
});
