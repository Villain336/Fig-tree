import {
  flattenPath,
  inflateRect,
  strokePath,
  type Polylines,
  type Rect,
} from "@fig-tree/geometry";
import type { SceneNode } from "./scene";

/** Maximum flattening error in device pixels. */
export const SCREEN_TOLERANCE = 0.2;

/**
 * Cached levels are reused while they are at most this many powers of two
 * finer than required, so small zoom changes never re-flatten.
 */
const LEVEL_HYSTERESIS = 2;
const MIN_LEVEL = -24;
const MAX_LEVEL = 24;

let nextUploadId = 1;

/** Flattened geometry in the node's local space at one tolerance level. */
export interface GeometryLevel {
  /** Unique per (re)build; GPU caches key their uploads on it. */
  readonly uploadId: number;
  readonly level: number;
  readonly polylines: Polylines;
  /** Closed-contour line segments as (x0, y0, x1, y1) quads. */
  readonly segments: Float32Array<ArrayBuffer>;
  readonly segmentCount: number;
  readonly bounds: Rect;
}

export type GeometryRole = "fill" | "stroke";

/**
 * Lazily flattened geometry for one node role. Geometry lives in local space,
 * so moving or rotating a node never invalidates it; only zooming past a
 * tolerance threshold or editing the path does.
 */
export class GeometrySlot {
  private cached: GeometryLevel | null = null;
  private cachedVersion = -1;
  private boundsVersion = -1;
  private bounds: Rect | null = null;

  constructor(readonly node: SceneNode, readonly role: GeometryRole) {}

  /** Conservative local bounds, independent of tolerance. */
  localBounds(): Rect {
    if (this.bounds && this.boundsVersion === this.node.geometryVersion) return this.bounds;
    const path = this.node.path;
    let b: Rect = path ? path.bounds() : { minX: 0, minY: 0, maxX: -1, maxY: -1 };
    const stroke = this.node.stroke;
    if (this.role === "stroke" && stroke) {
      const h = stroke.width / 2;
      const miter = (stroke.join ?? "miter") === "miter" ? Math.max(1, stroke.miterLimit ?? 4) : 1;
      const square = stroke.cap === "square" ? Math.SQRT2 : 1;
      b = inflateRect(b, h * Math.max(miter, square));
    }
    this.bounds = b;
    this.boundsVersion = this.node.geometryVersion;
    return b;
  }

  /** The level currently cached, if still valid for the node's geometry. */
  current(): GeometryLevel | null {
    return this.cached && this.cachedVersion === this.node.geometryVersion ? this.cached : null;
  }

  /**
   * Geometry flattened finely enough for `scale` device pixels per local unit.
   */
  at(scale: number): GeometryLevel {
    const needed = requiredLevel(scale);
    const c = this.current();
    if (c && c.level >= needed && c.level <= needed + LEVEL_HYSTERESIS) return c;
    this.cached = this.build(needed);
    this.cachedVersion = this.node.geometryVersion;
    return this.cached;
  }

  private build(level: number): GeometryLevel {
    const tolerance = SCREEN_TOLERANCE / 2 ** level;
    const path = this.node.path;
    const stroke = this.node.stroke;
    let polylines: Polylines;
    if (!path) polylines = { points: new Float64Array(0), contourStarts: new Uint32Array([0]), closed: new Uint8Array(0) };
    else if (this.role === "stroke" && stroke) polylines = strokePath(path, stroke, undefined, tolerance);
    else polylines = flattenPath(path, undefined, tolerance);
    const segments = polylinesToSegments(polylines);
    return {
      uploadId: nextUploadId++,
      level,
      polylines,
      segments,
      segmentCount: segments.length / 4,
      bounds: polylineBounds(polylines),
    };
  }
}

/** Smallest level L with 2^L >= scale, so local tolerance 0.2/2^L is <= 0.2 device px. */
export function requiredLevel(scale: number): number {
  if (!(scale > 0) || !Number.isFinite(scale)) return 0;
  return Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, Math.ceil(Math.log2(scale) - 1e-9)));
}

/** Converts contours (implicitly closed) to line segments, dropping zero-length edges. */
export function polylinesToSegments(p: Polylines): Float32Array<ArrayBuffer> {
  const pts = p.points;
  let count = 0;
  for (let c = 0; c + 1 < p.contourStarts.length; c++) {
    const n = p.contourStarts[c + 1]! - p.contourStarts[c]!;
    if (n >= 2) count += n;
  }
  const out = new Float32Array(count * 4);
  let k = 0;
  for (let c = 0; c + 1 < p.contourStarts.length; c++) {
    const s = p.contourStarts[c]!;
    const e = p.contourStarts[c + 1]!;
    if (e - s < 2) continue;
    for (let i = s; i < e; i++) {
      const j = i + 1 < e ? i + 1 : s;
      const x0 = Math.fround(pts[i * 2]!), y0 = Math.fround(pts[i * 2 + 1]!);
      const x1 = Math.fround(pts[j * 2]!), y1 = Math.fround(pts[j * 2 + 1]!);
      if (x0 === x1 && y0 === y1) continue;
      out[k++] = x0;
      out[k++] = y0;
      out[k++] = x1;
      out[k++] = y1;
    }
  }
  return k === out.length ? out : out.slice(0, k);
}

function polylineBounds(p: Polylines): Rect {
  const r = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const pts = p.points;
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i]!, y = pts[i + 1]!;
    if (x < r.minX) r.minX = x;
    if (x > r.maxX) r.maxX = x;
    if (y < r.minY) r.minY = y;
    if (y > r.maxY) r.maxY = y;
  }
  return r;
}
