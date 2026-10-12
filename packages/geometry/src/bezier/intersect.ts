import {
  closestParam,
  derivativeAt,
  flatness,
  pointAt,
  cubicRootsIn,
  polyCoefficients,
  solveQuadratic,
  subCurve,
  type Cubic,
} from "./cubic";

/**
 * Curve–curve intersection with a distance tolerance.
 *
 * - **Transversal crossings** are found by Bézier clipping (Sederberg and
 *   Nishita, "Curve intersection using Bézier clipping", CAD 1990): each curve
 *   is clipped against the other's fat line, and when clipping stalls the
 *   longer piece is halved. Pieces flat within the tolerance are intersected
 *   as chords, then refined with Newton iterations on A(t) − B(u) = 0.
 * - **Touches** (tangential contacts, endpoints lying on the other curve,
 *   near misses closer than `eps`) are reported as hits too, so a planar
 *   arrangement built from the result has a vertex wherever two curves come
 *   within `eps`. That is what keeps booleans topologically consistent.
 * - **Overlaps** (coincident stretches, e.g. shared edges or the same arc
 *   split differently) are reported as parameter intervals; no hits are
 *   reported inside them.
 *
 * Lines (`Cubic.line`) take exact paths: line–line in closed form, line–curve
 * by the roots of the curve's signed distance polynomial.
 */
export interface CurveHit {
  /** Parameter on the first curve. */
  readonly t: number;
  /** Parameter on the second curve. */
  readonly u: number;
  readonly x: number;
  readonly y: number;
}

export interface CurveOverlap {
  readonly t0: number;
  readonly t1: number;
  /** Parameters on the second curve matching t0 and t1 (u1 < u0 when the curves run in opposite directions). */
  readonly u0: number;
  readonly u1: number;
}

export interface CurveIntersections {
  readonly hits: CurveHit[];
  readonly overlaps: CurveOverlap[];
}

const EMPTY: CurveIntersections = { hits: [], overlaps: [] };

export function intersectCurves(a: Cubic, b: Cubic, eps: number): CurveIntersections {
  if (!hullsOverlap(a, b, eps)) return EMPTY;
  const anchors = endpointTouches(a, b, eps);
  const overlap = anchors.length >= 2 ? findOverlap(a, b, eps, anchors) : null;
  if (overlap) return overlap;
  let hits: CurveHit[];
  if (a.line && b.line) hits = lineLine(a, b, eps);
  else if (a.line) hits = lineCurve(a, b, eps, false);
  else if (b.line) hits = lineCurve(b, a, eps, true);
  else hits = curveCurve(a, b, eps);
  hits.push(...anchors);
  return { hits: dedupeHits(a, b, hits, eps), overlaps: [] };
}

function hullsOverlap(a: Cubic, b: Cubic, eps: number): boolean {
  const aminX = Math.min(a.x0, a.x1, a.x2, a.x3), amaxX = Math.max(a.x0, a.x1, a.x2, a.x3);
  const bminX = Math.min(b.x0, b.x1, b.x2, b.x3), bmaxX = Math.max(b.x0, b.x1, b.x2, b.x3);
  if (aminX > bmaxX + eps || bminX > amaxX + eps) return false;
  const aminY = Math.min(a.y0, a.y1, a.y2, a.y3), amaxY = Math.max(a.y0, a.y1, a.y2, a.y3);
  const bminY = Math.min(b.y0, b.y1, b.y2, b.y3), bmaxY = Math.max(b.y0, b.y1, b.y2, b.y3);
  return !(aminY > bmaxY + eps || bminY > amaxY + eps);
}

