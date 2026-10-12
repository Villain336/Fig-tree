import {
  determinant,
  emptyRect,
  intersectRect,
  invert,
  isEmptyRect,
  maxScale,
  multiply,
  transformRect,
  translation,
  unionRect,
  type FillRule,
  type Mat2D,
  type Rect,
} from "@fig-tree/geometry";
import { ItemKind, type DrawItem, type DrawList, type LayerInfo } from "./compile";
import type { GeometryLevel } from "./geometry-cache";
import { atlasCompatible, placeGlyphs, type GlyphAtlas, type GlyphPlacement } from "./glyphs/atlas";
import { deviceToImage, type ImageAtlas, type ImagePlacement } from "./images";
import { encodePaint, premultiply, type EncodedPaint } from "./paint";
import type { BlendMode, Color } from "./types";

export interface PaintRecord {
  /** Stable per node and role. */
  readonly key: number;
  /** Changes whenever the encoded paint changes. */
  readonly uploadId: number;
  readonly paint: EncodedPaint;
}

/** An integer rectangle in device pixels. */
export interface IRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * A texture drawn by a frame entry: the output of a render-graph node,
 * whose top-left texel sits at (x, y) in the entry's plan.
 */
export interface TextureDraw {
  readonly node: GraphNode;
  readonly x: number;
  readonly y: number;
}

/**
 * The render graph: offscreen work a frame needs before its entries can be
 * composited. Every node produces one premultiplied RGBA texture covering
 * `rect` (in the frame's device pixels); nodes are listed in dependency
 * order, so executing them in order is always valid. `key` describes what a
 * node computes (content, view, region), so a backend can keep the textures
 * that frames draw from and reuse them while nothing changes.
 */
export type GraphNode = RasterNode | BlurNode | MorphNode | ShadowNode | BackdropNode | MeshNode;

interface GraphBase {
  readonly id: number;
  readonly key: string;
  readonly rect: IRect;
}

/** Rasterizes a plan (a range of the draw list) into a texture: transparent, or over `background`. */
export interface RasterNode extends GraphBase {
  readonly op: "raster";
  readonly plan: FramePlan;
  readonly background: readonly [number, number, number, number] | null;
}

/**
 * Gaussian blur with standard deviation `sigma` (device px). Outside its
 * input the image is transparent (`transparent`) or mirrored at the input's
 * edges (`mirror`, for backdrops). See {@link blurSteps} for how it is computed.
 */
export interface BlurNode extends GraphBase {
  readonly op: "blur";
  readonly input: GraphNode;
  readonly sigma: number;
  readonly edge: "transparent" | "mirror";
}

/** Dilates (radius > 0) or erodes (radius < 0) a shape's alpha by a disk, in device px. */
export interface MorphNode extends GraphBase {
  readonly op: "morph";
  readonly input: GraphNode;
  readonly radius: number;
}

/**
 * A shadow from a blurred shape B and the node's shape S, with a
 * premultiplied color c and an offset o (device px):
 * drop: c·B(p − o)·(1 − S(p)) (S null: c·B(p − o));
 * inner: c·S(p)·(1 − B(p − o)).
 */
export interface ShadowNode extends GraphBase {
  readonly op: "shadow";
  readonly blurred: GraphNode;
  readonly shape: GraphNode | null;
  readonly inner: boolean;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly color: readonly [number, number, number, number];
}

/** A blurred backdrop shown through a shape: B(p)·S(p). */
export interface BackdropNode extends GraphBase {
  readonly op: "backdrop";
  readonly blurred: GraphNode;
  readonly shape: GraphNode;
}

/**
 * A mesh gradient's lookup texture: the surface color at each texel's box
 * position (premultiplied). The paint samples it bilinearly; the surface is
 * smooth, so a texture of half the box's device size is exact to 8 bits.
 */
