import { pointAt, splitAt } from "../bezier/cubic";
import type { Mat2D } from "../matrix";
import {
  draftOf,
  finish,
  incidence,
  isStraightSegment,
  loopDirections,
  remapRegions,
  segmentCubic,
  segmentFromCubic,
  type HandleMirroring,
  type NetworkSegment,
  type NetworkVertex,
  type Vec,
  type VectorNetwork,
} from "./network";

/**
 * Editing operations on vector networks. Every operation is pure: it returns
 * a new network of the same type, never mutates its input, and keeps the
 * network valid (`validateNetwork` finds nothing): indices are remapped when
 * vertices or segments are removed, and regions whose boundary an edit
 * breaks are removed rather than left dangling. These are the operations the
 * pen tool and vector edit mode call.
 */

type V<N extends VectorNetwork> = N["vertices"][number];
type S<N extends VectorNetwork> = N["segments"][number];

const ZERO: Vec = { x: 0, y: 0 };

function check<N extends VectorNetwork>(net: N, v: number): void {
  if (!Number.isInteger(v) || v < 0 || v >= net.vertices.length) throw new RangeError(`vertex ${v} does not exist`);
}

function checkSegment<N extends VectorNetwork>(net: N, s: number): void {
  if (!Number.isInteger(s) || s < 0 || s >= net.segments.length) throw new RangeError(`segment ${s} does not exist`);
}

// ── Vertices ─────────────────────────────────────────────────────────────

export function addVertex<N extends VectorNetwork>(net: N, x: number, y: number, props: Omit<NetworkVertex, "x" | "y"> = {}): { network: N; vertex: number } {
  const d = draftOf(net);
  d.vertices.push({ ...props, x, y } as V<N>);
  return { network: finish(net, d), vertex: d.vertices.length - 1 };
}

/** Moves vertices by (dx, dy); their tangents move with them (they are relative). */
export function moveVertices<N extends VectorNetwork>(net: N, ids: readonly number[], dx: number, dy: number): N {
  const d = draftOf(net);
  for (const v of new Set(ids)) {
    check(net, v);
    const p = d.vertices[v]!;
    d.vertices[v] = { ...p, x: p.x + dx, y: p.y + dy };
  }
  return finish(net, d);
}

export function setVertexPosition<N extends VectorNetwork>(net: N, v: number, x: number, y: number): N {
  check(net, v);
  const d = draftOf(net);
  d.vertices[v] = { ...d.vertices[v]!, x, y };
  return finish(net, d);
}

/** Sets vertex properties (corner radius, cap, mirroring); `undefined` removes one. */
export function updateVertex<N extends VectorNetwork>(net: N, v: number, props: Partial<Omit<NetworkVertex, "x" | "y">>): N {
  check(net, v);
  const d = draftOf(net);
  const next: Record<string, unknown> = { ...(d.vertices[v]! as object) };
  for (const [k, val] of Object.entries(props)) {
    if (val === undefined) delete next[k];
    else next[k] = val;
  }
  d.vertices[v] = next as unknown as V<N>;
  return finish(net, d);
}

/** Applies an affine transform to every vertex and tangent. */
export function transformNetwork<N extends VectorNetwork>(net: N, m: Mat2D): N {
  const [a, b, c, dd, e, f] = m;
  const d = draftOf(net);
  d.vertices = d.vertices.map((v) => ({ ...v, x: a * v.x + c * v.y + e, y: b * v.x + dd * v.y + f }));
  const lin = (t: Vec | undefined): Vec | undefined => (t ? { x: a * t.x + c * t.y, y: b * t.x + dd * t.y } : undefined);
  d.segments = d.segments.map((s) => withTangents(s, lin(s.tangentStart), lin(s.tangentEnd)));
  // A reflection reverses the orientation of loops; fill rules are orientation-independent, so regions stay.
  return finish(net, d);
}

/**
 * Removes vertices with every segment that touches them. Regions that lose a
 * segment are removed. Indices above the removed ones shift down.
 */
