import { emptyRect, flattenPath, includePoint, multiply, Path, strokePath, type Mat2D, type Polylines, type Rect } from "@fig-tree/geometry";
import { rasterizeCoverage } from "./rasterize";

/**
 * Glyph outlines and runs, as the renderer sees them: the text engine
 * implements {@link GlyphSource} for each font instance and puts
 * {@link GlyphRun}s on scene nodes.
 */
export interface GlyphSource {
  /** Unique per font instance (font file and variation coordinates). */
  readonly key: string;
  readonly unitsPerEm: number;
  /** Outline in font units, y down, origin on the baseline. */
  path(glyphId: number): Path;
  /** Tight outline bounds in font units (y down), or null for an empty glyph. */
  bounds(glyphId: number): Rect | null;
}

export interface GlyphRun {
  readonly source: GlyphSource;
  /** Font size in local units per em. */
  readonly size: number;
  /** Glyph id, x, y (baseline origin, local units) triples. */
  readonly glyphs: Float64Array | Float32Array;
  /** Synthetic oblique: horizontal shear (x += skew · −y), 0 for none. */
  readonly skew?: number;
  /** Synthetic bold: outline expansion in em, 0 for none. */
  readonly embolden?: number;
}

/** A glyph bitmap's place in the atlas. */
export interface AtlasGlyph {
  /** Atlas texel of the bitmap's top-left corner. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Bitmap origin relative to the glyph's pen position (rounded to whole pixels plus the subpixel phase). */
  readonly left: number;
  readonly top: number;
  /** Frame the glyph was last used in (eviction never removes glyphs of the current frame). */
  lastUsed: number;
  readonly key: string;
}

/** A coverage bitmap waiting to be uploaded to the GPU atlas texture. */
export interface AtlasUpload {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** Horizontal subpixel positions per pixel (glyphs are cached at 0, ¼, ½ and ¾). */
export const SUBPIXEL_STEPS = 4;
/** Device sizes above this (px per em) render as paths instead of atlas bitmaps. */
export const ATLAS_MAX_SIZE = 96;
/** Flattening tolerance for atlas glyphs, in device pixels. */
const GLYPH_TOLERANCE = 0.05;

/**
 * Sizes are bucketed so zooming reuses bitmaps: 1/8 px below 24 px, 1/4 px
 * up to 48 px, 1/2 px above. A bucket differs from the exact size by at most
 * a quarter of a pixel per em, invisible at these sizes; positions are
 * always exact.
 */
export function sizeBucket(size: number): number {
  if (size <= 24) return Math.round(size * 8) / 8;
  if (size <= 48) return Math.round(size * 4) / 4;
  return Math.round(size * 2) / 2;
}

/** Cell sizes (square, including a 1 px gutter) of the shelf allocator's classes. */
const CELL_CLASSES = [8, 12, 16, 24, 32, 48, 64, 96, 128];

interface Shelf {
  readonly cell: number;
  readonly y: number;
  /** Next free x for new cells. */
  next: number;
  /** Freed cell x positions. */
  free: number[];
}

/**
 * The CPU side of the glyph atlas: an R8 coverage texture managed as shelves
 * of square cells per size class, filled by the exact-area rasterizer, with
 * least-recently-used eviction that never evicts a glyph the current frame
 * uses. Backends upload {@link takeUploads} into their texture.
 */
export class GlyphAtlas {
  private readonly glyphs = new Map<string, AtlasGlyph>();
  private readonly shelves: Shelf[] = [];
  private shelfTop = 0;
  private uploads: AtlasUpload[] = [];
  /** Current frame number; bump with {@link beginFrame}. */
  frame = 0;
  /** Glyph bitmaps rasterized since creation, and in the current frame. */
  rasterized = 0;
  rasterizedThisFrame = 0;
  evicted = 0;
  /** Bumped when the atlas is reset (backends then re-upload everything). */
  generation = 0;

  constructor(
    readonly width = 2048,
    readonly height = 2048,
  ) {}

  get size(): number {
    return this.glyphs.size;
  }

  beginFrame(): void {
    this.frame++;
    this.rasterizedThisFrame = 0;
  }

  /** Bitmaps rasterized since the last call; backends upload them before drawing. */
  takeUploads(): AtlasUpload[] {
    const u = this.uploads;
    this.uploads = [];
    return u;
  }