export interface MeshNode extends GraphBase {
  readonly op: "mesh";
  readonly paint: PaintRecord;
  /** The shader's time (its own time plus clock × speed). */
  readonly time: number;
}

/** One visible step of a frame, in paint order. */
export interface FrameEntry {
  readonly kind: ItemKind;
  readonly item: DrawItem;
  /** Fill geometry, or the clip path of a clipping layer. */
  readonly geometry: GeometryLevel | null;
  readonly paint: PaintRecord | null;
  /** Local space to device pixels. */
  readonly matrix: Mat2D;
  /** Device-pixel bounds clipped to the target; never empty. */
  readonly bounds: Rect;
  /** Glyph bitmaps from the atlas (text drawn in atlas mode); the entry then has no geometry. */
  readonly glyphs: readonly GlyphPlacement[] | null;
  /** Fill: opacity multiplied into the draw. Layer: applied when the layer is composited. */
  readonly alpha: number;
  readonly fillRule: FillRule;
  /** Begin and End entries: what the layer does. */
  readonly layer: LayerInfo | null;
  /** Fill drawn as coverage only (opaque white): shape renders for effects, vector masks. */
  readonly shape: boolean;
  /** A texture fill (effects, blurred layers): no geometry; the texture carries color and coverage. */
  readonly texture: TextureDraw | null;
  /** A texture the paint samples: the captured backdrop (fluted glass) or a mesh gradient's lookup texture. */
  readonly sampled: TextureDraw | null;
  /** Where the paint's image is in the image atlas. */
  readonly image: ImagePlacement | null;
}

export interface FramePlan {
  readonly list: DrawList;
  /** The glyph atlas the plan's text entries use (backends upload its new bitmaps). */
  readonly atlas: GlyphAtlas | null;
  /** The image atlas the plan's image entries use. */
  readonly images: ImageAtlas | null;
  /** Target size in device pixels. */
  readonly width: number;
  readonly height: number;
  /** World to device pixels. */
  readonly view: Mat2D;
  readonly entries: readonly FrameEntry[];
  /** Offscreen work to do before compositing, in order (top-level plans only; sub-plans share it). */
  readonly graph: readonly GraphNode[];
  /** The renderer clock in seconds (animated shader paints). */
  readonly time: number;
}

/** Caches encoded paints across frames, keyed by node and role. */
export class PaintCache {
  private records = new Map<number, { version: number; record: PaintRecord }>();
  private nextUploadId = 1;

  get(item: DrawItem): PaintRecord | null {
    const role = item.paintRole;
    if (!role) return null;
    const paint = role === "fill" ? item.node.fill : item.node.stroke?.paint;
    if (!paint) return null;
    const key = item.node.id * 2 + (role === "stroke" ? 1 : 0);
    const cached = this.records.get(key);
    if (cached && cached.version === item.node.paintVersion) return cached.record;
    const record: PaintRecord = { key, uploadId: this.nextUploadId++, paint: encodePaint(paint) };
    this.records.set(key, { version: item.node.paintVersion, record });
    return record;
  }
}

export interface PlanOptions {
  readonly atlas?: GlyphAtlas | null;
  readonly images?: ImageAtlas | null;
  /** Canvas color: backdrops rooted at the canvas start from it. */
  readonly background?: Color;
  /** Changes whenever scene content changes (effect textures are cached per content version). */
  readonly contentVersion?: number;
  /** Renderer clock in seconds. */
  readonly time?: number;
}

/**
 * How a blur of standard deviation `sigma` is computed, shared by both
 * backends so they produce the same result: the image is halved
 * (2x2 box filter) `levels` times, until the remaining deviation is at most
 * 2 texels of the reduced image (each halving's box filter already blurs
 * by a known amount, subtracted here), then blurred with a separable
 * Gaussian of deviation `sigmaLow` (kernel radius ceil(3·sigmaLow)), then
 * scaled back up bilinearly one level at a time.
 */
