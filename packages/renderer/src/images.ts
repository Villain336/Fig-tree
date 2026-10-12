import { invert, transformPoint, type Mat2D, type Rect } from "@fig-tree/geometry";
import type { RenderImage } from "./types";

/** Side of the image atlas texture (RGBA8, premultiplied): 64 MB of GPU memory at most. */
export const IMAGE_ATLAS_SIZE = 4096;
/** Requested image rectangles are rounded out to this many texels, so small pans reuse uploads. */
const RECT_GRAIN = 64;
/** CPU memory kept for decoded mip levels beyond level 0, least recently used first out. */
const MIP_BUDGET_BYTES = 256 << 20;

/** Where a frame finds an image region: a rectangle of one mip level, copied into the atlas. */
export interface ImagePlacement {
  /** Atlas texel of the rectangle's top-left corner. */
  readonly atlasX: number;
  readonly atlasY: number;
  readonly level: number;
  /** Size of the whole mip level in texels. */
  readonly levelWidth: number;
  readonly levelHeight: number;
  /** The rectangle of the level held in the atlas. */
  readonly rectX: number;
  readonly rectY: number;
  readonly rectWidth: number;
  readonly rectHeight: number;
  /** Device pixels per level-0 image pixel along the image's axes (for edge anti-aliasing). */
  readonly pixelsPerTexel: number;
}

export interface ImageUpload {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** RGBA8 premultiplied, rows top to bottom. */
  readonly data: Uint8Array;
}

interface Level {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

interface Shelf {
  y: number;
  height: number;
  x: number;
}

/**
 * Images on the GPU: per frame, every image draw asks for the part of one
 * mip level it needs (the level whose texels are closest to, but not larger
 * than, a device pixel; only the visible rectangle, unless the image
 * repeats). Rectangles are copied into one atlas texture and reused across
 * frames; when the atlas fills up it is cleared and refilled with what the
 * current frame needs, and if even that does not fit, draws fall back to
 * coarser levels. So GPU memory for images never exceeds the atlas, however
 * large the images are. Mip levels are built on the CPU (2x2 box filter of
 * premultiplied texels) and kept within a memory budget.
 */
export class ImageAtlas {
  readonly width = IMAGE_ATLAS_SIZE;
  readonly height = IMAGE_ATLAS_SIZE;
  /** Bumped when the atlas is cleared; backends then drop their texture's contents. */
  generation = 0;
  private placements = new Map<string, { placement: ImagePlacement; frame: number }>();
  private shelves: Shelf[] = [];
  private uploads: ImageUpload[] = [];
  private frame = 0;
  private readonly mips = new Map<string, Level[]>();
  private mipBytes = 0;
  /** Bytes uploaded this frame, for stats. */
  uploadedThisFrame = 0;
  /** Whether the atlas has ever been used (backends create the texture lazily). */
  used = false;

  /** `replan`: the frame is being planned again after a clear; never clear twice (fall back to coarser levels). */
  beginFrame(replan = false): void {
    this.frame++;
    this.repeatFrame = false;
    this.noClear = replan;
    this.uploadedThisFrame = 0;
  }

  takeUploads(): ImageUpload[] {
    const u = this.uploads;
    this.uploads = [];
    return u;
  }

  /**
   * Places the region of `image` a draw needs: `deviceToImage` maps device
   * pixels to level-0 image pixels, `device` is the draw's visible device
   * rectangle. Returns null for empty images.
   */
  place(image: RenderImage, deviceToImage: Mat2D, device: Rect, repeat: boolean): ImagePlacement | null {
    if (image.width <= 0 || image.height <= 0) return null;
    this.used = true;
    const texelsPerPixel = Math.max(Math.hypot(deviceToImage[0], deviceToImage[1]), Math.hypot(deviceToImage[2], deviceToImage[3]));
    const maxLevel = Math.floor(Math.log2(Math.max(image.width, image.height)));
    let level = texelsPerPixel > 1 ? Math.min(maxLevel, Math.floor(Math.log2(texelsPerPixel) + 1e-9)) : 0;
    const pixelsPerTexel = texelsPerPixel > 0 ? 1 / texelsPerPixel : 1;
    for (; level <= maxLevel; level++) {
      const lw = levelSize(image.width, level);
      const lh = levelSize(image.height, level);
      let rect: [number, number, number, number];
      if (repeat) rect = [0, 0, lw, lh];
      else {
        // The visible device rectangle in level texels, rounded out to the grain.
        const sx = lw / image.width;
        const sy = lh / image.height;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const [px, py] of [[device.minX, device.minY], [device.maxX, device.minY], [device.maxX, device.maxY], [device.minX, device.maxY]] as const) {
          const p = transformPoint(deviceToImage, px, py);
          x0 = Math.min(x0, p.x * sx);
          y0 = Math.min(y0, p.y * sy);
          x1 = Math.max(x1, p.x * sx);
          y1 = Math.max(y1, p.y * sy);
        }
        const g = RECT_GRAIN;
        const rx0 = clampInt(Math.floor((x0 - 2) / g) * g, 0, lw);
        const ry0 = clampInt(Math.floor((y0 - 2) / g) * g, 0, lh);
        const rx1 = clampInt(Math.ceil((x1 + 2) / g) * g, 0, lw);
        const ry1 = clampInt(Math.ceil((y1 + 2) / g) * g, 0, lh);
        if (rx1 <= rx0 || ry1 <= ry0) return null;
        rect = [rx0, ry0, rx1 - rx0, ry1 - ry0];
      }
      if (rect[2] > this.width || rect[3] > this.height) continue;
      const key = `${image.key}|${level}|${rect.join(",")}`;
      const cached = this.placements.get(key);
      if (cached) {
        cached.frame = this.frame;
        return cached.placement;
      }
      let spot = this.allocate(rect[2], rect[3]);
      if (!spot && !this.noClear) {
        this.clearUnused();
        spot = this.allocate(rect[2], rect[3]);
      }
      if (!spot) continue; // even an empty atlas has no room: try a coarser level
      const placement: ImagePlacement = {
        atlasX: spot.x, atlasY: spot.y, level, levelWidth: lw, levelHeight: lh,
        rectX: rect[0], rectY: rect[1], rectWidth: rect[2], rectHeight: rect[3], pixelsPerTexel,
      };
      this.placements.set(key, { placement, frame: this.frame });
      const data = this.levelData(image, level);
      const upload = new Uint8Array(rect[2] * rect[3] * 4);
      for (let y = 0; y < rect[3]; y++) {
        const src = ((rect[1] + y) * lw + rect[0]) * 4;
        upload.set(data.subarray(src, src + rect[2] * 4), y * rect[2] * 4);
      }
      this.uploads.push({ x: spot.x, y: spot.y, width: rect[2], height: rect[3], data: upload });
      this.uploadedThisFrame += upload.byteLength;
      return placement;
    }
    return null;
  }