export function removeVertices<N extends VectorNetwork>(net: N, ids: readonly number[]): N {
  const gone = new Set(ids);
  for (const v of gone) check(net, v);
  const vmap = new Int32Array(net.vertices.length);
  const vertices: V<N>[] = [];
  net.vertices.forEach((v, i) => {
    if (gone.has(i)) vmap[i] = -1;
    else {
      vmap[i] = vertices.length;
      vertices.push(v);
    }
  });
  const smap = new Int32Array(net.segments.length);
  const segments: S<N>[] = [];
  net.segments.forEach((s, i) => {
    if (gone.has(s.start) || gone.has(s.end)) smap[i] = -1;
    else {
      smap[i] = segments.length;
      segments.push({ ...s, start: vmap[s.start]!, end: vmap[s.end]! });
    }
  });
  const regions = remapRegions(net.regions, (s) => (smap[s]! >= 0 ? smap[s]! : null));
  return { ...net, vertices, segments, regions } as N;
}

/** Removes vertices that no segment uses. */
export function removeIsolatedVertices<N extends VectorNetwork>(net: N): N {
  const used = new Uint8Array(net.vertices.length);
  for (const s of net.segments) {
    used[s.start] = 1;
    used[s.end] = 1;
  }
  const ids: number[] = [];
  used.forEach((u, i) => {
    if (!u) ids.push(i);
  });
  return ids.length ? removeVertices(net, ids) : net;
}

/**
 * Merges vertex `remove` into `keep`: segments that used `remove` now use
 * `keep` (tangents unchanged), straight segments that collapse to a point are
 * removed, then `remove` is deleted. Regions stay when their loops still close.
 */
export function mergeVertices<N extends VectorNetwork>(net: N, keep: number, remove: number): N {
  check(net, keep);
  check(net, remove);
  if (keep === remove) return net;
  const d = draftOf(net);
  const smap = new Int32Array(net.segments.length);
  const segments: S<N>[] = [];
  d.segments.forEach((s, i) => {
    const start = s.start === remove ? keep : s.start;
    const end = s.end === remove ? keep : s.end;
    const next = { ...s, start, end };
    if (start === end && isStraightSegment(next)) smap[i] = -1;
    else {
      smap[i] = segments.length;
      segments.push(next);
    }
  });
  const regions = remapRegions(net.regions, (s) => (smap[s]! >= 0 ? smap[s]! : null), segments);
  const merged = { ...net, vertices: d.vertices, segments, regions } as N;
  return removeVertices(merged, [remove]);
}

/**
 * Detaches the segments meeting at a vertex: each incident segment end after
 * the first gets its own copy of the vertex. Regions through the vertex are
 * removed (their loops no longer close).
 */
export function disconnectVertex<N extends VectorNetwork>(net: N, v: number): N {
  check(net, v);
  const d = draftOf(net);
  let first = true;
  d.segments = d.segments.map((s) => {
    let next = s;
    for (const key of ["start", "end"] as const) {
      if (next[key] !== v) continue;
      if (first) {
        first = false;
        continue;
      }
      d.vertices.push({ ...d.vertices[v]! });
      next = { ...next, [key]: d.vertices.length - 1 };
    }
    return next;
  });
  d.regions = remapRegions(net.regions, (s) => s, d.segments);
  return finish(net, d);
}

// ── Segments ─────────────────────────────────────────────────────────────

function withTangents<T extends NetworkSegment>(s: T, ts: Vec | undefined, te: Vec | undefined): T {
  const out: Record<string, unknown> = { ...(s as object) };
  delete out.tangentStart;
  delete out.tangentEnd;
  if (ts && (ts.x !== 0 || ts.y !== 0)) out.tangentStart = { x: ts.x, y: ts.y };
  if (te && (te.x !== 0 || te.y !== 0)) out.tangentEnd = { x: te.x, y: te.y };
  return out as unknown as T;
}

/** Adds a segment between two vertices (straight unless tangents are given). */
export function addSegment<N extends VectorNetwork>(net: N, start: number, end: number, tangentStart?: Vec, tangentEnd?: Vec): { network: N; segment: number } {
  check(net, start);
  check(net, end);
  const s = withTangents({ start, end } as NetworkSegment, tangentStart, tangentEnd);
  if (start === end && isStraightSegment(s)) throw new RangeError("a straight segment cannot start and end at the same vertex");
  const d = draftOf(net);
  d.segments.push(s as S<N>);
  return { network: finish(net, d), segment: d.segments.length - 1 };
}

