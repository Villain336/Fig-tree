import { buildArrangement, type Arrangement } from "../boolean/arrangement";
import { flattenPath, windingNumber, type FillRule } from "../flatten";
import { Path } from "../path";
import { addSegment } from "./edit";
import { draftOf, finish, loopDirections, loopCubics, segmentCubic, type VectorNetwork } from "./network";

/**
 * Faces of a vector network: the bounded areas enclosed by its segments,
 * found as the faces of the plane graph (segments sorted by angle around
 * each vertex, curves that leave a vertex in the same direction ordered by
 * where they go next). A face is its outer loop plus the outer boundaries of
 * any separate parts of the network inside it (holes). Segments are expected
 * to meet only at vertices; crossing segments without a vertex do not split
 * faces.
 */
export interface NetworkFace {
  /** Loops of segment indices, outer boundary first, then holes. */
  readonly loops: number[][];
  /** Area of the face (outer loop minus holes), positive. */
  readonly area: number;
}

export function networkFaces(net: VectorNetwork): NetworkFace[] {
  if (net.segments.length === 0) return [];
  const arr = buildArrangement(
    net.segments.map((_, i) => ({ curve: segmentCubic(net, i), dim: 0 })),
    { dims: 1, intersect: false },
  );
  const loopOf = (cycle: readonly number[]): number[] | null => cycleToLoop(arr, cycle, net);
  // Bounded faces: positive area cycles. Component outer cycles: the others.
  const bounded: { loop: number[]; area: number; face: number; poly: ReturnType<typeof flattenPath> }[] = [];
  const outerByComponent = new Map<number, number>();
  arr.componentOuter.forEach((f, c) => {
    if (f >= 0) outerByComponent.set(c, f);
  });
  const outerFaces = new Set(arr.componentOuter);
  arr.faces.forEach((cycle, f) => {
    if (outerFaces.has(f) || !(arr.faceArea[f]! > 0)) return;
    const loop = loopOf(cycle);
    if (!loop) return;
    bounded.push({ loop, area: arr.faceArea[f]!, face: f, poly: flattenPath(loopPath(net, loop), undefined, toleranceFor(net)) });
  });
  const faces = bounded.map((b) => ({ loops: [b.loop], area: b.area }));
  // Place each component inside the smallest face (of another component) containing it.
  for (const [c, f] of outerByComponent) {
    const cycle = arr.faces[f]!;
    const hole = loopOf(cycle);
    if (!hole) continue;
    const v = arr.vertices[arr.origin(cycle[0]!)]!;
    let best = -1;
    bounded.forEach((b, i) => {
      if (arr.faceComponent[b.face] === c) return;
      if (windingNumber(b.poly, v.x, v.y) === 0) return;
      if (best === -1 || b.area < bounded[best]!.area) best = i;
    });
    if (best >= 0) {
      faces[best]!.loops.push(hole);
      faces[best] = { loops: faces[best]!.loops, area: faces[best]!.area + arr.faceArea[f]! };
    }
  }
  return faces;
}

function toleranceFor(net: VectorNetwork): number {
  let ext = 1;
  for (const v of net.vertices) ext = Math.max(ext, Math.abs(v.x), Math.abs(v.y));
  return ext * 1e-6;
}

/**
 * Turns a face cycle (half-edges of monotonic pieces) into a loop of segment
 * indices: pieces of one segment collapse into it, and segments the cycle
 * walks in both directions (dangling segments, bridges) are cut out.
 */
function cycleToLoop(arr: Arrangement, cycle: readonly number[], net: VectorNetwork): number[] | null {
  const seq: { s: number; fwd: boolean }[] = [];
  for (const h of cycle) {
    const src = arr.edges[h >> 1]!.sources[0]!;
    const fwd = (src.t1 > src.t0) === ((h & 1) === 0);
    const last = seq[seq.length - 1];
    if (last && last.s === src.source && last.fwd === fwd) continue;
    seq.push({ s: src.source, fwd });
  }
  while (seq.length > 1 && seq[0]!.s === seq[seq.length - 1]!.s && seq[0]!.fwd === seq[seq.length - 1]!.fwd) seq.pop();
  // Remove segments walked both ways.
  const count = new Map<number, number>();
  for (const { s } of seq) count.set(s, (count.get(s) ?? 0) + 1);
  const loop = seq.filter(({ s }) => count.get(s) === 1).map(({ s }) => s);
  if (loop.length === 0) return null;
  return loopDirections(net.segments, loop) ? loop : null;
}