export function blurSteps(sigma: number): { levels: number; sigmaLow: number } {
  if (!(sigma > 0)) return { levels: 0, sigmaLow: 0 };
  let levels = 0;
  let variance = sigma * sigma;
  // A 2x2 box at level k-1 adds 0.25 texel² of level k-1, i.e. 0.25·4^(k-1) px².
  // Bilinear upscaling from level k to k-1 adds about 1/8 texel² of level k-1... measured, see tests.
  while (variance / 4 ** levels > 4 && levels < 8) {
    const next = levels + 1;
    const added = 0.25 * 4 ** (next - 1) + 0.125 * 4 ** (next - 1);
    if (variance - added <= 0) break;
    variance -= added;
    levels = next;
  }
  return { levels, sigmaLow: Math.sqrt(Math.max(0, variance)) / 2 ** levels };
}

/**
 * Culls the draw list against the viewport and produces the ordered entries a
 * backend renders, re-opening only the layers that contain visible content,
 * and the render graph for effects, blurred layers, backdrops and masks.
 */
export function planFrame(
  list: DrawList,
  paints: PaintCache,
  view: Mat2D,
  width: number,
  height: number,
  atlas: GlyphAtlas | null = null,
  options: PlanOptions = {},
): FramePlan {
  const time = options.time ?? 0;
  const ctx: PlanContext = {
    list,
    paints,
    atlas,
    images: options.images ?? null,
    view,
    graph: [],
    nextId: 1,
    background: premultiply(options.background ?? { r: 1, g: 1, b: 1, a: 1 }),
    frameKey: `${list.generation}:${options.contentVersion ?? 0}:${view.slice(0, 4).join(",")}${list.animated ? `:t${time}` : ""}`,
    time,
  };
  if (width <= 0 || height <= 0 || !invert(view)) return emptyPlan(ctx, width, height);
  const plan = planRange(ctx, 0, list.items.length, { x: 0, y: 0, width, height }, false);
  return { ...plan, graph: ctx.graph };
}

interface PlanContext {
  readonly list: DrawList;
  readonly paints: PaintCache;
  readonly atlas: GlyphAtlas | null;
  readonly images: ImageAtlas | null;
  /** World to frame device pixels. */
  readonly view: Mat2D;
  readonly graph: GraphNode[];
  nextId: number;
  readonly background: readonly [number, number, number, number];
  readonly frameKey: string;
  readonly time: number;
}

function emptyPlan(ctx: PlanContext, width: number, height: number): FramePlan {
  return { list: ctx.list, atlas: ctx.atlas, images: ctx.images, width, height, view: ctx.view, entries: [], graph: ctx.graph, time: ctx.time };
}

function addNode<T extends GraphNode>(ctx: PlanContext, node: Omit<T, "id">): T {
  const full = { ...node, id: ctx.nextId++ } as T;
  ctx.graph.push(full);
  return full;
}

/** Rect key relative to the view's translation, so panning by whole pixels keeps keys stable. */
function rectKey(ctx: PlanContext, r: IRect): string {
  return `${r.x - ctx.view[4]},${r.y - ctx.view[5]},${r.width},${r.height}`;
}

function toIRect(r: Rect): IRect | null {
  if (isEmptyRect(r) || !(r.maxX > r.minX) || !(r.maxY > r.minY)) return null;
  const x = Math.floor(r.minX);
  const y = Math.floor(r.minY);
  const w = Math.ceil(r.maxX) - x;
  const h = Math.ceil(r.maxY) - y;
  return w > 0 && h > 0 ? { x, y, width: w, height: h } : null;
}

function grow(r: IRect, by: number): IRect {
  const b = Math.ceil(Math.max(0, by));
  return { x: r.x - b, y: r.y - b, width: r.width + 2 * b, height: r.height + 2 * b };
}

/** Largest texture side an effect may use; larger regions are cut down (only on-screen parts are needed). */
const MAX_EFFECT_SIDE = 8192;

