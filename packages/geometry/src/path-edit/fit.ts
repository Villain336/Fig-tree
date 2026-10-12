import { closestParam, cubic, derivativeAt, lineCubic, pointAt, secondDerivativeAt, type Cubic } from "../bezier/cubic";
import type { Vec } from "../vector-network/network";

/**
 * Least-squares cubic fitting, after P. J. Schneider, "An Algorithm for
 * Automatically Fitting Digitized Curves" (Graphics Gems, 1990):
 *
 * 1. Points get chord-length parameters.
 * 2. With the end tangent directions fixed, the two handle lengths that
 *    minimize the squared distances are solved in closed form (a 2×2 system).
 * 3. Parameters are improved by Newton–Raphson steps towards each point's
 *    closest curve point, and the fit is repeated.
 * 4. If the largest distance still exceeds the tolerance, the points are
 *    split at the worst one (with a tangent estimated there) and both halves
 *    are fitted recursively.
 *
 * The error is measured at each point's parameter, which bounds its true
 * distance to the curve from above, so every input point ends up within the
 * tolerance of the fitted curves. Two points always fit (a straight cubic),
 * so recursion terminates.
 *
 * Additions: consecutive duplicate points are dropped, and points where the
 * input turns sharply (more than `cornerAngle`) are kept as corners: the
 * fit is split there and each side keeps its own tangent.
 */

export interface FitOptions {
  /** Largest allowed distance from any input point to the curves. */
  readonly tolerance: number;
  /** Turning angle (degrees) above which a point is a corner. Default 60. */
  readonly cornerAngle?: number;
  /** Newton reparameterization rounds per fit attempt. Default 8. */
  readonly iterations?: number;
}

export function fitCurve(input: readonly Vec[], options: FitOptions): Cubic[] {
  const tol = Math.max(options.tolerance, 1e-12);
  const pts = dedupe(input, tol * 1e-3);
  if (pts.length < 2) return [];
  if (pts.length === 2) return [lineCubic(pts[0]!.x, pts[0]!.y, pts[1]!.x, pts[1]!.y)];
  const corners = cornerIndices(pts, ((options.cornerAngle ?? 60) * Math.PI) / 180);
  const out: Cubic[] = [];
  const iterations = options.iterations ?? 8;
  for (let k = 0; k + 1 < corners.length; k++) {
    const first = corners[k]!, last = corners[k + 1]!;
    const run = pts.slice(first, last + 1);
    if (run.length === 2) {
      out.push(lineCubic(run[0]!.x, run[0]!.y, run[1]!.x, run[1]!.y));
      continue;
    }
    const t1 = endTangent(run, false);
    const t2 = endTangent(run, true);
    fitRecursive(run, 0, run.length - 1, t1, t2, tol, iterations, out);
  }
  return out;
}

function dedupe(pts: readonly Vec[], eps: number): Vec[] {
  const out: Vec[] = [];
  for (const p of pts) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) <= eps && Math.abs(last.y - p.y) <= eps) continue;
    out.push({ x: p.x, y: p.y });
  }
  return out;
}

/** Indices of the first point, the corners, and the last point. */
function cornerIndices(pts: readonly Vec[], maxTurn: number): number[] {
  const out = [0];
  for (let i = 1; i + 1 < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!, c = pts[i + 1]!;
    const ux = b.x - a.x, uy = b.y - a.y, vx = c.x - b.x, vy = c.y - b.y;
    const turn = Math.abs(Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy));
    if (turn > maxTurn) out.push(i);
  }
  out.push(pts.length - 1);
  return out;
}

