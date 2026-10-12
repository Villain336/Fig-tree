import { arcLength, closestParam, cubic, lineCubic, pointAt, tangentAt, type Cubic } from "../bezier/cubic";
import { removeSegments, removeVertices, setSegmentTangents } from "../vector-network/edit";
import { draftOf, finish, remapRegions, segmentCubic, segmentFromCubic, type Vec, type VectorNetwork } from "../vector-network/network";
import { fitCurve, fitSingleCubic, type FitOptions } from "./fit";
import { pathToNetwork } from "../vector-network/convert";
import { Path } from "../path";

/**
 * Shape-preserving node editing: deleting a vertex while keeping the curve
 * it sat on, simplifying chains, and turning freehand input into a network.
 */

/**
 * Joins two consecutive curves (c1 ends where c2 starts) into one cubic
 * with the same end points and end tangent directions:
 *
 * - two collinear straight pieces become one straight segment;
 * - two halves of a cubic split by De Casteljau are recognized and the
 *   original cubic is restored exactly (the split parameter follows from
 *   the handle lengths at the joint);
 * - otherwise the joint is fitted by least squares over samples of both
 *   curves (arc-length parameters refined by Newton steps).
 */
export function joinCurves(c1: Cubic, c2: Cubic): Cubic {
  const scale = Math.max(1e-12, Math.hypot(c2.x3 - c1.x0, c2.y3 - c1.y0), arcLength(c1) + arcLength(c2));
  if (c1.line && c2.line) {
    const cross = (c1.x3 - c1.x0) * (c2.y3 - c2.y0) - (c1.y3 - c1.y0) * (c2.x3 - c2.x0);
    const dot = (c1.x3 - c1.x0) * (c2.x3 - c2.x0) + (c1.y3 - c1.y0) * (c2.y3 - c2.y0);
    if (Math.abs(cross) <= 1e-12 * scale * scale && dot >= 0) return lineCubic(c1.x0, c1.y0, c2.x3, c2.y3);
  }
  const restored = restoreSplit(c1, c2, scale);
  if (restored) return restored;
  // Least squares over samples of both pieces, in arc-length proportion.
  const l1 = arcLength(c1), l2 = arcLength(c2);
  const total = l1 + l2;
  const samples: Vec[] = [];
  const params: number[] = [];
  const N = 24;
  for (let i = 0; i <= N; i++) {
    const p = pointAt(c1, i / N);
    samples.push(p);
    params.push(total > 0 ? ((i / N) * l1) / total : i / (2 * N));
  }
  for (let i = 1; i <= N; i++) {
    const p = pointAt(c2, i / N);
    samples.push(p);
    params.push(total > 0 ? (l1 + (i / N) * l2) / total : 0.5 + i / (2 * N));
  }
  const t1 = tangentAt(c1, 0);
  const te = tangentAt(c2, 1);
  return fitSingleCubic(samples, params, t1, { x: -te.x, y: -te.y });
}

/** If c1 and c2 are the two halves of one cubic split at some τ, that cubic. */
function restoreSplit(c1: Cubic, c2: Cubic, scale: number): Cubic | null {
  // Halves of B split at τ: Q2→Q3 and R0→R1 are collinear with lengths in ratio τ : (1 − τ).
  const a = Math.hypot(c1.x3 - c1.x2, c1.y3 - c1.y2);
  const b = Math.hypot(c2.x1 - c2.x0, c2.y1 - c2.y0);
  if (a + b === 0) return null;
  const tau = a / (a + b);
  if (!(tau > 1e-6 && tau < 1 - 1e-6)) return null;
  const p1x = c1.x0 + (c1.x1 - c1.x0) / tau, p1y = c1.y0 + (c1.y1 - c1.y0) / tau;
  const p2x = c2.x3 + (c2.x2 - c2.x3) / (1 - tau), p2y = c2.y3 + (c2.y2 - c2.y3) / (1 - tau);
  const cand = cubic(c1.x0, c1.y0, p1x, p1y, p2x, p2y, c2.x3, c2.y3);
  // Verify both halves against the candidate.
  const tol = 1e-9 * scale;
  for (const s of [0.25, 0.5, 0.75, 1]) {
    const q = pointAt(c1, s), r = pointAt(cand, s * tau);
    if (Math.hypot(q.x - r.x, q.y - r.y) > tol) return null;
    const q2 = pointAt(c2, s), r2 = pointAt(cand, tau + s * (1 - tau));
    if (Math.hypot(q2.x - r2.x, q2.y - r2.y) > tol) return null;
  }
  return cand;
}

