import {
  areaContribution,
  closestParam,
  cubicBounds,
  isDegenerate,
  monotonicSplits,
  pointAt,
  reverseCubic,
  subCurve,
  tangentAt,
  withEndpoints,
  yAt,
  xAt,
  type Cubic,
} from "../bezier/cubic";
import { intersectCurves } from "../bezier/intersect";

/**
 * A planar arrangement of curves: the curves split at every crossing and
 * contact, endpoints within the snapping tolerance merged into one vertex,
 * coincident pieces merged into one edge, and the faces of the resulting
 * plane graph with their winding numbers.
 *
 * Every input curve carries a winding contribution in one "dimension" (a
 * set of contours filled with one rule: an operand of a boolean, or a region
 * of a vector network). Crossing an edge from its right to its left adds the
 * edge's contribution, so the winding numbers of all faces follow from one
 * known face per connected component:
 *
 *   W(left of e) − W(right of e) = w(e)
 *
 * "Left" is the side where cross(direction, p − a) > 0, so the rule does not
 * depend on whether y points up or down. The unbounded face of a connected
 * component gets its winding numbers by casting one ray against the other
 * components' edges (every edge is monotonic in y, so each crosses a
 * horizontal line at most once); breadth-first search across edges gives the
 * rest. Faces are therefore always mutually consistent, whatever the
 * numerical noise in the intersections.
 */

export interface ArrangementCurve {
  readonly curve: Cubic;
  /** Winding dimension this curve contributes to. */
  readonly dim: number;
  /** Signed contribution (normally 1; −1 for a reversed copy). */
  readonly weight?: number;
}

export interface ArrangementOptions {
  /** Number of winding dimensions. */
  readonly dims: number;
  /** Distance below which curves are considered touching and points are merged. Defaults to a tolerance relative to the input's extent. */
  readonly eps?: number;
  /** Find crossings between curves (true for booleans). Vector networks pass false when their segments only meet at vertices. */
  readonly intersect?: boolean;
  /** Drop edges whose contributions cancel out (retraced or coincident opposite edges). */
  readonly dropCancelled?: boolean;
}

/** Where an arrangement edge came from: input curve `source`, parameters t0 → t1 (t0 > t1 when reversed). */
export interface EdgeSource {
  readonly source: number;
  readonly t0: number;
  readonly t1: number;
}

export interface ArrangementEdge {
  /** Geometry from vertex `a` to vertex `b`. */
  readonly curve: Cubic;
  readonly a: number;
  readonly b: number;
  /** Winding contributions as (dimension, weight) pairs. */
  readonly w: readonly (readonly [number, number])[];
  readonly sources: readonly EdgeSource[];
}

const EMPTY_WINDING: ReadonlyMap<number, number> = new Map();

export class Arrangement {
  readonly vertices: { x: number; y: number }[] = [];
  readonly edges: ArrangementEdge[] = [];
  /** Half-edge h (2e: a→b, 2e+1: b→a): next half-edge around its left face. */
  next: Int32Array = new Int32Array(0);
  /** Face of each half-edge (the face on its left). */
  face: Int32Array = new Int32Array(0);
  /** Half-edges of each face cycle, in order. */
  readonly faces: number[][] = [];
  /** Signed area of each face cycle (bounded faces positive, the outer cycle of each component negative). */
  readonly faceArea: number[] = [];
  /** Connected component of each face. */
  readonly faceComponent: number[] = [];
  /** The outer (unbounded) face cycle of each component. */
  readonly componentOuter: number[] = [];
  /** Winding numbers per face: the nonzero dimensions only (faces are usually inside few operands). */
  winding: Map<number, number>[] = [];
  /** Faces whose winding numbers disagreed across an edge during propagation (0 for consistent input). */
  inconsistencies = 0;

  constructor(
    readonly dims: number,
    readonly eps: number,
  ) {}

