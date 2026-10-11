import { describe, expect, it } from "vitest";
import { Scene, type SceneNode } from "@fig-tree/renderer";
import { DrawList } from "../../renderer/src/compile";
import { CommandError, FigDocument, REMOTE, ROOT_ID, SceneBridge, seededRandom, type Command } from "../src";
import { randomCommand } from "./convergence-harness";
import { makeDoc } from "./helpers";

const RED = { type: "solid" as const, color: { r: 1, g: 0, b: 0, a: 1 } };
const BLUE = { type: "solid" as const, color: { r: 0, g: 0, b: 1, a: 0.5 } };
const stops = [
  { position: 0, color: { r: 1, g: 1, b: 1, a: 1 } },
  { position: 1, color: { r: 0, g: 0, b: 0, a: 1 } },
];

function setup(commands: Command[]) {
  const { doc, page, user } = makeDoc(3);
  doc.apply(commands.map((c) => ("parent" in c && c.parent === "PAGE" ? { ...c, parent: page } : c)) as Command[], user);
  const scene = new Scene();
  const bridge = new SceneBridge(doc, scene);
  return { doc, page, user, scene, bridge };
}

/** A structural description of a scene subtree, for comparisons. */
function describeScene(n: SceneNode): unknown {
  const b = n.path?.bounds();
  return {
    name: n.name,
    t: n.transform.map((v) => Math.round(v * 1e6) / 1e6),
    v: n.visible,
    o: n.opacity,
    clip: n.clipsContent,
    rule: n.fillRule,
    path: b ? [b.minX, b.minY, b.maxX, b.maxY].map((v) => Math.round(v * 1e6) / 1e6) : null,
    verbs: n.path ? Array.from(n.path.verbs).join("") : null,
    fill: n.fill,
    stroke: n.stroke,
    kids: n.children.map(describeScene),
  };
}

/** Every node of the bridge's page is in the scene, under its document parent's scene node. */
function expectProjected(doc: FigDocument, bridge: SceneBridge, scene: Scene): void {
  const reachable = new Set<SceneNode>();
  const walk = (n: SceneNode): void => {
    reachable.add(n);
    n.children.forEach(walk);
  };
  walk(scene.root);
  for (const id of doc.tree.subtree(bridge.page)) {
    const main = bridge.sceneNodeFor(id);
    expect(main && reachable.has(main), `${id} is in the scene`).toBe(true);
    const parent = doc.tree.parentOf(id)!;
    if (parent !== ROOT_ID) expect(bridge.nodeIdFor(main!.parent)).toBe(parent);
  }
}

