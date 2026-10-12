import {
  determinant,
  intersectRect,
  invert,
  isEmptyRect,
  maxScale,
  multiply,
  transformRect,
  type Mat2D,
  type Rect,
} from "@fig-tree/geometry";
import { ItemKind, type DrawItem, type DrawList } from "./compile";
import type { GeometryLevel } from "./geometry-cache";
import { atlasCompatible, placeGlyphs, type GlyphAtlas, type GlyphPlacement } from "./glyphs/atlas";
import { encodePaint, type EncodedPaint } from "./paint";

export interface PaintRecord {
  /** Stable per node and role. */
  readonly key: number;
  /** Changes whenever the encoded paint changes. */
  readonly uploadId: number;
  readonly paint: EncodedPaint;
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
}

export interface FramePlan {
  readonly list: DrawList;
  /** The glyph atlas the plan's text entries use (backends upload its new bitmaps). */
  readonly atlas: GlyphAtlas | null;
  /** Target size in device pixels. */
  readonly width: number;
  readonly height: number;
  /** World to device pixels. */
  readonly view: Mat2D;
  readonly entries: readonly FrameEntry[];
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

/**
 * Culls the draw list against the viewport and produces the ordered entries a
 * backend renders, re-opening only the layers that contain visible content.
 */
export function planFrame(list: DrawList, paints: PaintCache, view: Mat2D, width: number, height: number, atlas: GlyphAtlas | null = null): FramePlan {
  const entries: FrameEntry[] = [];
  const plan: FramePlan = { list, width, height, view, entries, atlas };
  const inv = invert(view);
  if (!inv || width <= 0 || height <= 0) return plan;
  const screen: Rect = { minX: 0, minY: 0, maxX: width, maxY: height };
  const hits = list.index.query(transformRect(inv, screen));
  const items = list.items;
  const open: number[] = [];
  const chain: number[] = [];

  const deviceBounds = (item: DrawItem): Rect => intersectRect(transformRect(view, item.worldBounds), screen);

  for (let h = 0; h < hits.length; h++) {
    const item = items[hits[h]!]!;
    if (item.alpha <= 0) continue;
    const bounds = deviceBounds(item);
    if (isEmptyRect(bounds) || bounds.maxX <= bounds.minX || bounds.maxY <= bounds.minY) continue;
    const matrix = multiply(view, item.world);
    if (!isUsable(matrix)) continue;
    const paint = paints.get(item);
    if (!paint) continue;

    chain.length = 0;
    for (let p = item.parentLayer; p >= 0; p = items[p]!.parentLayer) chain.push(p);
    chain.reverse();
    let common = 0;
    while (common < open.length && common < chain.length && open[common] === chain[common]) common++;
    while (open.length > common) closeLayer(open.pop()!);
    for (let i = common; i < chain.length; i++) {
      const begin = items[chain[i]!]!;
      const layerMatrix = multiply(view, begin.world);
      entries.push({
        kind: ItemKind.BeginLayer,
        item: begin,
        geometry: begin.geometry && isUsable(layerMatrix) ? begin.geometry.at(maxScale(layerMatrix)) : null,
        paint: null,
        matrix: layerMatrix,
        bounds: deviceBounds(begin),
        glyphs: null,
      });
      open.push(chain[i]!);
    }
    // Text: small axis-aligned glyph runs draw from the glyph atlas.
    const run = item.paintRole === "fill" ? item.node.glyphs : null;
    if (run && atlas && atlasCompatible(matrix, run)) {
      const placements = placeGlyphs(atlas, run, matrix);
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
          entries.push({ kind: ItemKind.Fill, item, geometry: null, paint, matrix, bounds: b, glyphs: placements });
        }
        continue;
      }
    }
    entries.push({
      kind: ItemKind.Fill,
      item,
      geometry: item.geometry!.at(maxScale(matrix)),
      paint,
      matrix,
      bounds,
      glyphs: null,
    });
  }
  while (open.length > 0) closeLayer(open.pop()!);
  return plan;

  function closeLayer(beginIndex: number): void {
    const begin = items[beginIndex]!;
    entries.push({
      kind: ItemKind.EndLayer,
      item: items[begin.match]!,
      geometry: null,
      paint: null,
      matrix: multiply(view, begin.world),
      bounds: deviceBounds(begin),
      glyphs: null,
    });
  }
}

function isUsable(m: Mat2D): boolean {
  const det = determinant(m);
  return Number.isFinite(det) && Math.abs(det) > 1e-12 && m.every(Number.isFinite);
}
