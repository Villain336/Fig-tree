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

/**
 * Appends an elliptical arc as cubic segments of at most 90° each, starting
 * at the current point (which must already be at the arc's start). Angles
 * are in radians, measured clockwise from +x in y-down coordinates.
 */
function appendArc(path: Path, cx: number, cy: number, rx: number, ry: number, start: number, sweep: number): void {
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
  const step = sweep / n;
  const k = (4 / 3) * Math.tan(step / 4);
  let a0 = start;
  for (let i = 0; i < n; i++) {
    const a1 = a0 + step;
    const c0 = Math.cos(a0), s0 = Math.sin(a0);
    const c1 = Math.cos(a1), s1 = Math.sin(a1);
    path.cubicTo(
      cx + rx * (c0 - k * s0), cy + ry * (s0 + k * c0),
      cx + rx * (c1 + k * s1), cy + ry * (s1 - k * c1),
      cx + rx * c1, cy + ry * s1,
    );
    a0 = a1;
  }
}

/**
 * Ellipse in the box `(x, y, width, height)` with optional arc data: a pie or
 * ring segment from `start` sweeping `sweep` radians (clockwise, y down), and
 * an inner radius as a fraction of the outer one. A full sweep with an inner
 * radius is a donut (two oppositely wound contours, correct under nonzero).
 */
export function ellipseArcPath(
  x: number,
  y: number,
  width: number,
  height: number,
  start = 0,
  sweep = Math.PI * 2,
  innerRatio = 0,
): Path {
  const rx = width / 2, ry = height / 2;
  const cx = x + rx, cy = y + ry;
  const inner = Math.min(1, Math.max(0, Number.isFinite(innerRatio) ? innerRatio : 0));
  const full = !(Math.abs(sweep) < Math.PI * 2 - 1e-9);
  const sw = full ? Math.PI * 2 : sweep;
  const path = new Path();
  const at = (r: number, a: number): [number, number] => [cx + rx * r * Math.cos(a), cy + ry * r * Math.sin(a)];
  if (full && inner === 0) return ellipsePath(cx, cy, rx, ry);
  if (full) {
    path.moveTo(...at(1, start));
    appendArc(path, cx, cy, rx, ry, start, sw);
    path.close();
    path.moveTo(...at(inner, start));
    appendArc(path, cx, cy, rx * inner, ry * inner, start, -sw);
    return path.close();
  }
  if (sw === 0) return path;
  path.moveTo(...at(1, start));
  appendArc(path, cx, cy, rx, ry, start, sw);
  if (inner === 0) {
    path.lineTo(cx, cy);
  } else {
    path.lineTo(...at(inner, start + sw));
    appendArc(path, cx, cy, rx * inner, ry * inner, start + sw, -sw);
  }
  return path.close();
}

/**
 * Closed polygon through `points` with every corner rounded by a circular
 * arc tangent to both edges. Each corner's radius is reduced so its tangent
 * points never pass the middle of an adjacent edge. Zero-length edges and
 * straight corners are left sharp.
 */
