import {
  booleanOperation,
  contoursArea,
  pathContours,
  pathShape,
  regionPath,
  roundedPolygonPath,
  validateNetwork,
  type FillShape,
  type Path,
  type VectorNetwork as GeometryNetwork,
} from "@fig-tree/geometry";
import { Scene, type SceneNode } from "@fig-tree/renderer";
import { FontRegistry, loadHarfBuzz } from "@fig-tree/text";
import { beforeAll, describe, expect, it } from "vitest";
import { fixtureRegistry } from "../../text/conformance/fonts";
import { CommandError, FigDocument, SceneBridge, VectorNetwork, booleanContours, seededRandom, textToVectorNetwork, type Command } from "../src";
import { outlinePath } from "../src/bridge/geometry";
import { makeDoc } from "./helpers";

const RED = { type: "solid" as const, color: { r: 1, g: 0, b: 0, a: 1 } };
const BLUE = { type: "solid" as const, color: { r: 0, g: 0, b: 1, a: 1 } };

function setup(commands: (page: string) => Command[]) {
  const { doc, page, user } = makeDoc(5);
  doc.apply(commands(page), user);
  return { doc, page, user };
}

/** Total filled area of a vector node's regions (each region with its own rule, unioned). */
function networkArea(net: GeometryNetwork): number {
  const shapes: FillShape[] = net.regions.map((r, i) => ({ fillRule: r.fillRule, contours: pathContours(regionPath(net, i)) }));
  return Math.abs(contoursArea(booleanOperation("union", [{ shapes }]).contours));
}

function pathArea(p: Path): number {
  return Math.abs(contoursArea(booleanOperation("union", [{ shapes: [pathShape(p)] }]).contours));
}

const square = { vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }], segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 0 }], regions: [] };

describe("editVector", () => {
  it("applies a batch of network edits as one undoable step", () => {
    const { doc, page, user } = setup((p) => [{ type: "createNode", node: { id: "v", type: "vector", props: { vectorNetwork: square, fills: [RED] } }, parent: p }]);
    void page;
    const r = doc.apply(
      [
        {
          type: "editVector",
          id: "v",
          ops: [
            { op: "toggleFill", x: 50, y: 50 },
            { op: "splitSegment", segment: 0, t: 0.5 },
            { op: "bendSegment", segment: 4, t: 0.5, x: 75, y: -20 },
            { op: "setVertex", vertex: 2, cornerRadius: 10 },
            { op: "setMirroring", vertex: 4, mirroring: "angle" },
          ],
        },
      ],
      user,
    );
    expect(r.affected).toEqual(["v"]);
    const net = doc.get<GeometryNetwork>("v", "vectorNetwork");
    expect(validateNetwork(net)).toEqual([]);
    expect(VectorNetwork.safeParse(net).success).toBe(true);
    expect(net.regions[0]!.loops[0]).toEqual([0, 4, 1, 2, 3]);
    expect(net.vertices[2]!.cornerRadius).toBe(10);
    doc.undoManager(user).undo();
    expect(doc.get<GeometryNetwork>("v", "vectorNetwork").regions).toEqual([]);
  });

  it("rejects an invalid operation with its position, and applies nothing", () => {
    const { doc, user } = setup((p) => [{ type: "createNode", node: { id: "v", type: "vector", props: { vectorNetwork: square } }, parent: p }]);
    const before = JSON.stringify(doc.get("v", "vectorNetwork"));
    expect(() => doc.apply([{ type: "editVector", id: "v", ops: [{ op: "addVertex", x: 1, y: 1 }, { op: "addSegment", start: 0, end: 99 }] }], user)).toThrow(
      /op 1 \(addSegment\): vertex 99 does not exist/,
    );
    expect(JSON.stringify(doc.get("v", "vectorNetwork"))).toBe(before);
    expect(() => doc.apply([{ type: "editVector", id: "v", ops: [{ op: "straightenSegment", segment: 7 }] }], user)).toThrow(CommandError);
  });

  it("keeps networks valid under 2,000 random edit operations through the command API", () => {
    const { doc, user } = setup((p) => [{ type: "createNode", node: { id: "v", type: "vector", props: { vectorNetwork: square } }, parent: p }]);
    const rand = seededRandom(11);
    const pick = (n: number): number => Math.floor(rand() * n);
    const coord = (): number => Math.round((rand() * 200 - 50) * 4) / 4;
    let applied = 0;
    for (let i = 0; i < 2000; i++) {
      const net = doc.get<GeometryNetwork>("v", "vectorNetwork");
      const nv = net.vertices.length, ns = net.segments.length;
      const ops: Command[] = [];
      const k = pick(10);
      const op =
        k === 0 ? { op: "addVertex", x: coord(), y: coord() }
        : k === 1 && nv > 1 ? { op: "addSegment", start: pick(nv), end: pick(nv), tangentStart: { x: coord() / 4, y: coord() / 4 } }
        : k === 2 && ns > 0 ? { op: "splitSegment", segment: pick(ns), t: 0.1 + rand() * 0.8 }
        : k === 3 && nv > 0 ? { op: "deleteVertex", vertex: pick(nv) }
        : k === 4 && ns > 0 ? { op: "bendSegment", segment: pick(ns), t: rand(), x: coord(), y: coord() }
        : k === 5 ? { op: "toggleFill", x: coord(), y: coord() }
        : k === 6 && nv > 1 ? { op: "closePath", start: pick(nv), end: pick(nv) }
        : k === 7 && nv > 0 ? { op: "setMirroring", vertex: pick(nv), mirroring: (["none", "angle", "angle-length"] as const)[pick(3)] }
        : k === 8 && nv > 1 ? { op: "mergeVertices", keep: pick(nv), remove: pick(nv) }
        : nv > 0 ? { op: "moveVertices", vertices: [pick(nv)], dx: coord() / 10, dy: coord() / 10 }
        : { op: "addVertex", x: coord(), y: coord() };
      ops.push({ type: "editVector", id: "v", ops: [op as never] });
      try {
        doc.apply(ops, user);
        applied++;
      } catch (e) {
        expect(e).toBeInstanceOf(CommandError);
      }
      if (i % 50 === 0) expect(VectorNetwork.safeParse(doc.get("v", "vectorNetwork")).success).toBe(true);
    }
    expect(applied).toBeGreaterThan(1500);
    expect(validateNetwork(doc.get<GeometryNetwork>("v", "vectorNetwork"))).toEqual([]);
  });
});