function clampRect(r: IRect): IRect {
  return { x: r.x, y: r.y, width: Math.min(r.width, MAX_EFFECT_SIDE), height: Math.min(r.height, MAX_EFFECT_SIDE) };
}

/**
 * Plans the items [first, end) for the device rectangle `rect` (frame
 * pixels) as their own target. `shape` draws everything as coverage
 * (effects' shape sources): effects and blend modes are skipped, opacity is
 * 1 and every paint counts as opaque (images and shaders by their alpha).
 */
function planRange(ctx: PlanContext, first: number, end: number, rect: IRect, shape: boolean): FramePlan {
  const list = ctx.list;
  const items = list.items;
  const view = multiply(translation(-rect.x, -rect.y), ctx.view);
  const width = rect.width;
  const height = rect.height;
  const entries: FrameEntry[] = [];
  const plan: FramePlan = { list, atlas: ctx.atlas, images: ctx.images, width, height, view, entries, graph: [], time: ctx.time };
  const inv = invert(view);
  if (!inv) return plan;
  const screen: Rect = { minX: 0, minY: 0, maxX: width, maxY: height };
  const hits = list.index.query(transformRect(inv, screen));
  const open: number[] = [];
  let chain: number[] = [];
  let skipUntil = -1;

  const deviceBounds = (item: DrawItem): Rect => intersectRect(transformRect(view, item.worldBounds), screen);
  /** Frame-pixel rectangle of local device bounds. */
  const toFrame = (r: IRect): IRect => ({ x: r.x + rect.x, y: r.y + rect.y, width: r.width, height: r.height });
  const isRegister = (p: number): boolean => {
    const mode = items[p]!.layer!.mode;
    return shape ? mode === "clip" || mode === "mask-group" || mode === "mask-source" : mode !== "offscreen";
  };

  const openLayer = (p: number): void => {
    const begin = items[p]!;
    const layerMatrix = multiply(view, begin.world);
    const info = begin.layer!;
    entries.push({
      kind: ItemKind.BeginLayer,
      item: begin,
      geometry: begin.geometry && isUsable(layerMatrix) ? begin.geometry.at(maxScale(layerMatrix)) : null,
      paint: null,
      matrix: layerMatrix,
      bounds: deviceBounds(begin),
      glyphs: null,
      alpha: shape ? 1 : begin.alpha,
      fillRule: begin.fillRule,
      layer: shape ? { ...info, blend: "normal", backdrop: false } : info,
      shape: false,
      texture: null,
      sampled: null,
      image: null,
    });
    open.push(p);
  };
  const closeLayer = (p: number): void => {
    const begin = items[p]!;
    entries.push({
      kind: ItemKind.EndLayer,
      item: items[begin.match]!,
      geometry: null,
      paint: null,
      matrix: multiply(view, begin.world),
      bounds: deviceBounds(begin),
      glyphs: null,
      alpha: shape ? 1 : begin.alpha,
      fillRule: begin.fillRule,
      layer: shape ? { ...begin.layer!, blend: "normal", backdrop: false } : begin.layer!,
      shape: false,
      texture: null,
      sampled: null,
      image: null,
    });
  };
  /** Opens and closes layers so that exactly `chain` is open. */
  const syncLayers = (target: readonly number[]): void => {
    let common = 0;
    while (common < open.length && common < target.length && open[common] === target[common]) common++;
    while (open.length > common) closeLayer(open.pop()!);
    for (let i = common; i < target.length; i++) openLayer(target[i]!);
  };
  /** A texture entry, wrapped in a blend layer when it has a blend mode. */
  const pushTexture = (item: DrawItem, node: GraphNode, out: IRect, alpha: number, blend: BlendMode): void => {
    const local = { x: out.x - rect.x, y: out.y - rect.y };
    const bounds = { minX: local.x, minY: local.y, maxX: local.x + out.width, maxY: local.y + out.height };
    const base = { item, geometry: null, paint: null, matrix: view, bounds, glyphs: null, fillRule: "nonzero" as FillRule, shape: false, sampled: null, image: null };
    const layer: LayerInfo = { mode: "group", blend, maskType: null, backdrop: false, blurRadius: 0 };
    if (blend !== "normal") entries.push({ ...base, kind: ItemKind.BeginLayer, alpha: 1, layer, texture: null });
    entries.push({ ...base, kind: ItemKind.Fill, alpha, layer: null, texture: { node, x: node.rect.x - rect.x, y: node.rect.y - rect.y } });
    if (blend !== "normal") entries.push({ ...base, kind: ItemKind.EndLayer, alpha: 1, layer, texture: null });
  };

  for (let h = 0; h < hits.length; h++) {
    const index = hits[h]!;
    if (index < first || index >= end || index < skipUntil) continue;
    const item = items[index]!;
    chain = [];
    for (let p = item.parentLayer; p >= first; p = items[p]!.parentLayer) chain.push(p);
    chain.reverse();
    // An offscreen layer (layer blur) draws as one texture: its content is planned on its own.
    let offscreen = -1;
    if (!shape) {
      const oi = chain.findIndex((p) => items[p]!.layer!.mode === "offscreen");
      if (oi >= 0) {
        offscreen = chain[oi]!;
        chain = chain.slice(0, oi);
      } else if (item.kind === ItemKind.BeginLayer && item.layer!.mode === "offscreen") {
        offscreen = index;
      }
    }
    syncLayers(chain.filter(isRegister));
    if (offscreen >= 0) {
      const o = items[offscreen]!;
      skipUntil = o.match;
      const out = toIRect(deviceBounds(o));
      if (!out) continue;
      const frameOut = toFrame(out);
      const s = Math.sqrt(Math.abs(determinant(multiply(view, o.world))));
      const sigma = (o.layer!.blurRadius / 2) * s;
      const contentRect = clampRect(grow(frameOut, Math.ceil(3 * sigma) + 1));
      const content = raster(ctx, offscreen + 1, o.match, contentRect, false, null);
      const blurred = blur(ctx, content, sigma, "transparent");
      pushTexture(o, blurred, frameOut, o.alpha, "normal");
      continue;
    }
    if (item.kind === ItemKind.BeginLayer) continue; // offscreen layers in shape mode: their content is hit on its own
    if (item.kind === ItemKind.Effect) {
      if (shape || item.alpha <= 0) continue;
      const out = toIRect(deviceBounds(item));
      if (!out) continue;
      const effect = planEffect(ctx, item, view, toFrame(out));
      if (effect) pushTexture(item, effect.node, toFrame(out), item.alpha, effect.blend);
      continue;
    }

    // Fills.
    const alpha = shape ? 1 : item.alpha;
    if (alpha <= 0) continue;
    const bounds = deviceBounds(item);
    if (isEmptyRect(bounds) || bounds.maxX <= bounds.minX || bounds.maxY <= bounds.minY) continue;
    const matrix = multiply(view, item.world);
    if (!isUsable(matrix)) continue;
    const paint = ctx.paints.get(item);
    if (!paint) continue;
    const vectorMask = chain.some((p) => items[p]!.layer!.mode === "mask-source" && items[p]!.layer!.maskType === "vector");
    const entryShape = shape || vectorMask;
    const base = { kind: ItemKind.Fill, item, paint, matrix, alpha, fillRule: item.fillRule, layer: null, shape: entryShape, texture: null };
    // Text: small axis-aligned glyph runs draw from the glyph atlas.
    const run = item.paintRole === "fill" ? item.node.glyphs : null;
    if (run && ctx.atlas && atlasCompatible(matrix, run)) {
      const placements = placeGlyphs(ctx.atlas, run, matrix);
      if (placements) {
        let glyphBounds: Rect = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
        for (const p of placements) {
          glyphBounds = {
            minX: Math.min(glyphBounds.minX, p.x),
            minY: Math.min(glyphBounds.minY, p.y),
            maxX: Math.max(glyphBounds.maxX, p.x + p.glyph.width),
            maxY: Math.max(glyphBounds.maxY, p.y + p.glyph.height),
          };
        }
        const b = intersectRect(glyphBounds, screen);
        if (placements.length > 0 && !isEmptyRect(b) && b.maxX > b.minX && b.maxY > b.minY) {
          entries.push({ ...base, geometry: null, bounds: b, glyphs: placements, sampled: meshLut(ctx, paint, matrix), image: imagePlacement(ctx, paint, matrix, b) });
        }
        continue;
      }
    }
    let sampled: TextureDraw | null = meshLut(ctx, paint, matrix);
    if (item.backdrop && !entryShape) {
      const node = planPaintBackdrop(ctx, item, view, rect, bounds);
      if (node) sampled = { node, x: node.rect.x - rect.x, y: node.rect.y - rect.y };
    }
    entries.push({ ...base, geometry: item.geometry!.at(maxScale(matrix)), bounds, glyphs: null, sampled, image: imagePlacement(ctx, paint, matrix, bounds) });
  }
  while (open.length > 0) closeLayer(open.pop()!);
  return plan;
}

