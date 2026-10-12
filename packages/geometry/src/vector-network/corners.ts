import { arcLength, paramAtLength, pointAt, subCurve, tangentAt, type Cubic } from "../bezier/cubic";
import { loopDirections, segmentCubic, segmentFromCubic, type NetworkRegion, type NetworkSegment, type NetworkVertex, type VectorNetwork } from "./network";

/**
 * Rounded corners on vector networks. A vertex with a corner radius (its own
 * `cornerRadius`, else the node's default) where exactly two segments meet is
 * replaced by a circular-looking arc tangent to both segments:
 *
 * - The arc starts at distance d = r / tan(θ/2) from the vertex along each
 *   segment (θ the angle between them), measured as arc length on curves. d
 *   is clamped so the two corners of one segment never overlap (half the
 *   segment when both ends are rounded, all of it otherwise); the radius
 *   shrinks with it, like rounded polygon corners.
 * - The arc is one cubic tangent to the trimmed segments, with handles
 *   (4/3)·tan(φ/4)·ρ, φ the turn between the tangents and ρ the radius of the
 *   circle through both ends tangent to the first. For straight segments
 *   this is the usual cubic circular arc.
 *
 * Straight-through vertices (θ = 180°), cusps and junctions of three or more
 * segments stay sharp. The result is an ordinary network (each rounded vertex
 * becomes two vertices joined by the arc segment, inserted into every region
 * loop through it), used for rendering, flattening and booleans.
 */