describe("flatten", () => {
  const shapes = (p: string): Command[] => [
    { type: "createNode", node: { id: "rect", type: "rectangle", props: { x: 10, y: 20, width: 120, height: 80, cornerRadius: { topLeft: 20, topRight: 0, bottomRight: 30, bottomLeft: 5 }, cornerSmoothing: 0.6, fills: [RED], rotation: 30 } }, parent: p },
    { type: "createNode", node: { id: "ell", type: "ellipse", props: { x: 200, y: 0, width: 100, height: 60, arcStart: 30, arcSweep: 250, innerRadius: 0.4, fills: [BLUE] } }, parent: p },
    { type: "createNode", node: { id: "donut", type: "ellipse", props: { x: 400, y: 0, width: 100, height: 100, innerRadius: 0.5, fills: [BLUE] } }, parent: p },
    { type: "createNode", node: { id: "poly", type: "polygon", props: { x: 0, y: 200, width: 90, height: 80, pointCount: 6, cornerRadius: 8, fills: [RED] } }, parent: p },
    { type: "createNode", node: { id: "star", type: "star", props: { x: 200, y: 200, width: 90, height: 90, pointCount: 5, innerRadius: 0.4, cornerRadius: 3, fills: [BLUE] } }, parent: p },
    { type: "createNode", node: { id: "line", type: "line", props: { x: 0, y: 400, width: 150, strokes: [RED], strokeWeight: 2 } }, parent: p },
    { type: "createNode", node: { id: "vec", type: "vector", props: { x: 300, y: 300, vectorNetwork: { ...square, regions: [{ loops: [[0, 1, 2, 3]], fillRule: "nonzero" }] }, cornerRadius: 12, fills: [RED] } }, parent: p },
  ];

  it("turns every primitive into an equivalent vector, keeping its box and paints", () => {
    for (const id of ["rect", "ell", "donut", "poly", "star", "line", "vec"]) {
      const { doc, user } = setup(shapes);
      const type = doc.typeOf(id)!;
      const w = doc.get<number>(id, "width"), h = doc.get<number>(id, "height");
      const before = type === "vector" ? null : type === "line" ? null : outlinePath(doc, id, type, w, h)!;
      const box = ["x", "y", "width", "height", "rotation"].map((k) => doc.get(id, k));
      const fills = doc.get(id, "fills");
      const r = doc.apply([{ type: "flatten", ids: [id], id: `${id}-v` }], user);
      expect(r.created).toEqual([`${id}-v`]);
      expect(r.deleted).toEqual([id]);
      const v = `${id}-v`;
      expect(doc.typeOf(v)).toBe("vector");
      expect(["x", "y", "width", "height", "rotation"].map((k) => doc.get(v, k))).toEqual(box);
      expect(doc.get(v, "fills")).toEqual(fills);
      const net = doc.get<GeometryNetwork>(v, "vectorNetwork");
      expect(validateNetwork(net)).toEqual([]);
      if (before) expect(networkArea(net)).toBeCloseTo(pathArea(before), 6);
      if (type === "vector") {
        // Corner radii are baked in: the flattened square is the rounded square.
        const rounded = pathArea(roundedPolygonPath([[0, 0], [100, 0], [100, 100], [0, 100]], 12));
        expect(networkArea(net)).toBeCloseTo(rounded, 3);
        expect(doc.get(v, "cornerRadius")).toBe(0);
      }
      if (type === "line") expect(net.segments).toHaveLength(1);
    }
  });

  it("merges several nodes into one vector in their parent's space, each keeping its fills", () => {
    const { doc, user, page } = setup(shapes);
    const r = doc.apply([{ type: "flatten", ids: ["rect", "poly", "star"], id: "merged" }], user);
    expect([...r.deleted].sort()).toEqual(["poly", "rect", "star"]);
    expect(doc.tree.childrenOf(page)).toContain("merged");
    const net = doc.get<{ regions: { fills?: unknown }[] }>("merged", "vectorNetwork");
    expect(net.regions).toHaveLength(3);
    expect(net.regions.map((reg) => reg.fills)).toEqual([[RED], [RED], [BLUE]]);
    // The box is the union of the parts' bounds.
    expect(doc.get<number>("merged", "x")).toBeLessThan(10);
    expect(doc.get<number>("merged", "width")).toBeGreaterThan(200);
  });

  it("refuses text (its outlines need fonts: use textToVectorNetwork through the bridge)", () => {
    const { doc, user } = setup((p) => [{ type: "createNode", node: { id: "t", type: "text", text: { content: "Hi", runs: [] } }, parent: p }]);
    expect(() => doc.apply([{ type: "flatten", ids: ["t"] }], user)).toThrow(/textToVectorNetwork/);
  });
});

