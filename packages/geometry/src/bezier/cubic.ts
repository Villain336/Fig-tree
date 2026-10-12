import type { Rect } from "../rect";

/**
 * A cubic Bézier segment. Straight segments are cubics too (control points at
 * the thirds, so every cubic formula applies), flagged `line` so algorithms
 * can take exact shortcuts and so straightness survives splitting.
 */
export interface Cubic {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly x3: number;
  readonly y3: number;
  readonly line: boolean;
}

export function cubic(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): Cubic {
  return { x0, y0, x1, y1, x2, y2, x3, y3, line: false };
}

/** A straight segment as a cubic with control points at the thirds. */
export function lineCubic(x0: number, y0: number, x3: number, y3: number): Cubic {
  const dx = (x3 - x0) / 3;
  const dy = (y3 - y0) / 3;
  return { x0, y0, x1: x0 + dx, y1: y0 + dy, x2: x3 - dx, y2: y3 - dy, x3, y3, line: true };
}

/** Exact degree elevation of a quadratic. */
export function quadCubic(x0: number, y0: number, qx: number, qy: number, x3: number, y3: number): Cubic {
  return cubic(x0, y0, x0 + (2 / 3) * (qx - x0), y0 + (2 / 3) * (qy - y0), x3 + (2 / 3) * (qx - x3), y3 + (2 / 3) * (qy - y3), x3, y3);
}

export function pointAt(c: Cubic, t: number): { x: number; y: number } {
  const mt = 1 - t;
  const a = mt * mt * mt, b = 3 * mt * mt * t, d = 3 * mt * t * t, e = t * t * t;
  return { x: a * c.x0 + b * c.x1 + d * c.x2 + e * c.x3, y: a * c.y0 + b * c.y1 + d * c.y2 + e * c.y3 };
}

export function xAt(c: Cubic, t: number): number {
  const mt = 1 - t;
  return mt * mt * mt * c.x0 + 3 * mt * mt * t * c.x1 + 3 * mt * t * t * c.x2 + t * t * t * c.x3;
}

export function yAt(c: Cubic, t: number): number {
  const mt = 1 - t;
  return mt * mt * mt * c.y0 + 3 * mt * mt * t * c.y1 + 3 * mt * t * t * c.y2 + t * t * t * c.y3;
}

/** First derivative B'(t). */
export function derivativeAt(c: Cubic, t: number): { x: number; y: number } {
  const mt = 1 - t;
  const a = 3 * mt * mt, b = 6 * mt * t, d = 3 * t * t;
  return {
    x: a * (c.x1 - c.x0) + b * (c.x2 - c.x1) + d * (c.x3 - c.x2),
    y: a * (c.y1 - c.y0) + b * (c.y2 - c.y1) + d * (c.y3 - c.y2),
  };
}

/** Second derivative B''(t). */
export function secondDerivativeAt(c: Cubic, t: number): { x: number; y: number } {
  const mt = 1 - t;
  return {
    x: 6 * mt * (c.x2 - 2 * c.x1 + c.x0) + 6 * t * (c.x3 - 2 * c.x2 + c.x1),
    y: 6 * mt * (c.y2 - 2 * c.y1 + c.y0) + 6 * t * (c.y3 - 2 * c.y2 + c.y1),
  };
}

/**
 * Unit tangent at t. Where the derivative vanishes (a handle coinciding with
 * its endpoint), falls back to the second and then the third derivative, so
 * endpoint directions of degenerate cubics are still meaningful. Zero for a
 * point.
 */
export function tangentAt(c: Cubic, t: number): { x: number; y: number } {
  let d = derivativeAt(c, t);
  let len = Math.hypot(d.x, d.y);
  const scale = Math.max(1e-300, Math.abs(c.x3 - c.x0) + Math.abs(c.y3 - c.y0) + Math.abs(c.x1 - c.x0) + Math.abs(c.y1 - c.y0) + Math.abs(c.x2 - c.x3) + Math.abs(c.y2 - c.y3));
  if (len <= scale * 1e-12) {
    // B'(t) ≈ 0: move along the curve's next non-vanishing derivative.
    const dd = secondDerivativeAt(c, t);
    const sign = t > 0.5 ? -1 : 1;
    d = { x: dd.x * sign, y: dd.y * sign };
    len = Math.hypot(d.x, d.y);
    if (len <= scale * 1e-12) {
      d = { x: c.x3 - c.x0 + 3 * (c.x1 - c.x2), y: c.y3 - c.y0 + 3 * (c.y1 - c.y2) };
      len = Math.hypot(d.x, d.y);
      if (len <= scale * 1e-12) {
        d = { x: c.x3 - c.x0, y: c.y3 - c.y0 };
        len = Math.hypot(d.x, d.y);
        if (len === 0) return { x: 0, y: 0 };
      }
    }
  }
  return { x: d.x / len, y: d.y / len };
}

