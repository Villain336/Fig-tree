import {
  IDENTITY,
  emptyRect,
  intersectRect,
  isEmptyRect,
  multiply,
  transformRect,
  unionRect,
  type FillRule,
  type Mat2D,
  type Rect,
} from "@fig-tree/geometry";
import { GeometrySlot } from "./geometry-cache";
import type { Scene, SceneNode } from "./scene";
import { SpatialIndex } from "./spatial";

export const ItemKind = { Fill: 0, BeginLayer: 1, EndLayer: 2 } as const;
export type ItemKind = (typeof ItemKind)[keyof typeof ItemKind];

/**
 * Maximum nesting of layers (group opacity and clips). Beyond it, group
 * opacity is folded into each draw (not isolated) and clips are ignored;
 * see `docs/parity.md`.
 */
export const MAX_LAYER_DEPTH = 8;

/**
 * One step of the flattened paint order. Fills cover both fill and stroke
 * draws (a stroke is a nonzero fill of its outline). Layers bracket content
 * that is composited as a group, optionally clipped by `geometry`.
 */
export interface DrawItem {
  readonly index: number;
  readonly kind: ItemKind;
  readonly node: SceneNode;
  /** Fill geometry, stroke outline, or the clip path of a clipping layer. */
  readonly geometry: GeometrySlot | null;
  readonly paintRole: "fill" | "stroke" | null;
  /** Fill: folded opacity. Layer: group opacity applied when the layer is composited. */
  readonly alpha: number;
  readonly fillRule: FillRule;
  /** Local to world. */
  readonly world: Mat2D;
  /** World bounds after ancestor clipping; empty if fully clipped away. */
  worldBounds: Rect;
  /** Enclosing BeginLayer item, or -1. */
  readonly parentLayer: number;
  /** Index of the matching End (for Begin) or Begin (for End); -1 for fills. */
  match: number;
}

/**
 * The scene compiled into paint order, with a spatial index over visible
 * fills. Rebuilt when the scene's structure or transforms change; geometry
 * slots survive rebuilds so flattened data and GPU uploads are reused.
 */
export class DrawList {
  items: DrawItem[] = [];
  readonly index = new SpatialIndex();
  /** Incremented on every recompile; backends use it to sweep caches of removed nodes. */
  generation = 0;
  /** Geometry slots and paint-owning node ids referenced by the current items. */
  liveSlots: ReadonlySet<GeometrySlot> = new Set();
  liveNodeIds: ReadonlySet<number> = new Set();
  private slots = new Map<number, { fill?: GeometrySlot; stroke?: GeometrySlot }>();
  private structureVersion = -1;
  private transformVersion = -1;
  private warnedDepth = false;

  /** Recompiles if the scene changed. Returns true when items were rebuilt. */
  sync(scene: Scene): boolean {
    const dirty = scene.takeDirty();
    if (
      dirty.size === 0 &&
      scene.structureVersion === this.structureVersion &&
      scene.transformVersion === this.transformVersion
    ) {
      return false;
    }
    this.compile(scene);
    this.structureVersion = scene.structureVersion;
    this.transformVersion = scene.transformVersion;
    return true;
  }

  /** Begin-layer items that clip `item`, outermost first. */
  clipChain(item: DrawItem): DrawItem[] {
    const chain: DrawItem[] = [];
    for (let p = item.parentLayer; p >= 0; p = this.items[p]!.parentLayer) {
      const layer = this.items[p]!;
      if (layer.geometry) chain.unshift(layer);
    }
    return chain;
  }

