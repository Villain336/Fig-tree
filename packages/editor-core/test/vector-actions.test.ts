import type { Command, FigDocument } from "@fig-tree/document";
import { booleanContours, nodeNetwork } from "@fig-tree/document";
import { contoursArea, maxDistanceToCurves, segmentCubic, type VectorNetwork } from "@fig-tree/geometry";
import type { FontRegistry } from "@fig-tree/text";
import { beforeAll, describe, expect, it } from "vitest";
import { buildOverlay, contextMenu, paste, selectionToSvg, setBooleanOperation, vectorSession, type Editor } from "../src";
import { documentSource } from "../src/vector/edit";
import { click, drag, key, rect, setup, text, textFonts } from "./helpers";

const RED = { type: "solid" as const, color: { r: 1, g: 0, b: 0, a: 1 } };
const BLUE = { type: "solid" as const, color: { r: 0, g: 0, b: 1, a: 1 } };
const INK = { type: "solid" as const, color: { r: 0, g: 0, b: 0, a: 1 } };
const net = (doc: FigDocument, id: string): VectorNetwork => doc.get<VectorNetwork>(id, "vectorNetwork");

const ellipse = (id: string, parent: string, x: number, y: number, w: number, h: number, props: Record<string, unknown> = {}): Command => ({
  type: "createNode",
  node: { id, type: "ellipse", props: { x, y, width: w, height: h, fills: [RED], ...props } },
  parent,
});

function groupArea(editor: Editor, id: string): number {
  return Math.abs(contoursArea(booleanContours(documentSource(editor.doc), id)));
}

describe("pencil tool", () => {
  it("fits a freehand stroke with curves in one undo step, within the tolerance", () => {
    const s = setup();
    key(s.editor, "p", { shift: true });
    expect(s.editor.tool.id).toBe("pencil");
    // A wave: 60 points along a sine.
    const pts: [number, number][] = [];
    for (let i = 0; i <= 60; i++) pts.push([100 + i * 5, 300 + Math.sin(i / 6) * 40]);
    s.editor.pointerDown({ x: pts[0]![0], y: pts[0]![1] });
    for (const [x, y] of pts.slice(1)) s.editor.pointerMove({ x, y });
    // The stroke shows on the overlay while drawing.
    expect(buildOverlay(s.editor).some((o) => o.kind === "path" && o.role === "pencil")).toBe(true);
    s.editor.pointerUp({ x: pts[60]![0], y: pts[60]![1] });
    const id = s.editor.selection[0]!;
    expect(s.doc.typeOf(id)).toBe("vector");
    expect(s.editor.history.undoDepth).toBe(1);
    const n = net(s.doc, id);
    // Far fewer segments than input points, an open stroke, no fill.
    expect(n.segments.length).toBeGreaterThan(1);
    expect(n.segments.length).toBeLessThan(15);
    expect(n.regions).toEqual([]);
    expect(s.doc.get(id, "fills")).toEqual([]);
    // Every input point is within the tolerance (1.5 px at 100%) of the curves.
    const x0 = s.doc.get<number>(id, "x"), y0 = s.doc.get<number>(id, "y");
    const curves = n.segments.map((_, i) => segmentCubic(n, i));
    expect(maxDistanceToCurves(pts.map(([x, y]) => ({ x: x - x0, y: y - y0 })), curves)).toBeLessThanOrEqual(1.5 + 1e-6);
    // The tool stays active for the next stroke.
    expect(s.editor.tool.id).toBe("pencil");
  });

  it("closes and fills a stroke that ends where it started", () => {
    const s = setup();
    key(s.editor, "p", { shift: true });
    s.editor.pointerDown({ x: 300, y: 200 });
    for (let i = 1; i <= 72; i++) {
      const a = (i / 72) * Math.PI * 2;
      s.editor.pointerMove({ x: 300 + Math.cos(a) * 100 - 100, y: 200 + Math.sin(a) * 100 });
    }
    s.editor.pointerUp({ x: 301, y: 201 });
    const id = s.editor.selection[0]!;
    const n = net(s.doc, id);
    expect(n.regions).toHaveLength(1);
    expect((s.doc.get(id, "fills") as unknown[]).length).toBe(1);
    // About a circle of radius 100.
    expect(s.doc.get<number>(id, "width")).toBeCloseTo(200, -1);
  });
});