function loopPath(net: VectorNetwork, loop: readonly number[]): Path {
  const p = new Path();
  const cs = loopCubics(net, loop);
  if (!cs || cs.length === 0) return p;
  p.moveTo(cs[0]!.x0, cs[0]!.y0);
  for (const c of cs) {
    if (c.line) p.lineTo(c.x3, c.y3);
    else p.cubicTo(c.x1, c.y1, c.x2, c.y2, c.x3, c.y3);
  }
  return p.close();
}

/** The innermost face containing (x, y), if any. */
export function faceAt(net: VectorNetwork, x: number, y: number, faces: readonly NetworkFace[] = networkFaces(net)): NetworkFace | null {
  let best: NetworkFace | null = null;
  const tol = toleranceFor(net);
  for (const f of faces) {
    const path = new Path();
    for (const loop of f.loops) path.append(loopPath(net, loop));
    if (windingNumber(flattenPath(path, undefined, tol), x, y) === 0) continue;
    if (!best || f.area < best.area) best = f;
  }
  return best;
}

function sameLoops(a: readonly (readonly number[])[], b: readonly (readonly number[])[]): boolean {
  const key = (ls: readonly (readonly number[])[]): string => ls.map((l) => [...l].sort((p, q) => p - q).join(",")).sort().join("|");
  return key(a) === key(b);
}

/**
 * The fill tool: fills the face under (x, y) as a new region, or removes the
 * region when that face is already filled. Returns the network unchanged when
 * the point is in no face.
 */
export function toggleFaceFill<N extends VectorNetwork>(net: N, x: number, y: number, fillRule: FillRule = "nonzero"): N {
  const face = faceAt(net, x, y);
  if (!face) return net;
  const d = draftOf(net);
  const existing = d.regions.findIndex((r) => sameLoops(r.loops, face.loops));
  if (existing >= 0) d.regions.splice(existing, 1);
  else d.regions.push({ loops: face.loops, fillRule } as N["regions"][number]);
  return finish(net, d);
}

/** Replaces the regions with one region per face (every enclosed area filled), keeping the fills of regions whose loops are unchanged. */
export function fillAllFaces<N extends VectorNetwork>(net: N, fillRule: FillRule = "nonzero"): N {
  const d = draftOf(net);
  d.regions = networkFaces(net).map((f) => {
    const old = net.regions.find((r) => sameLoops(r.loops, f.loops));
    return (old ?? { loops: f.loops, fillRule }) as N["regions"][number];
  });
  return finish(net, d);
}

/**
 * Connects two vertices with a straight segment (or the given tangents) and,
 * when that closes a loop, fills the new face it bounds (the smallest bounded
 * face next to the new segment), as the pen tool does when a path is closed.
 */
export function closePath<N extends VectorNetwork>(
  net: N,
  from: number,
  to: number,
  tangents: { start?: { x: number; y: number }; end?: { x: number; y: number } } = {},
  fillRule: FillRule = "nonzero",
): { network: N; segment: number; region: number | null } {
  const { network, segment } = addSegment(net, from, to, tangents.start, tangents.end);
  const faces = networkFaces(network).filter((f) => f.loops.some((l) => l.includes(segment)));
  if (faces.length === 0) return { network, segment, region: null };
  faces.sort((a, b) => a.area - b.area);
  const face = faces[0]!;
  if (network.regions.some((r) => sameLoops(r.loops, face.loops))) return { network, segment, region: null };
  const d = draftOf(network);
  d.regions.push({ loops: face.loops, fillRule } as N["regions"][number]);
  return { network: finish(network, d), segment, region: d.regions.length - 1 };
}