describe("SceneBridge structure", () => {
  it("maps a frame's fills, children, clip and strokes to scene nodes in paint order", () => {
    const { scene, bridge } = setup([
      {
        type: "createNode",
        node: {
          id: "f",
          type: "frame",
          props: { x: 10, y: 20, width: 200, height: 100, cornerRadius: 8, fills: [RED, BLUE], strokes: [RED, BLUE], strokeAlign: "center", strokeWeight: 2, opacity: 0.5 },
        },
        parent: "PAGE",
      },
      { type: "createNode", node: { id: "r", type: "rectangle", props: { x: 5, y: 5, width: 50, height: 50, fills: [BLUE] } }, parent: "f" },
    ]);
    const page = scene.root.children[0]!;
    const f = page.children[0]!;
    expect(f).toBe(bridge.sceneNodeFor("f"));
    expect(f.transform).toEqual([1, 0, 0, 1, 10, 20]);
    expect(f.opacity).toBe(0.5);
    expect(f.fill).toEqual({ type: "solid", color: RED.color });
    expect(f.path?.bounds()).toEqual({ minX: 0, minY: 0, maxX: 200, maxY: 100 });
    // [second fill, children host, lower stroke]; the top stroke rides on main.
    expect(f.children.map((c) => c.name)).toEqual(["f:fill", "f:children", "f:stroke"]);
    expect(f.children[0]!.fill).toEqual({ type: "solid", color: BLUE.color });
    const host = f.children[1]!;
    expect(host.clipsContent).toBe(true);
    expect(host.children).toEqual([bridge.sceneNodeFor("r")]);
    expect(f.children[2]!.stroke?.paint).toEqual({ type: "solid", color: RED.color });
    expect(f.stroke?.paint).toEqual({ type: "solid", color: BLUE.color });
    expect(bridge.nodeIdFor(f.children[2]!)).toBe("f");
    expect(bridge.nodeIdFor(bridge.sceneNodeFor("r")!)).toBe("r");
  });

  it("aligns strokes inside and outside with clipped double-width strokes", () => {
    const { scene } = setup([
      { type: "createNode", node: { id: "in", type: "rectangle", props: { strokes: [RED], strokeWeight: 4, strokeAlign: "inside" } }, parent: "PAGE" },
      { type: "createNode", node: { id: "out", type: "ellipse", props: { strokes: [RED], strokeWeight: 3, strokeAlign: "outside" } }, parent: "PAGE" },
    ]);
    const [inside, outside] = scene.root.children[0]!.children;
    const clipIn = inside!.children[0]!;
    expect(clipIn.clipsContent).toBe(true);
    expect(clipIn.fillRule).toBe("nonzero");
    expect(clipIn.children[0]!.stroke?.width).toBe(8);
    const clipOut = outside!.children[0]!;
    expect(clipOut.fillRule).toBe("evenodd");
    expect(clipOut.children[0]!.stroke?.width).toBe(6);
    expect(clipOut.path!.bounds().minX).toBeLessThan(-6);
  });

  it("maps gradient handles from the node box to local space", () => {
    const { scene } = setup([
      {
        type: "createNode",
        node: {
          id: "g",
          type: "rectangle",
          props: {
            width: 200,
            height: 100,
            fills: [
              { type: "linear-gradient", start: { x: 0, y: 0.5 }, end: { x: 1, y: 0.5 }, stops, opacity: 0.5 },
              { type: "radial-gradient", center: { x: 0.5, y: 0.5 }, radiusX: { x: 1, y: 0.5 }, radiusY: { x: 0.5, y: 1 }, stops },
            ],
          },
        },
        parent: "PAGE",
      },
    ]);
    const g = scene.root.children[0]!.children[0]!;
    expect(g.fill).toEqual({
      type: "linear-gradient",
      start: { x: 0, y: 50 },
      end: { x: 200, y: 50 },
      stops: [
        { offset: 0, color: { r: 1, g: 1, b: 1, a: 0.5 } },
        { offset: 1, color: { r: 0, g: 0, b: 0, a: 0.5 } },
      ],
    });
    expect(g.children[0]!.fill).toMatchObject({ type: "radial-gradient", center: { x: 0, y: 0 }, radius: 1, transform: [100, 0, 0, 50, 100, 50] });
  });

  it("draws every shape type from its properties", () => {
    const { scene } = setup([
      { type: "createNode", node: { id: "e", type: "ellipse", props: { width: 100, height: 50, arcSweep: 180, innerRadius: 0.5, fills: [RED] } }, parent: "PAGE" },
      { type: "createNode", node: { id: "p", type: "polygon", props: { pointCount: 6, cornerRadius: 4, fills: [RED] } }, parent: "PAGE" },
      { type: "createNode", node: { id: "s", type: "star", props: { pointCount: 5, fills: [RED] } }, parent: "PAGE" },
      { type: "createNode", node: { id: "l", type: "line", props: { width: 80, rotation: 45, strokes: [RED] } }, parent: "PAGE" },
      {
        type: "createNode",
        node: {
          id: "v",
          type: "vector",
          props: {
            fills: [RED],
            strokes: [BLUE],
            vectorNetwork: {
              vertices: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 80, y: 40 }],
              segments: [{ start: 0, end: 1 }, { start: 1, end: 2, tangentStart: { x: 10, y: 0 }, tangentEnd: { x: 0, y: -10 } }, { start: 2, end: 0 }, { start: 2, end: 3 }],
              regions: [{ loops: [[0, 1, 2]], fillRule: "evenodd" }],
            },
          },
        },
        parent: "PAGE",
      },
    ]);
    const [e, p, s, l, v] = scene.root.children[0]!.children;
    expect(e!.path!.bounds().minY).toBeCloseTo(25, 6);
    // A rounded hexagon stays inside its box; the sharp one touches it.
    expect(p!.path!.bounds().minY).toBeGreaterThan(0);
    expect(p!.path!.bounds().maxY).toBeLessThanOrEqual(100);
    expect(s!.path!.verbCount).toBeGreaterThan(10);
    expect(l!.stroke?.width).toBe(1);
    expect(l!.transform[0]).toBeCloseTo(Math.SQRT1_2, 9);
    // Regions are filled by children with their own rule; main strokes every segment.
    expect(v!.fill).toBeNull();
    expect(v!.children[0]!.fillRule).toBe("evenodd");
    expect(v!.stroke?.paint).toEqual({ type: "solid", color: BLUE.color });
    // Two contours: the loop 2-1-0-2 through the junction (closed, so it joins there) and the spoke 2-3.
    const verbs = Array.from(v!.path!.verbs);
    expect(verbs.filter((verb) => verb === 0).length).toBe(2);
    expect(verbs.filter((verb) => verb === 4).length).toBe(1);
  });

  it("records what the renderer cannot draw yet instead of faking it", () => {
    const asset = "4637adf6e38fb59e0bac38aa91f52d0350b030ccb924e115ed9135fd0252b667";
    const { scene, bridge } = setup([
      { type: "addAsset", id: asset, meta: { mimeType: "image/png", byteLength: 10 } },
      {
        type: "createNode",
        node: {
          id: "x",
          type: "rectangle",
          props: {
            blendMode: "multiply",
            effects: [{ type: "drop-shadow", color: RED.color, offset: { x: 0, y: 2 }, blur: 4, spread: 0 }, { type: "layer-blur", radius: 3, visible: false }],
            fills: [
              { type: "angular-gradient", center: { x: 0.5, y: 0.5 }, radiusX: { x: 1, y: 0.5 }, radiusY: { x: 0.5, y: 1 }, stops },
              { type: "image", asset, fit: "cover" },
              { ...RED, blendMode: "screen" },
            ],
            strokes: [RED],
            strokeWeight: { top: 1, right: 2, bottom: 1, left: 2 },
          },
        },
        parent: "PAGE",
      },
      { type: "createNode", node: { id: "t", type: "text", text: { content: "Hi", runs: [] } }, parent: "PAGE" },
      { type: "createNode", node: { id: "f", type: "frame", props: { overflowX: "hidden", overflowY: "visible" } }, parent: "PAGE" },
    ]);
    expect([...bridge.unsupported.get("x")!].sort()).toEqual([
      "blend-mode:multiply",
      "effect:drop-shadow",
      "fill:angular-gradient",
      "fill:image",
      "paint-blend-mode:screen",
      "stroke-weight-per-side",
    ]);
    expect([...bridge.unsupported.get("t")!]).toEqual(["text"]);
    expect([...bridge.unsupported.get("f")!]).toEqual(["overflow-single-axis"]);
    // Only the solid fill is drawn; the per-side stroke is not drawn at all.
    const x = scene.root.children[0]!.children[0]!;
    expect(x.fill).toEqual({ type: "solid", color: RED.color });
    expect(x.children).toEqual([]);
    expect(x.stroke).toBeNull();
    // Fixing the node clears its notes.
    const { doc, user } = { doc: bridge.doc, user: bridge.doc.actor("alice") };
    doc.apply([{ type: "updateProps", id: "x", props: { blendMode: null, effects: null, fills: [RED], strokeWeight: 2 } }], user);
    expect(bridge.unsupported.has("x")).toBe(false);
  });
});