export function roundNetworkCorners<N extends VectorNetwork>(net: N, defaultRadius = 0): N {
  const nv = net.vertices.length;
  const ends: { segment: number; end: "start" | "end" }[][] = Array.from({ length: nv }, () => []);
  net.segments.forEach((s, i) => {
    ends[s.start]!.push({ segment: i, end: "start" });
    ends[s.end]!.push({ segment: i, end: "end" });
  });
  const radiusOf = (v: number): number => {
    const r = net.vertices[v]!.cornerRadius ?? defaultRadius;
    return Number.isFinite(r) && r > 0 ? r : 0;
  };
  const rounded = new Array<boolean>(nv).fill(false);
  for (let v = 0; v < nv; v++) {
    const e = ends[v]!;
    rounded[v] = radiusOf(v) > 0 && e.length === 2 && e[0]!.segment !== e[1]!.segment;
  }
  if (!rounded.some(Boolean)) return net;

  // Segment lengths and how much each end may be trimmed.
  const curves = net.segments.map((_, i) => segmentCubic(net, i));
  const lengths = curves.map((c) => arcLength(c));
  const budget = (s: number, end: "start" | "end"): number => {
    const seg = net.segments[s]!;
    const other = end === "start" ? seg.end : seg.start;
    return rounded[other] ? lengths[s]! / 2 : lengths[s]!;
  };

  // Trim distances per segment end, and the corner arc per vertex.
  const trim = net.segments.map(() => ({ start: 0, end: 0 }));
  const corners = new Map<number, { from: { segment: number; end: "start" | "end" }; to: { segment: number; end: "start" | "end" }; d: number; turn: number }>();
  for (let v = 0; v < nv; v++) {
    if (!rounded[v]) continue;
    const [e1, e2] = ends[v]! as [typeof ends[0][0], typeof ends[0][0]];
    const u1 = leaving(curves[e1.segment]!, e1.end);
    const u2 = leaving(curves[e2.segment]!, e2.end);
    const cos = Math.max(-1, Math.min(1, u1.x * u2.x + u1.y * u2.y));
    const theta = Math.acos(cos);
    if (theta < 1e-6 || Math.PI - theta < 1e-6) continue;
    let d = radiusOf(v) / Math.tan(theta / 2);
    d = Math.min(d, budget(e1.segment, e1.end), budget(e2.segment, e2.end));
    if (!(d > 1e-9)) continue;
    trim[e1.segment]![e1.end] = d;
    trim[e2.segment]![e2.end] = d;
    corners.set(v, { from: e1, to: e2, d, turn: Math.PI - theta });
  }
  if (corners.size === 0) return net;

  // New vertices: a rounded vertex keeps its index for the trim point on its first segment; the second gets a new index.
  const vertices: NetworkVertex[] = net.vertices.map((v) => ({ ...v }));
  const secondVertex = new Map<number, number>();
  const trimmedEnd = (s: number, end: "start" | "end"): { x: number; y: number } => {
    const c = curves[s]!;
    const t = paramAt(c, end, trim[s]![end], lengths[s]!);
    return pointAt(c, t);
  };
  for (const [v, k] of corners) {
    const p1 = trimmedEnd(k.from.segment, k.from.end);
    const p2 = trimmedEnd(k.to.segment, k.to.end);
    const base = stripCorner(net.vertices[v]!);
    vertices[v] = { ...base, x: p1.x, y: p1.y };
    vertices.push({ ...base, x: p2.x, y: p2.y });
    secondVertex.set(v, vertices.length - 1);
  }
  // Trimmed segments.
  const segments: NetworkSegment[] = net.segments.map((seg, i) => {
    const c = curves[i]!;
    const t0 = paramAt(c, "start", trim[i]!.start, lengths[i]!);
    const t1 = paramAt(c, "end", trim[i]!.end, lengths[i]!);
    let start = seg.start, end = seg.end;
    const ks = corners.get(seg.start);
    if (ks && ks.to.segment === i && ks.to.end === "start") start = secondVertex.get(seg.start)!;
    const ke = corners.get(seg.end);
    if (ke && ke.to.segment === i && ke.to.end === "end") end = secondVertex.get(seg.end)!;
    const piece = t0 === 0 && t1 === 1 ? c : subCurve(c, t0, t1);
    const a = vertices[start]!, b = vertices[end]!;
    const fixed: Cubic = piece.line ? piece : { ...piece, x0: a.x, y0: a.y, x3: b.x, y3: b.y };
    return { ...seg, ...segmentFromCubic(start, end, fixed) } as NetworkSegment;
  });
  // Clean tangents on segments that became straight lines.
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]! as NetworkSegment & Record<string, unknown>;
    if (curves[i]!.line) {
      const copy: Record<string, unknown> = { ...s };
      delete copy.tangentStart;
      delete copy.tangentEnd;
      segments[i] = copy as unknown as NetworkSegment;
    }
  }
  // Corner arcs.
  const cornerSegment = new Map<number, number>();
  for (const [v, k] of corners) {
    const a = vertices[v]!, b = vertices[secondVertex.get(v)!]!;
    const c1 = curves[k.from.segment]!, c2 = curves[k.to.segment]!;
    // Direction of travel into the corner along the first segment, and out of it along the second.
    const tin = arriving(c1, k.from.end, paramAt(c1, k.from.end, k.d, lengths[k.from.segment]!));
    const tout = leavingAt(c2, k.to.end, paramAt(c2, k.to.end, k.d, lengths[k.to.segment]!));
    const chord = Math.hypot(b.x - a.x, b.y - a.y);
    const phi = Math.acos(Math.max(-1, Math.min(1, tin.x * tout.x + tin.y * tout.y)));
    const rho = phi > 1e-9 ? chord / (2 * Math.sin(phi / 2)) : chord;
    const h = phi > 1e-9 ? (4 / 3) * Math.tan(phi / 4) * rho : chord / 3;
    segments.push({ start: v, end: secondVertex.get(v)!, tangentStart: { x: tin.x * h, y: tin.y * h }, tangentEnd: { x: -tout.x * h, y: -tout.y * h } });
    cornerSegment.set(v, segments.length - 1);
  }
  // Regions: insert each corner arc between the two segments it joins.
  const regions: NetworkRegion[] = net.regions.map((r) => ({
    ...r,
    loops: r.loops.map((loop) => {
      const dirs = loopDirections(net.segments, loop);
      if (!dirs) return [...loop];
      const out: number[] = [];
      loop.forEach((s, i) => {
        out.push(s);
        const seg = net.segments[s]!;
        const v = dirs[i] ? seg.end : seg.start;
        if (corners.has(v)) out.push(cornerSegment.get(v)!);
      });
      return out;
    }),
  }));
  return { ...net, vertices, segments, regions } as unknown as N;
}

function stripCorner(v: NetworkVertex): NetworkVertex {
  const copy: Record<string, unknown> = { ...v };
  delete copy.cornerRadius;
  return copy as unknown as NetworkVertex;
}

/** Parameter at arc length `d` from the given end. */
function paramAt(c: Cubic, end: "start" | "end", d: number, length: number): number {
  if (d <= 0) return end === "start" ? 0 : 1;
  if (end === "start") return paramAtLength(c, d, length);
  return paramAtLength(c, length - d, length);
}

/** Unit direction leaving the vertex at the given end of a curve. */
function leaving(c: Cubic, end: "start" | "end"): { x: number; y: number } {
  if (end === "start") return tangentAt(c, 0);
  const t = tangentAt(c, 1);
  return { x: -t.x, y: -t.y };
}

/** Direction of travel towards the vertex at parameter t (the vertex at the given end). */
function arriving(c: Cubic, end: "start" | "end", t: number): { x: number; y: number } {
  const d = tangentAt(c, t);
  return end === "end" ? d : { x: -d.x, y: -d.y };
}

/** Direction of travel away from the vertex at parameter t. */
function leavingAt(c: Cubic, end: "start" | "end", t: number): { x: number; y: number } {
  const d = tangentAt(c, t);
  return end === "start" ? d : { x: -d.x, y: -d.y };
}