/** Unit tangent at the start (pointing into the run) or end (pointing back into it). */
function endTangent(pts: readonly Vec[], atEnd: boolean): Vec {
  const n = pts.length;
  const p0 = atEnd ? pts[n - 1]! : pts[0]!;
  // Average the direction to the first few points, weighted towards the nearest.
  let x = 0, y = 0;
  for (let k = 1; k <= Math.min(3, n - 1); k++) {
    const q = atEnd ? pts[n - 1 - k]! : pts[k]!;
    const dx = q.x - p0.x, dy = q.y - p0.y;
    const l = Math.hypot(dx, dy);
    if (l === 0) continue;
    const w = 1 / k;
    x += (dx / l) * w;
    y += (dy / l) * w;
  }
  const avg = normalize({ x, y });
  if (n < 3) return avg;
  // Second-order estimate: the derivative at the end of the parabola through
  // the first three points (chord-length parameters). Used when it agrees
  // with the average (it is exact on smooth input but amplifies noise).
  const p1 = atEnd ? pts[n - 2]! : pts[1]!, p2 = atEnd ? pts[n - 3]! : pts[2]!;
  const s1 = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  const s2 = s1 + Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (s1 === 0 || s2 === s1) return avg;
  const a = -(s1 + s2) / (s1 * s2), b = s2 / (s1 * (s2 - s1)), c = -s1 / (s2 * (s2 - s1));
  const quad = normalize({ x: a * p0.x + b * p1.x + c * p2.x, y: a * p0.y + b * p1.y + c * p2.y });
  return quad.x * avg.x + quad.y * avg.y > Math.cos(Math.PI / 6) ? quad : avg;
}

function normalize(v: Vec): Vec {
  const l = Math.hypot(v.x, v.y);
  return l === 0 ? { x: 0, y: 0 } : { x: v.x / l, y: v.y / l };
}

function fitRecursive(pts: readonly Vec[], first: number, last: number, t1: Vec, t2: Vec, tol: number, iterations: number, out: Cubic[]): void {
  const n = last - first + 1;
  const p0 = pts[first]!, p3 = pts[last]!;
  if (n === 2) {
    out.push(lineCubic(p0.x, p0.y, p3.x, p3.y));
    return;
  }
  let u = chordParams(pts, first, last);
  let bez = generate(pts, first, last, u, t1, t2);
  let { max, index } = maxError(pts, first, last, bez, u);
  if (max <= tol && tame(bez)) {
    out.push(bez);
    return;
  }
  // Newton reparameterization rounds while they help (Schneider only tries them when close).
  {
    for (let i = 0; i < iterations; i++) {
      const u2 = reparameterize(pts, first, last, u, bez);
      const bez2 = generate(pts, first, last, u2, t1, t2);
      const e2 = maxError(pts, first, last, bez2, u2);
      if (e2.max >= max * 0.99) break;
      u = u2;
      bez = bez2;
      ({ max, index } = e2);
      if (max <= tol && tame(bez)) {
        out.push(bez);
        return;
      }
    }
  }
  // Split at the worst point.
  const split = Math.min(last - 1, Math.max(first + 1, index));
  const a = pts[split - 1]!, c = pts[split + 1]!;
  let center = normalize({ x: a.x - c.x, y: a.y - c.y });
  if (center.x === 0 && center.y === 0) center = normalize({ x: a.x - pts[split]!.x, y: a.y - pts[split]!.y });
  fitRecursive(pts, first, split, t1, center, tol, iterations, out);
  fitRecursive(pts, split, last, { x: -center.x, y: -center.y }, t2, tol, iterations, out);
}

/** Rejects fits whose handles are much longer than the chord: they loop or cusp between the points. */
function tame(c: Cubic): boolean {
  const chord = Math.hypot(c.x3 - c.x0, c.y3 - c.y0);
  return Math.hypot(c.x1 - c.x0, c.y1 - c.y0) <= 2 * chord && Math.hypot(c.x2 - c.x3, c.y2 - c.y3) <= 2 * chord;
}

function chordParams(pts: readonly Vec[], first: number, last: number): number[] {
  const u = [0];
  for (let i = first + 1; i <= last; i++) u.push(u[u.length - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y));
  const total = u[u.length - 1]!;
  return total > 0 ? u.map((v) => v / total) : u.map((_, i) => i / (u.length - 1));
}

/**
 * The cubic from pts[first] to pts[last] with tangent directions t1 (at the
 * start, pointing along the curve) and t2 (at the end, pointing back) whose
 * handle lengths minimize Σ|B(u_i) − p_i|².
 */