  /** Shelf allocation with one texel of padding around each rectangle. */
  private allocate(w: number, h: number): { x: number; y: number } | null {
    const pw = w + 1;
    const ph = h + 1;
    for (const s of this.shelves) {
      if (ph <= s.height && s.x + pw <= this.width) {
        const spot = { x: s.x, y: s.y };
        s.x += pw;
        return spot;
      }
    }
    const top = this.shelves.reduce((m, s) => Math.max(m, s.y + s.height), 0);
    if (top + ph > this.height || pw > this.width) return null;
    this.shelves.push({ y: top, height: ph, x: pw });
    return { x: 0, y: top };
  }

  /**
   * Starts over with an empty atlas. Placements handed out earlier in this
   * frame point at rectangles that may now be overwritten, so the frame is
   * flagged to be planned again (`repeatFrame`); the renderer does that once.
   */
  private clearUnused(): void {
    this.placements.clear();
    this.shelves = [];
    this.uploads = [];
    this.generation++;
    this.repeatFrame = true;
  }

  /** Set when the atlas was cleared while a frame was being planned. */
  repeatFrame = false;
  private noClear = false;

  /** Mip level `level` of an image (level 0 is the image itself). */
  levelData(image: RenderImage, level: number): Uint8Array {
    if (level === 0) return image.data;
    let levels = this.mips.get(image.key);
    if (!levels) {
      levels = [{ width: image.width, height: image.height, data: image.data }];
      this.mips.set(image.key, levels);
    } else {
      // Most recently used last.
      this.mips.delete(image.key);
      this.mips.set(image.key, levels);
    }
    while (levels.length <= level) {
      const prev = levels[levels.length - 1]!;
      const next = downsample(prev);
      levels.push(next);
      this.mipBytes += next.data.byteLength;
    }
    while (this.mipBytes > MIP_BUDGET_BYTES && this.mips.size > 1) {
      const [oldest, old] = this.mips.entries().next().value as [string, Level[]];
      if (oldest === image.key) break;
      for (const l of old.slice(1)) this.mipBytes -= l.data.byteLength;
      this.mips.delete(oldest);
    }
    return levels[level]!.data;
  }
}

/** Size of mip level `level` along an axis of `size` texels. */
export function levelSize(size: number, level: number): number {
  return Math.max(1, Math.floor(size / 2 ** level));
}

/** Halves a level with a box filter over premultiplied texels (odd edges fold into the last texel). */
function downsample(src: Level): Level {
  const w = Math.max(1, Math.floor(src.width / 2));
  const h = Math.max(1, Math.floor(src.height / 2));
  const out = new Uint8Array(w * h * 4);
  const sx = src.width / w;
  const sy = src.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, a = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * src.width + xx) * 4;
          r += src.data[i]!;
          g += src.data[i + 1]!;
          b += src.data[i + 2]!;
          a += src.data[i + 3]!;
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y * w + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return { width: w, height: h, data: out };
}

/** Device → image pixel mapping of an image draw: the inverse of (device ← local ← image). */
export function deviceToImage(entryMatrix: Mat2D, localToImage: Mat2D): Mat2D | null {
  const inv = invert(entryMatrix);
  if (!inv) return null;
  const [a, b, c, d, e, f] = localToImage;
  const [A, B, C, D, E, F] = inv;
  return [a * A + c * B, b * A + d * B, a * C + c * D, b * C + d * D, a * E + c * F + e, b * E + d * F + f];
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