/** Endpoints of either curve that lie within eps of the other. */
function endpointTouches(a: Cubic, b: Cubic, eps: number): CurveHit[] {
  const out: CurveHit[] = [];
  const e2 = eps * eps;
  // Points outside the other curve's (inflated) control hull cannot be within eps of it.
  const near = (c: Cubic, x: number, y: number): boolean =>
    x >= Math.min(c.x0, c.x1, c.x2, c.x3) - eps && x <= Math.max(c.x0, c.x1, c.x2, c.x3) + eps &&
    y >= Math.min(c.y0, c.y1, c.y2, c.y3) - eps && y <= Math.max(c.y0, c.y1, c.y2, c.y3) + eps;
  // Shared end points (consecutive curves of a contour) need no search.
  const endParam = (c: Cubic, x: number, y: number): number => {
    if (Math.abs(c.x0 - x) <= eps && Math.abs(c.y0 - y) <= eps && (c.x0 - x) ** 2 + (c.y0 - y) ** 2 <= e2) return 0;
    if (Math.abs(c.x3 - x) <= eps && Math.abs(c.y3 - y) <= eps && (c.x3 - x) ** 2 + (c.y3 - y) ** 2 <= e2) return 1;
    return -1;
  };
  for (const t of [0, 1]) {
    const x = t === 0 ? a.x0 : a.x3, y = t === 0 ? a.y0 : a.y3;
    if (!near(b, x, y)) continue;
    const e = endParam(b, x, y);
    if (e >= 0) {
      out.push({ t, u: e, x, y });
      continue;
    }
    const q = closestParam(b, x, y);
    if (q.dist2 <= e2) out.push({ t, u: q.t, x, y });
  }
  for (const u of [0, 1]) {
    const x = u === 0 ? b.x0 : b.x3, y = u === 0 ? b.y0 : b.y3;
    if (!near(a, x, y)) continue;
    const e = endParam(a, x, y);
    if (e >= 0) {
      // Already found from the other side.
      if (!out.some((h) => h.t === e && h.u === u)) out.push({ t: e, u, x, y });
      continue;
    }
    const q = closestParam(a, x, y);
    if (q.dist2 <= e2) out.push({ t: q.t, u, x, y });
  }
  return out;
}

/**
 * Coincident stretch of two curves, if any: two distinct points where an
 * endpoint of one lies on the other, with the curves within eps of each other
 * everywhere in between.
 */
function findOverlap(a: Cubic, b: Cubic, eps: number, anchors: readonly CurveHit[]): CurveIntersections | null {
  // The pair of anchors spanning the widest interval on a.
  let best: [CurveHit, CurveHit] | null = null;
  let span = 0;
  for (let i = 0; i < anchors.length; i++) {
    for (let j = i + 1; j < anchors.length; j++) {
      const p = anchors[i]!, q = anchors[j]!;
      const s = Math.abs(p.t - q.t);
      if (s > span && Math.abs(p.u - q.u) > 1e-9 && Math.hypot(p.x - q.x, p.y - q.y) > 2 * eps) {
        span = s;
        best = [p, q];
      }
    }
  }
  if (!best || span < 1e-9) return null;
  let [p, q] = best;
  if (p.t > q.t) [p, q] = [q, p];
  // Sample a between the anchors: every sample must lie on b, with b's parameter moving monotonically.
  const N = 9;
  const e2 = eps * eps * 4;
  let lastU = p.u;
  const dir = Math.sign(q.u - p.u);
  for (let i = 1; i < N; i++) {
    const t = p.t + ((q.t - p.t) * i) / N;
    const pt = pointAt(a, t);
    const c = closestParam(b, pt.x, pt.y);
    if (c.dist2 > e2) return null;
    if ((c.t - lastU) * dir < -1e-9) return null;
    lastU = c.t;
  }
  // And b between its anchors must lie on a (rules out b looping away and back).
  for (let i = 1; i < N; i++) {
    const u = p.u + ((q.u - p.u) * i) / N;
    const pt = pointAt(b, u);
    if (closestParam(a, pt.x, pt.y).dist2 > e2) return null;
  }
  return {
    hits: [p, q],
    overlaps: [{ t0: p.t, t1: q.t, u0: p.u, u1: q.u }],
  };
}

function lineLine(a: Cubic, b: Cubic, eps: number): CurveHit[] {
  const dax = a.x3 - a.x0, day = a.y3 - a.y0;
  const dbx = b.x3 - b.x0, dby = b.y3 - b.y0;
  const den = dax * dby - day * dbx;
  if (den === 0) return [];
  const ex = b.x0 - a.x0, ey = b.y0 - a.y0;
  const t = (ex * dby - ey * dbx) / den;
  const u = (ex * day - ey * dax) / den;
  // Accept parameters slightly outside [0, 1] by eps in length.
  const la = Math.hypot(dax, day), lb = Math.hypot(dbx, dby);
  const ta = la > 0 ? eps / la : 0, tb = lb > 0 ? eps / lb : 0;
  if (t < -ta || t > 1 + ta || u < -tb || u > 1 + tb) return [];
  const tc = Math.max(0, Math.min(1, t)), uc = Math.max(0, Math.min(1, u));
  // Clamping moves the points apart when the lines are nearly parallel: keep only true contacts.
  const ax = a.x0 + dax * tc, ay = a.y0 + day * tc, bx = b.x0 + dbx * uc, by = b.y0 + dby * uc;
  if (Math.hypot(ax - bx, ay - by) > eps) return [];
  return [{ t: tc, u: uc, x: (ax + bx) / 2, y: (ay + by) / 2 }];
}

