import { cubicBounds, lineCubic, subCurve, withEndpoints, type Cubic } from "../bezier/cubic";
import type { FillRule } from "../flatten";
import { Path, Verb } from "../path";
import { emptyRect, unionRect, rectsIntersect, inflateRect, type Rect } from "../rect";
import { buildArrangement, defaultEps, type Arrangement, type ArrangementCurve } from "./arrangement";

/**
 * Boolean operations on curved shapes, computed exactly on the curves (the
 * output is made of pieces of the input curves, not polylines):
 *
 * 1. Every operand's contours go into one planar arrangement
 *    (`arrangement.ts`): curves are split at all crossings and contacts,
 *    nearly coincident points are merged, coincident pieces become one edge
 *    carrying every operand's winding contribution.
 * 2. Each face gets its winding number per operand (consistent by
 *    construction), and each operand's own fill rule decides whether the
 *    face is inside it.
 * 3. The operation picks the faces of the result; its boundary is traced as
 *    closed contours with the inside on the left, so the result fills
 *    correctly with either fill rule (its winding is 0 or 1 everywhere).
 * 4. Consecutive output pieces of the same input curve are joined back into
 *    one curve, so curve counts stay close to the input's.
 *
 * Operands whose bounding boxes do not overlap any other operand of their
 * cluster are computed separately, which keeps unions of many disjoint
 * shapes linear and lets {@link BooleanEvaluator} recompute only the
 * clusters an edit touched.
 */

export type BooleanOperation = "union" | "subtract" | "intersect" | "exclude";

/** Closed contours filled with one fill rule. */
export interface FillShape {
  readonly contours: readonly (readonly Cubic[])[];
  readonly fillRule: FillRule;
}

/** An operand: the union of its shapes (a vector network's regions, a group's children). */
export interface BooleanOperand {
  readonly shapes: readonly FillShape[];
}

export interface BooleanOptions {
  /** Snapping tolerance; defaults to 1e-8 of the input's extent. */
  readonly eps?: number;
}

export interface BooleanResult {
  /** Closed contours, inside on the left: fill with either rule. */
  readonly contours: Cubic[][];
  /** Consistency failures found while propagating winding numbers (0 for a sound result). */
  readonly inconsistencies: number;
  /** Times the arrangement was rebuilt with a coarser tolerance because the first one was inconsistent. */
  readonly retries: number;
}

/** Whether a face that is inside the given operands belongs to the result. */
function selects(op: BooleanOperation, inside: readonly boolean[]): boolean {
  switch (op) {
    case "union":
      return inside.some(Boolean);
    case "intersect":
      return inside.length > 0 && inside.every(Boolean);
    case "subtract":
      return inside[0] === true && !inside.slice(1).some(Boolean);
    case "exclude":
      return inside.filter(Boolean).length % 2 === 1;
  }
}

function insideRule(w: number, rule: FillRule): boolean {
  return rule === "nonzero" ? w !== 0 : (w & 1) === 1;
}

export function booleanOperation(op: BooleanOperation, operands: readonly BooleanOperand[], options: BooleanOptions = {}): BooleanResult {
  const bounds = operands.map(operandBounds);
  const clusters = clusterOperands(bounds);
  const contours: Cubic[][] = [];
  let inconsistencies = 0;
  let retries = 0;
  const eps = options.eps ?? defaultEps(extentOf(bounds));
  // An empty operand empties an intersection; disjoint clusters have no common area.
  if (op === "intersect" && (clusters.length > 1 || clusters.flat().length < operands.length)) return { contours: [], inconsistencies: 0, retries: 0 };
  for (const cluster of clusters) {
    if (op === "subtract" && cluster[0] !== 0) continue;
    const r = booleanCluster(op, cluster.map((i) => operands[i]!), eps);
    contours.push(...r.contours);
    inconsistencies += r.inconsistencies;
    retries += r.retries;
  }
  return { contours, inconsistencies, retries };
}

