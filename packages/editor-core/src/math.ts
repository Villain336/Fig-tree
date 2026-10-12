import { invert, multiply, transformPoint, type Mat2D, type Point } from "@fig-tree/geometry";

/** An axis-aligned box as position and size (world or screen units). */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export const EMPTY_BOX: Box = { x: 0, y: 0, width: 0, height: 0 };

export function boxRight(b: Box): number {
  return b.x + b.width;
}

export function boxBottom(b: Box): number {
  return b.y + b.height;
}

export function boxCenter(b: Box): Point {
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** The smallest box containing every point. */
export function boxOfPoints(points: readonly Point[]): Box {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (minX > maxX) return EMPTY_BOX;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Union of boxes; null for none. */
export function unionBoxes(boxes: Iterable<Box>): Box | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of boxes) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  return minX <= maxX ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : null;
}

/** Box spanned by two corner points (in any order). */
export function boxFromCorners(a: Point, b: Point): Box {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}

export function boxContainsPoint(b: Box, p: Point): boolean {
  return p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
}

/** Whether `outer` contains `inner` entirely (edges may touch). */
export function boxContainsBox(outer: Box, inner: Box): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}

export function inflateBox(b: Box, d: number): Box {
  return { x: b.x - d, y: b.y - d, width: b.width + 2 * d, height: b.height + 2 * d };
}

/** Whether two boxes overlap (touching counts). */
export function boxesIntersect(a: Box, b: Box): boolean {
  return a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;
}

/** The four corners of a `width × height` box placed by `m` (top-left, top-right, bottom-right, bottom-left). */
export function quad(m: Mat2D, width: number, height: number): [Point, Point, Point, Point] {
  return [transformPoint(m, 0, 0), transformPoint(m, width, 0), transformPoint(m, width, height), transformPoint(m, 0, height)];
}

/** Axis-aligned bounds of a transformed `width × height` box. */
export function transformedBox(m: Mat2D, width: number, height: number): Box {
  return boxOfPoints(quad(m, width, height));
}

/** Whether a convex quad (corners in order) contains a point. */
export function quadContains(q: readonly Point[], p: Point): boolean {
  let sign = 0;
  for (let i = 0; i < q.length; i++) {
    const a = q[i]!;
    const b = q[(i + 1) % q.length]!;
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (Math.abs(cross) < 1e-12) continue;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Distance from `p` to the segment `a`–`b`. */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Local-space point for a world point under `world` (the node's local-to-world matrix). */
export function toLocal(world: Mat2D, p: Point): Point | null {
  const inv = invert(world);
  return inv ? transformPoint(inv, p.x, p.y) : null;
}

/** Angle of a vector in degrees, clockwise from +x in a y-down space. */
export function angleOf(x: number, y: number): number {
  return (Math.atan2(y, x) * 180) / Math.PI;
}

/** Rotation in degrees of a matrix's x axis (y-down, clockwise positive). */
export function matrixRotation(m: Mat2D): number {
  return angleOf(m[0], m[1]);
}

/** Rounds away float noise (1e-9), keeping -0 out of stored values. */
export function clean(v: number, digits = 1e6): number {
  const r = Math.round(v * digits) / digits;
  return Object.is(r, -0) ? 0 : r;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export { invert, multiply, transformPoint, type Mat2D, type Point };