  halfEdgeCurve(h: number): Cubic {
    const e = this.edges[h >> 1]!;
    return h & 1 ? reverseCubic(e.curve) : e.curve;
  }

  origin(h: number): number {
    const e = this.edges[h >> 1]!;
    return h & 1 ? e.b : e.a;
  }

  windingOf(face: number, dim: number): number {
    return this.winding[face]?.get(dim) ?? 0;
  }

  /** The face's nonzero winding numbers by dimension. */
  faceWinding(face: number): ReadonlyMap<number, number> {
    return this.winding[face] ?? EMPTY_WINDING;
  }

  /**
   * Traces the boundary between faces where `inside` holds and faces where it
   * does not, as closed cycles of half-edges with the inside on their left.
   */
  boundary(inside: (face: number) => boolean): number[][] {
    const nh = this.edges.length * 2;
    const inFace = new Uint8Array(this.faces.length);
    for (let f = 0; f < this.faces.length; f++) inFace[f] = inside(f) ? 1 : 0;
    const isBoundary = (h: number): boolean => inFace[this.face[h]!] === 1 && inFace[this.face[h ^ 1]!] === 0;
    const used = new Uint8Array(nh);
    const cycles: number[][] = [];
    for (let start = 0; start < nh; start++) {
      if (used[start] || !isBoundary(start)) continue;
      const cycle: number[] = [];
      let h = start;
      let guard = 0;
      while (!used[h]) {
        used[h] = 1;
        cycle.push(h);
        // At the head vertex, turn from the twin clockwise to the first boundary half-edge.
        let g = this.next[h]!;
        let spins = 0;
        while (!isBoundary(g)) {
          g = this.next[g ^ 1]!;
          if (++spins > nh) break;
        }
        h = g;
        if (++guard > nh) break;
      }
      cycles.push(cycle);
    }
    return cycles;
  }
}

interface Piece {
  readonly c: Cubic;
  readonly input: number;
  /** Parameter range of the input curve this piece covers. */
  readonly t0: number;
  readonly t1: number;
  /** Point ids of the piece's ends. */
  readonly p0: number;
  readonly p3: number;
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  /** Splits found by intersection: (t in the piece, point id). */
  readonly splits: { t: number; p: number }[];
}

/** Default snapping tolerance for an input with the given extent. */
export function defaultEps(extent: number): number {
  return Math.max(1e-12, extent * 1e-8);
}