/** Removes segments (regions that use them are removed). Vertices stay. */
export function removeSegments<N extends VectorNetwork>(net: N, ids: readonly number[]): N {
  const gone = new Set(ids);
  for (const s of gone) checkSegment(net, s);
  const smap = new Int32Array(net.segments.length);
  const segments: S<N>[] = [];
  net.segments.forEach((s, i) => {
    if (gone.has(i)) smap[i] = -1;
    else {
      smap[i] = segments.length;
      segments.push(s);
    }
  });
  const regions = remapRegions(net.regions, (s) => (smap[s]! >= 0 ? smap[s]! : null));
  return { ...net, segments, regions } as N;
}

export function setSegmentTangents<N extends VectorNetwork>(net: N, s: number, tangentStart: Vec | undefined, tangentEnd: Vec | undefined): N {
  checkSegment(net, s);
  const d = draftOf(net);
  const next = withTangents(d.segments[s]!, tangentStart, tangentEnd);
  if (next.start === next.end && isStraightSegment(next)) throw new RangeError("a segment from a vertex to itself needs a handle");
  d.segments[s] = next;
  return finish(net, d);
}

/** Makes a segment straight (zero tangents). */
export function straightenSegment<N extends VectorNetwork>(net: N, s: number): N {
  return setSegmentTangents(net, s, undefined, undefined);
}

/**
 * Makes a straight segment a curve with the same shape: handles a third of
 * the way along the chord, so it can be bent. Curves are returned unchanged.
 */
export function curveSegment<N extends VectorNetwork>(net: N, s: number): N {
  checkSegment(net, s);
  const seg = net.segments[s]!;
  if (!isStraightSegment(seg)) return net;
  const a = net.vertices[seg.start]!, b = net.vertices[seg.end]!;
  const dx = (b.x - a.x) / 3, dy = (b.y - a.y) / 3;
  if (dx === 0 && dy === 0) return net;
  return setSegmentTangents(net, s, { x: dx, y: dy }, { x: -dx, y: -dy });
}

/**
 * Splits a segment at parameter t (De Casteljau, so the shape is unchanged).
 * The segment keeps its index for the first half; the second half is
 * appended. Regions get both halves in walking order.
 */
export function splitSegment<N extends VectorNetwork>(net: N, s: number, t: number): { network: N; vertex: number; segment: number } {
  checkSegment(net, s);
  if (!(t > 0 && t < 1)) throw new RangeError(`split parameter must be in (0, 1), got ${t}`);
  const seg = net.segments[s]!;
  const c = segmentCubic(net, s);
  const [l, r] = splitAt(c, t);
  const d = draftOf(net);
  d.vertices.push({ x: l.x3, y: l.y3 } as V<N>);
  const m = d.vertices.length - 1;
  const first = segmentFromCubic(seg.start, m, l);
  const second = segmentFromCubic(m, seg.end, r);
  d.segments[s] = { ...withTangents(seg, first.tangentStart, first.tangentEnd), start: seg.start, end: m };
  d.segments.push({ ...withTangents(seg, second.tangentStart, second.tangentEnd), start: m, end: seg.end } as S<N>);
  const n = d.segments.length - 1;
  d.regions = remapRegions(net.regions, (i) => (i === s ? [s, n] : i), d.segments, net.segments);
  return { network: finish(net, d), vertex: m, segment: n };
}

/**
 * Bends a segment so the point at parameter t moves to `target`, changing
 * the two handles by the smallest amount that does it (the least-norm
 * solution of b1(t)·Δ1 + b2(t)·Δ2 = target − B(t)). A straight segment
 * becomes a curve. Vertices whose mirroring is set keep their other handle
 * mirrored.
 */
export function bendSegment<N extends VectorNetwork>(net: N, s: number, t: number, target: Vec): N {
  checkSegment(net, s);
  const tt = Math.min(1 - 1e-6, Math.max(1e-6, t));
  let out = curveSegment(net, s);
  const c = segmentCubic(out, s);
  const p = pointAt(c, tt);
  const dx = target.x - p.x, dy = target.y - p.y;
  const mt = 1 - tt;
  const b1 = 3 * mt * mt * tt, b2 = 3 * mt * tt * tt;
  const den = b1 * b1 + b2 * b2;
  const seg = out.segments[s]!;
  const ts = seg.tangentStart ?? ZERO, te = seg.tangentEnd ?? ZERO;
  const nts = { x: ts.x + (dx * b1) / den, y: ts.y + (dy * b1) / den };
  const nte = { x: te.x + (dx * b2) / den, y: te.y + (dy * b2) / den };
  out = setSegmentTangents(out, s, nts, nte);
  out = mirrorAt(out, seg.start, s, "start");
  out = mirrorAt(out, seg.end, s, "end");
  return out;
}