function imagePlacement(ctx: PlanContext, paint: PaintRecord, matrix: Mat2D, bounds: Rect): ImagePlacement | null {
  const p = paint.paint;
  if (!p.image || !ctx.images) return null;
  const toImage = deviceToImage(matrix, p.imageMatrix);
  if (!toImage) return null;
  const repeat = p.kind === 5 && p.params[2] === 1;
  return ctx.images.place(p.image, toImage, bounds, repeat);
}

/** The lookup texture of a mesh gradient paint, sized to half its box on screen (16 to 512 texels a side). */
function meshLut(ctx: PlanContext, paint: PaintRecord, matrix: Mat2D): TextureDraw | null {
  const p = paint.paint;
  if (p.kind !== 6 || p.params[0] !== 0) return null;
  const s = Math.sqrt(Math.abs(determinant(matrix)));
  const side = (v: number): number => Math.max(16, Math.min(512, Math.ceil((v * s) / 2)));
  const width = side(p.params[4]!);
  const height = side(p.params[5]!);
  const time = p.params[2]! + ctx.time * p.params[3]!;
  const node = addNode<MeshNode>(ctx, { op: "mesh", key: `mesh${paint.uploadId}:${width}x${height}:t${time}`, rect: { x: 0, y: 0, width, height }, paint, time });
  return { node, x: 0, y: 0 };
}