/** Computes the boolean of operands that form one overlap cluster. */
function booleanCluster(op: BooleanOperation, operands: readonly BooleanOperand[], eps: number): BooleanResult {
  const curves: ArrangementCurve[] = [];
  const rules: FillRule[] = [];
  const dimOperand: number[] = [];
  operands.forEach((operand, k) => {
    for (const shape of operand.shapes) {
      const dim = rules.length;
      rules.push(shape.fillRule);
      dimOperand.push(k);
      for (const contour of shape.contours) for (const c of closeContour(contour)) curves.push({ curve: c, dim });
    }
  });
  if (curves.length === 0) return { contours: [], inconsistencies: 0, retries: 0 };
  let arr = buildArrangement(curves, { dims: rules.length, eps, dropCancelled: true });
  // Safety net: winding numbers that disagree across an edge mean a contact
  // was missed or mis-ordered. Snapping more aggressively merges such
  // near-degenerate features; keep the most consistent arrangement.
  let retries = 0;
  for (const factor of [64, 4096]) {
    if (arr.inconsistencies === 0) break;
    retries++;
    const again = buildArrangement(curves, { dims: rules.length, eps: eps * factor, dropCancelled: true });
    if (again.inconsistencies < arr.inconsistencies) arr = again;
  }
  const k = operands.length;
  const inside = new Array<boolean>(k);
  const cycles = arr.boundary((f) => {
    inside.fill(false);
    for (const [d, w] of arr.faceWinding(f)) if (insideRule(w, rules[d]!)) inside[dimOperand[d]!] = true;
    return selects(op, inside);
  });
  return { contours: cycles.map((cycle) => joinCycle(arr, cycle, curves)), inconsistencies: arr.inconsistencies, retries };
}

/** Normalizes one shape: resolves self-intersections, overlaps and its fill rule into clean contours. */
export function simplifyShape(shape: FillShape, options: BooleanOptions = {}): BooleanResult {
  return booleanOperation("union", [{ shapes: [shape] }], options);
}

/**
 * Turns an arrangement boundary cycle into curves, joining consecutive
 * pieces of one input curve back into a single piece of it.
 */
function joinCycle(arr: Arrangement, cycle: readonly number[], inputs: readonly ArrangementCurve[]): Cubic[] {
  interface Run {
    source: number;
    t0: number;
    t1: number;
    a: number;
    b: number;
    curve: Cubic;
  }
  const runs: Run[] = [];
  for (const h of cycle) {
    const e = arr.edges[h >> 1]!;
    const s = e.sources[0]!;
    const rev = (h & 1) === 1;
    const t0 = rev ? s.t1 : s.t0;
    const t1 = rev ? s.t0 : s.t1;
    const a = rev ? e.b : e.a;
    const b = rev ? e.a : e.b;
    const curve = arr.halfEdgeCurve(h);
    const last = runs[runs.length - 1];
    if (last && last.source === s.source && Math.abs(last.t1 - t0) <= 1e-12 && last.b === a && Math.sign(last.t1 - last.t0) === Math.sign(t1 - t0)) {
      last.t1 = t1;
      last.b = b;
      continue;
    }
    runs.push({ source: s.source, t0, t1, a, b, curve });
  }
  // The cycle may start in the middle of a run: join the last run into the first.
  if (runs.length > 1) {
    const first = runs[0]!, last = runs[runs.length - 1]!;
    if (last.source === first.source && Math.abs(last.t1 - first.t0) <= 1e-12 && last.b === first.a && Math.sign(last.t1 - last.t0) === Math.sign(first.t1 - first.t0)) {
      first.t0 = last.t0;
      first.a = last.a;
      runs.pop();
    }
  }
  const curves = runs.map((r) => {
    const va = arr.vertices[r.a]!, vb = arr.vertices[r.b]!;
    const src = inputs[r.source]!.curve;
    const piece = Math.abs(r.t1 - r.t0) < 1e-15 ? r.curve : subCurve(src, r.t0, r.t1);
    return withEndpoints(piece, va.x, va.y, vb.x, vb.y);
  });
  return mergeCollinear(curves, arr.eps);
}

/** Joins consecutive straight pieces that continue in the same direction (e.g. edges two operands share). */
function mergeCollinear(curves: Cubic[], eps: number): Cubic[] {
  if (curves.length < 2) return curves;
  const straightOn = (a: Cubic, b: Cubic): boolean => {
    if (!a.line || !b.line) return false;
    const ux = a.x3 - a.x0, uy = a.y3 - a.y0, vx = b.x3 - b.x0, vy = b.y3 - b.y0;
    const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
    if (lu === 0 || lv === 0) return true;
    // Distance of the joint from the merged chord, and same direction.
    const wx = b.x3 - a.x0, wy = b.y3 - a.y0;
    const lw = Math.hypot(wx, wy);
    return ux * vx + uy * vy > 0 && lw > 0 && Math.abs(ux * wy - uy * wx) / lw <= eps;
  };
  const out: Cubic[] = [];
  for (const c of curves) {
    const last = out[out.length - 1];
    if (last && straightOn(last, c)) out[out.length - 1] = lineCubic(last.x0, last.y0, c.x3, c.y3);
    else out.push(c);
  }
  // Around the seam.
  while (out.length > 2 && straightOn(out[out.length - 1]!, out[0]!)) {
    const last = out.pop()!;
    out[0] = lineCubic(last.x0, last.y0, out[0]!.x3, out[0]!.y3);
  }
  return out;
}