/** The handle of segment `s` at its `end` ("start" or "end"), relative to that vertex. */
export function handleOf(net: VectorNetwork, s: number, end: "start" | "end"): Vec {
  const seg = net.segments[s]!;
  return (end === "start" ? seg.tangentStart : seg.tangentEnd) ?? ZERO;
}

/** The other segment end at a vertex of degree two, if the vertex has exactly two. */
export function oppositeEnd(net: VectorNetwork, v: number, s: number, end: "start" | "end"): { segment: number; end: "start" | "end" } | null {
  const ends: { segment: number; end: "start" | "end" }[] = [];
  net.segments.forEach((seg, i) => {
    if (seg.start === v) ends.push({ segment: i, end: "start" });
    if (seg.end === v) ends.push({ segment: i, end: "end" });
  });
  if (ends.length !== 2) return null;
  const other = ends.find((e) => !(e.segment === s && e.end === end));
  return other ?? null;
}

/** Re-applies the vertex's mirroring to the handle opposite (s, end), keeping (s, end) as the leader. */
function mirrorAt<N extends VectorNetwork>(net: N, v: number, s: number, end: "start" | "end"): N {
  const mode = net.vertices[v]!.handleMirroring ?? "none";
  if (mode === "none") return net;
  const opp = oppositeEnd(net, v, s, end);
  if (!opp) return net;
  const lead = handleOf(net, s, end);
  const other = handleOf(net, opp.segment, opp.end);
  return setHandle(net, opp.segment, opp.end, mirrored(lead, other, mode));
}

function mirrored(lead: Vec, other: Vec, mode: HandleMirroring): Vec {
  if (mode === "angle-length") return { x: -lead.x, y: -lead.y };
  const ll = Math.hypot(lead.x, lead.y);
  const ol = Math.hypot(other.x, other.y);
  if (ll === 0) return other;
  return { x: (-lead.x / ll) * ol, y: (-lead.y / ll) * ol };
}

function setHandle<N extends VectorNetwork>(net: N, s: number, end: "start" | "end", h: Vec): N {
  const seg = net.segments[s]!;
  return end === "start" ? setSegmentTangents(net, s, h, seg.tangentEnd) : setSegmentTangents(net, s, seg.tangentStart, h);
}

/**
 * Moves one handle: the control point of segment `s` at its `end`, relative to
 * that vertex. With mirroring "angle" the opposite handle at a vertex of
 * degree two turns to stay collinear (keeping its length); with
 * "angle-length" it becomes the exact opposite. Defaults to the vertex's own
 * mirroring setting.
 */
export function moveHandle<N extends VectorNetwork>(net: N, s: number, end: "start" | "end", handle: Vec, mirroring?: HandleMirroring): N {
  checkSegment(net, s);
  const seg = net.segments[s]!;
  const v = end === "start" ? seg.start : seg.end;
  const mode = mirroring ?? net.vertices[v]!.handleMirroring ?? "none";
  let out = setHandle(net, s, end, handle);
  if (mode !== "none") {
    const opp = oppositeEnd(out, v, s, end);
    if (opp) out = setHandle(out, opp.segment, opp.end, mirrored(handle, handleOf(out, opp.segment, opp.end), mode));
  }
  return out;
}

/**
 * Sets a vertex's mirroring and makes its handles obey it ("smooth" or
 * "symmetric" a vertex): at a vertex of degree two, both handles become
 * collinear along the bisecting direction (keeping their lengths for
 * "angle", averaging them for "angle-length"). A vertex without handles gets
 * smooth ones: parallel to the line through its neighbours, a third of the
 * way to each (as a Catmull–Rom spline would). "none" only stores the mode.
 */
