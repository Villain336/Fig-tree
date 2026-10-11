import { Path } from "./path";

/** Uniform radius, or `[topLeft, topRight, bottomRight, bottomLeft]`. */
export type CornerRadii = number | readonly [number, number, number, number];

/** Cubic handle length (as a fraction of radius) for a quarter circle. */
const KAPPA = 0.5522847498307936;

/**
 * Rectangle with per-corner radii and optional corner smoothing.
 *
 * Radii are clamped like CSS `border-radius`: if adjacent radii exceed an
 * edge they are all scaled down by the same factor.
 *
 * `smoothing` in [0, 1] turns each circular corner into a curvature-continuous
 * one. Our construction keeps the corner's circular core of radius `r` but
 * shrinks it to a `90° − 2φ` arc (φ = 45°·s), and joins it to each edge with a
 * cubic whose curvature is 0 at the edge and exactly 1/r where it meets the
 * arc (G2 at both ends). The corner then starts `r·(1 + s)` from the vertex
 * instead of `r`. When an edge is too short for that, smoothing is reduced
 * for that corner only, never the radius.
 */
export function roundedRectPath(
  x: number,
  y: number,
  width: number,
  height: number,
  radii: CornerRadii = 0,
  smoothing = 0,
): Path {
  if (width < 0) {
    x += width;
    width = -width;
  }
  if (height < 0) {
    y += height;
    height = -height;
  }
  const raw = typeof radii === "number" ? [radii, radii, radii, radii] : [...radii];
  // Sub-nanounit radii are treated as sharp corners; they would only produce NaN handles.
  const r = raw.map((v) => (Number.isFinite(v) && v > 1e-9 ? v : 0)) as [number, number, number, number];
  const [tl, tr, br, bl] = r;
  const fit = Math.min(
    1,
    tl + tr > 0 ? width / (tl + tr) : 1,
    bl + br > 0 ? width / (bl + br) : 1,
    tl + bl > 0 ? height / (tl + bl) : 1,
    tr + br > 0 ? height / (tr + br) : 1,
  );
  for (let i = 0; i < 4; i++) r[i] = r[i]! * fit;
  const s = Math.min(1, Math.max(0, smoothing));

  // Corners clockwise (y down): vertex, incoming edge direction, outgoing direction.
  const corners = [
    { vx: x, vy: y, ix: 0, iy: -1, ox: 1, oy: 0 },
    { vx: x + width, vy: y, ix: 1, iy: 0, ox: 0, oy: 1 },
    { vx: x + width, vy: y + height, ix: 0, iy: 1, ox: -1, oy: 0 },
    { vx: x, vy: y + height, ix: -1, iy: 0, ox: 0, oy: -1 },
  ] as const;
  // Edge lengths: edge k runs from corner k to corner k+1.
  const edges = [width, height, width, height];
  const smooth = r.map((ri, i) => {
    if (ri === 0 || s === 0) return 0;
    const prev = (i + 3) % 4;
    const next = (i + 1) % 4;
    // Proportional share of each adjacent edge this corner may occupy.
    const shareIn = (edges[prev]! * ri) / (ri + r[prev]!);
    const shareOut = (edges[i]! * ri) / (ri + r[next]!);
    return Math.max(0, Math.min(s, shareIn / ri - 1, shareOut / ri - 1));
  });

  const path = new Path();
  const extent = (i: number): number => r[i]! * (1 + smooth[i]!);
  const tlc = corners[0];
  path.moveTo(tlc.vx + tlc.ox * extent(0), tlc.vy + tlc.oy * extent(0));
  for (const i of [1, 2, 3, 0]) {
    const c = corners[i]!;
    emitCorner(path, c.vx, c.vy, c.ix, c.iy, c.ox, c.oy, r[i]!, smooth[i]!);
  }
  return path.close();
}

/**
 * Appends one corner: a line to the corner's start followed by its curves.
 * Geometry is expressed in the corner frame (u along the incoming edge,
 * v along the outgoing edge, origin at the vertex).
 */
function emitCorner(
  path: Path,
  vx: number, vy: number,
  ix: number, iy: number,
  ox: number, oy: number,
  r: number,
  s: number,
): void {
  const pt = (u: number, v: number): [number, number] => [vx + ix * u + ox * v, vy + iy * u + oy * v];
  if (r === 0) {
    path.lineTo(vx, vy);
    return;
  }
  if (s < 1e-6) {
    path.lineTo(...pt(-r, 0));
    path.cubicTo(...pt(-r + KAPPA * r, 0), ...pt(0, r - KAPPA * r), ...pt(0, r));
    return;
  }
  const phi = (Math.PI / 4) * s;
  const sinP = Math.sin(phi);
  const cosP = Math.cos(phi);
  // Transition cubic P0..P3 (see roundedRectPath doc):
  //   P3 lies on the circle at turning angle φ; P2 = P3 − b·t(φ); P1 = P2 − c·t_in.
  //   Curvature 0 at P0 requires P0, P1, P2 collinear on the edge, which fixes
  //   b = r·tan(φ/2). Curvature 1/r at P3 gives c = 3b²/(2r·sin φ).
  //   The remaining handle a places P0 exactly r(1+s) from the vertex.
  const b = r * Math.tan(phi / 2);
  const c = (3 * b * b) / (2 * r * sinP);
  const a = Math.max(0, r * s + r * sinP - c - b * cosP);
  const p3u = -r + r * sinP;
  const p3v = r * (1 - cosP);
  const p2u = p3u - b * cosP;
  const p2v = p3v - b * sinP; // = 0 analytically
  const p1u = p2u - c;
  const p0u = p1u - a;
  // Circular core from angle φ to 90° − φ.
  const alpha = Math.PI / 2 - 2 * phi;
  const hl = (4 / 3) * Math.tan(alpha / 4) * r;
  const q3u = -r + cosP * r;
  const q3v = r - sinP * r;
  // Mirror across the corner's diagonal: (u, v) -> (-v, -u).
  path.lineTo(...pt(p0u, 0));
  path.cubicTo(...pt(p1u, 0), ...pt(p2u, p2v), ...pt(p3u, p3v));
  if (alpha > 1e-9) {
    path.cubicTo(...pt(p3u + hl * cosP, p3v + hl * sinP), ...pt(q3u - hl * sinP, q3v - hl * cosP), ...pt(q3u, q3v));
  }
  path.cubicTo(...pt(-p2v, -p2u), ...pt(0, -p1u), ...pt(0, -p0u));
}

/** Axis-aligned ellipse built from four cubic quarter arcs. */
export function ellipsePath(cx: number, cy: number, rx: number, ry: number): Path {
  const kx = KAPPA * rx;
  const ky = KAPPA * ry;
  return new Path()
    .moveTo(cx + rx, cy)
    .cubicTo(cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry)
    .cubicTo(cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy)
    .cubicTo(cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry)
    .cubicTo(cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy)
    .close();
}