export function buildArrangement(input: readonly ArrangementCurve[], options: ArrangementOptions): Arrangement {
  const dims = options.dims;
  // Extent of the input, for the default tolerance.
  let extent = 0;
  for (const { curve: c } of input) {
    extent = Math.max(extent, Math.abs(c.x0), Math.abs(c.y0), Math.abs(c.x1), Math.abs(c.y1), Math.abs(c.x2), Math.abs(c.y2), Math.abs(c.x3), Math.abs(c.y3));
  }
  const eps = options.eps ?? defaultEps(extent);
  const snap = 4 * eps;
  const arr = new Arrangement(dims, eps);

  // ── Points ──────────────────────────────────────────────────────────────
  const px: number[] = [];
  const py: number[] = [];
  const fixed: boolean[] = [];
  const addPoint = (x: number, y: number, isFixed: boolean): number => {
    px.push(x);
    py.push(y);
    fixed.push(isFixed);
    return px.length - 1;
  };

  // ── Pieces: inputs split at their x/y extrema ───────────────────────────
  const pieces: Piece[] = [];
  input.forEach(({ curve }, index) => {
    if (isDegenerate(curve, eps)) return;
    const ts = [0, ...monotonicSplits(curve), 1];
    let prev = addPoint(curve.x0, curve.y0, true);
    for (let i = 0; i + 1 < ts.length; i++) {
      const t0 = ts[i]!, t1 = ts[i + 1]!;
      const c = subCurve(curve, t0, t1);
      const last = i + 2 === ts.length;
      const p3 = last ? addPoint(curve.x3, curve.y3, true) : addPoint(c.x3, c.y3, false);
      const b = cubicBounds(c);
      pieces.push({ c, input: index, t0, t1, p0: prev, p3, minX: b.minX, maxX: b.maxX, minY: b.minY, maxY: b.maxY, splits: [] });
      prev = p3;
    }
  });
  // ── Intersections (sweep over x) ────────────────────────────────────────
  if (options.intersect !== false) {
    const order = pieces.map((_, i) => i).sort((i, j) => pieces[i]!.minX - pieces[j]!.minX);
    const active: number[] = [];
    for (const i of order) {
      const p = pieces[i]!;
      // Drop pieces that end before this one starts.
      let k = 0;
      for (const j of active) if (pieces[j]!.maxX >= p.minX - snap) active[k++] = j;
      active.length = k;
      for (const j of active) {
        const q = pieces[j]!;
        if (q.minY > p.maxY + snap || p.minY > q.maxY + snap) continue;
        const r = intersectCurves(p.c, q.c, eps);
        for (const h of r.hits) {
          const id = addPoint(h.x, h.y, false);
          p.splits.push({ t: h.t, p: id });
          q.splits.push({ t: h.u, p: id });
        }
      }
      active.push(i);
    }
  }
  // ── Snap points into vertices (union-find on a hash grid) ───────────────
  const n = px.length;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const unite = (i: number, j: number): void => {
    const a = find(i), b = find(j);
    if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
  };
  // Sweep over x: points within `snap` in both coordinates are merged.
  const byX = Array.from({ length: n }, (_, i) => i).sort((i, j) => px[i]! - px[j]!);
  for (let k = 0; k < n; k++) {
    const i = byX[k]!;
    for (let m = k + 1; m < n; m++) {
      const j = byX[m]!;
      if (px[j]! - px[i]! > snap) break;
      if (Math.abs(py[i]! - py[j]!) <= snap) unite(i, j);
    }
  }
  // Representative positions: the first original vertex in the cluster, else the mean.
  const vertexOf = new Int32Array(n).fill(-1);
  const sumX = new Map<number, [number, number, number, boolean]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const s = sumX.get(r);
    if (!s) sumX.set(r, [px[i]!, py[i]!, 1, fixed[i]!]);
    else if (fixed[i] && !s[3]) sumX.set(r, [px[i]!, py[i]!, 1, true]);
    else if (!s[3]) {
      s[0] += px[i]!;
      s[1] += py[i]!;
      s[2]++;
    }
  }
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (vertexOf[r] === -1) {
      const s = sumX.get(r)!;
      vertexOf[r] = arr.vertices.length;
      arr.vertices.push({ x: s[0] / s[2], y: s[1] / s[2] });
    }
    vertexOf[i] = vertexOf[r]!;
  }
  // ── Edges: pieces split at their (snapped) split points ─────────────────
  interface RawEdge {
    curve: Cubic;
    a: number;
    b: number;
    w: Map<number, number>;
    sources: EdgeSource[];
  }
  const raw: RawEdge[] = [];
  for (const p of pieces) {
    const marks = [{ t: 0, v: vertexOf[p.p0]! }, ...p.splits.map((s) => ({ t: s.t, v: vertexOf[s.p]! })), { t: 1, v: vertexOf[p.p3]! }];
    marks.sort((x, y) => x.t - y.t);
    // Clamp the first and last marks to the piece's own end vertices.
    const ordered: { t: number; v: number }[] = [];
    for (const m of marks) {
      const last = ordered[ordered.length - 1];
      if (last && last.v === m.v) continue;
      if (last && m.t - last.t <= 0) {
        // Same parameter, different vertex: keep the later one only if it is the piece's end.
        if (m.t === 1) ordered[ordered.length - 1] = m;
        continue;
      }
      ordered.push(m);
    }
    if (ordered.length > 0) ordered[0] = { t: 0, v: ordered[0]!.v };
    if (ordered.length > 1) ordered[ordered.length - 1] = { t: 1, v: ordered[ordered.length - 1]!.v };
    const info = input[p.input]!;
    const weight = info.weight ?? 1;
    for (let i = 0; i + 1 < ordered.length; i++) {
      const m0 = ordered[i]!, m1 = ordered[i + 1]!;
      const va = arr.vertices[m0.v]!, vb = arr.vertices[m1.v]!;
      const curve = withEndpoints(subCurve(p.c, m0.t, m1.t), va.x, va.y, vb.x, vb.y);
      if (m0.v === m1.v && isDegenerate(curve, snap)) continue;
      const span = p.t1 - p.t0;
      raw.push({
        curve,
        a: m0.v,
        b: m1.v,
        w: new Map([[info.dim, weight]]),
        sources: [{ source: p.input, t0: p.t0 + span * m0.t, t1: p.t0 + span * m1.t }],
      });
    }
  }
  // ── Merge coincident edges ──────────────────────────────────────────────
  const groups = new Map<number, number[]>();
  const nverts = arr.vertices.length;
  raw.forEach((e, i) => {
    const key = e.a < e.b ? e.a * nverts + e.b : e.b * nverts + e.a;
    const g = groups.get(key);
    if (g) g.push(i);
    else groups.set(key, [i]);
  });
  const merged: RawEdge[] = [];
  for (const g of groups.values()) {
    const kept: RawEdge[] = [];
    for (const i of g) {
      const e = raw[i]!;
      const twin = kept.find((k) => coincident(k, e, snap * 4));
      if (!twin) {
        kept.push({ curve: e.curve, a: e.a, b: e.b, w: new Map(e.w), sources: [...e.sources] });
        continue;
      }
      const sign = twin.a === e.a && (twin.a !== twin.b || sameDirectionLoop(twin.curve, e.curve)) ? 1 : -1;
      for (const [d, w] of e.w) twin.w.set(d, (twin.w.get(d) ?? 0) + sign * w);
      twin.sources.push(...e.sources);
    }
    merged.push(...kept);
  }
  for (const e of merged) {
    const w: [number, number][] = [];
    for (const [d, v] of e.w) if (v !== 0) w.push([d, v]);
    if (options.dropCancelled && w.length === 0) continue;
    arr.edges.push({ curve: e.curve, a: e.a, b: e.b, w, sources: e.sources });
  }
  buildTopology(arr, input.length > 0);
  return arr;
}