/**
 * The contour's curves as a closed chain: a line bridges any gap between
 * consecutive curves (and from the end back to the start), so every contour
 * has a well-defined winding number whatever the caller passed.
 */
function closeContour(contour: readonly Cubic[]): readonly Cubic[] {
  if (contour.length === 0) return contour;
  let out: Cubic[] | null = null;
  for (let i = 0; i < contour.length; i++) {
    const c = contour[i]!, next = contour[(i + 1) % contour.length]!;
    if (out) out.push(c);
    if (c.x3 !== next.x0 || c.y3 !== next.y0) {
      if (!out) out = contour.slice(0, i + 1);
      out.push(lineCubic(c.x3, c.y3, next.x0, next.y0));
    }
  }
  return out ?? contour;
}

function operandBounds(o: BooleanOperand): Rect {
  let r = emptyRect();
  for (const s of o.shapes) for (const contour of s.contours) for (const c of contour) r = unionRect(r, cubicBounds(c));
  return r;
}

function extentOf(bounds: readonly Rect[]): number {
  let e = 0;
  for (const b of bounds) if (b.minX <= b.maxX) e = Math.max(e, Math.abs(b.minX), Math.abs(b.maxX), Math.abs(b.minY), Math.abs(b.maxY));
  return e;
}

/**
 * Groups operands whose bounding boxes overlap (transitively). Clusters are
 * returned in operand order (each cluster's indices ascending), so the first
 * operand is the first index of its cluster.
 */
export function clusterOperands(bounds: readonly Rect[]): number[][] {
  const n = bounds.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const order = bounds.map((_, i) => i).filter((i) => bounds[i]!.minX <= bounds[i]!.maxX);
  order.sort((i, j) => bounds[i]!.minX - bounds[j]!.minX);
  const active: number[] = [];
  for (const i of order) {
    const b = inflateRect(bounds[i]!, 1e-9 * (1 + Math.abs(bounds[i]!.maxX) + Math.abs(bounds[i]!.maxY)));
    let k = 0;
    for (const j of active) if (bounds[j]!.maxX >= b.minX) active[k++] = j;
    active.length = k;
    for (const j of active) {
      if (rectsIntersect(b, bounds[j]!)) {
        const a = find(i), c = find(j);
        if (a !== c) parent[Math.max(a, c)] = Math.min(a, c);
      }
    }
    active.push(i);
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    if (!(bounds[i]!.minX <= bounds[i]!.maxX)) continue;
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(i);
    else groups.set(r, [i]);
  }
  return [...groups.values()].sort((a, b) => a[0]! - b[0]!);
}

/**
 * Re-evaluates booleans incrementally: each operand comes with a key that
 * changes whenever its geometry does, and results are cached per overlap
 * cluster, so editing one child of a large boolean group recomputes only the
 * cluster(s) it belongs to.
 */
export class BooleanEvaluator {
  private cache = new Map<string, BooleanResult>();
  /** Clusters computed (not served from the cache) by the last evaluation. */
  lastComputed = 0;
  lastClusters = 0;

  evaluate(op: BooleanOperation, operands: readonly (BooleanOperand & { readonly key: string })[], options: BooleanOptions = {}): BooleanResult {
    const bounds = operands.map(operandBounds);
    const clusters = clusterOperands(bounds);
    this.lastClusters = clusters.length;
    this.lastComputed = 0;
    if (op === "intersect" && (clusters.length > 1 || clusters.flat().length < operands.length)) return { contours: [], inconsistencies: 0, retries: 0 };
    const eps = options.eps ?? defaultEps(Math.max(1, extentOf(bounds)));
    const next = new Map<string, BooleanResult>();
    const contours: Cubic[][] = [];
    let inconsistencies = 0;
    let retries = 0;
    for (const cluster of clusters) {
      if (op === "subtract" && cluster[0] !== 0) continue;
      const key = `${op}|${eps}|${cluster.map((i) => operands[i]!.key).join("\u0000")}`;
      let r = this.cache.get(key);
      if (!r) {
        r = booleanCluster(op, cluster.map((i) => operands[i]!), eps);
        this.lastComputed++;
      }
      next.set(key, r);
      contours.push(...r.contours);
      inconsistencies += r.inconsistencies;
      retries += r.retries;
    }
    this.cache = next;
    return { contours, inconsistencies, retries };
  }
}

// ── Conversions ───────────────────────────────────────────────────────────

/**
 * The contours of a path as cubics. Quadratics are elevated exactly; open
 * contours are kept open (fill operations close them with a line, as
 * canvas and SVG fills do).
 */
export function pathContours(path: Path): Cubic[][] {
  return pathContoursDetailed(path).map((c) => c.curves);
}