/** Largest distance from samples of `original` curves to the curve `c`. */
export function deviation(original: readonly Cubic[], c: Cubic, samplesPerCurve = 32): number {
  let worst = 0;
  for (const o of original) {
    for (let i = 0; i <= samplesPerCurve; i++) {
      const p = pointAt(o, i / samplesPerCurve);
      worst = Math.max(worst, Math.sqrt(closestParam(c, p.x, p.y).dist2));
    }
  }
  return worst;
}

/**
 * Deletes a vertex. Where two segments meet (degree two), they are replaced
 * by one segment that keeps the shape ({@link joinCurves}); regions running
 * through the vertex keep their fill. An end vertex is removed with its
 * segment; a junction with all of its segments.
 */
export function deleteVertexPreservingShape<N extends VectorNetwork>(net: N, v: number): N {
  if (!(v >= 0 && v < net.vertices.length)) throw new RangeError(`vertex ${v} does not exist`);
  const ends: { s: number; end: "start" | "end" }[] = [];
  net.segments.forEach((seg, i) => {
    if (seg.start === v) ends.push({ s: i, end: "start" });
    if (seg.end === v) ends.push({ s: i, end: "end" });
  });
  if (ends.length !== 2 || ends[0]!.s === ends[1]!.s) return removeVertices(net, [v]);
  const [e1, e2] = ends as [typeof ends[0], typeof ends[0]];
  // c1 runs a → v, c2 runs v → b.
  const c1 = segmentCubic(net, e1.s, e1.end === "end");
  const c2 = segmentCubic(net, e2.s, e2.end === "start");
  const s1 = net.segments[e1.s]!, s2 = net.segments[e2.s]!;
  const a = e1.end === "end" ? s1.start : s1.end;
  const b = e2.end === "start" ? s2.end : s2.start;
  const joined = joinCurves(c1, c2);
  const noHandles = joined.x1 === joined.x0 && joined.y1 === joined.y0 && joined.x2 === joined.x3 && joined.y2 === joined.y3;
  if (a === b && (joined.line || noHandles)) {
    // Two straight segments forming a closed spike: nothing is left.
    return removeVertices(removeSegments(net, [e1.s, e2.s]), [v]);
  }
  const d = draftOf(net);
  d.segments[e1.s] = { ...stripTangents(s1), ...segmentFromCubic(a, b, joined) } as N["segments"][number];
  const keep = e1.s, drop = e2.s;
  const smap = (i: number): number | number[] | null => (i === drop ? [] : i > drop ? i - 1 : i);
  const segments = d.segments.filter((_, i) => i !== drop).map((seg) => seg);
  const regions = remapRegions(net.regions, smap, segments);
  void keep;
  const out = finish(net, { vertices: d.vertices, segments, regions });
  return removeVertices(out, [v]);
}

function stripTangents<T extends object>(s: T): T {
  const copy: Record<string, unknown> = { ...(s as object) };
  delete copy.tangentStart;
  delete copy.tangentEnd;
  return copy as unknown as T;
}

/**
 * Simplifies a network: removes vertices of degree two (and merges their
 * segments) as long as the result stays within `tolerance` of the original
 * geometry everywhere. Error is always measured against the original
 * curves, so it does not accumulate. Vertices with a corner radius, a cap or
 * that are sharp corners turning more than `cornerAngle` degrees are kept.
 */
