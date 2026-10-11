import { Path, multiply, rotation, scaling, translation, type Mat2D } from "@fig-tree/geometry";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DrawList, ItemKind } from "../src/compile";
import { Scene, type SceneNode } from "../src/scene";
import { rgba, solid } from "../src/types";

const paint = solid(rgba(0, 0, 0, 1));
const box = (w: number, h: number): Path => new Path().moveTo(0, 0).lineTo(w, 0).lineTo(w, h).lineTo(0, h).close();

/** Builds a random scene from a seed of choices: nested clips, groups, strokes and empty nodes. */
function buildScene(spec: readonly NodeSpec[]): { scene: Scene; nodes: SceneNode[] } {
  const scene = new Scene();
  const nodes: SceneNode[] = [];
  for (const s of spec) {
    const parent = s.parent < 0 || nodes.length === 0 ? scene.root : nodes[s.parent % nodes.length]!;
    const node = scene.createNode({
      transform: translation(s.x, s.y),
      path: s.hasPath ? box(s.w, s.h) : null,
      fill: s.fill ? paint : null,
      stroke: s.stroke ? { paint, width: 2 } : null,
      opacity: s.opacity,
      clipsContent: s.clip,
    });
    parent.appendChild(node);
    nodes.push(node);
  }
  return { scene, nodes };
}

interface NodeSpec {
  parent: number;
  x: number;
  y: number;
  w: number;
  h: number;
  hasPath: boolean;
  fill: boolean;
  stroke: boolean;
  opacity: number;
  clip: boolean;
}

const nodeSpec = fc.record({
  parent: fc.integer({ min: -1, max: 40 }),
  x: fc.integer({ min: -200, max: 200 }),
  y: fc.integer({ min: -200, max: 200 }),
  w: fc.integer({ min: 1, max: 300 }),
  h: fc.integer({ min: 1, max: 300 }),
  hasPath: fc.boolean(),
  fill: fc.boolean(),
  stroke: fc.boolean(),
  opacity: fc.constantFrom(1, 1, 0.5),
  clip: fc.boolean(),
});

const edit = fc.record({
  node: fc.nat(),
  kind: fc.constantFrom("translate", "rotate", "scale", "path"),
  a: fc.integer({ min: -150, max: 150 }),
  b: fc.integer({ min: 1, max: 250 }),
});

function snapshot(list: DrawList): unknown {
  return list.items.map((it) => ({
    kind: it.kind,
    node: it.node.id,
    world: it.world.map((v) => Math.round(v * 1e6) / 1e6),
    bounds: [it.worldBounds.minX, it.worldBounds.minY, it.worldBounds.maxX, it.worldBounds.maxY].map((v) =>
      Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : v,
    ),
    match: it.match,
    parentLayer: it.parentLayer,
  }));
}

function queries(list: DrawList): number[][] {
  const rects = [
    { minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 },
    { minX: 0, minY: 0, maxX: 50, maxY: 50 },
    { minX: -100, minY: 20, maxX: 10, maxY: 200 },
    { minX: 120, minY: -40, maxX: 400, maxY: 60 },
  ];
  return rects.map((r) => Array.from(list.index.query(r)));
}

describe("DrawList incremental updates", () => {
  it("transform and geometry edits update only the edited subtree, matching a full recompile", () => {
    fc.assert(
      fc.property(fc.array(nodeSpec, { minLength: 1, maxLength: 40 }), fc.array(edit, { minLength: 1, maxLength: 8 }), (spec, edits) => {
        const { scene, nodes } = buildScene(spec);
        const list = new DrawList();
        list.sync(scene);
        for (const e of edits) {
          const n = nodes[e.node % nodes.length]!;
          const m: Mat2D =
            e.kind === "rotate" ? multiply(n.transform, rotation(e.a / 100))
            : e.kind === "scale" ? multiply(n.transform, scaling(e.b / 100))
            : translation(e.a, e.b - 125);
          if (e.kind === "path") {
            if (n.path) n.path = box(e.b, e.b / 2);
          } else {
            n.transform = m;
          }
          list.sync(scene);
          expect(list.lastSync.kind).not.toBe("full");
        }
        const fresh = new DrawList();
        fresh.sync(scene);
        expect(snapshot(list)).toEqual(snapshot(fresh));
        expect(queries(list)).toEqual(queries(fresh));
      }),
      { numRuns: 300 },
    );
  });

  it("does not touch items outside the edited subtree", () => {
    const scene = new Scene();
    const frames: SceneNode[] = [];
    for (let f = 0; f < 10; f++) {
      const frame = scene.createNode({ transform: translation(f * 200, 0), path: box(180, 180), fill: paint, clipsContent: true });
      scene.root.appendChild(frame);
      frames.push(frame);
      for (let i = 0; i < 20; i++) frame.appendChild(scene.createNode({ transform: translation(i * 8, i * 8), path: box(10, 10), fill: paint }));
    }
    const list = new DrawList();
    list.sync(scene);
    expect(list.lastSync.kind).toBe("full");
    frames[3]!.children[5]!.transform = translation(1, 1);
    list.sync(scene);
    // One fill, plus the enclosing clip layer's begin/end bounds.
    expect(list.lastSync).toEqual({ kind: "incremental", items: 3 });
    frames[3]!.transform = translation(610, 5);
    list.sync(scene);
    // The frame's fill, its 20 children and its clip layer.
    expect(list.lastSync).toEqual({ kind: "incremental", items: 1 + 20 + 2 });
    expect(list.items.filter((it) => it.kind === ItemKind.Fill).length).toBe(210);
  });

  it("recompiles fully when a node gains or loses its path", () => {
    const scene = new Scene();
    const n = scene.createNode({ fill: paint });
    scene.root.appendChild(n);
    const list = new DrawList();
    list.sync(scene);
    expect(list.items.length).toBe(0);
    n.path = box(10, 10);
    list.sync(scene);
    expect(list.lastSync.kind).toBe("full");
    expect(list.items.length).toBe(1);
  });
});