/** Signed curvature at t (positive turning towards +90°, i.e. counter-clockwise in y-up axes). */
export function curvatureAt(c: Cubic, t: number): number {
  const d = derivativeAt(c, t);
  const dd = secondDerivativeAt(c, t);
  const len = Math.hypot(d.x, d.y);
  if (len === 0) return 0;
  return (d.x * dd.y - d.y * dd.x) / (len * len * len);
}

/** De Casteljau split at t. */
export function splitAt(c: Cubic, t: number): [Cubic, Cubic] {
  const ax = c.x0 + (c.x1 - c.x0) * t, ay = c.y0 + (c.y1 - c.y0) * t;
  const bx = c.x1 + (c.x2 - c.x1) * t, by = c.y1 + (c.y2 - c.y1) * t;
  const cx = c.x2 + (c.x3 - c.x2) * t, cy = c.y2 + (c.y3 - c.y2) * t;
  const dx = ax + (bx - ax) * t, dy = ay + (by - ay) * t;
  const ex = bx + (cx - bx) * t, ey = by + (cy - by) * t;
  const fx = dx + (ex - dx) * t, fy = dy + (ey - dy) * t;
  return [
    { x0: c.x0, y0: c.y0, x1: ax, y1: ay, x2: dx, y2: dy, x3: fx, y3: fy, line: c.line },
    { x0: fx, y0: fy, x1: ex, y1: ey, x2: cx, y2: cy, x3: c.x3, y3: c.y3, line: c.line },
  ];
}

/**
 * The part of `c` between parameters t0 and t1 (t0 > t1 gives the reversed
 * piece). Computed by blossoming, so it is exact up to rounding and does not
 * accumulate error like repeated splitting.
 */
export function subCurve(c: Cubic, t0: number, t1: number): Cubic {
  if (t0 === 0 && t1 === 1) return c;
  if (c.line) {
    const p = pointAt(c, t0);
    const q = pointAt(c, t1);
    return lineCubic(p.x, p.y, q.x, q.y);
  }
  const bx = (u: number, v: number, w: number): number => blossom(c.x0, c.x1, c.x2, c.x3, u, v, w);
  const by = (u: number, v: number, w: number): number => blossom(c.y0, c.y1, c.y2, c.y3, u, v, w);
  return {
    x0: bx(t0, t0, t0), y0: by(t0, t0, t0),
    x1: bx(t0, t0, t1), y1: by(t0, t0, t1),
    x2: bx(t0, t1, t1), y2: by(t0, t1, t1),
    x3: bx(t1, t1, t1), y3: by(t1, t1, t1),
    line: false,
  };
}

/** The polar form (blossom) of a 1D cubic Bézier. */
function blossom(p0: number, p1: number, p2: number, p3: number, u: number, v: number, w: number): number {
  // Three rounds of de Casteljau with different parameters.
  const a0 = p0 + (p1 - p0) * u, a1 = p1 + (p2 - p1) * u, a2 = p2 + (p3 - p2) * u;
  const b0 = a0 + (a1 - a0) * v, b1 = a1 + (a2 - a1) * v;
  return b0 + (b1 - b0) * w;
}

export function reverseCubic(c: Cubic): Cubic {
  return { x0: c.x3, y0: c.y3, x1: c.x2, y1: c.y2, x2: c.x1, y2: c.y1, x3: c.x0, y3: c.y0, line: c.line };
}

/** Moves the endpoints (and their handles by the same offsets), keeping the tangent directions. */
export function withEndpoints(c: Cubic, x0: number, y0: number, x3: number, y3: number): Cubic {
  if (c.line) return lineCubic(x0, y0, x3, y3);
  const d0x = x0 - c.x0, d0y = y0 - c.y0, d3x = x3 - c.x3, d3y = y3 - c.y3;
  return { x0, y0, x1: c.x1 + d0x, y1: c.y1 + d0y, x2: c.x2 + d3x, y2: c.y2 + d3y, x3, y3, line: false };
}