/** A raster node for the items [first, end) over `rect`, keyed by what it draws. */
function raster(ctx: PlanContext, first: number, end: number, rect: IRect, shape: boolean, background: readonly [number, number, number, number] | null): RasterNode {
  const plan = planRange(ctx, first, end, rect, shape);
  return addNode<RasterNode>(ctx, {
    op: "raster",
    key: `r${first}-${end}${shape ? "s" : ""}${background ? `b${background.join(",")}` : ""}@${rectKey(ctx, rect)}|${ctx.frameKey}`,
    rect,
    plan,
    background,
  });
}

/** A raster of one synthetic item (an exact spread shape), as coverage. */
function rasterItem(ctx: PlanContext, item: DrawItem, rect: IRect): RasterNode {
  const view = multiply(translation(-rect.x, -rect.y), ctx.view);
  const matrix = multiply(view, item.world);
  const screen: Rect = { minX: 0, minY: 0, maxX: rect.width, maxY: rect.height };
  const bounds = intersectRect(transformRect(matrix, item.geometry!.localBounds()), screen);
  const entries: FrameEntry[] = [];
  if (!isEmptyRect(bounds) && bounds.maxX > bounds.minX && bounds.maxY > bounds.minY && isUsable(matrix)) {
    entries.push({
      kind: ItemKind.Fill, item, geometry: item.geometry!.at(maxScale(matrix)), paint: null, matrix, bounds, glyphs: null,
      alpha: 1, fillRule: "nonzero", layer: null, shape: true, texture: null, sampled: null, image: null,
    });
  }
  const plan: FramePlan = { list: ctx.list, atlas: ctx.atlas, images: ctx.images, width: rect.width, height: rect.height, view, entries, graph: [], time: ctx.time };
  return addNode<RasterNode>(ctx, { op: "raster", key: `spread${item.node.id}:${item.geometry!.localBounds().minX}@${rectKey(ctx, rect)}|${ctx.frameKey}`, rect, plan, background: null });
}