  private compile(scene: Scene): void {
    const items: DrawItem[] = [];
    const liveSlots = new Map<number, { fill?: GeometrySlot; stroke?: GeometrySlot }>();
    const slotFor = (node: SceneNode, role: "fill" | "stroke"): GeometrySlot => {
      let entry = liveSlots.get(node.id);
      if (!entry) {
        entry = this.slots.get(node.id) ?? {};
        liveSlots.set(node.id, entry);
      }
      const existing = entry[role];
      if (existing && existing.node === node) return existing;
      const slot = new GeometrySlot(node, role);
      entry[role] = slot;
      return slot;
    };
    const drawCounts = new Map<SceneNode, number>();
    const countDraws = (node: SceneNode): number => {
      if (!node.visible) return 0;
      let n = 0;
      if (node.path && node.fill) n++;
      if (node.path && node.stroke) n++;
      for (const c of node.children) n += countDraws(c);
      drawCounts.set(node, n);
      return n;
    };
    countDraws(scene.root);

    const pushFill = (
      node: SceneNode, role: "fill" | "stroke", world: Mat2D, alpha: number, parentLayer: number, clip: Rect,
    ): Rect => {
      const geometry = slotFor(node, role);
      const bounds = intersectRect(transformRect(world, geometry.localBounds()), clip);
      items.push({
        index: items.length, kind: ItemKind.Fill, node, geometry, paintRole: role, alpha,
        fillRule: role === "stroke" ? "nonzero" : node.fillRule, world, worldBounds: bounds, parentLayer, match: -1,
      });
      return bounds;
    };
    const pushBegin = (node: SceneNode, world: Mat2D, alpha: number, clipGeometry: GeometrySlot | null, parentLayer: number): number => {
      const index = items.length;
      items.push({
        index, kind: ItemKind.BeginLayer, node, geometry: clipGeometry, paintRole: null, alpha,
        fillRule: node.fillRule, world, worldBounds: emptyRect(), parentLayer, match: -1,
      });
      return index;
    };
    const pushEnd = (begin: number, bounds: Rect): void => {
      const b = items[begin]!;
      b.worldBounds = bounds;
      b.match = items.length;
      items.push({
        index: items.length, kind: ItemKind.EndLayer, node: b.node, geometry: null, paintRole: null, alpha: b.alpha,
        fillRule: b.fillRule, world: b.world, worldBounds: bounds, parentLayer: b.parentLayer, match: begin,
      });
    };

    const visit = (node: SceneNode, parentWorld: Mat2D, alphaMul: number, parentLayer: number, depth: number, clip: Rect): Rect => {
      const draws = drawCounts.get(node) ?? 0;
      if (draws === 0) return emptyRect();
      const world = multiply(parentWorld, node.transform);
      const wantsGroup = node.opacity < 1 && draws > 1;
      const group = wantsGroup && depth < MAX_LAYER_DEPTH;
      if (wantsGroup && !group) this.warnDepth();
      const contentAlpha = group ? 1 : alphaMul * node.opacity;
      let layer = parentLayer;
      let depthInside = depth;
      let groupBegin = -1;
      if (group) {
        groupBegin = pushBegin(node, world, alphaMul * node.opacity, null, parentLayer);
        layer = groupBegin;
        depthInside++;
      }
      let bounds = emptyRect();
      if (node.path && node.fill) bounds = unionRect(bounds, pushFill(node, "fill", world, contentAlpha, layer, clip));
      const childDraws = node.children.some((c) => (drawCounts.get(c) ?? 0) > 0);
      if (childDraws) {
        const wantsClip = node.clipsContent && node.path !== null;
        const clips = wantsClip && depthInside < MAX_LAYER_DEPTH;
        if (wantsClip && !clips) this.warnDepth();
        let childClip = clip;
        let clipBegin = -1;
        if (clips) {
          const clipGeometry = slotFor(node, "fill");
          childClip = intersectRect(clip, transformRect(world, clipGeometry.localBounds()));
          clipBegin = pushBegin(node, world, 1, clipGeometry, layer);
        }
        let childBounds = emptyRect();
        for (const child of node.children) {
          childBounds = unionRect(
            childBounds,
            visit(child, world, contentAlpha, clips ? clipBegin : layer, clips ? depthInside + 1 : depthInside, childClip),
          );
        }
        if (clips) pushEnd(clipBegin, childBounds);
        bounds = unionRect(bounds, childBounds);
      }
      if (node.path && node.stroke) bounds = unionRect(bounds, pushFill(node, "stroke", world, contentAlpha, layer, clip));
      if (group) pushEnd(groupBegin, bounds);
      return bounds;
    };
    const everything: Rect = { minX: -Infinity, minY: -Infinity, maxX: Infinity, maxY: Infinity };
    visit(scene.root, IDENTITY, 1, -1, 0, everything);

    this.items = items;
    this.slots = liveSlots;
    this.generation++;
    const slots = new Set<GeometrySlot>();
    const ids = new Set<number>();
    for (const it of items) {
      if (it.geometry) slots.add(it.geometry);
      ids.add(it.node.id);
    }
    this.liveSlots = slots;
    this.liveNodeIds = ids;
    this.index.build(items.filter((it) => it.kind === ItemKind.Fill && !isEmptyRect(it.worldBounds)));
  }

  private warnDepth(): void {
    if (this.warnedDepth) return;
    this.warnedDepth = true;
    console.warn(`fig-tree renderer: layers nested deeper than ${MAX_LAYER_DEPTH} are rendered without isolation`);
  }
}