/** The contours of a path as cubics, with whether each was closed (a closing line is added where needed). */
export function pathContoursDetailed(path: Path): { curves: Cubic[]; closed: boolean }[] {
  const out: { curves: Cubic[]; closed: boolean }[] = [];
  let cur: Cubic[] | null = null;
  let sx = 0, sy = 0, x = 0, y = 0;
  const coords = path.coords;
  const verbs = path.verbs;
  let k = 0;
  for (let i = 0; i < verbs.length; i++) {
    switch (verbs[i] as Verb) {
      case Verb.MoveTo:
        if (cur && cur.length) out.push({ curves: cur, closed: false });
        cur = [];
        sx = x = coords[k]!;
        sy = y = coords[k + 1]!;
        k += 2;
        break;
      case Verb.LineTo: {
        const nx = coords[k]!, ny = coords[k + 1]!;
        k += 2;
        if (!cur) cur = [];
        if (nx !== x || ny !== y) cur.push(lineCubic(x, y, nx, ny));
        x = nx;
        y = ny;
        break;
      }
      case Verb.QuadTo: {
        const qx = coords[k]!, qy = coords[k + 1]!, nx = coords[k + 2]!, ny = coords[k + 3]!;
        k += 4;
        if (!cur) cur = [];
        cur.push({ x0: x, y0: y, x1: x + (2 / 3) * (qx - x), y1: y + (2 / 3) * (qy - y), x2: nx + (2 / 3) * (qx - nx), y2: ny + (2 / 3) * (qy - ny), x3: nx, y3: ny, line: false });
        x = nx;
        y = ny;
        break;
      }
      case Verb.CubicTo: {
        const c: Cubic = { x0: x, y0: y, x1: coords[k]!, y1: coords[k + 1]!, x2: coords[k + 2]!, y2: coords[k + 3]!, x3: coords[k + 4]!, y3: coords[k + 5]!, line: false };
        k += 6;
        if (!cur) cur = [];
        cur.push(c);
        x = c.x3;
        y = c.y3;
        break;
      }
      case Verb.Close:
        if (cur) {
          if (x !== sx || y !== sy) cur.push(lineCubic(x, y, sx, sy));
          if (cur.length) out.push({ curves: cur, closed: true });
        }
        cur = null;
        x = sx;
        y = sy;
        break;
    }
  }
  if (cur && cur.length) out.push({ curves: cur, closed: false });
  return out;
}

/** A path from closed contours of cubics. */
export function contoursToPath(contours: readonly (readonly Cubic[])[]): Path {
  const p = new Path();
  for (const contour of contours) {
    if (contour.length === 0) continue;
    const first = contour[0]!;
    p.moveTo(first.x0, first.y0);
    for (const c of contour) {
      if (c.line) p.lineTo(c.x3, c.y3);
      else p.cubicTo(c.x1, c.y1, c.x2, c.y2, c.x3, c.y3);
    }
    p.close();
  }
  return p;
}

export function pathShape(path: Path, fillRule: FillRule = "nonzero"): FillShape {
  return { contours: pathContours(path), fillRule };
}

/** Signed area of closed contours (Green's theorem on the exact curves). */
export function contoursArea(contours: readonly (readonly Cubic[])[]): number {
  let a = 0;
  for (const contour of contours) for (const c of closeContour(contour)) a += areaOf(c);
  return a;
}

function areaOf(c: Cubic): number {
  if (c.line) return (c.x0 * c.y3 - c.x3 * c.y0) / 2;
  // Exact for cubics: 3-point Gauss–Legendre on a degree-5 integrand.
  const nodes = [0.5 - Math.sqrt(15) / 10, 0.5, 0.5 + Math.sqrt(15) / 10];
  const weights = [5 / 18, 8 / 18, 5 / 18];
  let s = 0;
  for (let i = 0; i < 3; i++) {
    const t = nodes[i]!, mt = 1 - t;
    const x = mt * mt * mt * c.x0 + 3 * mt * mt * t * c.x1 + 3 * mt * t * t * c.x2 + t * t * t * c.x3;
    const y = mt * mt * mt * c.y0 + 3 * mt * mt * t * c.y1 + 3 * mt * t * t * c.y2 + t * t * t * c.y3;
    const dx = 3 * mt * mt * (c.x1 - c.x0) + 6 * mt * t * (c.x2 - c.x1) + 3 * t * t * (c.x3 - c.x2);
    const dy = 3 * mt * mt * (c.y1 - c.y0) + 6 * mt * t * (c.y2 - c.y1) + 3 * t * t * (c.y3 - c.y2);
    s += weights[i]! * (x * dy - y * dx);
  }
  return s / 2;
}

export function contoursBounds(contours: readonly (readonly Cubic[])[]): Rect {
  let r = emptyRect();
  for (const contour of contours) for (const c of contour) r = unionRect(r, cubicBounds(c));
  return r;
}