/**
 * Hits between a line and a curve: roots of the curve's signed distance to
 * the line, plus near-tangential touches (local extrema of the distance
 * within eps). `swap` reports parameters as (curve, line).
 */
function lineCurve(line: Cubic, c: Cubic, eps: number, swap: boolean): CurveHit[] {
  const dx = line.x3 - line.x0, dy = line.y3 - line.y0;
  const len = Math.hypot(dx, dy);
  if (len === 0) return [];
  const nx = -dy / len, ny = dx / len;
  const d0 = (c.x0 - line.x0) * nx + (c.y0 - line.y0) * ny;
  const d1 = (c.x1 - line.x0) * nx + (c.y1 - line.y0) * ny;
  const d2 = (c.x2 - line.x0) * nx + (c.y2 - line.y0) * ny;
  const d3 = (c.x3 - line.x0) * nx + (c.y3 - line.y0) * ny;
  const [A, B, C, D] = polyCoefficients(d0, d1, d2, d3);
  const ts = cubicRootsIn(A, B, C, D, -1e-9, 1 + 1e-9).map((t) => Math.max(0, Math.min(1, t)));
  // Touches: extrema of the distance that come within eps of the line.
  for (const t of solveQuadratic(3 * A, 2 * B, C)) {
    if (t < 0 || t > 1) continue;
    const d = ((A * t + B) * t + C) * t + D;
    if (Math.abs(d) <= eps && !ts.some((r) => Math.abs(r - t) < 1e-7)) ts.push(t);
  }
  const out: CurveHit[] = [];
  const tu = eps / len;
  for (const t of ts) {
    const p = pointAt(c, t);
    const u = ((p.x - line.x0) * dx + (p.y - line.y0) * dy) / (len * len);
    if (u < -tu || u > 1 + tu) continue;
    const uc = Math.max(0, Math.min(1, u));
    const lx = line.x0 + dx * uc, ly = line.y0 + dy * uc;
    if (Math.hypot(lx - p.x, ly - p.y) > eps) continue;
    out.push(swap ? { t, u: uc, x: p.x, y: p.y } : { t: uc, u: t, x: p.x, y: p.y });
  }
  return out;
}

// ── Curve–curve: Bézier clipping ──────────────────────────────────────────

interface Piece {
  readonly c: Cubic;
  readonly t0: number;
  readonly t1: number;
}

const MAX_DEPTH = 64;
const MAX_CANDIDATES = 4096;

function curveCurve(a: Cubic, b: Cubic, eps: number): CurveHit[] {
  const raw: { t: number; u: number }[] = [];
  const stack: { p: Piece; q: Piece; depth: number; clipA: boolean }[] = [
    { p: { c: a, t0: 0, t1: 1 }, q: { c: b, t0: 0, t1: 1 }, depth: 0, clipA: false },
  ];
  let guard = 0;
  while (stack.length > 0) {
    if (++guard > 200_000 || raw.length > MAX_CANDIDATES) break;
    const { p, q, depth, clipA } = stack.pop()!;
    if (!hullsOverlap(p.c, q.c, eps)) continue;
    const fp = flatness(p.c), fq = flatness(q.c);
    if ((fp <= eps && fq <= eps) || depth >= MAX_DEPTH) {
      chordHits(p, q, eps, raw);
      continue;
    }
    // Clip q against p's fat line (or the other way round), alternating.
    const [from, to] = clipA ? [q, p] : [p, q];
    const range = clipRange(from.c, to.c, eps);
    if (range === null) continue;
    const [lo, hi] = range;
    if (hi - lo < 0.8) {
      const sub: Piece = {
        c: subCurve(to.c, lo, hi),
        t0: to.t0 + (to.t1 - to.t0) * lo,
        t1: to.t0 + (to.t1 - to.t0) * hi,
      };
      if (clipA) stack.push({ p: sub, q, depth: depth + 1, clipA: !clipA });
      else stack.push({ p, q: sub, depth: depth + 1, clipA: !clipA });
      continue;
    }
    // Clipping stalled: halve the piece with the longer parameter range in model space.
    const sizeP = Math.max(Math.abs(p.c.x3 - p.c.x0) + Math.abs(p.c.y3 - p.c.y0), fp);
    const sizeQ = Math.max(Math.abs(q.c.x3 - q.c.x0) + Math.abs(q.c.y3 - q.c.y0), fq);
    if (sizeP >= sizeQ) {
      const [l, r] = halves(p);
      stack.push({ p: l, q, depth: depth + 1, clipA: false }, { p: r, q, depth: depth + 1, clipA: false });
    } else {
      const [l, r] = halves(q);
      stack.push({ p, q: l, depth: depth + 1, clipA: false }, { p, q: r, depth: depth + 1, clipA: false });
    }
  }
  return raw.map(({ t, u }) => refine(a, b, t, u, eps));
}