export function transformCubic(c: Cubic, m: readonly [number, number, number, number, number, number]): Cubic {
  const [a, b, cc, d, e, f] = m;
  return {
    x0: a * c.x0 + cc * c.y0 + e, y0: b * c.x0 + d * c.y0 + f,
    x1: a * c.x1 + cc * c.y1 + e, y1: b * c.x1 + d * c.y1 + f,
    x2: a * c.x2 + cc * c.y2 + e, y2: b * c.x2 + d * c.y2 + f,
    x3: a * c.x3 + cc * c.y3 + e, y3: b * c.x3 + d * c.y3 + f,
    line: c.line,
  };
}

/** Bounding box of the control polygon (contains the curve). */
export function hullBounds(c: Cubic): Rect {
  return {
    minX: Math.min(c.x0, c.x1, c.x2, c.x3),
    minY: Math.min(c.y0, c.y1, c.y2, c.y3),
    maxX: Math.max(c.x0, c.x1, c.x2, c.x3),
    maxY: Math.max(c.y0, c.y1, c.y2, c.y3),
  };
}

/** Tight bounding box (solves for extrema). */
export function cubicBounds(c: Cubic): Rect {
  const r: Rect = {
    minX: Math.min(c.x0, c.x3),
    minY: Math.min(c.y0, c.y3),
    maxX: Math.max(c.x0, c.x3),
    maxY: Math.max(c.y0, c.y3),
  };
  if (c.line) return r;
  for (const t of extremaParams(c.x0, c.x1, c.x2, c.x3)) {
    const x = xAt(c, t);
    if (x < r.minX) r.minX = x;
    if (x > r.maxX) r.maxX = x;
  }
  for (const t of extremaParams(c.y0, c.y1, c.y2, c.y3)) {
    const y = yAt(c, t);
    if (y < r.minY) r.minY = y;
    if (y > r.maxY) r.maxY = y;
  }
  return r;
}

/** Parameters in (0, 1) where a 1D cubic's derivative vanishes, ascending. */
export function extremaParams(p0: number, p1: number, p2: number, p3: number): number[] {
  // B'(t)/3 = a t² + b t + c
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const out: number[] = [];
  for (const t of solveQuadratic(a, b, c)) if (t > 0 && t < 1) out.push(t);
  out.sort((u, v) => u - v);
  return out;
}

/**
 * Real roots of a t² + b t + c, numerically stable, including the linear case
 * (|a| negligible relative to b and c). A double root is returned once.
 */
export function solveQuadratic(a: number, b: number, c: number): number[] {
  const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(c));
  if (scale === 0) return [];
  if (Math.abs(a) <= scale * 1e-12) {
    if (Math.abs(b) <= scale * 1e-12) return [];
    return [-c / b];
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) {
    // A tiny negative discriminant from rounding is a double root.
    if (disc > -1e-12 * b * b) return [-b / (2 * a)];
    return [];
  }
  if (disc === 0) return [-b / (2 * a)];
  const sq = Math.sqrt(disc);
  const q = -0.5 * (b + (b < 0 ? -sq : sq));
  const r1 = q / a;
  const r2 = q !== 0 ? c / q : -b / a - r1;
  return r1 < r2 ? [r1, r2] : [r2, r1];
}

/**
 * Real roots of a t³ + b t² + c t + d in [lo, hi], ascending. Robust for any
 * coefficients (including a nearly vanishing cubic term, where Cardano's
 * formula cancels catastrophically): the interval is cut at the critical
 * points (stable quadratic roots of the derivative) into monotonic pieces,
 * and each piece whose ends differ in sign is bisected, with Newton steps
 * when they stay inside the bracket. Double roots without a sign change are
 * reported when the polynomial vanishes at a critical point.
 */
