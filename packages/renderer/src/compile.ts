import {
  IDENTITY,
  emptyRect,
  inflateRect,
  intersectRect,
  isEmptyRect,
  maxScale,
  multiply,
  transformRect,
  unionRect,
  type FillRule,
  type Mat2D,
  type Path,
  type Rect,
} from "@fig-tree/geometry";
import { GeometrySlot } from "./geometry-cache";
import { paintTraits, type Scene, type SceneNode } from "./scene";
import { shaderUsesBackdrop } from "./shaders/library";
import { SpatialIndex } from "./spatial";
import type { BlendMode, BlurEffect, Effect, MaskType, Paint, ShadowEffect } from "./types";

export const ItemKind = { Fill: 0, BeginLayer: 1, EndLayer: 2, Effect: 3 } as const;
export type ItemKind = (typeof ItemKind)[keyof typeof ItemKind];

/**
 * Maximum nesting of register layers (group opacity, blend modes, clips and
 * masks). Beyond it, group opacity is folded into each draw (not isolated),
 * blend modes fall back to normal and clips and masks are ignored; see
 * `docs/parity.md`. Offscreen layers (layer blur) start a new count, since
 * their content is rendered on its own.
 */
export const MAX_LAYER_DEPTH = 8;

/**
 * What a layer bracket does:
 * - `group`: isolated group (opacity, blend mode, isolation): content starts
 *   transparent, then is composited with `blend` at the end;
 * - `clip`: clips content to the begin item's geometry;
 * - `mask-group`: content multiplied by the value of its `mask-source` (its first child layer);
 * - `mask-source`: a mask's own rendering; at its end its value (alpha,
 *   luminance or shape) becomes the enclosing mask group's mask;
 * - `offscreen`: content rendered into a texture of its own, then blurred
 *   (layer blur) and drawn as one texture.
 */
export type LayerMode = "group" | "clip" | "mask-group" | "mask-source" | "offscreen";

export interface LayerInfo {
  readonly mode: LayerMode;
  readonly blend: BlendMode;
  readonly maskType: MaskType | null;
  /**
   * Clip layers whose content blends with what is below them start from a
   * copy of that backdrop instead of transparency (CSS: `overflow` does not
   * isolate), which composites identically for normal content.
   */
  readonly backdrop: boolean;
  /** Offscreen layers: the layer blur radius in local units (σ = radius / 2). */
  readonly blurRadius: number;
}

/**
 * What an effect item draws (one per shadow and background blur, placed in
 * paint order: background blur and drop shadows before the node's content,
 * inner shadows after its fill), and the item ranges it reads.
 */
export interface EffectInfo {
  readonly effect: ShadowEffect | BlurEffect;
  /** The node's content items (fill, children, strokes): [contentFirst, contentEnd). */
  contentFirst: number;
  contentEnd: number;
  /** The node's own fill item, or -1. Inner shadows and background blurs take their shape from it when present. */
  ownFill: number;
  /** Background blur: the first item of the backdrop root's content (what the backdrop is made of). */
  readonly rootFirst: number;
  /** Background blur: the backdrop root is the canvas (the backdrop starts from the background color). */
  readonly rootIsCanvas: boolean;
  /** An exact spread shape to rasterize instead of dilating the node's shape. */
  readonly spreadItem: DrawItem | null;
}

/** Fills with a paint that reads what is behind them (fluted glass): where their backdrop comes from. */
export interface BackdropSource {
  readonly rootFirst: number;
  readonly rootIsCanvas: boolean;
}

/**
 * One step of the flattened paint order. Fills cover both fill and stroke
 * draws (a stroke is a nonzero fill of its outline). Layers bracket content
 * that is composited as a group. Effect items draw shadows and blurs.
 */