function halves(p: Piece): [Piece, Piece] {
  const m = (p.t0 + p.t1) / 2;
  return [
    { c: subCurve(p.c, 0, 0.5), t0: p.t0, t1: m },
    { c: subCurve(p.c, 0.5, 1), t0: m, t1: p.t1 },
  ];
}

/**
 * The parameter range of `c` (in [0, 1]) that can lie within the fat line of
 * `f`, or null when none can. Uses the convex hull of the distance curve.
 */
function clipRange(f: Cubic, c: Cubic, eps: number): [number, number] | null {
  let lx = f.x3 - f.x0, ly = f.y3 - f.y0;
  let len = Math.hypot(lx, ly);
  if (len <= eps) {
    // Degenerate chord: use the handle direction instead.
    lx = f.x2 - f.x1;
    ly = f.y2 - f.y1;
    len = Math.hypot(lx, ly);
    if (len <= eps) return [0, 1];
  }
  const nx = -ly / len, ny = lx / len;
  const ox = f.x0, oy = f.y0;
  const d1 = (f.x1 - ox) * nx + (f.y1 - oy) * ny;
  const d2 = (f.x2 - ox) * nx + (f.y2 - oy) * ny;
  const d3 = (f.x3 - ox) * nx + (f.y3 - oy) * ny;
  const k = d1 * d2 > 0 ? 3 / 4 : 4 / 9;
  const dmin = Math.min(0, d3, k * Math.min(0, d1, d2)) - eps;
  const dmax = Math.max(0, d3, k * Math.max(0, d1, d2)) + eps;
  const e = [
    (c.x0 - ox) * nx + (c.y0 - oy) * ny,
    (c.x1 - ox) * nx + (c.y1 - oy) * ny,
    (c.x2 - ox) * nx + (c.y2 - oy) * ny,
    (c.x3 - ox) * nx + (c.y3 - oy) * ny,
  ];
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < 4; i++) {
    const xi = i / 3, ei = e[i]!;
    if (ei >= dmin && ei <= dmax) {
      lo = Math.min(lo, xi);
      hi = Math.max(hi, xi);
    }
    for (let j = i + 1; j < 4; j++) {
      const xj = j / 3, ej = e[j]!;
      for (const level of [dmin, dmax]) {
        if ((ei - level) * (ej - level) < 0) {
          const x = xi + ((level - ei) / (ej - ei)) * (xj - xi);
          lo = Math.min(lo, x);
          hi = Math.max(hi, x);
        }
      }
    }
  }
  if (lo > hi) return null;
  return [Math.max(0, lo - 1e-12), Math.min(1, hi + 1e-12)];
}