describe("SceneBridge incremental updates", () => {
  function grid(n: number) {
    const { doc, page, user } = makeDoc(4);
    const commands: Command[] = [];
    for (let f = 0; f < n; f++) {
      commands.push({ type: "createNode", node: { id: `f${f}`, type: "frame", props: { x: f * 120, width: 110, height: 110, fills: [RED] } }, parent: page });
      for (let i = 0; i < 5; i++) commands.push({ type: "createNode", node: { id: `r${f}-${i}`, type: "rectangle", props: { x: i * 20, y: i * 20, width: 15, height: 15, fills: [BLUE] } }, parent: `f${f}` });
    }
    doc.apply(commands, user);
    const scene = new Scene();
    const bridge = new SceneBridge(doc, scene);
    const list = new DrawList();
    list.sync(scene);
    expectProjected(doc, bridge, scene);
    // One fill per frame and per rectangle.
    expect(list.items.filter((it) => it.kind === 0).length).toBe(n * 6);
    return { doc, page, user, scene, bridge, list };
  }

  it("recompiles only the node whose property changed", () => {
    const { doc, user, bridge, list, scene } = grid(10);
    expect(bridge.lastCompiled).toBe(1 + 10 + 50);
    doc.apply([{ type: "updateProps", id: "r3-2", props: { fills: [RED] } }], user);
    expect(bridge.lastCompiled).toBe(1);
    // A paint edit does not even touch the draw list.
    expect(list.sync(scene)).toBe(false);
    doc.apply([{ type: "updateProps", id: "r3-2", props: { x: 3 } }], user);
    expect(bridge.lastCompiled).toBe(1);
    list.sync(scene);
    expect(list.lastSync.kind).toBe("incremental");
    doc.apply([{ type: "updateProps", id: "f4", props: { width: 90 } }], user);
    expect(bridge.lastCompiled).toBe(1);
  });

  it("relinks only what moved, and compiles only new nodes", () => {
    const { doc, user, bridge, page } = grid(5);
    doc.apply([{ type: "createNode", node: { id: "new", type: "ellipse" }, parent: "f2", index: 0 }], user);
    expect(bridge.lastCompiled).toBe(1);
    expect(bridge.sceneNodeFor("f2")!.children[0]!.children[0]).toBe(bridge.sceneNodeFor("new"));
    doc.apply([{ type: "setParent", ids: ["new"], parent: "f0", keepPosition: false }], user);
    expect(bridge.lastCompiled).toBe(0);
    expect(bridge.sceneNodeFor("new")!.parent).toBe(bridge.sceneNodeFor("f0")!.children[0]);
    doc.apply([{ type: "reorder", id: "f0", index: 4 }], user);
    expect(bridge.lastCompiled).toBe(0);
    expect(bridge.scene.root.children[0]!.children.at(-1)).toBe(bridge.sceneNodeFor("f0"));
    doc.apply([{ type: "delete", ids: ["f1"] }], user);
    expect(bridge.sceneNodeFor("f1")).toBeUndefined();
    expect(bridge.sceneNodeFor("r1-0")).toBeUndefined();
    // Moving to another page removes the subtree from this page's scene.
    doc.apply([{ type: "createNode", node: { id: "p2", type: "page" }, parent: ROOT_ID }, { type: "setPage", ids: ["f2"], page: "p2" }], user);
    expect(bridge.sceneNodeFor("f2")).toBeUndefined();
    bridge.setPage("p2");
    expect(bridge.sceneNodeFor("f2")).toBeDefined();
    expect(bridge.sceneNodeFor("f0")).toBeUndefined();
    doc.apply([{ type: "delete", ids: ["p2"] }], user);
    expect(bridge.page).toBe(page);
  });

  it("follows remote updates and undo", () => {
    const { doc, user, bridge } = grid(2);
    const other = FigDocument.fromUpdate(doc.encodeState(), { random: seededRandom(9), clientId: 77 });
    other.apply([{ type: "updateProps", id: "f1", props: { y: 300 } }], other.actor("bob"));
    doc.applyUpdate(other.encodeState(doc.stateVector()), REMOTE);
    expect(bridge.sceneNodeFor("f1")!.transform[5]).toBe(300);
    doc.apply([{ type: "updateProps", id: "f0", props: { opacity: 0.25 } }], user);
    doc.undo(user);
    expect(bridge.sceneNodeFor("f0")!.opacity).toBe(1);
  });

  it("keeps the scene identical to a fresh projection under random edits", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const doc = FigDocument.create({ random: seededRandom(seed), clientId: 1 });
      const user = doc.actor("u");
      const random = seededRandom(seed * 13);
      const scene = new Scene();
      const bridge = new SceneBridge(doc, scene);
      for (let i = 0; i < 300; i++) {
        let cmd = randomCommand(doc, random);
        // Give shapes visible paints and geometry so the projection has content to compare.
        if (cmd.type === "createNode" && cmd.node.type !== "page" && cmd.node.type !== "group" && cmd.node.type !== "text") {
          cmd = { ...cmd, node: { ...cmd.node, props: { ...(cmd.node.props ?? {}), fills: [RED], strokes: [BLUE], strokeAlign: random() < 0.5 ? "center" : "inside" } } };
        }
        try {
          doc.apply([cmd], user);
        } catch (e) {
          if (!(e instanceof CommandError)) throw e;
        }
        if (i % 50 === 49) {
          expectProjected(doc, bridge, scene);
          const fresh = new Scene();
          const reference = new SceneBridge(doc, fresh, { page: bridge.page });
          expect(describeScene(scene.root)).toEqual(describeScene(fresh.root));
          reference.dispose();
        }
      }
    }
  });
});