/** Whether two edges between the same vertices trace the same curve (in either direction). */
function coincident(e: { curve: Cubic; a: number; b: number }, f: { curve: Cubic; a: number; b: number }, tol: number): boolean {
  const t2 = tol * tol;
  for (const t of [0.25, 0.5, 0.75]) {
    const p = pointAt(f.curve, t);
    if (closestParam(e.curve, p.x, p.y).dist2 > t2) return false;
    const q = pointAt(e.curve, t);
    if (closestParam(f.curve, q.x, q.y).dist2 > t2) return false;
  }
  return true;
}

/** For two coincident loops at one vertex: whether they run the same way round. */
function sameDirectionLoop(a: Cubic, b: Cubic): boolean {
  const ta = tangentAt(a, 0), tb = tangentAt(b, 0);
  return ta.x * tb.x + ta.y * tb.y > 0;
}

/**
 * Sorts each vertex's outgoing half-edges by angle, links face cycles,
 * finds connected components and their outer faces, and computes winding
 * numbers.
 */
function buildTopology(arr: Arrangement, _nonEmpty: boolean): void {
  const ne = arr.edges.length;
  const nh = ne * 2;
  const nv = arr.vertices.length;
  // Outgoing half-edges per vertex with their angles.
  const outgoing: number[][] = Array.from({ length: nv }, () => []);
  const angle = new Float64Array(nh);
  const probe = new Float64Array(nh);
  for (let e = 0; e < ne; e++) {
    const { curve, a, b } = arr.edges[e]!;
    outgoing[a]!.push(2 * e);
    outgoing[b]!.push(2 * e + 1);
    const t0 = tangentAt(curve, 0);
    const t1 = tangentAt(curve, 1);
    angle[2 * e] = Math.atan2(t0.y, t0.x);
    angle[2 * e + 1] = Math.atan2(-t1.y, -t1.x);
  }
  const pos = new Int32Array(nh);
  const next = new Int32Array(nh);
  for (let v = 0; v < nv; v++) {
    const out = outgoing[v]!;
    if (out.length === 0) continue;
    sortAround(arr, out, angle, probe);
    out.forEach((h, i) => (pos[h] = i));
  }
  for (let h = 0; h < nh; h++) {
    // h arrives at the origin of its twin.
    const tw = h ^ 1;
    const v = arr.origin(tw);
    const out = outgoing[v]!;
    const k = out.length;
    next[h] = out[(pos[tw]! - 1 + k) % k]!;
  }
  arr.next = next;
  // Face cycles.
  const face = new Int32Array(nh).fill(-1);
  for (let h = 0; h < nh; h++) {
    if (face[h] !== -1) continue;
    const f = arr.faces.length;
    const cycle: number[] = [];
    let area = 0;
    let g = h;
    let guard = 0;
    while (face[g] === -1) {
      face[g] = f;
      cycle.push(g);
      const c = arr.edges[g >> 1]!.curve;
      area += g & 1 ? -areaContribution(c) : areaContribution(c);
      g = next[g]!;
      if (++guard > nh) break;
    }
    arr.faces.push(cycle);
    arr.faceArea.push(area);
  }
  arr.face = face;

  // Connected components (by vertices).
  const comp = new Int32Array(nv);
  for (let i = 0; i < nv; i++) comp[i] = i;
  const find = (i: number): number => {
    while (comp[i] !== i) {
      comp[i] = comp[comp[i]!]!;
      i = comp[i]!;
    }
    return i;
  };
  for (const e of arr.edges) {
    const a = find(e.a), b = find(e.b);
    if (a !== b) comp[Math.max(a, b)] = Math.min(a, b);
  }
  const compId = new Map<number, number>();
  const vertexComp = new Int32Array(nv);
  for (let v = 0; v < nv; v++) {
    const r = find(v);
    let id = compId.get(r);
    if (id === undefined) compId.set(r, (id = compId.size));
    vertexComp[v] = id;
  }
  const ncomp = compId.size;
  const outer = new Array<number>(ncomp).fill(-1);
  arr.faces.forEach((cycle, f) => {
    const c = vertexComp[arr.origin(cycle[0]!)]!;
    arr.faceComponent.push(c);
    if (outer[c] === -1 || arr.faceArea[f]! < arr.faceArea[outer[c]!]!) outer[c] = f;
  });
  arr.componentOuter.push(...outer);
  // Winding numbers (sparse: only nonzero dimensions are stored).
  const W: Map<number, number>[] = new Array(arr.faces.length);
  const seen = new Uint8Array(arr.faces.length);
  const index = new RowIndex(arr);
  const add = (m: Map<number, number>, d: number, v: number): void => {
    const n = (m.get(d) ?? 0) + v;
    if (n === 0) m.delete(d);
    else m.set(d, n);
  };
  for (let c = 0; c < ncomp; c++) {
    const f0 = outer[c]!;
    if (f0 === -1) continue;
    // Ray from a vertex of this component against the other components' edges.
    const v = arr.origin(arr.faces[f0]![0]!);
    const { x, y } = arr.vertices[v]!;
    const w0 = new Map<number, number>();
    index.cast(x, y, (e, sign) => {
      if (vertexComp[arr.edges[e]!.a] === c) return;
      for (const [d, w] of arr.edges[e]!.w) add(w0, d, sign * w);
    });
    W[f0] = w0;
    seen[f0] = 1;
    const queue = [f0];
    while (queue.length > 0) {
      const f = queue.pop()!;
      const wf = W[f]!;
      for (const h of arr.faces[f]!) {
        const g = h ^ 1;
        const f2 = face[g]!;
        const e = arr.edges[h >> 1]!;
        const s = h & 1 ? -1 : 1;
        if (!seen[f2]) {
          seen[f2] = 1;
          const w2 = new Map(wf);
          for (const [d, w] of e.w) add(w2, d, -s * w);
          W[f2] = w2;
          queue.push(f2);
        } else {
          // Check consistency: W(f2) must equal W(f) − s·w.
          const w2 = W[f2]!;
          let ok = f2 !== f || e.w.length === 0;
          for (const [d, w] of e.w) if ((w2.get(d) ?? 0) !== (wf.get(d) ?? 0) - s * w) ok = false;
          if (!ok) arr.inconsistencies++;
        }
      }
    }
  }
  for (let f = 0; f < W.length; f++) if (!W[f]) W[f] = new Map();
  arr.winding = W;
}