  /**
   * The atlas glyph for `gid` of `run` at a device size and subpixel phase,
   * rasterizing it if needed. Returns null when it does not fit (the caller
   * draws the run as paths instead).
   */
  glyph(run: GlyphRun, gid: number, deviceSize: number, phase: number): AtlasGlyph | null {
    const bucket = sizeBucket(deviceSize);
    const key = `${run.source.key}|${gid}|${bucket}|${phase}|${run.skew ?? 0}|${run.embolden ?? 0}`;
    const hit = this.glyphs.get(key);
    if (hit) {
      hit.lastUsed = this.frame;
      return hit;
    }
    // Outline in device pixels, at the subpixel phase.
    const scale = bucket / run.source.unitsPerEm;
    const skew = run.skew ?? 0;
    const m: Mat2D = [scale, 0, -skew * scale, scale, phase / SUBPIXEL_STEPS, 0];
    const outline = run.source.path(gid);
    if (outline.isEmpty()) {
      const empty: AtlasGlyph = { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, lastUsed: this.frame, key };
      this.glyphs.set(key, empty);
      return empty;
    }
    const devicePath = outline.transform(m);
    let poly: Polylines = flattenPath(devicePath, undefined, GLYPH_TOLERANCE);
    const embolden = (run.embolden ?? 0) * bucket;
    let extra: Polylines | null = null;
    if (embolden > 0) extra = strokePath(devicePath, { width: embolden, join: "round" }, undefined, GLYPH_TOLERANCE);
    const b = devicePath.bounds();
    const pad = embolden / 2 + 1;
    const left = Math.floor(b.minX - pad);
    const top = Math.floor(b.minY - pad);
    const width = Math.ceil(b.maxX + pad) - left;
    const height = Math.ceil(b.maxY + pad) - top;
    const cell = CELL_CLASSES.find((c) => c >= Math.max(width, height) + 1);
    if (cell === undefined) return null;
    const slot = this.allocate(cell);
    if (!slot) return null;
    // Rasterize relative to the bitmap's corner.
    const shift = (p: Polylines): Polylines => {
      const pts = new Float64Array(p.points.length);
      for (let i = 0; i < pts.length; i += 2) {
        pts[i] = p.points[i]! - left;
        pts[i + 1] = p.points[i + 1]! - top;
      }
      return { points: pts, contourStarts: p.contourStarts, closed: p.closed };
    };
    poly = shift(poly);
    const data = rasterizeCoverage(poly, width, height);
    if (extra) {
      const stroke = rasterizeCoverage(shift(extra), width, height);
      for (let i = 0; i < data.length; i++) data[i] = Math.min(255, data[i]! + stroke[i]!);
    }
    const g: AtlasGlyph = { x: slot.x, y: slot.y, width, height, left, top, lastUsed: this.frame, key };
    this.glyphs.set(key, g);
    this.uploads.push({ x: slot.x, y: slot.y, width, height, data });
    this.rasterized++;
    this.rasterizedThisFrame++;
    return g;
  }

  /** Finds a free cell of `cell` px: a freed cell, a new cell on a shelf, a new shelf, or an evicted cell. */
  private allocate(cell: number): { x: number; y: number } | null {
    for (const s of this.shelves) {
      if (s.cell !== cell) continue;
      const x = s.free.pop();
      if (x !== undefined) return { x, y: s.y };
      if (s.next + cell <= this.width) {
        const at = s.next;
        s.next += cell;
        return { x: at, y: s.y };
      }
    }
    if (this.shelfTop + cell <= this.height) {
      const s: Shelf = { cell, y: this.shelfTop, next: cell, free: [] };
      this.shelfTop += cell;
      this.shelves.push(s);
      return { x: 0, y: s.y };
    }
    // Evict the least recently used glyph of this cell size not used this frame.
    let victim: AtlasGlyph | null = null;
    for (const g of this.glyphs.values()) {
      if (g.width === 0 || g.lastUsed >= this.frame) continue;
      const s = this.shelfAt(g.y);
      if (!s || s.cell !== cell) continue;
      if (!victim || g.lastUsed < victim.lastUsed) victim = g;
    }
    if (!victim) return null;
    this.glyphs.delete(victim.key);
    this.evicted++;
    return { x: victim.x, y: victim.y };
  }