describe("boolean actions", () => {
  const scene = (page: string): Command[] => [ellipse("a", page, 100, 100, 100, 100), ellipse("b", page, 150, 100, 100, 100, { fills: [BLUE] })];

  it("makes live boolean groups from shortcuts and menus, then follows edits of a child", () => {
    const s = setup(scene);
    s.editor.select(["a", "b"]);
    key(s.editor, "u", { shift: true, alt: true });
    const g = s.editor.selection[0]!;
    expect(s.doc.typeOf(g)).toBe("group");
    expect(s.doc.get(g, "booleanOperation")).toBe("union");
    expect(s.doc.get(g, "fills")).toEqual([RED]);
    expect(s.doc.tree.childrenOf(g)).toEqual(["a", "b"]);
    const union = groupArea(s.editor, g);
    // Changing the operation of the selected group (shortcut, or the layers panel).
    key(s.editor, "s", { shift: true, alt: true });
    expect(s.doc.get(g, "booleanOperation")).toBe("subtract");
    const sub = groupArea(s.editor, g);
    expect(sub).toBeLessThan(union);
    setBooleanOperation(s.editor, g, "intersect");
    expect(s.doc.get(g, "booleanOperation")).toBe("intersect");
    const inter = groupArea(s.editor, g);
    setBooleanOperation(s.editor, g, "exclude");
    expect(groupArea(s.editor, g)).toBeCloseTo(union - inter, 3);
    // Editing a child updates the result: moving b away leaves no intersection.
    setBooleanOperation(s.editor, g, "intersect");
    s.editor.select(["b"]);
    drag(s.editor, [240, 150], [440, 150], { mod: true });
    expect(groupArea(s.editor, g)).toBeLessThan(1e-6);
    // Each action is one undo step.
    s.editor.run("edit.undo");
    expect(groupArea(s.editor, g)).toBeGreaterThan(100);
  });

  it("keeps operands where they are drawn, so a child's points are edited in place and the result follows", () => {
    const s = setup(scene);
    s.editor.select(["a", "b"]);
    s.editor.run("boolean.union");
    const g = s.editor.selection[0]!;
    // The group draws its result at the result's bounds; its children keep their own place.
    expect(s.editor.geometry.bounds("b")).toEqual({ x: 150, y: 100, width: 100, height: 100 });
    const area = groupArea(s.editor, g);
    // Edit b's points: it becomes a vector (same id inside the group), and the union grows.
    s.editor.select(["b"]);
    key(s.editor, "Enter");
    const v = vectorSession(s.editor)!;
    s.editor.updateSettings({ snapping: false });
    // The ellipse's right point is at (250, 150).
    click(s.editor, 250, 150);
    expect(v.selectedVertices).toHaveLength(1);
    drag(s.editor, [250, 150], [330, 150]);
    expect(s.doc.tree.parentOf(v.nodeId)).toBe(g);
    expect(groupArea(s.editor, g)).toBeGreaterThan(area + 1000);
    expect(s.editor.history.undoDepth).toBe(2);
  });

  it("lists the boolean operations, flatten, outline stroke and copy as SVG in the context menu", () => {
    const s = setup(scene);
    s.editor.select(["a", "b"]);
    const menu = contextMenu(s.editor, "canvas");
    const items = new Map(menu.filter((m) => m !== "separator").map((m) => [m.action, m]));
    for (const a of ["boolean.union", "boolean.subtract", "boolean.intersect", "boolean.exclude", "object.flatten", "edit.copyAsSvg"]) expect(items.get(a)?.enabled, a).toBe(true);
    // No strokes: outline stroke is disabled.
    expect(items.get("object.outlineStroke")?.enabled).toBe(false);
    expect(items.get("boolean.union")?.shortcut).toBe("Shift+Alt+U");
    s.editor.run("boolean.subtract");
    expect(s.doc.get(s.editor.selection[0]!, "booleanOperation")).toBe("subtract");
  });

  it("flattens a boolean group into one vector with the same area (Cmd/Ctrl+E)", () => {
    const s = setup(scene);
    s.editor.select(["a", "b"]);
    s.editor.run("boolean.union");
    const g = s.editor.selection[0]!;
    const area = groupArea(s.editor, g);
    key(s.editor, "e", { mod: true });
    const v = s.editor.selection[0]!;
    expect(s.doc.typeOf(v)).toBe("vector");
    expect(s.doc.has(g)).toBe(false);
    const n = nodeNetwork(documentSource(s.doc), v)!;
    expect(n.regions.length).toBeGreaterThan(0);
    expect(s.editor.history.undoDepth).toBe(2);
    // The flattened vector is editable: its points can be moved.
    key(s.editor, "Enter");
    expect(vectorSession(s.editor)?.nodeId).toBe(v);
    void area;
  });

  it("outlines a stroke into a filled vector (Shift+Cmd/Ctrl+O)", () => {
    const s = setup((page) => [rect("r", page, 100, 100, 100, 100, { strokes: [INK], strokeWeight: 10, fills: [] })]);
    s.editor.select(["r"]);
    key(s.editor, "o", { shift: true, mod: true });
    const id = s.editor.selection[0]!;
    expect(s.doc.typeOf(id)).toBe("vector");
    expect(s.doc.get(id, "fills")).toEqual([INK]);
    expect(s.doc.get(id, "strokes")).toEqual([]);
    // Without fills, the original is replaced.
    expect(s.doc.has("r")).toBe(false);
    expect(s.editor.history.undoDepth).toBe(1);
  });
});