/** Orders outgoing half-edges counter-clockwise (by angle), breaking ties between tangent curves by where they go next. */
function sortAround(arr: Arrangement, out: number[], angle: Float64Array, probe: Float64Array): void {
  if (out.length < 2) return;
  out.sort((p, q) => angle[p]! - angle[q]!);
  // Runs of nearly equal tangent angles: the tangents of curves that touch
  // tangentially differ only by rounding, so order such runs by where the
  // curves actually go (their crossing with a small circle around the vertex).
  const TIE = 1e-3;
  const k = out.length;
  let hasTie = false;
  for (let i = 0; i < k; i++) {
    const a = angle[out[i]!]!, b = angle[out[(i + 1) % k]!]!;
    let d = b - a;
    if (i + 1 === k) d += 2 * Math.PI;
    if (Math.abs(d) < TIE || Math.abs(d - 2 * Math.PI) < TIE) hasTie = true;
  }
  if (!hasTie) return;
  // Rotate so the largest angular gap is the cut, then sort by (angle, turn).
  let gapAt = 0, gap = -1;
  for (let i = 0; i < k; i++) {
    const a = angle[out[i]!]!;
    const b = i + 1 < k ? angle[out[i + 1]!]! : angle[out[0]!]! + 2 * Math.PI;
    if (b - a > gap) {
      gap = b - a;
      gapAt = i + 1;
    }
  }
  const base = angle[out[gapAt % k]!]!;
  const rel = new Map<number, number>();
  for (const h of out) {
    let a = angle[h]! - base;
    while (a < -TIE) a += 2 * Math.PI;
    rel.set(h, a);
  }
  out.sort((p, q) => rel.get(p)! - rel.get(q)!);
  // Within each run of equal angles, order by the direction to the point at a common distance r.
  for (let i = 0; i < k; ) {
    let j = i + 1;
    while (j < k && rel.get(out[j]!)! - rel.get(out[j - 1]!)! < TIE) j++;
    if (j - i > 1) {
      const run = out.slice(i, j);
      let r = Infinity;
      for (const h of run) {
        const c = arr.halfEdgeCurve(h);
        r = Math.min(r, maxReach(c) / 4);
      }
      const ref = tangentAt(arr.halfEdgeCurve(run[0]!), 0);
      for (const h of run) probe[h] = turnProbe(arr, h, r, ref);
      run.sort((p, q) => probe[p]! - probe[q]!);
      for (let m = 0; m < run.length; m++) out[i + m] = run[m]!;
    }
    i = j;
  }
}

