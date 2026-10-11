import { Path, ellipsePath, rotation, scaling, translation, multiply, IDENTITY } from "@fig-tree/geometry";
import { describe, expect, it } from "vitest";
import { DrawList, ItemKind, MAX_LAYER_DEPTH } from "../src/compile";
import { PaintCache, planFrame } from "../src/frame";
import { hitTest } from "../src/hit-test";
import { Scene } from "../src/scene";
import { rgba, solid } from "../src/types";

const red = solid(rgba(1, 0, 0, 1));
const square = (x: number, y: number, s: number): Path =>
  new Path().moveTo(x, y).lineTo(x + s, y).lineTo(x + s, y + s).lineTo(x, y + s).close();

function compile(scene: Scene): DrawList {
  const list = new DrawList();
  list.sync(scene);
  return list;
}

describe("Scene", () => {
  it("rejects cycles and cross-scene moves", () => {
    const scene = new Scene();
    const a = scene.createNode();
    const b = scene.createNode();
    a.appendChild(b);
    expect(() => b.appendChild(a)).toThrow();
    expect(() => new Scene().root.appendChild(a)).toThrow();
  });

  it("reparents nodes", () => {
    const scene = new Scene();
    const a = scene.createNode();
    const b = scene.createNode();
    const c = scene.createNode();
    a.appendChild(c);
    b.insertChild(0, c);
    expect(a.children).toEqual([]);
    expect(c.parent).toBe(b);
  });

  it("bumps geometry versions only for path and stroke-style edits", () => {
    const scene = new Scene();
    const n = scene.createNode({ path: square(0, 0, 10), stroke: { paint: red, width: 2 } });
    const g = n.geometryVersion;
    n.transform = translation(5, 5);
    n.fill = red;
    n.stroke = { paint: solid(rgba(0, 0, 1, 1)), width: 2 };
    expect(n.geometryVersion).toBe(g);
    n.stroke = { paint: red, width: 3 };
    expect(n.geometryVersion).toBe(g + 1);
    n.path = square(0, 0, 20);
    expect(n.geometryVersion).toBe(g + 2);
  });
});

describe("DrawList", () => {
  it("orders fill, children and stroke, and folds single-draw opacity", () => {
    const scene = new Scene();
    const parent = scene.createNode({ path: square(0, 0, 100), fill: red, stroke: { paint: red, width: 1 } });
    parent.appendChild(scene.createNode({ path: square(10, 10, 10), fill: red, opacity: 0.5 }));
    scene.root.appendChild(parent);
    const list = compile(scene);
    expect(list.items.map((i) => [i.kind, i.paintRole])).toEqual([
      [ItemKind.Fill, "fill"],
      [ItemKind.Fill, "fill"],
      [ItemKind.Fill, "stroke"],
    ]);
    expect(list.items[1]!.alpha).toBe(0.5);
  });

  it("wraps multi-draw opacity groups and clips in layers", () => {
    const scene = new Scene();
    const group = scene.createNode({ opacity: 0.4 });
    const frame = scene.createNode({ path: square(0, 0, 50), clipsContent: true });
    frame.appendChild(scene.createNode({ path: square(-20, -20, 100), fill: red }));
    group.appendChild(scene.createNode({ path: square(0, 0, 10), fill: red }));
    group.appendChild(frame);
    scene.root.appendChild(group);
    const list = compile(scene);
    expect(list.items.map((i) => i.kind)).toEqual([
      ItemKind.BeginLayer, ItemKind.Fill, ItemKind.BeginLayer, ItemKind.Fill, ItemKind.EndLayer, ItemKind.EndLayer,
    ]);
    expect(list.items[0]!.alpha).toBe(0.4);
    expect(list.items[0]!.match).toBe(5);
    expect(list.items[2]!.geometry).not.toBeNull();
    // The clipped child's bounds are cut down to the frame.
    expect(list.items[3]!.worldBounds).toEqual({ minX: 0, minY: 0, maxX: 50, maxY: 50 });
  });

  it("degrades gracefully beyond the maximum layer depth", () => {
    const scene = new Scene();
    let parent = scene.root;
    for (let i = 0; i < MAX_LAYER_DEPTH + 3; i++) {
      const g = scene.createNode({ opacity: 0.9 });
      g.appendChild(scene.createNode({ path: square(i, i, 5), fill: red }));
      parent.appendChild(g);
      parent = g;
    }
    const warn = console.warn;
    console.warn = () => {};
    const list = compile(scene);
    console.warn = warn;
    let depth = 0;
    let maxDepth = 0;
    for (const it of list.items) {
      if (it.kind === ItemKind.BeginLayer) maxDepth = Math.max(maxDepth, ++depth);
      if (it.kind === ItemKind.EndLayer) depth--;
    }
    expect(maxDepth).toBe(MAX_LAYER_DEPTH);
    expect(depth).toBe(0);
  });

  it("keeps geometry slots (and their flattened data) across recompiles", () => {
    const scene = new Scene();
    const n = scene.createNode({ path: ellipsePath(0, 0, 10, 10), fill: red });
    scene.root.appendChild(n);
    const list = compile(scene);
    const slot = list.items[0]!.geometry!;
    const level = slot.at(1);
    n.transform = translation(100, 0);
    expect(list.sync(scene)).toBe(true);
    expect(list.items[0]!.geometry).toBe(slot);
    expect(slot.at(1)).toBe(level);
    expect(list.sync(scene)).toBe(false);
  });

  it("drops removed nodes from the live sets", () => {
    const scene = new Scene();
    const n = scene.createNode({ path: square(0, 0, 1), fill: red });
    scene.root.appendChild(n);
    const list = compile(scene);
    expect(list.liveNodeIds.has(n.id)).toBe(true);
    n.removeFromParent();
    list.sync(scene);
    expect(list.liveNodeIds.has(n.id)).toBe(false);
    expect(list.liveSlots.size).toBe(0);
  });
});