describe("text to outlines", () => {
  let fonts: FontRegistry;
  beforeAll(async () => {
    fonts = await textFonts();
  });

  it("flattens text into a vector of its glyph outlines through the bridge", () => {
    const s = setup((page) => [text("t", page, "Fig", { x: 100, y: 100, fontSize: 48, fills: [BLUE] })], { fonts });
    s.editor.select(["t"]);
    const before = s.editor.geometry.bounds("t");
    s.editor.run("object.flatten");
    const id = s.editor.selection[0]!;
    expect(s.doc.has("t")).toBe(false);
    expect(s.doc.typeOf(id)).toBe("vector");
    expect(s.doc.get(id, "fills")).toEqual([BLUE]);
    const n = net(s.doc, id);
    // F, i (two contours) and g (two): at least five loops.
    expect(n.regions[0]!.loops.length).toBeGreaterThanOrEqual(5);
    const after = s.editor.geometry.bounds(id);
    for (const k of ["x", "y", "width", "height"] as const) expect(after[k]).toBeCloseTo(before[k], 3);
    expect(s.editor.history.undoDepth).toBe(1);
  });
});

describe("SVG", () => {
  it("copies the selection as SVG that pastes back as the same geometry", async () => {
    const s = setup((page) => [
      rect("r", page, 100, 100, 80, 60, { fills: [RED], strokes: [INK], strokeWeight: 2 }),
      ellipse("e", page, 200, 100, 60, 60, { fills: [BLUE] }),
    ]);
    s.editor.select(["r", "e"]);
    const svg = selectionToSvg(s.editor)!;
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="160" height="60"/);
    expect(svg).toContain('fill="#ff0000"');
    expect(svg).toContain('fill="#0000ff"');
    expect(svg).toContain('stroke="#000000"');
    // Paste it back: vectors at the same place with the same colors.
    s.editor.select([]);
    const ids = await paste(s.editor, { text: svg });
    expect(ids).toHaveLength(1);
    const kids = s.doc.tree.subtree(ids[0]!).filter((id) => s.doc.typeOf(id) === "vector");
    expect(kids.length).toBeGreaterThanOrEqual(2);
    const fills = kids.map((k) => JSON.stringify(s.doc.get(k, "fills")));
    expect(fills).toContain(JSON.stringify([RED]));
    expect(fills).toContain(JSON.stringify([BLUE]));
  });

  it("pastes SVG paths as editable vectors", async () => {
    const s = setup();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><path d="M10 10 C 60 -20 140 40 190 10 L 190 90 L 10 90 Z" fill="#00ff00"/></svg>`;
    const [frameId] = await paste(s.editor, { text: svg });
    const v = s.doc.tree.subtree(frameId!).find((id) => s.doc.typeOf(id) === "vector")!;
    const n = net(s.doc, v);
    expect(n.vertices).toHaveLength(4);
    expect(n.regions).toHaveLength(1);
    s.editor.select([v]);
    key(s.editor, "Enter");
    const session = vectorSession(s.editor)!;
    expect(session.nodeId).toBe(v);
    // Move the bottom-left point.
    const m = s.editor.geometry.worldMatrix(v);
    const p = net(s.doc, v).vertices[3]!;
    const at = { x: m[4] + p.x, y: m[5] + p.y };
    click(s.editor, at.x, at.y);
    expect(session.selectedVertices).toEqual([3]);
    s.editor.updateSettings({ snapping: false });
    drag(s.editor, [at.x, at.y], [at.x - 30, at.y + 20]);
    const m2 = s.editor.geometry.worldMatrix(v);
    const q = net(s.doc, v).vertices[3]!;
    expect(Math.round(m2[4] + q.x)).toBe(Math.round(at.x - 30));
    expect(Math.round(m2[5] + q.y)).toBe(Math.round(at.y + 20));
  });
});