/** Largest distance from the curve's start reached by its samples. */
function maxReach(c: Cubic): number {
  let best = 0;
  for (let i = 1; i <= 8; i++) {
    const p = pointAt(c, i / 8);
    best = Math.max(best, Math.hypot(p.x - c.x0, p.y - c.y0));
  }
  return best;
}

/**
 * The signed angle (counter-clockwise positive) from the reference direction
 * to the half-edge's first point at distance `r` from its origin: the order
 * in which curves leaving a vertex in (nearly) the same direction cross a
 * circle of radius r around it.
 */
function turnProbe(arr: Arrangement, h: number, r: number, t: { x: number; y: number }): number {
  const c = arr.halfEdgeCurve(h);
  // First parameter whose point is r away: scan, then bisect.
  let lo = 0, hi = 1;
  const N = 32;
  for (let i = 1; i <= N; i++) {
    const p = pointAt(c, i / N);
    if (Math.hypot(p.x - c.x0, p.y - c.y0) >= r) {
      hi = i / N;
      lo = (i - 1) / N;
      break;
    }
  }
  for (let i = 0; i < 50; i++) {
    const m = (lo + hi) / 2;
    const p = pointAt(c, m);
    if (Math.hypot(p.x - c.x0, p.y - c.y0) >= r) hi = m;
    else lo = m;
  }
  const p = pointAt(c, hi);
  const dx = p.x - c.x0, dy = p.y - c.y0;
  return Math.atan2(t.x * dy - t.y * dx, t.x * dx + t.y * dy);
}

