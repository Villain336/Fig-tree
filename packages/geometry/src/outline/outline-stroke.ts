import {
  arcLength,
  curvatureAt,
  derivativeAt,
  inflectionParams,
  lineCubic,
  paramAtLength,
  pointAt,
  subCurve,
  tangentAt,
  type Cubic,
} from "../bezier/cubic";
import { booleanOperation, pathContoursDetailed, type FillShape } from "../boolean/boolean";
import type { Path } from "../path";
import type { LineCap, LineJoin } from "../stroke";

/**
 * Outline stroke: the area a stroke paints, as closed curves (cubics), with
 * the same semantics as the polygon stroker (`stroke.ts`): butt, round and
 * square caps; miter (with limit, falling back to bevel), round and bevel
 * joins; SVG dash patterns.
 *
 * Construction: every curve is cut into pieces that turn by at most a few
 * degrees; each piece contributes the band between its two offset curves
 * (each offset approximated by one cubic whose handles are the piece's
 * handles scaled by the offset's speed ratio 1 ∓ h·κ, subdivided until it is
 * within tolerance of the true offset). Joins and caps contribute their
 * shapes (wedges, disks, squares). The union of all of these, computed by
 * our boolean engine with each piece as its own shape (so overlapping
 * pieces never cancel), is the stroke outline. Every piece lies inside the
 * true stroke area, so the union does too, up to the tolerance.
 */

export interface OutlineStrokeStyle {
  readonly width: number;
  readonly join?: LineJoin;
  readonly cap?: LineCap;
  readonly miterLimit?: number;
  readonly dash?: readonly number[];
  readonly dashOffset?: number;
}

export interface OutlineOptions {
  /** Maximum distance between the approximate and true offset curves. Default 1e-3 of the stroke width. */
  readonly tolerance?: number;
}

/** Contours of the stroke outline (closed, inside on the left: fill with either rule). */
export function outlineStroke(path: Path, style: OutlineStrokeStyle, options: OutlineOptions = {}): Cubic[][] {
  const shapes = strokeShapes(path, style, options);
  if (shapes.length === 0) return [];
  return booleanOperation("union", [{ shapes }]).contours;
}

/** The pieces whose union is the stroke (bands, joins, caps), before the union. */
export function strokeShapes(path: Path, style: OutlineStrokeStyle, options: OutlineOptions = {}): FillShape[] {
  const h = style.width / 2;
  if (!(h > 0)) return [];
  const tol = options.tolerance ?? style.width * 1e-3;
  const chains: { curves: Cubic[]; closed: boolean }[] = [];
  for (const contour of pathContoursDetailed(path)) {
    if (style.dash && style.dash.length > 0) chains.push(...dashCurves(contour.curves, contour.closed, style.dash, style.dashOffset ?? 0));
    else chains.push(contour);
  }
  const shapes: FillShape[] = [];
  const push = (contour: Cubic[]): void => {
    if (contour.length) shapes.push({ contours: [contour], fillRule: "nonzero" });
  };
  const join = style.join ?? "miter";
  const cap = style.cap ?? "butt";
  const limit = style.miterLimit ?? 4;
  for (const chain of chains) {
    const curves = chain.curves.filter((c) => arcLength(c) > tol * 1e-3);
    if (curves.length === 0) {
      // A dot: caps only.
      const p = chain.curves[0];
      if (p && cap === "round") push(circle(p.x0, p.y0, h));
      else if (p && cap === "square") push(square(p.x0, p.y0, h));
      continue;
    }
    for (const c of curves) for (const band of pieceBands(c, h, tol)) push(band);
    // Joins between consecutive curves (and around a closed chain).
    const n = curves.length;
    for (let i = 0; i < (chain.closed ? n : n - 1); i++) {
      const a = curves[i]!, b = curves[(i + 1) % n]!;
      const shape = joinShape(a.x3, a.y3, tangentAt(a, 1), tangentAt(b, 0), h, join, limit);
      if (shape) push(shape);
    }
    if (!chain.closed) {
      const first = curves[0]!, last = curves[n - 1]!;
      const t0 = tangentAt(first, 0), t1 = tangentAt(last, 1);
      const s = capShape(first.x0, first.y0, { x: -t0.x, y: -t0.y }, h, cap);
      if (s) push(s);
      const e = capShape(last.x3, last.y3, t1, h, cap);
      if (e) push(e);
    }
  }
  return shapes;
}