export function cubicRootsIn(a: number, b: number, c: number, d: number, lo: number, hi: number): number[] {
  const f = (t: number): number => ((a * t + b) * t + c) * t + d;
  const df = (t: number): number => (3 * a * t + 2 * b) * t + c;
  const cuts = [lo];
  for (const t of solveQuadratic(3 * a, 2 * b, c)) if (t > lo && t < hi) cuts.push(t);
  cuts.push(hi);
  cuts.sort((p, q) => p - q);
  const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d));
  const out: number[] = [];
  const push = (t: number): void => {
    if (out.length === 0 || Math.abs(t - out[out.length - 1]!) > 1e-12 * Math.max(1, Math.abs(t))) out.push(t);
  };
  for (let i = 0; i + 1 < cuts.length; i++) {
    let l = cuts[i]!, r = cuts[i + 1]!;
    let fl = f(l), fr = f(r);
    if (fl === 0) {
      push(l);
      continue;
    }
    if (fl * fr > 0) {
      // A double root at a critical point touches zero without a sign change.
      if (i > 0 && Math.abs(fl) <= 1e-14 * scale) push(l);
      continue;
    }
    if (fr === 0) continue; // reported as the next piece's left end
    let t = l - (fl * (r - l)) / (fr - fl);
    for (let k = 0; k < 100; k++) {
      const ft = f(t);
      if (ft === 0) break;
      if ((ft < 0) === (fl < 0)) {
        l = t;
        fl = ft;
      } else {
        r = t;
        fr = ft;
      }
      const g = df(t);
      let next = g !== 0 ? t - ft / g : (l + r) / 2;
      if (!(next > l && next < r)) next = (l + r) / 2;
      if (Math.abs(next - t) <= 1e-16 * Math.max(1, Math.abs(t)) || r - l <= 1e-16 * Math.max(1, Math.abs(l))) {
        t = next;
        break;
      }
      t = next;
    }
    push(t);
  }
  if (Math.abs(f(hi)) === 0) push(hi);
  return out;
}

/**
 * Real roots of a t³ + b t² + c t + d, ascending. Falls back to the
 * quadratic when the cubic term vanishes; otherwise uses
 * {@link cubicRootsIn} over the Cauchy bound of the roots.
 */
export function solveCubic(a: number, b: number, c: number, d: number): number[] {
  const s = Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d));
  if (s === 0) return [];
  if (Math.abs(a) <= s * 1e-14) return solveQuadratic(b, c, d);
  const bound = 1 + Math.max(Math.abs(b), Math.abs(c), Math.abs(d)) / Math.abs(a);
  return cubicRootsIn(a, b, c, d, -bound, bound);
}

/** Polynomial coefficients [a, b, c, d] of a 1D cubic Bézier: a t³ + b t² + c t + d. */
export function polyCoefficients(p0: number, p1: number, p2: number, p3: number): [number, number, number, number] {
  return [-p0 + 3 * p1 - 3 * p2 + p3, 3 * p0 - 6 * p1 + 3 * p2, -3 * p0 + 3 * p1, p0];
}

/**
 * Parameters in (0, 1) at which the curve is split into pieces monotonic in
 * both x and y (ascending, without duplicates).
 */
export function monotonicSplits(c: Cubic): number[] {
  if (c.line) return [];
  const ts = [...extremaParams(c.x0, c.x1, c.x2, c.x3), ...extremaParams(c.y0, c.y1, c.y2, c.y3)].sort((a, b) => a - b);
  const out: number[] = [];
  for (const t of ts) if (t > 1e-9 && t < 1 - 1e-9 && (out.length === 0 || t - out[out.length - 1]! > 1e-9)) out.push(t);
  return out;
}

/** Inflection parameters in (0, 1). */
export function inflectionParams(c: Cubic): number[] {
  if (c.line) return [];
  // Zeros of B'(t) × B''(t).
  const ax = c.x1 - c.x0, ay = c.y1 - c.y0;
  const bx = c.x2 - 2 * c.x1 + c.x0, by = c.y2 - 2 * c.y1 + c.y0;
  const cx = c.x3 + 3 * (c.x1 - c.x2) - c.x0, cy = c.y3 + 3 * (c.y1 - c.y2) - c.y0;
  const qa = bx * cy - by * cx;
  const qb = ax * cy - ay * cx;
  const qc = ax * by - ay * bx;
  return solveQuadratic(qa, qb, qc).filter((t) => t > 1e-9 && t < 1 - 1e-9);
}