/** Hits between the chords of two flat pieces (crossings, or contacts closer than eps). */
function chordHits(p: Piece, q: Piece, eps: number, out: { t: number; u: number }[]): void {
  const a = p.c, b = q.c;
  const dax = a.x3 - a.x0, day = a.y3 - a.y0;
  const dbx = b.x3 - b.x0, dby = b.y3 - b.y0;
  const den = dax * dby - day * dbx;
  const ex = b.x0 - a.x0, ey = b.y0 - a.y0;
  let s = -1, v = -1;
  if (den !== 0) {
    s = (ex * dby - ey * dbx) / den;
    v = (ex * day - ey * dax) / den;
  }
  // Chord parameters are not curve parameters (speed varies along a flat
  // piece): map chord points back to the curves by closest point.
  const onP = (x: number, y: number): number => p.t0 + (p.t1 - p.t0) * closestParam(a, x, y).t;
  const onQ = (x: number, y: number): number => q.t0 + (q.t1 - q.t0) * closestParam(b, x, y).t;
  if (s >= 0 && s <= 1 && v >= 0 && v <= 1) {
    const x = a.x0 + dax * s, y = a.y0 + day * s;
    out.push({ t: onP(x, y), u: onQ(x, y) });
    return;
  }
  // No crossing: the closest pair of chord points, if within eps (a touch).
  let bestD = Infinity, bs = 0, bv = 0;
  const tryPair = (ss: number, vv: number): void => {
    const x1 = a.x0 + dax * ss, y1 = a.y0 + day * ss;
    const x2 = b.x0 + dbx * vv, y2 = b.y0 + dby * vv;
    const d = Math.hypot(x1 - x2, y1 - y2);
    if (d < bestD) {
      bestD = d;
      bs = ss;
      bv = vv;
    }
  };
  const proj = (px: number, py: number, ox: number, oy: number, dx: number, dy: number): number => {
    const l2 = dx * dx + dy * dy;
    return l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ox) * dx + (py - oy) * dy) / l2));
  };
  tryPair(0, proj(a.x0, a.y0, b.x0, b.y0, dbx, dby));
  tryPair(1, proj(a.x3, a.y3, b.x0, b.y0, dbx, dby));
  tryPair(proj(b.x0, b.y0, a.x0, a.y0, dax, day), 0);
  tryPair(proj(b.x3, b.y3, a.x0, a.y0, dax, day), 1);
  if (bestD <= eps * 2) out.push({ t: onP(a.x0 + dax * bs, a.y0 + day * bs), u: onQ(b.x0 + dbx * bv, b.y0 + dby * bv) });
}

/** Newton refinement of A(t) = B(u); keeps the estimate when the system is ill-conditioned (tangency). */
function refine(a: Cubic, b: Cubic, t: number, u: number, eps: number): CurveHit {
  let bt = t, bu = u;
  let pa = pointAt(a, t), pb = pointAt(b, u);
  let err = Math.hypot(pa.x - pb.x, pa.y - pb.y);
  for (let i = 0; i < 8 && err > 0; i++) {
    const da = derivativeAt(a, bt), db = derivativeAt(b, bu);
    // [da, -db] [dt du]^T = pb - pa
    const det = -da.x * db.y + da.y * db.x;
    const scale = Math.hypot(da.x, da.y) * Math.hypot(db.x, db.y);
    if (Math.abs(det) <= scale * 1e-6) break;
    const rx = pb.x - pa.x, ry = pb.y - pa.y;
    const dt = (-rx * db.y + ry * db.x) / det;
    const du = (da.x * ry - da.y * rx) / det;
    const nt = bt + dt, nu = bu + du;
    if (nt < -1e-12 || nt > 1 + 1e-12 || nu < -1e-12 || nu > 1 + 1e-12) break;
    const na = pointAt(a, nt), nb = pointAt(b, nu);
    const nerr = Math.hypot(na.x - nb.x, na.y - nb.y);
    if (nerr >= err) break;
    bt = nt;
    bu = nu;
    pa = na;
    pb = nb;
    err = nerr;
  }
  void eps;
  bt = Math.max(0, Math.min(1, bt));
  bu = Math.max(0, Math.min(1, bu));
  return { t: bt, u: bu, x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
}

/** Merges hits closer than a few eps (clusters from tangential contacts) and sorts them by t. */
function dedupeHits(a: Cubic, b: Cubic, hits: CurveHit[], eps: number): CurveHit[] {
  if (hits.length <= 1) return hits;
  hits.sort((p, q) => p.t - q.t);
  const out: CurveHit[] = [];
  const near = 4 * eps;
  for (const h of hits) {
    const dup = out.find((o) => Math.hypot(o.x - h.x, o.y - h.y) <= near);
    if (!dup) {
      out.push(h);
      continue;
    }
    // Prefer endpoint parameters (exact vertices) over interior estimates.
    const exactH = h.t === 0 || h.t === 1 || h.u === 0 || h.u === 1;
    const exactO = dup.t === 0 || dup.t === 1 || dup.u === 0 || dup.u === 1;
    if (exactH && !exactO) out[out.indexOf(dup)] = h;
  }
  void a;
  void b;
  return out.sort((p, q) => p.t - q.t);
}