export function generate(pts: readonly Vec[], first: number, last: number, u: readonly number[], t1: Vec, t2: Vec): Cubic {
  const p0 = pts[first]!, p3 = pts[last]!;
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let i = 0; i < u.length; i++) {
    const t = u[i]!, mt = 1 - t;
    const b0 = mt * mt * mt, b1 = 3 * mt * mt * t, b2 = 3 * mt * t * t, b3 = t * t * t;
    const ax = t1.x * b1, ay = t1.y * b1;
    const bx = t2.x * b2, by = t2.y * b2;
    c00 += ax * ax + ay * ay;
    c01 += ax * bx + ay * by;
    c11 += bx * bx + by * by;
    const p = pts[first + i]!;
    const tx = p.x - (p0.x * (b0 + b1) + p3.x * (b2 + b3));
    const ty = p.y - (p0.y * (b0 + b1) + p3.y * (b2 + b3));
    x0 += ax * tx + ay * ty;
    x1 += bx * tx + by * ty;
  }
  const det = c00 * c11 - c01 * c01;
  let al = 0, ar = 0;
  if (Math.abs(det) > 1e-12 * Math.max(1, c00 * c11)) {
    al = (x0 * c11 - x1 * c01) / det;
    ar = (c00 * x1 - c01 * x0) / det;
  }
  const seg = Math.hypot(p3.x - p0.x, p3.y - p0.y);
  const epsilon = 1e-6 * seg;
  if (!(al > epsilon) || !(ar > epsilon) || !Number.isFinite(al) || !Number.isFinite(ar)) {
    // Degenerate system or handles pointing backwards: Wu–Barsky heuristic.
    al = ar = seg / 3;
  }
  return cubic(p0.x, p0.y, p0.x + t1.x * al, p0.y + t1.y * al, p3.x + t2.x * ar, p3.y + t2.y * ar, p3.x, p3.y);
}

function maxError(pts: readonly Vec[], first: number, last: number, bez: Cubic, u: readonly number[]): { max: number; index: number } {
  let max = 0, index = Math.floor((first + last) / 2);
  for (let i = first + 1; i < last; i++) {
    const p = pointAt(bez, u[i - first]!);
    const d = Math.hypot(p.x - pts[i]!.x, p.y - pts[i]!.y);
    if (d > max) {
      max = d;
      index = i;
    }
  }
  return { max, index };
}

function reparameterize(pts: readonly Vec[], first: number, _last: number, u: readonly number[], bez: Cubic): number[] {
  return u.map((t, i) => {
    const p = pts[first + i]!;
    const q = pointAt(bez, t);
    const d1 = derivativeAt(bez, t);
    const d2 = secondDerivativeAt(bez, t);
    const num = (q.x - p.x) * d1.x + (q.y - p.y) * d1.y;
    const den = d1.x * d1.x + d1.y * d1.y + (q.x - p.x) * d2.x + (q.y - p.y) * d2.y;
    if (den === 0) return t;
    const next = t - num / den;
    return Number.isFinite(next) ? Math.max(0, Math.min(1, next)) : t;
  });
}

/** Largest distance from the points to the nearest of the curves. */
export function maxDistanceToCurves(points: readonly Vec[], curves: readonly Cubic[]): number {
  let worst = 0;
  for (const p of points) {
    let best = Infinity;
    for (const c of curves) best = Math.min(best, closestParam(c, p.x, p.y).dist2);
    worst = Math.max(worst, Math.sqrt(best));
  }
  return worst;
}

/**
 * Fits one cubic from p0 to p3 with fixed end tangent directions to the
 * given samples (with their initial parameters), refining parameters by
 * Newton steps. Used to replace a chain of curves by a single one.
 */
export function fitSingleCubic(samples: readonly Vec[], params: readonly number[], t1: Vec, t2: Vec, iterations = 12): Cubic {
  let u = [...params];
  let bez = generate(samples, 0, samples.length - 1, u, normalize(t1), normalize(t2));
  for (let i = 0; i < iterations; i++) {
    u = reparameterize(samples, 0, samples.length - 1, u, bez);
    u[0] = 0;
    u[u.length - 1] = 1;
    bez = generate(samples, 0, samples.length - 1, u, normalize(t1), normalize(t2));
  }
  return bez;
}