export interface DrawItem {
  readonly index: number;
  readonly kind: ItemKind;
  readonly node: SceneNode;
  /** Fill geometry, stroke outline, or the clip path of a clipping layer. */
  readonly geometry: GeometrySlot | null;
  readonly paintRole: "fill" | "stroke" | null;
  /** Fill: folded opacity. Layer: group opacity applied when the layer is composited. Effect: folded opacity. */
  readonly alpha: number;
  readonly fillRule: FillRule;
  /** Local to world. Updated in place by incremental transform edits. */
  world: Mat2D;
  /** World bounds after ancestor clipping; empty if fully clipped away. Effects and offscreen layers include their reach. */
  worldBounds: Rect;
  /** Enclosing BeginLayer item, or -1. */
  readonly parentLayer: number;
  /** Index of the matching End (for Begin) or Begin (for End); -1 for fills and effects. */
  match: number;
  /** Begin and End items. */
  readonly layer: LayerInfo | null;
  /** Effect items. */
  readonly effect: EffectInfo | null;
  /** Fills whose paint needs the backdrop. */
  readonly backdrop: BackdropSource | null;
  /** Ancestor clip rect the item was compiled under. */
  clip: Rect;
}

/** Where a drawn node sits in the item list, kept for incremental updates. */
interface NodeInfo {
  parentWorld: Mat2D;
  /** Ancestor clip rect the node was compiled under. */
  clip: Rect;
  /** Items owned by the node itself (fill, stroke, layer brackets, effects), in order. */
  readonly own: number[];
  /** Item range [first, end) covering the node and its subtree. */
  readonly first: number;
  end: number;
}

/**
 * When more than this fraction of the indexed items move in one update, the
 * spatial index is bulk-loaded again instead of patched.
 */
const REINDEX_FRACTION = 0.25;

/** Gaussian tails are cut at 3σ; σ = radius / 2. */
export function blurReach(radius: number): number {
  return radius > 0 ? Math.ceil(1.5 * radius) : 0;
}

/** Effects that draw something. */
export function activeEffects(node: SceneNode): readonly Effect[] {
  const fx = node.effects;
  if (fx.length === 0) return fx;
  return fx.filter((e) => ("color" in e ? e.color.a > 0 : e.radius > 0));
}

/**
 * The scene compiled into paint order, with a spatial index over visible
 * fills, effects and offscreen layers. Rebuilt when the scene's structure
 * changes; geometry slots survive rebuilds so flattened data and GPU uploads
 * are reused.
 */
export class DrawList {
  items: DrawItem[] = [];
  readonly index = new SpatialIndex();
  /** Items recompiled or updated by the last {@link sync} (for tests and stats). */
  lastSync: { readonly kind: "none" | "full" | "incremental"; readonly items: number } = { kind: "none", items: 0 };
  private nodeInfo = new Map<SceneNode, NodeInfo>();
  /** Incremented on every recompile; backends use it to sweep caches of removed nodes. */
  generation = 0;
  /** Geometry slots and paint-owning node ids referenced by the current items. */
  liveSlots: ReadonlySet<GeometrySlot> = new Set();
  liveNodeIds: ReadonlySet<number> = new Set();
  /** Whether any item uses a paint that changes with the clock. */
  animated = false;
  /** Whether any item renders through an effect, mask or blend mode (backends prepare effect resources). */
  hasEffects = false;
  private slots = new Map<number, { fill?: GeometrySlot; stroke?: GeometrySlot }>();
  private spreadSlots = new Map<Path, GeometrySlot>();
  private structureVersion = -1;
  private transformVersion = -1;
  private warnedDepth = false;

  /**
   * Brings the list up to date with the scene. Structural edits recompile the
   * whole list; transform and geometry edits only update the edited subtrees'
   * matrices and bounds, their enclosing layers and effects and their index
   * entries. Returns true when anything changed.
   */
  sync(scene: Scene): boolean {
    const geometry = scene.takeDirty();
    const transforms = scene.takeDirtyTransforms();
    if (scene.structureVersion !== this.structureVersion) {
      this.compile(scene);
      this.structureVersion = scene.structureVersion;
      this.transformVersion = scene.transformVersion;
      this.lastSync = { kind: "full", items: this.items.length };
      return true;
    }
    if (geometry.size === 0 && transforms.size === 0 && scene.transformVersion === this.transformVersion) {
      this.lastSync = { kind: "none", items: 0 };
      return false;
    }
    for (const n of geometry) transforms.add(n);
    const updated = this.update(transforms);
    this.transformVersion = scene.transformVersion;
    this.lastSync = { kind: "incremental", items: updated };
    return true;
  }