export function setVertexMirroring<N extends VectorNetwork>(net: N, v: number, mode: HandleMirroring): N {
  check(net, v);
  let out = updateVertex(net, v, { handleMirroring: mode === "none" ? undefined : mode });
  if (mode === "none") return out;
  const ends: { segment: number; end: "start" | "end" }[] = [];
  out.segments.forEach((seg, i) => {
    if (seg.start === v) ends.push({ segment: i, end: "start" });
    if (seg.end === v) ends.push({ segment: i, end: "end" });
  });
  if (ends.length !== 2) return out;
  const [e1, e2] = ends as [typeof ends[0], typeof ends[0]];
  const h1 = handleOf(out, e1.segment, e1.end), h2 = handleOf(out, e2.segment, e2.end);
  const l1 = Math.hypot(h1.x, h1.y), l2 = Math.hypot(h2.x, h2.y);
  const p = out.vertices[v]!;
  const far = (e: { segment: number; end: "start" | "end" }): Vec => {
    const seg = out.segments[e.segment]!;
    return out.vertices[e.end === "start" ? seg.end : seg.start]!;
  };
  let dir: Vec;
  let len1 = l1, len2 = l2;
  if (l1 === 0 && l2 === 0) {
    const a = far(e1), b = far(e2);
    dir = { x: b.x - a.x, y: b.y - a.y };
    len1 = Math.hypot(a.x - p.x, a.y - p.y) / 3;
    len2 = Math.hypot(b.x - p.x, b.y - p.y) / 3;
  } else if (l1 === 0) {
    dir = { x: h2.x, y: h2.y };
    len1 = l2;
  } else if (l2 === 0) {
    dir = { x: -h1.x, y: -h1.y };
    len2 = l1;
  } else {
    dir = { x: h2.x / l2 - h1.x / l1, y: h2.y / l2 - h1.y / l1 };
  }
  const dl = Math.hypot(dir.x, dir.y);
  if (dl === 0) return out;
  const ux = dir.x / dl, uy = dir.y / dl;
  if (mode === "angle-length") len1 = len2 = (len1 + len2) / 2;
  out = setHandle(out, e1.segment, e1.end, { x: -ux * len1, y: -uy * len1 });
  out = setHandle(out, e2.segment, e2.end, { x: ux * len2, y: uy * len2 });
  return out;
}

/** Collapses every handle at a vertex (a sharp corner) and clears its mirroring. */
export function makeCorner<N extends VectorNetwork>(net: N, v: number): N {
  check(net, v);
  let out = updateVertex(net, v, { handleMirroring: undefined });
  out.segments.forEach((seg, i) => {
    // A loop from the vertex to itself keeps its handles: without them it would collapse to a point.
    if (seg.start === seg.end) return;
    if (seg.start === v) out = setHandle(out, i, "start", ZERO);
    if (seg.end === v) out = setHandle(out, i, "end", ZERO);
  });
  return out;
}

/** Reverses a segment's direction (same geometry). */
export function reverseSegment<N extends VectorNetwork>(net: N, s: number): N {
  checkSegment(net, s);
  const seg = net.segments[s]!;
  const d = draftOf(net);
  d.segments[s] = { ...withTangents(seg, seg.tangentEnd, seg.tangentStart), start: seg.end, end: seg.start };
  return finish(net, d);
}

/** Segment indices incident to a vertex. */
export function segmentsAt(net: VectorNetwork, v: number): number[] {
  return incidence(net)[v] ?? [];
}

/** Whether two vertices are connected by a chain of segments. */
export function connected(net: VectorNetwork, a: number, b: number): boolean {
  if (a === b) return true;
  const inc = incidence(net);
  const seen = new Uint8Array(net.vertices.length);
  const stack = [a];
  seen[a] = 1;
  while (stack.length) {
    const v = stack.pop()!;
    for (const s of inc[v]!) {
      const seg = net.segments[s]!;
      const w = seg.start === v ? seg.end : seg.start;
      if (w === b) return true;
      if (!seen[w]) {
        seen[w] = 1;
        stack.push(w);
      }
    }
  }
  return false;
}

/** Sanity helper used by tests: whether every region loop still closes. */
export function regionsClose(net: VectorNetwork): boolean {
  return net.regions.every((r) => r.loops.every((l) => loopDirections(net.segments, l) !== null));
}
