import { describe, expect, it } from "vitest";
import { Scene } from "@fig-tree/renderer";
import { LayoutNode, computeLayout, parseStyle } from "@fig-tree/layout";
import { DrawList } from "../../renderer/src/compile";
import { SceneBridge, cssDeclarations, type Command, type FigDocument } from "../src";
import { makeDoc } from "./helpers";

/**
 * The document's layout through the bridge: flex and grid frames position
 * and size their children from the CSS `cssDeclarations` states, fixed /
 * hug / fill sizing maps through it, and edits relayout incrementally.
 */

const RED = { type: "solid" as const, color: { r: 1, g: 0, b: 0, a: 1 } };

function setup(commands: (page: string) => Command[]) {
  const { doc, page, user } = makeDoc(9);
  doc.apply(commands(page), user);
  const scene = new Scene();
  const bridge = new SceneBridge(doc, scene);
  const box = (id: string): [number, number, number, number] => {
    const b = bridge.box(id)!;
    return [b.x, b.y, b.width, b.height].map((v) => Math.round(v * 1000) / 1000) as [number, number, number, number];
  };
  return { doc, page, user, scene, bridge, box };
}

const frame = (id: string, parent: string, props: Record<string, unknown>): Command => ({ type: "createNode", node: { id, type: "frame", props: { fills: [RED], ...props } }, parent });
const rect = (id: string, parent: string, props: Record<string, unknown> = {}): Command => ({ type: "createNode", node: { id, type: "rectangle", props: { fills: [RED], ...props } }, parent });

/** A frame laid out as a row: padding 10, gap 8, children fixed, fill and hug. */
const rowFrame = (page: string): Command[] => [
  frame("row", page, { x: 40, y: 30, width: 400, height: 100, display: "flex", padding: { top: 10, right: 10, bottom: 10, left: 10 }, columnGap: 8, alignItems: "center" }),
  rect("a", "row", { width: 50, height: 40 }),
  rect("b", "row", { width: 10, height: 20, widthMode: "fill" }),
  rect("c", "row", { width: 60, height: 30, heightMode: "fill" }),
];