describe("planFrame", () => {
  it("culls off-screen items and re-opens only the layers that hold visible content", () => {
    const scene = new Scene();
    const group = scene.createNode({ opacity: 0.5 });
    group.appendChild(scene.createNode({ path: square(10, 10, 10), fill: red }));
    group.appendChild(scene.createNode({ path: square(500, 500, 10), fill: red }));
    scene.root.appendChild(group);
    scene.root.appendChild(scene.createNode({ path: square(900, 900, 10), fill: red }));
    const list = compile(scene);
    const plan = planFrame(list, new PaintCache(), IDENTITY, 100, 100);
    expect(plan.entries.map((e) => e.kind)).toEqual([ItemKind.BeginLayer, ItemKind.Fill, ItemKind.EndLayer]);
    const zoomedOut = planFrame(list, new PaintCache(), scaling(0.1), 100, 100);
    expect(zoomedOut.entries.filter((e) => e.kind === ItemKind.Fill)).toHaveLength(3);
  });

  it("re-flattens only when zoom crosses a tolerance level", () => {
    const scene = new Scene();
    scene.root.appendChild(scene.createNode({ path: ellipsePath(50, 50, 40, 40), fill: red }));
    const list = compile(scene);
    const paints = new PaintCache();
    const at = (zoom: number): number => planFrame(list, paints, scaling(zoom), 4000, 4000).entries[0]!.geometry!.uploadId;
    const base = at(1);
    expect(at(0.9)).toBe(base);
    expect(at(0.3)).toBe(base); // finer than needed is fine within the hysteresis band
    expect(at(1.5)).not.toBe(base);
    const zoomed = at(1.5);
    expect(at(1.9)).toBe(zoomed);
  });

  it("produces device bounds clipped to the target and local-to-device matrices", () => {
    const scene = new Scene();
    const n = scene.createNode({ path: square(0, 0, 10), fill: red, transform: translation(20, 30) });
    scene.root.appendChild(n);
    const plan = planFrame(compile(scene), new PaintCache(), scaling(2), 45, 100);
    const e = plan.entries[0]!;
    expect(e.bounds).toEqual({ minX: 40, minY: 60, maxX: 45, maxY: 80 });
    expect(e.matrix).toEqual([2, 0, 0, 2, 40, 60]);
  });

  it("reuses encoded paints until they change", () => {
    const scene = new Scene();
    const n = scene.createNode({ path: square(0, 0, 10), fill: red });
    scene.root.appendChild(n);
    const list = compile(scene);
    const paints = new PaintCache();
    const first = planFrame(list, paints, IDENTITY, 50, 50).entries[0]!.paint!;
    expect(planFrame(list, paints, translation(1, 1), 50, 50).entries[0]!.paint).toBe(first);
    n.fill = solid(rgba(0, 1, 0, 1));
    list.sync(scene);
    expect(planFrame(list, paints, IDENTITY, 50, 50).entries[0]!.paint!.uploadId).not.toBe(first.uploadId);
  });
});

describe("hitTest", () => {
  it("returns the topmost node containing the point, honouring transforms, strokes and clips", () => {
    const scene = new Scene();
    const bottom = scene.createNode({ path: square(0, 0, 100), fill: red });
    const rotated = scene.createNode({ path: square(-10, -10, 20), fill: red, transform: multiply(translation(50, 50), rotation(Math.PI / 4)) });
    const ring = scene.createNode({ path: ellipsePath(150, 50, 30, 30), stroke: { paint: red, width: 6 } });
    const frame = scene.createNode({ path: square(200, 0, 50), clipsContent: true });
    const clipped = scene.createNode({ path: square(180, 0, 100), fill: red });
    frame.appendChild(clipped);
    scene.root.appendChild(bottom);
    scene.root.appendChild(rotated);
    scene.root.appendChild(ring);
    scene.root.appendChild(frame);
    const list = compile(scene);
    expect(hitTest(list, { x: 50, y: 50 })).toBe(rotated);
    // Corner of the unrotated square, outside the rotated one.
    expect(hitTest(list, { x: 59, y: 41 })).toBe(bottom);
    expect(hitTest(list, { x: 180, y: 50 })).toBe(ring);
    expect(hitTest(list, { x: 150, y: 50 })).toBeNull();
    expect(hitTest(list, { x: 220, y: 20 })).toBe(clipped);
    expect(hitTest(list, { x: 190, y: 20 })).toBeNull(); // clipped away
  });
});