export function simplifyNetwork<N extends VectorNetwork>(net: N, tolerance: number, cornerAngle = 45): N {
  let out = net;
  // Original geometry each current segment stands for.
  let represents: Cubic[][] = net.segments.map((_, i) => [segmentCubic(net, i)]);
  const maxTurn = (cornerAngle * Math.PI) / 180;
  let changed = true;
  while (changed) {
    changed = false;
    // Candidates: degree-two vertices, cheapest first.
    const ends: { s: number; end: "start" | "end" }[][] = out.vertices.map(() => []);
    out.segments.forEach((seg, i) => {
      ends[seg.start]!.push({ s: i, end: "start" });
      ends[seg.end]!.push({ s: i, end: "end" });
    });
    const candidates: { v: number; err: number; joined: Cubic }[] = [];
    for (let v = 0; v < out.vertices.length; v++) {
      const e = ends[v]!;
      const vert = out.vertices[v]!;
      if (e.length !== 2 || e[0]!.s === e[1]!.s || vert.cornerRadius !== undefined || vert.strokeCap !== undefined) continue;
      const c1 = segmentCubic(out, e[0]!.s, e[0]!.end === "end");
      const c2 = segmentCubic(out, e[1]!.s, e[1]!.end === "start");
      const t1 = tangentAt(c1, 1), t2 = tangentAt(c2, 0);
      const turn = Math.abs(Math.atan2(t1.x * t2.y - t1.y * t2.x, t1.x * t2.x + t1.y * t2.y));
      if (turn > maxTurn) continue;
      const joined = joinCurves(c1, c2);
      const err = deviation([...represents[e[0]!.s]!, ...represents[e[1]!.s]!], joined, 16);
      if (err <= tolerance) candidates.push({ v, err, joined });
    }
    if (candidates.length === 0) break;
    candidates.sort((p, q) => p.err - q.err);
    // Apply the cheapest one, then re-evaluate (indices shift).
    const { v } = candidates[0]!;
    const e = ends[v]!;
    const merged = [...represents[e[0]!.s]!, ...represents[e[1]!.s]!];
    const drop = e[1]!.s;
    const next = deleteVertexPreservingShape(out, v);
    if (next.segments.length !== out.segments.length - 1) break;
    represents = represents.filter((_, i) => i !== drop);
    represents[e[0]!.s > drop ? e[0]!.s - 1 : e[0]!.s] = merged;
    out = next;
    changed = true;
  }
  return out;
}

/**
 * Freehand input (a pencil stroke) as a network: the points are fitted with
 * cubics within `tolerance` ({@link fitCurve}); joints between fitted pieces
 * are smooth (mirrored "angle"), corners stay corners. A stroke that ends
 * where it started (within `closeDistance`) is closed and filled.
 */
export function freehandToNetwork(points: readonly Vec[], options: FitOptions & { readonly closeDistance?: number }): VectorNetwork {
  const curves = fitCurve(points, options);
  if (curves.length === 0) return { vertices: [], segments: [], regions: [] };
  const first = curves[0]!, last = curves[curves.length - 1]!;
  const close = options.closeDistance !== undefined && Math.hypot(last.x3 - first.x0, last.y3 - first.y0) <= options.closeDistance;
  const path = new Path().moveTo(first.x0, first.y0);
  curves.forEach((c, i) => {
    const end = close && i === curves.length - 1 ? { x: first.x0, y: first.y0 } : { x: c.x3, y: c.y3 };
    if (c.line) path.lineTo(end.x, end.y);
    else path.cubicTo(c.x1, c.y1, c.x2 + end.x - c.x3, c.y2 + end.y - c.y3, end.x, end.y);
  });
  if (close) path.close();
  let net = pathToNetwork(path, { fill: close });
  // Mark smooth joints as mirrored by angle.
  for (let v = 0; v < net.vertices.length; v++) {
    const segs = net.segments.map((s, i) => ({ s, i })).filter(({ s }) => s.start === v || s.end === v);
    if (segs.length !== 2) continue;
    const [p, q] = segs as [typeof segs[0], typeof segs[0]];
    const hp = p.s.start === v ? p.s.tangentStart : p.s.tangentEnd;
    const hq = q.s.start === v ? q.s.tangentStart : q.s.tangentEnd;
    if (!hp || !hq) continue;
    const cross = hp.x * hq.y - hp.y * hq.x;
    const dot = hp.x * hq.x + hp.y * hq.y;
    if (Math.abs(cross) <= 1e-6 * Math.hypot(hp.x, hp.y) * Math.hypot(hq.x, hq.y) && dot < 0) {
      const d = draftOf(net);
      d.vertices[v] = { ...d.vertices[v]!, handleMirroring: "angle" };
      net = finish(net, d);
    }
  }
  return net;
}

/** Re-exported so callers can make a straight segment from a curve. */
export { setSegmentTangents };