/** Splits a curve into pieces that turn at most `maxTurn`, cut at inflections. */
function pieces(c: Cubic, maxTurn: number): Cubic[] {
  if (c.line) return [c];
  const cuts = [0, ...inflectionParams(c), 1];
  const out: Cubic[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i]!, b = cuts[i + 1]!;
    const ta = tangentAt(c, a), tb = tangentAt(c, b);
    const turn = Math.abs(Math.atan2(ta.x * tb.y - ta.y * tb.x, ta.x * tb.x + ta.y * tb.y));
    const n = Math.max(1, Math.ceil(turn / maxTurn));
    for (let k = 0; k < n; k++) out.push(subCurve(c, a + ((b - a) * k) / n, a + ((b - a) * (k + 1)) / n));
  }
  return out;
}

/** The band between a piece's two offsets as closed contours (one per sub-piece). */
function pieceBands(c: Cubic, h: number, tol: number): Cubic[][] {
  const out: Cubic[][] = [];
  const stack = pieces(c, Math.PI / 18);
  let guard = 0;
  while (stack.length) {
    const p = stack.pop()!;
    const left = offsetCubic(p, h);
    const right = offsetCubic(p, -h);
    if (++guard < 20_000 && (offsetError(p, left, h) > tol || offsetError(p, right, -h) > tol)) {
      const m = 0.5;
      stack.push(subCurve(p, m, 1), subCurve(p, 0, m));
      continue;
    }
    const band = [
      left,
      lineCubic(left.x3, left.y3, right.x3, right.y3),
      reverse(right),
      lineCubic(right.x0, right.y0, left.x0, left.y0),
    ];
    out.push(band);
    // Where the curve bends tighter than the pen, add disks at the piece ends so the swept fan is covered.
    const k0 = Math.abs(curvatureAt(p, 0)), k1 = Math.abs(curvatureAt(p, 1));
    if (!p.line && Math.max(k0, k1) * h > 0.8) {
      out.push(circle(p.x0, p.y0, h), circle(p.x3, p.y3, h));
    }
  }
  return out;
}

function reverse(c: Cubic): Cubic {
  return { x0: c.x3, y0: c.y3, x1: c.x2, y1: c.y2, x2: c.x1, y2: c.y1, x3: c.x0, y3: c.y0, line: c.line };
}

/** Approximate offset of a short piece by d (positive: to the left, the side where cross(tangent, p) > 0). */
function offsetCubic(c: Cubic, d: number): Cubic {
  const t0 = tangentAt(c, 0), t1 = tangentAt(c, 1);
  const n0 = { x: -t0.y, y: t0.x }, n1 = { x: -t1.y, y: t1.x };
  const x0 = c.x0 + n0.x * d, y0 = c.y0 + n0.y * d;
  const x3 = c.x3 + n1.x * d, y3 = c.y3 + n1.y * d;
  if (c.line) return lineCubic(x0, y0, x3, y3);
  const k0 = curvatureAt(c, 0), k1 = curvatureAt(c, 1);
  const s0 = 1 - d * k0, s1 = 1 - d * k1;
  return {
    x0, y0,
    x1: x0 + (c.x1 - c.x0) * s0, y1: y0 + (c.y1 - c.y0) * s0,
    x2: x3 + (c.x2 - c.x3) * s1, y2: y3 + (c.y2 - c.y3) * s1,
    x3, y3,
    line: false,
  };
}

/** Largest distance between samples of the true offset and the approximation (sampled at matching parameters, an upper bound). */
function offsetError(c: Cubic, approx: Cubic, d: number): number {
  let worst = 0;
  for (const t of [0.2, 0.4, 0.5, 0.6, 0.8]) {
    const p = pointAt(c, t);
    const dv = derivativeAt(c, t);
    const l = Math.hypot(dv.x, dv.y);
    if (l === 0) continue;
    const q = { x: p.x - (dv.y / l) * d, y: p.y + (dv.x / l) * d };
    // Distance from the true offset point to the approximation, by projecting near the same parameter.
    let best = Infinity;
    for (const s of [t - 0.1, t - 0.05, t, t + 0.05, t + 0.1]) {
      if (s < 0 || s > 1) continue;
      const a = pointAt(approx, s);
      best = Math.min(best, Math.hypot(a.x - q.x, a.y - q.y));
    }
    worst = Math.max(worst, best);
  }
  return worst;
}

const KAPPA = 0.5522847498307936;

export function circle(cx: number, cy: number, r: number): Cubic[] {
  const k = KAPPA * r;
  return [
    { x0: cx + r, y0: cy, x1: cx + r, y1: cy + k, x2: cx + k, y2: cy + r, x3: cx, y3: cy + r, line: false },
    { x0: cx, y0: cy + r, x1: cx - k, y1: cy + r, x2: cx - r, y2: cy + k, x3: cx - r, y3: cy, line: false },
    { x0: cx - r, y0: cy, x1: cx - r, y1: cy - k, x2: cx - k, y2: cy - r, x3: cx, y3: cy - r, line: false },
    { x0: cx, y0: cy - r, x1: cx + k, y1: cy - r, x2: cx + r, y2: cy - k, x3: cx + r, y3: cy, line: false },
  ];
}