  private shelfAt(y: number): Shelf | undefined {
    return this.shelves.find((s) => s.y === y);
  }

  /** Forgets every glyph (for example after the GPU texture was lost). */
  reset(): void {
    this.glyphs.clear();
    this.shelves.length = 0;
    this.shelfTop = 0;
    this.uploads = [];
    this.generation++;
  }
}

/** Device-space placement of one glyph bitmap. */
export interface GlyphPlacement {
  /** Device pixel of the bitmap's top-left corner. */
  readonly x: number;
  readonly y: number;
  readonly glyph: AtlasGlyph;
}

/**
 * Places a run's glyphs for an axis-aligned device transform `m` (uniform
 * positive scale plus translation): each glyph snaps its baseline to a
 * whole pixel and its x to a quarter pixel, then takes its bitmap from the
 * atlas. Returns null when the atlas cannot hold them (draw as paths).
 */
export function placeGlyphs(atlas: GlyphAtlas, run: GlyphRun, m: Mat2D): GlyphPlacement[] | null {
  const scale = m[0];
  const deviceSize = run.size * scale;
  const out: GlyphPlacement[] = [];
  const g = run.glyphs;
  for (let i = 0; i + 2 < g.length; i += 3) {
    const x = m[0] * g[i + 1]! + m[4];
    const y = m[3] * g[i + 2]! + m[5];
    const px = Math.floor(x);
    const phase = Math.min(SUBPIXEL_STEPS - 1, Math.round((x - px) * SUBPIXEL_STEPS));
    const carry = Math.round((x - px) * SUBPIXEL_STEPS) === SUBPIXEL_STEPS ? 1 : 0;
    const glyph = atlas.glyph(run, g[i]!, deviceSize, carry ? 0 : phase);
    if (!glyph) return null;
    if (glyph.width === 0) continue;
    out.push({ x: px + carry + glyph.left, y: Math.round(y) + glyph.top, glyph });
  }
  return out;
}

/** Whether a device transform keeps glyphs axis-aligned at one scale, so atlas bitmaps can be used. */
export function atlasCompatible(m: Mat2D, run: GlyphRun): boolean {
  if (Math.abs(m[1]) > 1e-9 || Math.abs(m[2]) > 1e-9) return false;
  if (!(m[0] > 0) || Math.abs(m[0] - m[3]) > 1e-9 * m[0]) return false;
  return run.size * m[0] <= ATLAS_MAX_SIZE;
}

/** The run's outlines as one path in local units (for drawing as paths and hit-testing). */
export function runOutlinePath(run: GlyphRun): Path {
  const out = new Path();
  const scale = run.size / run.source.unitsPerEm;
  const skew = run.skew ?? 0;
  const g = run.glyphs;
  for (let i = 0; i + 2 < g.length; i += 3) {
    const glyph = run.source.path(g[i]!);
    if (glyph.isEmpty()) continue;
    const m: Mat2D = multiply([1, 0, 0, 1, g[i + 1]!, g[i + 2]!], [scale, 0, -skew * scale, scale, 0, 0]);
    out.appendTransformed(glyph, m);
  }
  return out;
}

/** Local bounds of a run's outlines (from per-glyph bounds; with skew and embolden margins). */
export function runBounds(run: GlyphRun): Rect {
  const r = emptyRect();
  const scale = run.size / run.source.unitsPerEm;
  const skew = run.skew ?? 0;
  const pad = ((run.embolden ?? 0) * run.size) / 2;
  const g = run.glyphs;
  for (let i = 0; i + 2 < g.length; i += 3) {
    const b = run.source.bounds(g[i]!);
    if (!b) continue;
    const x = g[i + 1]!;
    const y = g[i + 2]!;
    // Shear moves x by -skew * y; the extremes are at the box's top and bottom corners.
    for (const [bx, by] of [[b.minX, b.minY], [b.maxX, b.minY], [b.minX, b.maxY], [b.maxX, b.maxY]] as const) {
      includePoint(r, x + (bx - skew * by) * scale - pad, y + by * scale - pad);
      includePoint(r, x + (bx - skew * by) * scale + pad, y + by * scale + pad);
    }
  }
  return r;
}