describe("SceneBridge at 10,000 nodes", () => {
  it("loads a 10k-node document and applies a single-property update in well under a frame", () => {
    const { doc, page, user } = makeDoc(6);
    const commands: Command[] = [];
    for (let f = 0; f < 100; f++) {
      commands.push({ type: "createNode", node: { id: `f${f}`, type: "frame", props: { x: (f % 10) * 600, y: Math.floor(f / 10) * 400, width: 580, height: 380, cornerRadius: 8, fills: [RED] } }, parent: page });
      for (let i = 0; i < 99; i++) {
        commands.push({
          type: "createNode",
          node: {
            id: `n${f}-${i}`,
            type: i % 3 === 0 ? "ellipse" : "rectangle",
            props: { x: (i % 10) * 55, y: Math.floor(i / 10) * 37, width: 50, height: 30, ...(i % 3 ? { cornerRadius: 4 } : {}), fills: [i % 2 ? RED : BLUE], ...(i % 10 === 0 ? { strokes: [BLUE], strokeWeight: 2 } : {}) },
          },
          parent: `f${f}`,
        });
      }
    }
    let t = performance.now();
    doc.apply(commands, user);
    const createMs = performance.now() - t;
    expect(doc.tree.size).toBe(1 + 100 * 100);

    const scene = new Scene();
    t = performance.now();
    const bridge = new SceneBridge(doc, scene);
    const buildMs = performance.now() - t;
    const list = new DrawList();
    t = performance.now();
    list.sync(scene);
    const compileMs = performance.now() - t;
    expect(bridge.lastCompiled).toBe(10_001);
    expectProjected(doc, bridge, scene);
    // 100 frame fills and their clip layers (begin + end), 9,900 shape fills, and
    // 1,000 strokes aligned inside (the default): each a clip layer around a stroke.
    expect(list.items.length).toBe(100 + 200 + 9_900 + 1_000 * 3);

    // Median of repeated single-property updates: command validation, Yjs
    // transaction, change event, bridge recompile of one node, draw-list sync.
    const measure = (props: (k: number) => Record<string, unknown>): { median: number; max: number } => {
      const samples: number[] = [];
      for (let k = 0; k < 41; k++) {
        const s = performance.now();
        doc.apply([{ type: "updateProps", id: "n57-42", props: props(k) }], user);
        list.sync(scene);
        samples.push(performance.now() - s);
        expect(bridge.lastCompiled).toBe(1);
      }
      samples.sort((a, b) => a - b);
      return { median: samples[20]!, max: samples[40]! };
    };
    const fill = measure((k) => ({ fills: [{ type: "solid", color: { r: (k % 10) / 10, g: 0, b: 0, a: 1 } }] }));
    const move = measure((k) => ({ x: 100 + k }));
    const resize = measure((k) => ({ width: 40 + k }));
    console.log(
      `[bridge 10k] create ${createMs.toFixed(0)} ms, bridge build ${buildMs.toFixed(0)} ms, first draw-list compile ${compileMs.toFixed(0)} ms; ` +
        `single-prop update median/max: fill ${fill.median.toFixed(2)}/${fill.max.toFixed(2)} ms, x ${move.median.toFixed(2)}/${move.max.toFixed(2)} ms, width ${resize.median.toFixed(2)}/${resize.max.toFixed(2)} ms`,
    );
    for (const m of [fill, move, resize]) expect(m.median).toBeLessThan(16);
  }, 120_000);
});
