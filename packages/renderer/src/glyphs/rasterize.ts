import type { Polylines } from "@fig-tree/geometry";

/**
 * Exact-area coverage of closed polygons on a pixel grid, on the CPU: the
 * same quantity the WebGPU coverage stage integrates (the area of each
 * pixel inside the shape, nonzero rule clamped to 1), computed with a
 * signed-area accumulation buffer. For every edge and every pixel row it
 * crosses, the edge's signed height in that row is split between the
 * pixels its x-span touches, in proportion to the area to their right;
 * a prefix sum along each row then gives every pixel's winding-weighted
 * area. Used for glyph atlas bitmaps, where shapes are small and many.
 */

/**
 * Rasterizes polygons (contours implicitly closed) given in bitmap pixel
 * coordinates into an 8-bit coverage bitmap of `width` × `height`.
 * Geometry outside the bitmap is clipped (it must not extend left of x = 0
 * by more than the caller accepts: coverage left of the bitmap is dropped).
 */
export function rasterizeCoverage(p: Polylines, width: number, height: number, out = new Uint8Array(width * height)): Uint8Array {
  const stride = width + 2;
  const acc = new Float32Array(stride * height);
  const pts = p.points;
  for (let c = 0; c + 1 < p.contourStarts.length; c++) {
    const s = p.contourStarts[c]!;
    const e = p.contourStarts[c + 1]!;
    if (e - s < 2) continue;
    for (let i = s; i < e; i++) {
      const j = i + 1 < e ? i + 1 : s;
      accumulateLine(acc, stride, height, pts[i * 2]!, pts[i * 2 + 1]!, pts[j * 2]!, pts[j * 2 + 1]!);
    }
  }
  for (let y = 0; y < height; y++) {
    let sum = 0;
    const row = y * stride;
    for (let x = 0; x < width; x++) {
      sum += acc[row + x]!;
      const a = Math.abs(sum);
      out[y * width + x] = a >= 1 ? 255 : Math.round(a * 255);
    }
  }
  return out;
}

/** Adds one edge's signed area to the accumulation buffer (x is clamped to [0, stride - 2]). */
function accumulateLine(acc: Float32Array, stride: number, height: number, x0: number, y0: number, x1: number, y1: number): void {
  if (y0 === y1) return;
  let dir = 1;
  if (y0 > y1) {
    dir = -1;
    [x0, x1] = [x1, x0];
    [y0, y1] = [y1, y0];
  }
  const maxX = stride - 2;
  const dxdy = (x1 - x0) / (y1 - y0);
  const yStart = Math.max(0, Math.floor(y0));
  const yEnd = Math.min(height, Math.ceil(y1));
  for (let y = yStart; y < yEnd; y++) {
    const top = Math.max(y, y0);
    const bottom = Math.min(y + 1, y1);
    const dy = bottom - top;
    if (dy <= 0) continue;
    const xa = clamp(x0 + (top - y0) * dxdy, 0, maxX);
    const xb = clamp(x0 + (bottom - y0) * dxdy, 0, maxX);
    const d = dy * dir;
    const row = y * stride;
    const lo = Math.min(xa, xb);
    const hi = Math.max(xa, xb);
    const ilo = Math.floor(lo);
    const ihi = Math.ceil(hi);
    if (ihi - ilo <= 1) {
      // The edge stays within one pixel column: area right of it in that pixel.
      const mid = (xa + xb) / 2 - ilo;
      acc[row + ilo] = acc[row + ilo]! + d * (1 - mid);
      acc[row + ilo + 1] = acc[row + ilo + 1]! + d * mid;
      continue;
    }
    // The edge crosses several columns: integrate the coverage per column.
    const invW = 1 / (hi - lo);
    const f0 = lo - ilo; // fraction of the first column left of the edge
    const a0 = 0.5 * invW * (1 - f0) * (1 - f0); // area under the edge within the first column (normalized)
    const f1 = hi - (ihi - 1); // fraction of the last column left of the edge's end
    const am = 0.5 * invW * f1 * f1;
    acc[row + ilo] = acc[row + ilo]! + d * a0;
    if (ihi - ilo === 2) {
      acc[row + ilo + 1] = acc[row + ilo + 1]! + d * (1 - a0 - am);
    } else {
      const a1 = invW * (1.5 - f0);
      acc[row + ilo + 1] = acc[row + ilo + 1]! + d * (a1 - a0);
      for (let x = ilo + 2; x < ihi - 1; x++) acc[row + x] = acc[row + x]! + d * invW;
      const a2 = a1 + (ihi - ilo - 3) * invW;
      acc[row + ihi - 1] = acc[row + ihi - 1]! + d * (1 - a2 - am);
    }
    acc[row + ihi] = acc[row + ihi]! + d * am;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