function polygon(pts: readonly { x: number; y: number }[]): Cubic[] {
  return pts.map((p, i) => {
    const q = pts[(i + 1) % pts.length]!;
    return lineCubic(p.x, p.y, q.x, q.y);
  });
}

function square(x: number, y: number, h: number): Cubic[] {
  return polygon([{ x: x - h, y: y - h }, { x: x + h, y: y - h }, { x: x + h, y: y + h }, { x: x - h, y: y + h }]);
}

/** The join wedge at (x, y) between incoming direction a and outgoing direction b. */
function joinShape(x: number, y: number, a: { x: number; y: number }, b: { x: number; y: number }, h: number, join: LineJoin, limit: number): Cubic[] | null {
  const cross = a.x * b.y - a.y * b.x;
  const dot = a.x * b.x + a.y * b.y;
  if (Math.abs(cross) < 1e-9 && dot > 0) return null;
  if (join === "round") return circle(x, y, h);
  // The outer side is opposite to the turn.
  const side = cross > 0 ? -1 : 1;
  const na = { x: -a.y * side, y: a.x * side }, nb = { x: -b.y * side, y: b.x * side };
  const pa = { x: x + na.x * h, y: y + na.y * h }, pb = { x: x + nb.x * h, y: y + nb.y * h };
  if (join === "miter") {
    const denom = 1 + dot;
    if (denom > 1e-9 && Math.sqrt(2 / denom) <= limit) {
      const m = { x: x + ((na.x + nb.x) * h) / denom, y: y + ((na.y + nb.y) * h) / denom };
      return polygon([{ x, y }, pa, m, pb]);
    }
  }
  return polygon([{ x, y }, pa, pb]);
}

/** The cap at an end (x, y) where `t` points out of the stroke. */
function capShape(x: number, y: number, t: { x: number; y: number }, h: number, cap: LineCap): Cubic[] | null {
  if (cap === "butt") return null;
  if (cap === "round") return circle(x, y, h);
  const n = { x: -t.y * h, y: t.x * h };
  const e = { x: t.x * h, y: t.y * h };
  return polygon([
    { x: x + n.x, y: y + n.y },
    { x: x - n.x, y: y - n.y },
    { x: x - n.x + e.x, y: y - n.y + e.y },
    { x: x + n.x + e.x, y: y + n.y + e.y },
  ]);
}

/** Cuts a chain of curves into dashes (open chains) following an SVG dash pattern, with lengths measured exactly along the curves. */
export function dashCurves(curves: readonly Cubic[], closed: boolean, dash: readonly number[], offset: number): { curves: Cubic[]; closed: boolean }[] {
  const pattern = dash.length % 2 === 1 ? [...dash, ...dash] : [...dash];
  const total = pattern.reduce((s, v) => s + v, 0);
  if (pattern.some((v) => !(v >= 0) || !Number.isFinite(v)) || !(total > 0)) return [{ curves: [...curves], closed }];
  let phase = ((offset % total) + total) % total;
  let index = 0;
  while (phase >= pattern[index]! && phase > 0) {
    phase -= pattern[index]!;
    index = (index + 1) % pattern.length;
  }
  let remaining = pattern[index]! - phase;
  let on = index % 2 === 0;
  const startsOn = on;
  const dashes: Cubic[][] = [];
  let current: Cubic[] | null = on ? [] : null;
  let toggled = false;
  for (const c of curves) {
    const len = arcLength(c);
    let at = 0; // length consumed on this curve
    while (len - at > remaining) {
      const t0 = paramAtLength(c, at, len), t1 = paramAtLength(c, at + remaining, len);
      if (on) {
        if (t1 > t0) current!.push(subCurve(c, t0, t1));
        dashes.push(current!);
        current = null;
      } else current = [];
      at += remaining;
      on = !on;
      toggled = true;
      index = (index + 1) % pattern.length;
      remaining = pattern[index]!;
    }
    if (on) {
      const t0 = paramAtLength(c, at, len);
      if (t0 < 1) current!.push(subCurve(c, t0, 1));
    }
    remaining -= len - at;
  }
  if (closed && !toggled && startsOn) return [{ curves: [...curves], closed: true }];
  if (current) {
    if (closed && startsOn && dashes.length > 0) current.push(...dashes.shift()!);
    dashes.push(current);
  }
  return dashes.filter((d) => d.length > 0).map((d) => ({ curves: d, closed: false }));
}