describe("boolean groups", () => {
  const twoCircles = (p: string): Command[] => [
    { type: "createNode", node: { id: "a", type: "ellipse", props: { x: 0, y: 0, width: 100, height: 100, fills: [RED], strokes: [BLUE], strokeWeight: 3 } }, parent: p },
    { type: "createNode", node: { id: "b", type: "ellipse", props: { x: 60, y: 20, width: 80, height: 80, fills: [BLUE] } }, parent: p },
  ];
  const circleArea = (r: number): number => Math.PI * r * r;

  it("creates boolean groups that take their paints from the bottom operand", () => {
    const { doc, user } = setup(twoCircles);
    doc.apply([{ type: "group", ids: ["a", "b"], id: "u", booleanOperation: "union" }], user);
    expect(doc.get("u", "booleanOperation")).toBe("union");
    expect(doc.get("u", "name")).toBe("Union");
    expect(doc.get("u", "fills")).toEqual([RED]);
    expect(doc.get("u", "strokes")).toEqual([BLUE]);
    expect(doc.get("u", "strokeWeight")).toBe(3);
  });

  it("computes every operation from its children (areas against the geometry engine)", () => {
    for (const op of ["union", "subtract", "intersect", "exclude"] as const) {
      const { doc, user } = setup(twoCircles);
      doc.apply([{ type: "group", ids: ["a", "b"], id: "g", booleanOperation: op }], user);
      const contours = booleanContours({ typeOf: (id) => doc.typeOf(id), get: (id, k) => doc.get(id, k), childrenOf: (id) => doc.tree.childrenOf(id) }, "g");
      const a = pathShape(outlinePath(doc, "a", "ellipse", 100, 100)!);
      const b = pathShape(outlinePath(doc, "b", "ellipse", 80, 80)!);
      const shift = (s: FillShape, dx: number, dy: number): FillShape => ({ fillRule: s.fillRule, contours: s.contours.map((c) => c.map((q) => ({ ...q, x0: q.x0 + dx, x1: q.x1 + dx, x2: q.x2 + dx, x3: q.x3 + dx, y0: q.y0 + dy, y1: q.y1 + dy, y2: q.y2 + dy, y3: q.y3 + dy }))) });
      const want = booleanOperation(op, [{ shapes: [a] }, { shapes: [shift(b, 60, 20)] }]).contours;
      expect(Math.abs(contoursArea(contours))).toBeCloseTo(Math.abs(contoursArea(want)), 6);
    }
    expect(circleArea(50)).toBeGreaterThan(0);
  });

  it("renders the result through the bridge, re-evaluates when a child changes, and hides the operands", () => {
    const { doc, user } = setup(twoCircles);
    doc.apply([{ type: "group", ids: ["a", "b"], id: "g", booleanOperation: "subtract" }], user);
    const scene = new Scene();
    const bridge = new SceneBridge(doc, scene);
    const main = bridge.sceneNodeFor("g")!;
    expect(main.fill).toEqual({ type: "solid", color: RED.color });
    // The stroke came from the bottom operand with its alignment (inside): a clipped stroke node.
    expect(doc.get("g", "strokeAlign")).toBe("inside");
    expect(main.children.some((c) => c.name === "g:stroke-inside")).toBe(true);
    const areaOf = (n: SceneNode): number => pathArea(n.path!);
    const subtractArea = areaOf(main);
    expect(subtractArea).toBeLessThan(circleArea(50));
    expect(subtractArea).toBeGreaterThan(circleArea(50) - circleArea(40));
    // The operands are compiled but hidden.
    const host = main.children.find((c) => c.name === "g:operands")!;
    expect(host.visible).toBe(false);
    expect(host.children.map((c) => bridge.nodeIdFor(c))).toEqual(["a", "b"]);
    expect(bridge.unsupported.get("g")).toBeUndefined();
    // Move b away: the subtraction leaves the whole circle.
    doc.apply([{ type: "updateProps", id: "b", props: { x: 500 } }], user);
    expect(areaOf(bridge.sceneNodeFor("g")!)).toBeCloseTo(pathArea(outlinePath(doc, "a", "ellipse", 100, 100)!), 6);
    expect(bridge.lastCompiled).toBe(2); // b and its boolean group
    // Change the operation.
    doc.apply([{ type: "updateProps", id: "g", props: { booleanOperation: "union" } }], user);
    expect(areaOf(bridge.sceneNodeFor("g")!)).toBeGreaterThan(circleArea(50) + circleArea(40) - 1);
    // A plain group again: the children are drawn themselves.
    doc.apply([{ type: "updateProps", id: "g", props: { booleanOperation: "none" } }], user);
    const plain = bridge.sceneNodeFor("g")!;
    expect(plain.path).toBeNull();
    expect(plain.children.map((c) => bridge.nodeIdFor(c))).toEqual(["a", "b"]);
    // Deleting an operand updates the result; undo restores it.
    doc.apply([{ type: "updateProps", id: "g", props: { booleanOperation: "intersect" } }], user);
    const inter = areaOf(bridge.sceneNodeFor("g")!);
    doc.apply([{ type: "updateProps", id: "b", props: { x: 60 } }], user);
    const inter2 = areaOf(bridge.sceneNodeFor("g")!);
    expect(inter2).toBeGreaterThan(inter);
  });

  it("nests boolean groups and plain groups as operands", () => {
    const { doc, user } = setup((p) => [
      ...twoCircles(p),
      { type: "createNode", node: { id: "c", type: "rectangle", props: { x: 40, y: 40, width: 20, height: 100, fills: [RED] } }, parent: p },
      { type: "createNode", node: { id: "d", type: "rectangle", props: { x: 0, y: 130, width: 140, height: 10, fills: [RED] } }, parent: p },
    ]);
    doc.apply([{ type: "group", ids: ["a", "b"], id: "inner", booleanOperation: "union" }], user);
    doc.apply([{ type: "group", ids: ["c", "d"], id: "plain" }], user);
    doc.apply([{ type: "group", ids: ["inner", "plain"], id: "outer", booleanOperation: "subtract" }], user);
    const bridge = new SceneBridge(doc, new Scene());
    const outer = pathArea(bridge.sceneNodeFor("outer")!.path!);
    const inner = pathArea(bridge.sceneNodeFor("inner")!.path!);
    expect(outer).toBeLessThan(inner);
    // Editing a leaf two levels down recompiles both boolean groups.
    doc.apply([{ type: "updateProps", id: "c", props: { width: 40 } }], user);
    expect(pathArea(bridge.sceneNodeFor("outer")!.path!)).toBeLessThan(outer);
    // Flatten the outer boolean into a vector with the same area.
    doc.apply([{ type: "flatten", ids: ["outer"], id: "flat" }], user);
    const net = doc.get<GeometryNetwork>("flat", "vectorNetwork");
    expect(networkArea(net)).toBeCloseTo(pathArea(bridge.sceneNodeFor("flat")!.children.find((n) => n.name === "flat:region0")?.path ?? new SceneNodePathFallback(net).path), 3);
  });

  it("re-evaluates a boolean group of 1,000 children incrementally (timing)", () => {
    const { doc, user, page } = setup(() => []);
    const commands: Command[] = [];
    for (let i = 0; i < 1000; i++) {
      const col = i % 40, row = Math.floor(i / 40);
      commands.push({ type: "createNode", node: { id: `n${i}`, type: i % 2 ? "ellipse" : "rectangle", props: { x: col * 25, y: row * 100, width: 32, height: 40, ...(i % 2 ? {} : { cornerRadius: 6 }), fills: [RED] } }, parent: page });
    }
    doc.apply(commands, user);
    doc.apply([{ type: "group", ids: Array.from({ length: 1000 }, (_, i) => `n${i}`), id: "big", booleanOperation: "union" }], user);
    let t = performance.now();
    const bridge = new SceneBridge(doc, new Scene());
    const build = performance.now() - t;
    const times: number[] = [];
    for (let k = 0; k < 9; k++) {
      t = performance.now();
      doc.apply([{ type: "updateProps", id: `n${(k * 97) % 1000}`, props: { y: Math.floor(((k * 97) % 1000) / 40) * 100 + 5 + k } }], user);
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    console.log(`[boolean group perf] 1,000 children: bridge build ${build.toFixed(0)} ms (incl. layout and every child), child edit → result redrawn median ${times[4]!.toFixed(1)} ms, max ${times[8]!.toFixed(1)} ms`);
    expect(bridge.sceneNodeFor("big")!.path!.isEmpty()).toBe(false);
    expect(times[4]!).toBeLessThan(build);
  });
});

describe("outline stroke", () => {
  it("outlines centered, inside and outside strokes into a vector filled with the stroke paint", () => {
    for (const [align, factor] of [["center", 1], ["inside", 1], ["outside", 1]] as const) {
      const { doc, user } = setup((p) => [{ type: "createNode", node: { id: "r", type: "rectangle", props: { x: 10, y: 10, width: 100, height: 60, fills: [RED], strokes: [BLUE], strokeWeight: 4, strokeAlign: align } }, parent: p }]);
      const r = doc.apply([{ type: "outlineStroke", id: "r", newId: "s" }], user);
      expect(r.created).toEqual(["s"]);
      expect(doc.get("r", "strokes")).toEqual([]);
      expect(doc.get("s", "fills")).toEqual([BLUE]);
      const area = networkArea(doc.get<GeometryNetwork>("s", "vectorNetwork"));
      // A band of width 4 around (or inside, or outside) the 100 × 60 rectangle, with miter corners.
      const want = align === "center" ? 104 * 64 - 96 * 56 : align === "inside" ? 100 * 60 - 92 * 52 : 108 * 68 - 100 * 60;
      expect(area).toBeCloseTo(want * factor, 3);
    }
  });

  it("replaces a node without fills, and outlines open vector paths", () => {
    const { doc, user, page } = setup((p) => [
      { type: "createNode", node: { id: "v", type: "vector", props: { vectorNetwork: { vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }], segments: [{ start: 0, end: 1 }], regions: [] }, strokes: [RED], strokeWeight: 10, strokeCap: "round" } }, parent: p },
    ]);
    doc.apply([{ type: "outlineStroke", id: "v", newId: "o" }], user);
    expect(doc.has("v")).toBe(false);
    expect(doc.tree.childrenOf(page)).toEqual(["o"]);
    expect(networkArea(doc.get<GeometryNetwork>("o", "vectorNetwork"))).toBeCloseTo(1000 + Math.PI * 25, 1);
  });
});

