import type { Mat2D } from "./matrix";

/**
 * Axis-aligned bounding box. The field names match rbush's `BBox`, so rects
 * can be inserted into the spatial index without conversion.
 */
export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function emptyRect(): Rect {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

export function isEmptyRect(r: Rect): boolean {
  return !(r.minX <= r.maxX && r.minY <= r.maxY);
}

export function rectFromXYWH(x: number, y: number, w: number, h: number): Rect {
  return { minX: Math.min(x, x + w), minY: Math.min(y, y + h), maxX: Math.max(x, x + w), maxY: Math.max(y, y + h) };
}

export function includePoint(r: Rect, x: number, y: number): void {
  if (x < r.minX) r.minX = x;
  if (y < r.minY) r.minY = y;
  if (x > r.maxX) r.maxX = x;
  if (y > r.maxY) r.maxY = y;
}

export function unionRect(a: Rect, b: Rect): Rect {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

export function intersectRect(a: Rect, b: Rect): Rect {
  return {
    minX: Math.max(a.minX, b.minX),
    minY: Math.max(a.minY, b.minY),
    maxX: Math.min(a.maxX, b.maxX),
    maxY: Math.min(a.maxY, b.maxY),
  };
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

export function rectContainsPoint(r: Rect, x: number, y: number): boolean {
  return x >= r.minX && x <= r.maxX && y >= r.minY && y <= r.maxY;
}

export function inflateRect(r: Rect, amount: number): Rect {
  return { minX: r.minX - amount, minY: r.minY - amount, maxX: r.maxX + amount, maxY: r.maxY + amount };
}

/** Bounds of the four transformed corners of `r` (exact for affine maps). */
export function transformRect(m: Mat2D, r: Rect): Rect {
  if (isEmptyRect(r)) return emptyRect();
  const [a, b, c, d, e, f] = m;
  // Interval arithmetic on each output coordinate gives the exact AABB.
  const x0 = a * r.minX, x1 = a * r.maxX, y0 = c * r.minY, y1 = c * r.maxY;
  const u0 = b * r.minX, u1 = b * r.maxX, v0 = d * r.minY, v1 = d * r.maxY;
  return {
    minX: Math.min(x0, x1) + Math.min(y0, y1) + e,
    maxX: Math.max(x0, x1) + Math.max(y0, y1) + e,
    minY: Math.min(u0, u1) + Math.min(v0, v1) + f,
    maxY: Math.max(u0, u1) + Math.max(v0, v1) + f,
  };
}