/** Gauss–Legendre nodes and weights on [0, 1]. */
const GL3 = [
  [0.5 - Math.sqrt(15) / 10, 5 / 18],
  [0.5, 8 / 18],
  [0.5 + Math.sqrt(15) / 10, 5 / 18],
] as const;
const GL8_RAW = [
  [-0.9602898564975363, 0.1012285362903763],
  [-0.7966664774136267, 0.2223810344533745],
  [-0.5255324099163290, 0.3137066458778873],
  [-0.1834346424956498, 0.3626837833783620],
  [0.1834346424956498, 0.3626837833783620],
  [0.5255324099163290, 0.3137066458778873],
  [0.7966664774136267, 0.2223810344533745],
  [0.9602898564975363, 0.1012285362903763],
] as const;
const GL8 = GL8_RAW.map(([x, w]) => [(x + 1) / 2, w / 2] as const);

/**
 * The curve's contribution to a contour's signed area, ½∫(x dy − y dx).
 * The integrand is a degree-5 polynomial, so 3-point Gauss–Legendre is exact.
 * Summed over a closed contour this is its shoelace area (positive when the
 * contour turns counter-clockwise in y-up axes, i.e. clockwise on screen).
 */
export function areaContribution(c: Cubic): number {
  if (c.line) return (c.x0 * c.y3 - c.x3 * c.y0) / 2;
  let s = 0;
  for (const [t, w] of GL3) {
    const p = pointAt(c, t);
    const d = derivativeAt(c, t);
    s += w * (p.x * d.y - p.y * d.x);
  }
  return s / 2;
}

/** Arc length from t0 to t1, by adaptive Gauss–Legendre quadrature. */
export function arcLength(c: Cubic, t0 = 0, t1 = 1, tolerance = 1e-9): number {
  if (c.line) {
    return Math.hypot(c.x3 - c.x0, c.y3 - c.y0) * Math.abs(t1 - t0);
  }
  return adaptiveLength(c, t0, t1, glLength(c, t0, t1), tolerance, 0);
}

function glLength(c: Cubic, t0: number, t1: number): number {
  let s = 0;
  const h = t1 - t0;
  for (const [u, w] of GL8) {
    const d = derivativeAt(c, t0 + h * u);
    s += w * Math.hypot(d.x, d.y);
  }
  return s * h;
}

function adaptiveLength(c: Cubic, t0: number, t1: number, whole: number, tol: number, depth: number): number {
  const m = (t0 + t1) / 2;
  const left = glLength(c, t0, m);
  const right = glLength(c, m, t1);
  if (depth >= 12 || Math.abs(left + right - whole) <= tol) return left + right;
  return adaptiveLength(c, t0, m, left, tol / 2, depth + 1) + adaptiveLength(c, m, t1, right, tol / 2, depth + 1);
}

/** The parameter at which the arc length from 0 reaches `length` (clamped to [0, 1]). */
export function paramAtLength(c: Cubic, length: number, total = arcLength(c)): number {
  if (length <= 0) return 0;
  if (length >= total) return 1;
  if (c.line) return length / total;
  // Newton on L(t) − length, safeguarded by bisection.
  let lo = 0, hi = 1;
  let t = length / total;
  for (let i = 0; i < 40; i++) {
    const f = arcLength(c, 0, t, 1e-10) - length;
    if (Math.abs(f) < 1e-10 * Math.max(1, total)) return t;
    if (f > 0) hi = t;
    else lo = t;
    const d = derivativeAt(c, t);
    const speed = Math.hypot(d.x, d.y);
    let next = speed > 0 ? t - f / speed : (lo + hi) / 2;
    if (!(next > lo && next < hi)) next = (lo + hi) / 2;
    t = next;
  }
  return t;
}

/**
 * Largest distance of the inner control points from the chord: an upper
 * bound (times 3/4) of the curve's deviation from its chord.
 */
export function flatness(c: Cubic): number {
  if (c.line) return 0;
  const dx = c.x3 - c.x0, dy = c.y3 - c.y0;
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.max(Math.hypot(c.x1 - c.x0, c.y1 - c.y0), Math.hypot(c.x2 - c.x0, c.y2 - c.y0));
  const d1 = Math.abs((c.x1 - c.x0) * dy - (c.y1 - c.y0) * dx) / len;
  const d2 = Math.abs((c.x2 - c.x0) * dy - (c.y2 - c.y0) * dx) / len;
  // Handles that overshoot the chord's ends also deviate.
  const t1 = ((c.x1 - c.x0) * dx + (c.y1 - c.y0) * dy) / (len * len);
  const t2 = ((c.x2 - c.x0) * dx + (c.y2 - c.y0) * dy) / (len * len);
  const over = Math.max(0, -t1, t1 - 1, -t2, t2 - 1) * len;
  return Math.max(d1, d2, over);
}