describe("vector rendering", () => {
  it("draws vertex corner radii (no longer unsupported)", () => {
    const { doc } = setup((p) => [
      { type: "createNode", node: { id: "v", type: "vector", props: { vectorNetwork: { ...square, regions: [{ loops: [[0, 1, 2, 3]], fillRule: "nonzero" }] }, cornerRadius: 20, fills: [RED], strokes: [BLUE] } }, parent: p },
    ]);
    const bridge = new SceneBridge(doc, new Scene());
    expect(bridge.unsupported.get("v")).toBeUndefined();
    const region = bridge.sceneNodeFor("v")!.children.find((n) => n.name === "v:region0")!;
    expect(pathArea(region.path!)).toBeCloseTo(pathArea(roundedPolygonPath([[0, 0], [100, 0], [100, 100], [0, 100]], 20)), 3);
  });
});

describe("text outlines", () => {
  let fonts: FontRegistry;
  beforeAll(async () => {
    await loadHarfBuzz();
    fonts = fixtureRegistry();
  });

  it("flattens text to a network of glyph outlines where the renderer draws them", () => {
    const doc = FigDocument.create({ random: seededRandom(3), clientId: 1 });
    const page = doc.pages[0]!;
    doc.apply([{ type: "createNode", node: { id: "t", type: "text", props: { fontFamily: "Inter", fontSize: 40, fills: [RED], x: 0, y: 0 }, text: { content: "Hello", runs: [] } }, parent: page }], doc.actor("a"));
    const bridge = new SceneBridge(doc, new Scene(), { fonts });
    const net = textToVectorNetwork(bridge, "t");
    expect(net).not.toBeNull();
    expect(validateNetwork(net!)).toEqual([]);
    // Every glyph contour is a loop of the one region.
    expect(net!.regions[0]!.loops.length).toBe(pathContours(bridge.textOutlinePath("t")!).length);
    expect(net!.regions[0]!.loops.length).toBeGreaterThanOrEqual(6);
    const box = bridge.box("t")!;
    const b = net!.vertices.reduce((m, v) => ({ minX: Math.min(m.minX, v.x), maxX: Math.max(m.maxX, v.x), minY: Math.min(m.minY, v.y), maxY: Math.max(m.maxY, v.y) }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
    expect(b.minX).toBeGreaterThanOrEqual(0);
    expect(b.maxX).toBeLessThanOrEqual(box.width + 1);
    expect(b.maxY).toBeLessThanOrEqual(box.height);
    // Usable as a boolean operand: a text in a boolean group.
    doc.apply([{ type: "createNode", node: { id: "bar", type: "rectangle", props: { x: 0, y: 15, width: 200, height: 10, fills: [RED] } }, parent: page }], doc.actor("a"));
    doc.apply([{ type: "group", ids: ["t", "bar"], id: "g", booleanOperation: "union" }], doc.actor("a"));
    expect(bridge.sceneNodeFor("g")!.path!.isEmpty()).toBe(false);
  });
});

/** Fallback used only to compute a flattened network's area when the scene has no region node. */
class SceneNodePathFallback {
  constructor(private readonly net: GeometryNetwork) {}
  get path(): Path {
    const p = regionPath(this.net, 0);
    return p;
  }
}

void ({} as FontRegistry);