export function roundedPolygonPath(points: readonly (readonly [number, number])[], radius = 0): Path {
  const path = new Path();
  const n = points.length;
  if (n === 0) return path;
  const r = Number.isFinite(radius) && radius > 1e-9 ? radius : 0;
  if (r === 0 || n < 3) {
    path.moveTo(points[0]![0], points[0]![1]);
    for (let i = 1; i < n; i++) path.lineTo(points[i]![0], points[i]![1]);
    return path.close();
  }
  interface Corner { inX: number; inY: number; outX: number; outY: number; c1x: number; c1y: number; c2x: number; c2y: number; sharp: boolean; vx: number; vy: number }
  const corners: Corner[] = [];
  for (let i = 0; i < n; i++) {
    const [px, py] = points[(i + n - 1) % n]!;
    const [vx, vy] = points[i]!;
    const [nx, ny] = points[(i + 1) % n]!;
    const l1 = Math.hypot(px - vx, py - vy);
    const l2 = Math.hypot(nx - vx, ny - vy);
    const sharp = { inX: vx, inY: vy, outX: vx, outY: vy, c1x: vx, c1y: vy, c2x: vx, c2y: vy, sharp: true, vx, vy };
    if (l1 < 1e-12 || l2 < 1e-12) {
      corners.push(sharp);
      continue;
    }
    const ux = (px - vx) / l1, uy = (py - vy) / l1;
    const wx = (nx - vx) / l2, wy = (ny - vy) / l2;
    const cos = Math.max(-1, Math.min(1, ux * wx + uy * wy));
    const angle = Math.acos(cos); // interior angle between the edges
    if (angle < 1e-6 || Math.PI - angle < 1e-6) {
      corners.push(sharp);
      continue;
    }
    const tanHalf = Math.tan(angle / 2);
    // Tangent distance from the vertex for radius r: r / tan(angle/2).
    const maxT = Math.min(l1, l2) / 2;
    const t = Math.min(r / tanHalf, maxT);
    const rr = t * tanHalf;
    const turn = Math.PI - angle; // arc angle
    const h = (4 / 3) * Math.tan(turn / 4) * rr;
    const inX = vx + ux * t, inY = vy + uy * t;
    const outX = vx + wx * t, outY = vy + wy * t;
    corners.push({ inX, inY, outX, outY, c1x: inX - ux * h, c1y: inY - uy * h, c2x: outX - wx * h, c2y: outY - wy * h, sharp: false, vx, vy });
  }
  const first = corners[0]!;
  path.moveTo(first.outX, first.outY);
  for (let k = 1; k <= n; k++) {
    const c = corners[k % n]!;
    if (c.sharp) {
      path.lineTo(c.vx, c.vy);
      continue;
    }
    path.lineTo(c.inX, c.inY);
    path.cubicTo(c.c1x, c.c1y, c.c2x, c.c2y, c.outX, c.outY);
  }
  return path.close();
}

/** Vertices of a regular polygon or star, stretched so their bounding box fills `(x, y, width, height)`. */
function fitToBox(raw: [number, number][], x: number, y: number, width: number, height: number): [number, number][] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [px, py] of raw) {
    minX = Math.min(minX, px);
    minY = Math.min(minY, py);
    maxX = Math.max(maxX, px);
    maxY = Math.max(maxY, py);
  }
  const sx = maxX - minX > 0 ? width / (maxX - minX) : 0;
  const sy = maxY - minY > 0 ? height / (maxY - minY) : 0;
  return raw.map(([px, py]) => [x + (px - minX) * sx, y + (py - minY) * sy]);
}

/**
 * Regular polygon with `sides` vertices (at least 3), first vertex at the top
 * centre, stretched so it exactly fills the box. Corners are rounded by
 * `cornerRadius` (see {@link roundedPolygonPath}).
 */
export function polygonPath(x: number, y: number, width: number, height: number, sides: number, cornerRadius = 0): Path {
  const n = Math.max(3, Math.floor(sides));
  const raw: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    raw.push([Math.cos(a), Math.sin(a)]);
  }
  return roundedPolygonPath(fitToBox(raw, x, y, width, height), cornerRadius);
}

/**
 * Star with `points` tips (at least 3) and inner vertices at `innerRatio` of
 * the outer radius, first tip at the top centre, stretched to fill the box.
 */
export function starPath(
  x: number,
  y: number,
  width: number,
  height: number,
  points: number,
  innerRatio: number,
  cornerRadius = 0,
): Path {
  const n = Math.max(3, Math.floor(points));
  const inner = Math.min(1, Math.max(0, Number.isFinite(innerRatio) ? innerRatio : 0.5));
  const raw: [number, number][] = [];
  for (let i = 0; i < n * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / n;
    const r = i % 2 === 0 ? 1 : inner;
    raw.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return roundedPolygonPath(fitToBox(raw, x, y, width, height), cornerRadius);
}