/** Whether the control points are (numerically) collinear and ordered, so the cubic is a straight segment traversed once. */
export function isStraight(c: Cubic, tolerance: number): boolean {
  return c.line || flatness(c) <= tolerance;
}

/**
 * Closest point on the curve to (px, py): parameter and squared distance.
 * Coarse sampling finds candidates, Newton iterations on (B − p)·B' refine
 * them; endpoints are always considered.
 */
export function closestParam(c: Cubic, px: number, py: number): { t: number; dist2: number } {
  if (c.line) {
    const dx = c.x3 - c.x0, dy = c.y3 - c.y0;
    const l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - c.x0) * dx + (py - c.y0) * dy) / l2));
    const x = c.x0 + dx * t, y = c.y0 + dy * t;
    return { t, dist2: (x - px) ** 2 + (y - py) ** 2 };
  }
  const N = 24;
  let best = { t: 0, dist2: Infinity };
  const d2At = (t: number): number => {
    const p = pointAt(c, t);
    return (p.x - px) ** 2 + (p.y - py) ** 2;
  };
  const consider = (t: number): void => {
    const d2 = d2At(t);
    if (d2 < best.dist2) best = { t, dist2: d2 };
  };
  const starts: number[] = [];
  let prev = Infinity;
  const samples: number[] = [];
  for (let i = 0; i <= N; i++) samples.push(d2At(i / N));
  for (let i = 0; i <= N; i++) {
    const d = samples[i]!;
    const next = i < N ? samples[i + 1]! : Infinity;
    if (d <= prev && d <= next) {
      // Golden-section search in the bracket around the sampled minimum (robust near cusps), then Newton.
      let lo = Math.max(0, (i - 1) / N), hi = Math.min(1, (i + 1) / N);
      const g = 0.6180339887498949;
      let x1 = hi - g * (hi - lo), x2 = lo + g * (hi - lo);
      let f1 = d2At(x1), f2 = d2At(x2);
      for (let k = 0; k < 30; k++) {
        if (f1 < f2) {
          hi = x2;
          x2 = x1;
          f2 = f1;
          x1 = hi - g * (hi - lo);
          f1 = d2At(x1);
        } else {
          lo = x1;
          x1 = x2;
          f1 = f2;
          x2 = lo + g * (hi - lo);
          f2 = d2At(x2);
        }
      }
      starts.push((lo + hi) / 2);
    }
    prev = d;
  }
  consider(0);
  consider(1);
  for (let t of starts) {
    consider(t);
    for (let k = 0; k < 20; k++) {
      const p = pointAt(c, t);
      const d1 = derivativeAt(c, t);
      const d2 = secondDerivativeAt(c, t);
      const rx = p.x - px, ry = p.y - py;
      const f = rx * d1.x + ry * d1.y;
      const g = d1.x * d1.x + d1.y * d1.y + rx * d2.x + ry * d2.y;
      if (g === 0) break;
      let next = t - f / g;
      if (next < 0) next = 0;
      else if (next > 1) next = 1;
      if (Math.abs(next - t) < 1e-15) {
        t = next;
        break;
      }
      t = next;
    }
    consider(t);
  }
  return best;
}

export function cubicToArray(c: Cubic): number[] {
  return [c.x0, c.y0, c.x1, c.y1, c.x2, c.y2, c.x3, c.y3];
}

export function cubicFromArray(a: readonly number[], line = false): Cubic {
  return { x0: a[0]!, y0: a[1]!, x1: a[2]!, y1: a[3]!, x2: a[4]!, y2: a[5]!, x3: a[6]!, y3: a[7]!, line };
}

/** Whether the cubic has zero length (all control points coincide within `eps`). */
export function isDegenerate(c: Cubic, eps: number): boolean {
  return (
    Math.abs(c.x0 - c.x3) <= eps && Math.abs(c.y0 - c.y3) <= eps &&
    Math.abs(c.x1 - c.x0) <= eps && Math.abs(c.y1 - c.y0) <= eps &&
    Math.abs(c.x2 - c.x3) <= eps && Math.abs(c.y2 - c.y3) <= eps
  );
}