function blur(ctx: PlanContext, input: GraphNode, sigma: number, edge: "transparent" | "mirror"): GraphNode {
  if (!(sigma > 0.05)) return input;
  return addNode<BlurNode>(ctx, { op: "blur", key: `blur${sigma.toFixed(4)}${edge}(${input.key})`, rect: input.rect, input, sigma, edge });
}

/** Plans one effect item over `out` (frame pixels); returns its output node and blend mode. */
function planEffect(ctx: PlanContext, item: DrawItem, view: Mat2D, out: IRect): { node: GraphNode; blend: BlendMode } | null {
  const fx = item.effect!;
  const e = fx.effect;
  const m = multiply(view, item.world);
  const s = Math.sqrt(Math.abs(determinant(m)));
  if (!(s > 0)) return null;
  const sigma = (e.radius / 2) * s;
  const reach = Math.ceil(3 * sigma) + 1;
  const ownShape = fx.ownFill >= 0 ? ([fx.ownFill, fx.ownFill + 1] as const) : ([fx.contentFirst, fx.contentEnd] as const);
  if (e.type === "background-blur") {
    // Chromium samples the backdrop only inside the element's border box and mirrors it at the edges.
    const shapeWorld = fx.ownFill >= 0 ? ctx.list.items[fx.ownFill]!.worldBounds : contentWorldBounds(ctx.list, fx.contentFirst, fx.contentEnd);
    const shapeBounds = toIRect(transformRect(ctx.view, shapeWorld));
    if (!shapeBounds) return null;
    const region = intersectI(shapeBounds, grow(out, reach));
    if (!region) return null;
    const back = raster(ctx, fx.rootFirst, item.index, clampRect(region), false, fx.rootIsCanvas ? ctx.background : null);
    const blurred = blur(ctx, back, sigma, "mirror");
    const mask = raster(ctx, ownShape[0], ownShape[1], out, true, null);
    return { node: addNode<BackdropNode>(ctx, { op: "backdrop", key: `bd(${blurred.key})(${mask.key})`, rect: out, blurred, shape: mask }), blend: "normal" };
  }
  if (e.type === "layer-blur") return null;
  if (!("offset" in e)) return null;
  const ox = m[0] * e.offset.x + m[2] * e.offset.y;
  const oy = m[1] * e.offset.x + m[3] * e.offset.y;
  const spread = e.spread * s;
  const color = premultiply(e.color);
  const blend = e.blendMode ?? "normal";
  if (e.type === "drop-shadow") {
    const sourceOut = { x: Math.floor(out.x - ox), y: Math.floor(out.y - oy), width: out.width + 2, height: out.height + 2 };
    const r0 = grow(sourceOut, reach + Math.max(0, Math.ceil(spread)) + 1);
    const srcRect = clampRect(unionI(r0, out));
    const shapeNode = raster(ctx, fx.contentFirst, fx.contentEnd, srcRect, true, null);
    let spreadNode: GraphNode = shapeNode;
    if (fx.spreadItem) spreadNode = rasterItem(ctx, fx.spreadItem, srcRect);
    else if (Math.abs(spread) >= 0.01) spreadNode = addNode<MorphNode>(ctx, { op: "morph", key: `morph${spread.toFixed(3)}(${shapeNode.key})`, rect: srcRect, input: shapeNode, radius: spread });
    const blurred = blur(ctx, spreadNode, sigma, "transparent");
    const knockout = e.showBehind ? null : shapeNode;
    return {
      node: addNode<ShadowNode>(ctx, { op: "shadow", key: `ds${ox.toFixed(3)},${oy.toFixed(3)},${color.join(",")}(${blurred.key})(${knockout?.key ?? ""})@${rectKey(ctx, out)}`, rect: out, blurred, shape: knockout, inner: false, offsetX: ox, offsetY: oy, color }),
      blend,
    };
  }
  // Inner shadow.
  const srcRect = clampRect(grow(out, reach + Math.ceil(Math.hypot(ox, oy) + Math.abs(spread)) + 1));
  const shapeNode = raster(ctx, ownShape[0], ownShape[1], srcRect, true, null);
  let spreadNode: GraphNode = shapeNode;
  if (fx.spreadItem) spreadNode = rasterItem(ctx, fx.spreadItem, srcRect);
  else if (Math.abs(spread) >= 0.01) spreadNode = addNode<MorphNode>(ctx, { op: "morph", key: `morph${(-spread).toFixed(3)}(${shapeNode.key})`, rect: srcRect, input: shapeNode, radius: -spread });
  const blurred = blur(ctx, spreadNode, sigma, "transparent");
  return {
    node: addNode<ShadowNode>(ctx, { op: "shadow", key: `is${ox.toFixed(3)},${oy.toFixed(3)},${color.join(",")}(${blurred.key})(${shapeNode.key})@${rectKey(ctx, out)}`, rect: out, blurred, shape: shapeNode, inner: true, offsetX: ox, offsetY: oy, color }),
    blend,
  };
}