  /** Begin-layer items that clip `item`, outermost first. */
  clipChain(item: DrawItem): DrawItem[] {
    const chain: DrawItem[] = [];
    for (let p = item.parentLayer; p >= 0; p = this.items[p]!.parentLayer) {
      const layer = this.items[p]!;
      if (layer.layer?.mode === "clip" && layer.geometry) chain.unshift(layer);
    }
    return chain;
  }

  private compile(scene: Scene): void {
    const items: DrawItem[] = [];
    const liveSlots = new Map<number, { fill?: GeometrySlot; stroke?: GeometrySlot }>();
    const spreadSlots = new Map<Path, GeometrySlot>();
    let animated = false;
    let hasEffects = false;
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
    const spreadSlot = (node: SceneNode, path: Path): GeometrySlot => {
      let slot = this.spreadSlots.get(path);
      if (!slot || slot.node !== node) slot = new GeometrySlot(node, "fill", path);
      spreadSlots.set(path, slot);
      return slot;
    };

    // Pre-pass: draws per subtree (so empty subtrees cost nothing) and whether
    // a subtree blends with what is below it without an isolating layer.
    const drawCounts = new Map<SceneNode, number>();
    const leaks = new Map<SceneNode, boolean>();
    const countDraws = (node: SceneNode): number => {
      if (!node.visible) return 0;
      let n = 0;
      if (node.path && node.fill) n++;
      if (node.path && node.stroke) n++;
      for (const e of activeEffects(node)) if (e.type !== "layer-blur") n++;
      let childLeaks = false;
      for (const c of node.children) {
        n += countDraws(c);
        if (leaks.get(c)) childLeaks = true;
      }
      drawCounts.set(node, n);
      const fx = activeEffects(node);
      const isolates = (node.opacity < 1 && n > 1) || node.isolate || fx.some((e) => e.type === "layer-blur") || node.mask !== null;
      const shadowBlends = fx.some((e) => (e.type === "drop-shadow" || e.type === "inner-shadow") && (e.blendMode ?? "normal") !== "normal");
      leaks.set(node, n > 0 && (node.blendMode !== "normal" || ((!isolates && (childLeaks || shadowBlends)))));
      return n;
    };
    countDraws(scene.root);

    const nodeInfo = new Map<SceneNode, NodeInfo>();
    let own: number[] = [];
    const base = (node: SceneNode, kind: ItemKind, world: Mat2D, parentLayer: number, clip: Rect) => ({
      index: items.length, kind, node, world, parentLayer, clip, match: -1, worldBounds: emptyRect(),
      geometry: null as GeometrySlot | null, paintRole: null as "fill" | "stroke" | null, alpha: 1, fillRule: node.fillRule as FillRule,
      layer: null as LayerInfo | null, effect: null as EffectInfo | null, backdrop: null as BackdropSource | null,
    });
    const pushFill = (
      node: SceneNode, role: "fill" | "stroke", world: Mat2D, alpha: number, parentLayer: number, clip: Rect, root: Root,
    ): DrawItem => {
      own.push(items.length);
      const geometry = slotFor(node, role);
      const paint = role === "fill" ? node.fill : node.stroke?.paint ?? null;
      if (paintTraits(paint) & 2) animated = true;
      const item: DrawItem = {
        ...base(node, ItemKind.Fill, world, parentLayer, clip),
        geometry, paintRole: role, alpha, fillRule: role === "stroke" ? "nonzero" : node.fillRule,
        worldBounds: intersectRect(transformRect(world, geometry.localBounds()), clip),
        backdrop: usesBackdrop(paint) ? { rootFirst: root.first, rootIsCanvas: root.canvas } : null,
      };
      if (item.backdrop) hasEffects = true;
      items.push(item);
      return item;
    };
    const pushBegin = (node: SceneNode, world: Mat2D, alpha: number, clipGeometry: GeometrySlot | null, parentLayer: number, clip: Rect, layer: Partial<LayerInfo> & { mode: LayerMode }): number => {
      const index = items.length;
      own.push(index);
      if (layer.mode !== "clip" && layer.mode !== "group") hasEffects = true;
      if ((layer.blend ?? "normal") !== "normal" || layer.backdrop) hasEffects = true;
      items.push({
        ...base(node, ItemKind.BeginLayer, world, parentLayer, clip),
        geometry: clipGeometry, alpha,
        layer: { blend: "normal", maskType: null, backdrop: false, blurRadius: 0, ...layer },
      });
      return index;
    };
    const pushEnd = (begin: number, bounds: Rect): void => {
      const b = items[begin]!;
      b.worldBounds = bounds;
      b.match = items.length;
      own.push(items.length);
      items.push({ ...b, index: items.length, kind: ItemKind.EndLayer, geometry: null, worldBounds: bounds, match: begin });
    };
    const pushEffect = (node: SceneNode, world: Mat2D, effect: ShadowEffect | BlurEffect, alpha: number, parentLayer: number, clip: Rect, root: Root): DrawItem => {
      own.push(items.length);
      hasEffects = true;
      const spreadPath = "spreadPath" in effect ? effect.spreadPath ?? null : null;
      let spreadItem: DrawItem | null = null;
      if (spreadPath && "spread" in effect && effect.spread !== 0) {
        const geometry = spreadSlot(node, spreadPath);
        spreadItem = {
          ...base(node, ItemKind.Fill, world, -1, clip),
          index: -1, geometry, paintRole: "fill", fillRule: "nonzero",
          worldBounds: transformRect(world, geometry.localBounds()),
        };
      }
      const item: DrawItem = {
        ...base(node, ItemKind.Effect, world, parentLayer, clip),
        alpha,
        effect: { effect, contentFirst: -1, contentEnd: -1, ownFill: -1, rootFirst: root.first, rootIsCanvas: root.canvas, spreadItem },
      };
      items.push(item);
      return item;
    };

    const visit = (node: SceneNode, parentWorld: Mat2D, alphaMul: number, parentLayer: number, depth: number, clip: Rect, root: Root): Rect => {
      const draws = drawCounts.get(node) ?? 0;
      if (draws === 0) return emptyRect();
      const info: NodeInfo = { parentWorld, clip, own: [], first: items.length, end: items.length };
      nodeInfo.set(node, info);
      const outerOwn = own;
      own = info.own;
      const world = multiply(parentWorld, node.transform);
      const fx = activeEffects(node);
      const layerBlur = fx.find((e): e is BlurEffect => e.type === "layer-blur");
      const backgroundBlur = fx.find((e): e is BlurEffect => e.type === "background-blur");
      const drops = fx.filter((e): e is ShadowEffect => e.type === "drop-shadow");
      const inners = fx.filter((e): e is ShadowEffect => e.type === "inner-shadow");

      const blend = node.blendMode;
      const childLeaks = node.children.some((c) => leaks.get(c));
      const wantsGroup = (node.opacity < 1 && draws > 1) || blend !== "normal" || (node.isolate && childLeaks);
      const group = wantsGroup && depth < MAX_LAYER_DEPTH;
      if (wantsGroup && !group) this.warnDepth();
      const contentAlpha = group ? 1 : alphaMul * node.opacity;
      let layer = parentLayer;
      let depthInside = depth;
      let groupBegin = -1;
      let innerRoot = root;
      if (group) {
        groupBegin = pushBegin(node, world, alphaMul * node.opacity, null, parentLayer, clip, { mode: "group", blend });
        layer = groupBegin;
        depthInside++;
        innerRoot = { first: groupBegin + 1, canvas: false };
      }
      // Background blur reads what is below the node, so its root is the one outside the node's group.
      const backdropItem = backgroundBlur ? pushEffect(node, world, backgroundBlur, contentAlpha, layer, clip, root) : null;
      let offBegin = -1;
      if (layerBlur) {
        offBegin = pushBegin(node, world, 1, null, layer, clip, { mode: "offscreen", blurRadius: layerBlur.radius });
        layer = offBegin;
        depthInside = 0;
        innerRoot = { first: offBegin + 1, canvas: false };
      }
      const dropItems = drops.map((e) => pushEffect(node, world, e, contentAlpha, layer, clip, innerRoot));
      const contentFirst = items.length;
      let bounds = emptyRect();
      let ownFill: DrawItem | null = null;
      if (node.path && node.fill) {
        ownFill = pushFill(node, "fill", world, contentAlpha, layer, clip, innerRoot);
        bounds = unionRect(bounds, ownFill.worldBounds);
      }
      const innerItems: DrawItem[] = [];
      if (ownFill) for (const e of inners) innerItems.push(pushEffect(node, world, e, contentAlpha, layer, clip, innerRoot));
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
          clipBegin = pushBegin(node, world, 1, clipGeometry, layer, clip, { mode: "clip", backdrop: childLeaks });
        }
        const childBounds = visitChildren(node.children, 0, world, contentAlpha, clips ? clipBegin : layer, clips ? depthInside + 1 : depthInside, childClip, innerRoot);
        own = info.own;
        if (clips) pushEnd(clipBegin, childBounds);
        bounds = unionRect(bounds, childBounds);
      }
      if (node.path && node.stroke) bounds = unionRect(bounds, pushFill(node, "stroke", world, contentAlpha, layer, clip, innerRoot).worldBounds);
      const contentEnd = items.length;
      if (!ownFill) for (const e of inners) innerItems.push(pushEffect(node, world, e, contentAlpha, layer, clip, innerRoot));
      for (const it of [...(backdropItem ? [backdropItem] : []), ...dropItems, ...innerItems]) {
        const fxInfo = it.effect!;
        fxInfo.contentFirst = contentFirst;
        fxInfo.contentEnd = contentEnd;
        fxInfo.ownFill = ownFill ? ownFill.index : -1;
        it.worldBounds = this.effectBounds(items, it);
        bounds = unionRect(bounds, it.worldBounds);
      }
      if (offBegin >= 0) {
        bounds = intersectRect(inflateRect(bounds, blurReach(layerBlur!.radius) * maxScale(world)), clip);
        pushEnd(offBegin, bounds);
      }
      if (group) pushEnd(groupBegin, bounds);
      info.end = items.length;
      own = outerOwn;
      return bounds;
    };

    // Children in paint order; a mask child masks the siblings after it.
    const visitChildren = (children: readonly SceneNode[], from: number, world: Mat2D, alpha: number, parentLayer: number, depth: number, clip: Rect, root: Root): Rect => {
      let bounds = emptyRect();
      const outerOwn = own;
      for (let i = from; i < children.length; i++) {
        const c = children[i]!;
        if (c.mask && c.visible && (drawCounts.get(c) ?? 0) > 0) {
          if (depth + 2 > MAX_LAYER_DEPTH) {
            this.warnDepth();
            continue; // the mask itself is never drawn
          }
          const groupBegin = pushBegin(c, world, 1, null, parentLayer, clip, { mode: "mask-group", maskType: c.mask });
          const sourceBegin = pushBegin(c, world, 1, null, groupBegin, clip, { mode: "mask-source", maskType: c.mask });
          const maskBounds = visit(c, world, 1, sourceBegin, depth + 2, clip, { first: sourceBegin + 1, canvas: false });
          own = outerOwn;
          pushEnd(sourceBegin, maskBounds);
          const content = visitChildren(children, i + 1, world, alpha, groupBegin, depth + 1, clip, { first: groupBegin + 1, canvas: false });
          own = outerOwn;
          const masked = intersectRect(maskBounds, content);
          pushEnd(groupBegin, masked);
          return unionRect(bounds, masked);
        }
        if (c.mask) continue;
        bounds = unionRect(bounds, visit(c, world, alpha, parentLayer, depth, clip, root));
      }
      return bounds;
    };

    const everything: Rect = { minX: -Infinity, minY: -Infinity, maxX: Infinity, maxY: Infinity };
    visit(scene.root, IDENTITY, 1, -1, 0, everything, { first: 0, canvas: true });

    this.items = items;
    this.nodeInfo = nodeInfo;
    this.slots = liveSlots;
    this.spreadSlots = spreadSlots;
    this.animated = animated;
    this.hasEffects = hasEffects;
    this.generation++;
    const slots = new Set<GeometrySlot>();
    const ids = new Set<number>();
    for (const it of items) {
      if (it.geometry) slots.add(it.geometry);
      if (it.effect?.spreadItem?.geometry) slots.add(it.effect.spreadItem.geometry);
      ids.add(it.node.id);
    }
    this.liveSlots = slots;
    this.liveNodeIds = ids;
    this.index.build(items.filter((it) => isIndexed(it) && !isEmptyRect(it.worldBounds)));
  }

  /**
   * World bounds of an effect item: its shape's bounds (content, or the
   * node's own fill for inner shadows and background blurs), moved and grown
   * by what the effect reaches, clipped by its ancestors' clips.
   */
  private effectBounds(items: readonly DrawItem[], item: DrawItem): Rect {
    const fx = item.effect!;
    let content = emptyRect();
    if (fx.ownFill >= 0 && (fx.effect.type === "inner-shadow" || fx.effect.type === "background-blur")) {
      content = items[fx.ownFill]!.worldBounds;
    } else {
      for (let i = fx.contentFirst; i < fx.contentEnd; i++) {
        const it = items[i]!;
        if (it.kind === ItemKind.Fill) content = unionRect(content, it.worldBounds);
      }
    }
    if (isEmptyRect(content)) return content;
    const e = fx.effect;
    if (e.type !== "drop-shadow") return content;
    const w = item.world;
    const ox = w[0] * e.offset.x + w[2] * e.offset.y;
    const oy = w[1] * e.offset.x + w[3] * e.offset.y;
    const reach = (Math.max(0, e.spread) + blurReach(e.radius)) * maxScale(w);
    const moved = { minX: content.minX + ox, minY: content.minY + oy, maxX: content.maxX + ox, maxY: content.maxY + oy };
    const spreadBounds = fx.spreadItem ? transformRect(w, fx.spreadItem.geometry!.localBounds()) : null;
    const shadow = inflateRect(spreadBounds ? unionRect(moved, { minX: spreadBounds.minX + ox, minY: spreadBounds.minY + oy, maxX: spreadBounds.maxX + ox, maxY: spreadBounds.maxY + oy }) : moved, reach);
    return intersectRect(shadow, item.clip);
  }

  /**
   * Re-derives matrices and bounds for the subtrees of `dirty` nodes (whose
   * transform or geometry changed) without touching paint order. Returns the
   * number of items updated.
   */
  private update(dirty: Set<SceneNode>): number {
    const roots: SceneNode[] = [];
    for (const node of dirty) {
      if (!this.nodeInfo.has(node)) continue; // draws nothing: nothing to update
      let covered = false;
      for (let p = node.parent; p; p = p.parent) {
        if (dirty.has(p) && this.nodeInfo.has(p)) {
          covered = true;
          break;
        }
      }
      if (!covered) roots.push(node);
    }
    const changed: DrawItem[] = [];
    const layers = new Set<number>();
    const effects = new Set<number>();
    const items = this.items;

    const revisit = (node: SceneNode, parentWorld: Mat2D, clip: Rect): void => {
      const info = this.nodeInfo.get(node);
      if (!info) return;
      info.parentWorld = parentWorld;
      info.clip = clip;
      const world = multiply(parentWorld, node.transform);
      let childClip = clip;
      for (const i of info.own) {
        const item = items[i]!;
        item.world = world;
        if (item.kind === ItemKind.Fill) {
          item.worldBounds = intersectRect(transformRect(world, item.geometry!.localBounds()), clip);
          item.clip = clip;
          changed.push(item);
        } else if (item.kind === ItemKind.Effect) {
          item.clip = clip;
          if (item.effect!.spreadItem) {
            item.effect!.spreadItem.world = world;
            item.effect!.spreadItem.clip = clip;
          }
          effects.add(i);
        } else if (item.kind === ItemKind.BeginLayer) {
          item.clip = clip;
          layers.add(i);
          if (item.layer!.mode === "clip" && item.geometry) childClip = intersectRect(clip, transformRect(world, item.geometry.localBounds()));
        }
      }
      for (const child of node.children) revisit(child, world, childClip);
    };

    for (const root of roots) {
      const info = this.nodeInfo.get(root)!;
      revisit(root, info.parentWorld, info.clip);
      // Enclosing layers' bounds include this subtree, and ancestors' effects read it.
      for (let p = items[info.first]!.parentLayer; p >= 0; p = items[p]!.parentLayer) layers.add(p);
      for (let a = root.parent; a; a = a.parent) {
        const ai = this.nodeInfo.get(a);
        if (ai) for (const i of ai.own) if (items[i]!.kind === ItemKind.Effect) effects.add(i);
      }
    }

    for (const i of effects) {
      const it = items[i]!;
      it.worldBounds = this.effectBounds(items, it);
      changed.push(it);
    }
    // Inner layers first: offscreen layers grow by their blur, and enclosing layers include them.
    for (const begin of [...layers].sort((a, b) => b - a)) {
      const b = items[begin]!;
      let bounds = emptyRect();
      for (let i = begin + 1; i < b.match; i++) {
        const it = items[i]!;
        if (it.kind === ItemKind.Fill || it.kind === ItemKind.Effect || (it.kind === ItemKind.BeginLayer && it.layer!.mode === "offscreen")) bounds = unionRect(bounds, it.worldBounds);
      }
      if (b.layer!.mode === "offscreen") bounds = intersectRect(inflateRect(bounds, blurReach(b.layer!.blurRadius) * maxScale(b.world)), b.clip);
      // A mask group shows nothing outside its mask (its first child layer, already updated).
      if (b.layer!.mode === "mask-group" && items[begin + 1]?.layer?.mode === "mask-source") bounds = intersectRect(bounds, items[begin + 1]!.worldBounds);
      b.worldBounds = bounds;
      const end = items[b.match]!;
      end.worldBounds = bounds;
      end.world = b.world;
      if (b.layer!.mode === "offscreen") changed.push(b);
    }

    const indexed = changed.filter(isIndexed);
    if (indexed.length > this.index.size * REINDEX_FRACTION) {
      this.index.build(items.filter((it) => isIndexed(it) && !isEmptyRect(it.worldBounds)));
    } else {
      for (const it of indexed) this.index.update(it.index, isEmptyRect(it.worldBounds) ? null : it.worldBounds);
    }
    return changed.length + layers.size * 2;
  }

  private warnDepth(): void {
    if (this.warnedDepth) return;
    this.warnedDepth = true;
    console.warn(`fig-tree renderer: layers nested deeper than ${MAX_LAYER_DEPTH} are rendered without isolation`);
  }
}

interface Root {
  readonly first: number;
  readonly canvas: boolean;
}

/** Items culled through the spatial index: fills, effects, and offscreen layers (whose blur reaches past their content). */
function isIndexed(it: DrawItem): boolean {
  return it.kind === ItemKind.Fill || it.kind === ItemKind.Effect || (it.kind === ItemKind.BeginLayer && it.layer!.mode === "offscreen");
}

function usesBackdrop(p: Paint | null): boolean {
  return p !== null && p.type === "shader" && shaderUsesBackdrop(p);
}