/** Horizontal-ray queries over the arrangement's edges, bucketed by rows. */
class RowIndex {
  private readonly rows: number[][];
  private readonly minY: number;
  private readonly rowH: number;

  constructor(private readonly arr: Arrangement) {
    let minY = Infinity, maxY = -Infinity;
    const ys: [number, number][] = [];
    for (const e of arr.edges) {
      const lo = Math.min(e.curve.y0, e.curve.y3), hi = Math.max(e.curve.y0, e.curve.y3);
      ys.push([lo, hi]);
      minY = Math.min(minY, lo);
      maxY = Math.max(maxY, hi);
    }
    const count = Math.max(1, Math.min(4096, Math.ceil(Math.sqrt(arr.edges.length) * 2)));
    this.minY = Number.isFinite(minY) ? minY : 0;
    this.rowH = Number.isFinite(maxY) && maxY > minY ? (maxY - minY) / count : 1;
    this.rows = Array.from({ length: count }, () => []);
    ys.forEach(([lo, hi], e) => {
      const r0 = this.row(lo), r1 = this.row(hi);
      for (let r = r0; r <= r1; r++) this.rows[r]!.push(e);
    });
  }

  private row(y: number): number {
    return Math.max(0, Math.min(this.rows.length - 1, Math.floor((y - this.minY) / this.rowH)));
  }

  /**
   * Calls `hit(edge, sign)` for every edge crossing the ray from (x, y) towards
   * +x, with sign +1 for edges heading towards +y (half-open in y).
   */
  cast(x: number, y: number, hit: (edge: number, sign: number) => void): void {
    for (const e of this.rows[this.row(y)]!) {
      const c = this.arr.edges[e]!.curve;
      const up = c.y0 <= y && y < c.y3;
      const down = c.y3 <= y && y < c.y0;
      if (!up && !down) continue;
      if (crossingX(c, y) > x) hit(e, up ? 1 : -1);
    }
  }
}

/** x where a curve monotonic in y crosses the horizontal line at y. */
export function crossingX(c: Cubic, y: number): number {
  if (c.line || (c.x0 === c.x3 && c.x1 === c.x0 && c.x2 === c.x0)) {
    const dy = c.y3 - c.y0;
    return dy === 0 ? c.x0 : c.x0 + ((y - c.y0) / dy) * (c.x3 - c.x0);
  }
  let lo = 0, hi = 1;
  const inc = c.y3 > c.y0;
  for (let i = 0; i < 60; i++) {
    const m = (lo + hi) / 2;
    const ym = yAt(c, m);
    if (ym < y === inc) lo = m;
    else hi = m;
  }
  return xAt(c, (lo + hi) / 2);
}