/** The backdrop a backdrop-reading paint (fluted glass) samples, frosted when it asks for it. */
function planPaintBackdrop(ctx: PlanContext, item: DrawItem, view: Mat2D, rect: IRect, bounds: Rect): GraphNode | null {
  const paint = item.paintRole === "fill" ? item.node.fill : item.node.stroke?.paint;
  if (!paint || paint.type !== "shader" || paint.shader !== "fluted-glass") return null;
  const m = multiply(view, item.world);
  const s = Math.sqrt(Math.abs(determinant(m)));
  const sigma = (paint.params.frost / 2) * s;
  // Flutes shift the backdrop by up to a flute width.
  const margin = Math.ceil(paint.params.fluteWidth * s * Math.max(0, Math.min(1, paint.params.distortion))) + Math.ceil(3 * sigma) + 2;
  const out = toIRect(bounds);
  if (!out) return null;
  const region = clampRect(grow({ x: out.x + rect.x, y: out.y + rect.y, width: out.width, height: out.height }, margin));
  const back = raster(ctx, item.backdrop!.rootFirst, item.index, region, false, item.backdrop!.rootIsCanvas ? ctx.background : null);
  return blur(ctx, back, sigma, "mirror");
}

function contentWorldBounds(list: DrawList, first: number, end: number): Rect {
  let b = emptyRect();
  for (let i = first; i < end; i++) {
    const it = list.items[i]!;
    if (it.kind === ItemKind.Fill) b = unionRect(b, it.worldBounds);
  }
  return b;
}

function intersectI(a: IRect, b: IRect): IRect | null {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

function unionI(a: IRect, b: IRect): IRect {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  return { x: x0, y: y0, width: Math.max(a.x + a.width, b.x + b.width) - x0, height: Math.max(a.y + a.height, b.y + b.height) - y0 };
}

function isUsable(m: Mat2D): boolean {
  const det = determinant(m);
  return Number.isFinite(det) && Math.abs(det) > 1e-12 && m.every(Number.isFinite);
}