describe("document layout", () => {
  it("positions and sizes children of a flex frame (fixed, fill and hug through the CSS mapping)", () => {
    const { box, scene, bridge } = setup(rowFrame);
    expect(box("row")).toEqual([40, 30, 400, 100]);
    // Content box 380 wide; a=50, c=60, gaps 16: the fill child takes the remaining 254.
    expect(box("a")).toEqual([10, 30, 50, 40]);
    expect(box("b")).toEqual([68, 40, 254, 20]);
    // heightMode fill on the cross axis is align-self: stretch.
    expect(box("c")).toEqual([330, 10, 60, 80]);
    // The scene uses the computed boxes.
    const main = bridge.sceneNodeFor("b")!;
    expect(main.transform).toEqual([1, 0, 0, 1, 68, 40]);
    expect(main.path!.bounds()).toMatchObject({ minX: 0, minY: 0, maxX: 254, maxY: 20 });
    expect(scene.root.children.length).toBe(1);
  });

  it("sizes a hug frame to its content", () => {
    const { box } = setup((page) => [
      frame("hug", page, { x: 0, y: 0, width: 10, height: 10, widthMode: "hug", heightMode: "hug", display: "flex", flexDirection: "column", rowGap: 4, padding: { top: 6, right: 6, bottom: 6, left: 6 } }),
      rect("p", "hug", { width: 70, height: 20 }),
      rect("q", "hug", { width: 40, height: 30 }),
    ]);
    expect(box("hug")).toEqual([0, 0, 82, 66]);
    // Column items stretch across the cross axis unless sized: fixed widths keep theirs.
    expect(box("p")).toEqual([6, 6, 70, 20]);
    expect(box("q")).toEqual([6, 30, 40, 30]);
  });

  it("lays out grid frames with tracks, gaps and placement", () => {
    const { box } = setup((page) => [
      frame("grid", page, {
        x: 0,
        y: 0,
        width: 300,
        height: 200,
        display: "grid",
        gridTemplateColumns: [{ type: "px", value: 100 }, { type: "fr", value: 1 }],
        gridTemplateRows: [{ type: "repeat", count: 2, tracks: [{ type: "fr", value: 1 }] }],
        rowGap: 10,
        columnGap: 20,
      }),
      rect("g1", "grid", { width: 10, height: 10, widthMode: "fill", heightMode: "fill" }),
      rect("g2", "grid", { width: 10, height: 10, widthMode: "fill", heightMode: "fill" }),
      rect("g3", "grid", { width: 30, height: 30, gridColumn: { start: 1, end: { span: 2 } } }),
    ]);
    expect(box("g1")).toEqual([0, 0, 100, 95]);
    expect(box("g2")).toEqual([120, 0, 180, 95]);
    // A fixed-size item spanning both columns sits at the start of its area.
    expect(box("g3")).toEqual([0, 105, 30, 30]);
  });

  it("keeps absolutely positioned children at their constraints when layout resizes the parent", () => {
    const { box, doc, user } = setup((page) => [
      frame("outer", page, { x: 0, y: 0, width: 200, height: 100, display: "flex" }),
      // A fill frame: its stored size is 200 × 100, its laid-out size follows the outer frame.
      frame("f", "outer", { width: 200, height: 100, widthMode: "fill", heightMode: "fill" }),
      rect("flow", "f", { x: 0, y: 0, width: 50, height: 50 }),
      rect("pinned", "f", { x: 150, y: 70, width: 40, height: 20, constraints: { horizontal: "end", vertical: "end" } }),
      rect("scaled", "f", { x: 20, y: 10, width: 100, height: 50, constraints: { horizontal: "scale", vertical: "center" } }),
    ]);
    expect(box("pinned")).toEqual([150, 70, 40, 20]);
    expect(box("scaled")).toEqual([20, 10, 100, 50]);
    // Growing the outer frame grows the fill frame: right and bottom insets (10 and 10) are kept,
    // scaled children keep their proportions, centered ones their offset from the center.
    doc.apply([{ type: "updateProps", id: "outer", props: { width: 300, height: 160 } }], user);
    expect(box("f")).toEqual([0, 0, 300, 160]);
    expect(box("pinned")).toEqual([250, 130, 40, 20]);
    expect(box("scaled")).toEqual([30, 40, 150, 50]);
    expect(box("flow")).toEqual([0, 0, 50, 50]);
  });

  it("flattens groups: their children join the group's parent", () => {
    const { box } = setup((page) => [
      frame("f", page, { x: 10, y: 10, width: 200, height: 100 }),
      { type: "createNode", node: { id: "grp", type: "group" }, parent: "f" },
      rect("in-group", "grp", { x: 30, y: 40, width: 20, height: 20 }),
    ]);
    expect(box("in-group")).toEqual([30, 40, 20, 20]);
  });

  it("matches the layout engine run on the stated CSS", () => {
    const { doc, bridge } = setup(rowFrame);
    const engine = cssTree(doc, "row");
    computeLayout(engine.root, 0, 0);
    for (const [id, n] of engine.nodes) {
      if (id === "row") continue;
      const b = bridge.box(id)!;
      expect([b.x, b.y, b.width, b.height]).toEqual([n.out.x, n.out.y, n.out.width, n.out.height]);
    }
  });

  it("reflows when gap, padding and alignment change, recompiling only nodes that moved", () => {
    const { doc, user, bridge, box } = setup(rowFrame);
    doc.apply([{ type: "updateProps", id: "row", props: { columnGap: 20 } }], user);
    expect(box("b")).toEqual([80, 40, 230, 20]);
    expect(box("c")).toEqual([330, 10, 60, 80]);
    // The frame itself, plus b which moved and resized; a and c stay put.
    expect(bridge.lastCompiled).toBe(2);
    doc.apply([{ type: "updateProps", id: "row", props: { padding: { top: 20, right: 20, bottom: 20, left: 20 } } }], user);
    expect(box("a")).toEqual([20, 30, 50, 40]);
    expect(box("c")).toEqual([320, 20, 60, 60]);
    doc.apply([{ type: "updateProps", id: "row", props: { alignItems: "flex-end" } }], user);
    expect(box("a")).toEqual([20, 40, 50, 40]);
    // A paint change does not relayout anything.
    doc.apply([{ type: "updateProps", id: "a", props: { fills: [{ type: "solid", color: { r: 0, g: 0, b: 1, a: 1 } }] } }], user);
    expect(bridge.lastCompiled).toBe(1);
    expect(bridge.lastRelaidOut).toBe(0);
    expect(bridge.layout.lastStats.layouts).toBe(0);
  });

  it("follows structural edits: inserted, moved, hidden and deleted children", () => {
    const { doc, user, box } = setup(rowFrame);
    doc.apply([rect("d", "row", { width: 30, height: 30 })], user);
    // The new child joins the flow (created as position: relative inside a flex frame).
    expect(box("d")).toEqual([360, 35, 30, 30]);
    expect(box("b")[2]).toBe(216);
    doc.apply([{ type: "updateProps", id: "d", props: { visible: false } }], user);
    expect(box("b")[2]).toBe(254);
    doc.apply([{ type: "reorder", id: "a", index: 3 }], user);
    expect(box("a")[0]).toBeGreaterThan(box("c")[0]);
    doc.apply([{ type: "delete", ids: ["c"] }], user);
    expect(box("b")[2]).toBe(254 + 60 + 8);
  });

  it("re-lays out a 10,000-node document of auto-layout frames incrementally", () => {
    const { doc, page, user } = makeDoc(12);
    const commands: Command[] = [];
    for (let f = 0; f < 100; f++) {
      commands.push(
        frame(`f${f}`, page, {
          x: (f % 10) * 600,
          y: Math.floor(f / 10) * 400,
          width: 580,
          height: 380,
          ...(f % 2 ? { display: "flex", flexWrap: "wrap", rowGap: 6, columnGap: 6, padding: { top: 10, right: 10, bottom: 10, left: 10 } } : { display: "grid", gridTemplateColumns: [{ type: "repeat", count: 10, tracks: [{ type: "fr", value: 1 }] }], rowGap: 4, columnGap: 4 }),
        }),
      );
      for (let i = 0; i < 99; i++) commands.push(rect(`n${f}-${i}`, `f${f}`, { width: 40 + (i % 7) * 3, height: 20 + (i % 5) * 4 }));
    }
    doc.apply(commands, user);
    const scene = new Scene();
    let t = performance.now();
    const bridge = new SceneBridge(doc, scene);
    const buildMs = performance.now() - t;
    expect(bridge.box("n31-5")!.x).toBeGreaterThan(0);
    const list = new DrawList();
    list.sync(scene);
    const samples: number[] = [];
    const relaid: number[] = [];
    for (let k = 0; k < 41; k++) {
      const id = `n${(k * 3) % 100}-${(k * 7) % 99}`;
      const s = performance.now();
      doc.apply([{ type: "updateProps", id, props: { width: 30 + (k % 9) * 5 } }], user);
      list.sync(scene);
      samples.push(performance.now() - s);
      relaid.push(bridge.layout.lastStats.layouts);
      // Only the edited frame's subtree moves: nothing in other frames is recompiled.
      expect(bridge.lastCompiled).toBeLessThanOrEqual(100);
    }
    samples.sort((a, b) => a - b);
    relaid.sort((a, b) => a - b);
    console.log(`[layout bridge 10k] build ${buildMs.toFixed(0)} ms; width edit in an auto-layout frame median ${samples[20]!.toFixed(2)} ms, max ${samples[40]!.toFixed(2)} ms; layouts per edit median ${relaid[20]} max ${relaid[40]}`);
    expect(samples[20]!).toBeLessThan(16);
  }, 120_000);
});

/** The layout tree of a frame built straight from its nodes' CSS declarations. */
function cssTree(doc: FigDocument, id: string): { root: LayoutNode; nodes: Map<string, LayoutNode> } {
  const nodes = new Map<string, LayoutNode>();
  const build = (n: string): LayoutNode => {
    const node = new LayoutNode(parseStyle(cssDeclarations(doc, n)));
    nodes.set(n, node);
    for (const c of doc.tree.childrenOf(n)) node.appendChild(build(c));
    return node;
  };
  return { root: build(id), nodes };
}
