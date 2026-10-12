import { lineCubic, quadCubic, type Cubic } from "../bezier/cubic";
import type { FillRule } from "../flatten";
import { Path, Verb } from "../path";
import { ellipseArcPath, polygonPath, roundedRectPath, starPath, type CornerRadii } from "../shapes";
import { formatSvgPath, parseSvgPath, type SvgFormatOptions } from "../svg-path";
import { loopDirections, segmentCubic, segmentFromCubic, type NetworkRegion, type NetworkSegment, type NetworkVertex, type VectorNetwork } from "./network";

export interface PathToNetworkOptions {
  /** Fill rule of the region made of the path's closed contours. Default nonzero. */
  readonly fillRule?: FillRule;
  /**
   * Points closer than this become one vertex, also across contours (so a
   * path whose subpaths meet becomes a connected network). Default 0: only
   * exactly equal points merge. Negative: never merge across contours.
   */
  readonly mergeDistance?: number;
  /** Make a region from the closed contours (default true). */
  readonly fill?: boolean;
}

/**
 * Converts a path to a vector network: one vertex per distinct point, one
 * segment per drawing command (quadratics elevated exactly to cubics, a
 * closing line where a closed contour does not end at its start), and one
 * region holding every closed contour as a loop, with the given fill rule.
 * Zero-length segments are dropped.
 */
export function pathToNetwork(path: Path, options: PathToNetworkOptions = {}): VectorNetwork {
  const vertices: NetworkVertex[] = [];
  const segments: NetworkSegment[] = [];
  const loops: number[][] = [];
  const merge = options.mergeDistance ?? 0;
  const index = new Map<string, number[]>();
  const cell = merge > 0 ? merge * 2 : 1;
  const vertexAt = (x: number, y: number, contourStart: number): number => {
    if (merge >= 0) {
      const key = merge > 0 ? `${Math.floor(x / cell)},${Math.floor(y / cell)}` : `${x},${y}`;
      const candidates: number[] = [];
      if (merge > 0) {
        const kx = Math.floor(x / cell), ky = Math.floor(y / cell);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) candidates.push(...(index.get(`${kx + dx},${ky + dy}`) ?? []));
      } else candidates.push(...(index.get(key) ?? []));
      for (const v of candidates) {
        const p = vertices[v]!;
        if (Math.hypot(p.x - x, p.y - y) <= merge) return v;
      }
      vertices.push({ x, y });
      const list = index.get(key);
      if (list) list.push(vertices.length - 1);
      else index.set(key, [vertices.length - 1]);
      return vertices.length - 1;
    }
    // No merging across contours: only within this contour.
    for (let v = contourStart; v < vertices.length; v++) if (vertices[v]!.x === x && vertices[v]!.y === y) return v;
    vertices.push({ x, y });
    return vertices.length - 1;
  };

  let contourStart = 0;
  let startVertex = -1;
  let current = -1;
  let contourSegs: number[] = [];
  let cx = 0, cy = 0;
  const add = (c: Cubic): void => {
    const end = vertexAt(c.x3, c.y3, contourStart);
    if (end === current && (c.line || (c.x1 === c.x0 && c.y1 === c.y0 && c.x2 === c.x3 && c.y2 === c.y3))) return;
    // Snap the curve's endpoints onto the merged vertices.
    const a = vertices[current]!, b = vertices[end]!;
    const fixed: Cubic = { ...c, x0: a.x, y0: a.y, x3: b.x, y3: b.y, x1: c.x1 + a.x - c.x0, y1: c.y1 + a.y - c.y0, x2: c.x2 + b.x - c.x3, y2: c.y2 + b.y - c.y3 };
    segments.push(segmentFromCubic(current, end, c.line ? lineCubic(a.x, a.y, b.x, b.y) : fixed));
    contourSegs.push(segments.length - 1);
    current = end;
  };
  const coords = path.coords;
  let k = 0;
  for (const verb of path.verbs) {
    switch (verb as Verb) {
      case Verb.MoveTo:
        cx = coords[k]!;
        cy = coords[k + 1]!;
        k += 2;
        contourStart = vertices.length;
        current = startVertex = vertexAt(cx, cy, contourStart);
        contourSegs = [];
        break;
      case Verb.LineTo: {
        const x = coords[k]!, y = coords[k + 1]!;
        k += 2;
        add(lineCubic(cx, cy, x, y));
        cx = x;
        cy = y;
        break;
      }
      case Verb.QuadTo: {
        const c = quadCubic(cx, cy, coords[k]!, coords[k + 1]!, coords[k + 2]!, coords[k + 3]!);
        k += 4;
        add(c);
        cx = c.x3;
        cy = c.y3;
        break;
      }
      case Verb.CubicTo: {
        const c: Cubic = { x0: cx, y0: cy, x1: coords[k]!, y1: coords[k + 1]!, x2: coords[k + 2]!, y2: coords[k + 3]!, x3: coords[k + 4]!, y3: coords[k + 5]!, line: false };
        k += 6;
        add(c);
        cx = c.x3;
        cy = c.y3;
        break;
      }
      case Verb.Close: {
        if (current !== startVertex) {
          const a = vertices[current]!, b = vertices[startVertex]!;
          segments.push({ start: current, end: startVertex });
          void a;
          void b;
          contourSegs.push(segments.length - 1);
          current = startVertex;
        }
        if (contourSegs.length > 0 && loopDirections(segments, contourSegs)) loops.push(contourSegs);
        contourSegs = [];
        const s = vertices[startVertex]!;
        cx = s.x;
        cy = s.y;
        break;
      }
    }
  }
  const regions: NetworkRegion[] = options.fill === false || loops.length === 0 ? [] : [{ loops, fillRule: options.fillRule ?? "nonzero" }];
  return { vertices, segments, regions };
}

/**
 * The network as one path for stroking: chains of segments through vertices
 * of degree two become single contours (so they get joins, not caps), closed
 * chains are closed contours, and junctions of three or more segments end
 * chains. Segments are walked in index order, so a network made by
 * {@link pathToNetwork} comes back as the same commands.
 */
export function networkStrokePath(net: VectorNetwork): Path {
  const path = new Path();
  for (const chain of strokeChains(net)) appendChain(path, net, chain);
  return path;
}

export interface Chain {
  /** Segments in walking order, each with its direction. */
  readonly segments: readonly { readonly index: number; readonly forward: boolean }[];
  readonly closed: boolean;
}

/** The network's segments grouped into stroke chains (see {@link networkStrokePath}). */
export function strokeChains(net: VectorNetwork): Chain[] {
  const degree = new Map<number, number[]>();
  net.segments.forEach((s, i) => {
    for (const v of [s.start, s.end]) {
      let list = degree.get(v);
      if (!list) degree.set(v, (list = []));
      list.push(i);
    }
  });
  const used = new Uint8Array(net.segments.length);
  const chains: Chain[] = [];
  const walk = (startVertex: number, firstSeg: number): Chain => {
    const segs: { index: number; forward: boolean }[] = [];
    let v = startVertex;
    let seg = firstSeg;
    for (;;) {
      used[seg] = 1;
      const s = net.segments[seg]!;
      const forward = s.start === v;
      segs.push({ index: seg, forward });
      v = forward ? s.end : s.start;
      if (v === startVertex) return { segments: segs, closed: true };
      const next = degree.get(v)!;
      if (next.length !== 2) return { segments: segs, closed: false };
      const cont = next.find((x) => !used[x]);
      if (cont === undefined) return { segments: segs, closed: false };
      seg = cont;
    }
  };
  // Walk in segment order. A segment on a closed loop of degree-two vertices
  // starts its loop; otherwise its chain is first followed backwards to an
  // end or a junction, so open chains are drawn whole from one end.
  for (let i = 0; i < net.segments.length; i++) {
    if (used[i]) continue;
    const s = net.segments[i]!;
    if (pureCycle(net, degree, i)) {
      chains.push(walk(s.start, i));
      continue;
    }
    let v = s.start;
    let seg = i;
    for (let guard = 0; guard <= net.segments.length; guard++) {
      const list = degree.get(v)!;
      if (list.length !== 2 || list[0] === list[1]) break;
      const prev = list[0] === seg ? list[1]! : list[0]!;
      if (used[prev]) break;
      const ps = net.segments[prev]!;
      v = ps.end === v ? ps.start : ps.end;
      seg = prev;
    }
    chains.push(walk(v, seg));
  }
  return chains;
}

/** Whether the chain through segment `start` is a closed loop of degree-two vertices. */
function pureCycle(net: VectorNetwork, degree: Map<number, number[]>, start: number): boolean {
  const origin = net.segments[start]!.start;
  let v = net.segments[start]!.end;
  let seg = start;
  for (let guard = 0; guard <= net.segments.length; guard++) {
    const list = degree.get(v)!;
    if (list.length !== 2) return false;
    if (v === origin) return true;
    const next = list[0] === seg ? list[1]! : list[0]!;
    const s = net.segments[next]!;
    v = s.start === v ? s.end : s.start;
    seg = next;
  }
  return false;
}

function appendChain(path: Path, net: VectorNetwork, chain: Chain): void {
  const first = chain.segments[0]!;
  const fs = net.segments[first.index]!;
  const start = net.vertices[first.forward ? fs.start : fs.end]!;
  path.moveTo(start.x, start.y);
  for (const { index, forward } of chain.segments) appendCubic(path, segmentCubic(net, index, forward));
  if (chain.closed) path.close();
}

function appendCubic(path: Path, c: Cubic): void {
  if (c.line) path.lineTo(c.x3, c.y3);
  else path.cubicTo(c.x1, c.y1, c.x2, c.y2, c.x3, c.y3);
}

/** One path per region (all of its loops), to fill with the region's rule. */
export function regionPath(net: VectorNetwork, region: number): Path {
  const path = new Path();
  for (const loop of net.regions[region]!.loops) {
    const dirs = loopDirections(net.segments, loop);
    if (!dirs) continue;
    const s0 = net.segments[loop[0]!]!;
    const v = net.vertices[dirs[0] ? s0.start : s0.end]!;
    path.moveTo(v.x, v.y);
    loop.forEach((s, i) => appendCubic(path, segmentCubic(net, s, dirs[i]!)));
    path.close();
  }
  return path;
}

/** Path data of the whole network for SVG (segments as stroke chains). Parsing it back gives the same network when regions are ignored. */
export function networkToSvgPath(net: VectorNetwork, options: SvgFormatOptions = {}): string {
  return formatSvgPath(networkStrokePath(net), options);
}

/** Parses SVG path data into a network (see {@link pathToNetwork}). Throws on a syntax error unless `lenient`. */
export function svgPathToNetwork(d: string, options: PathToNetworkOptions & { readonly lenient?: boolean } = {}): VectorNetwork {
  const { path, error } = parseSvgPath(d);
  if (error && !options.lenient) throw new SyntaxError(`invalid path data: ${error}`);
  return pathToNetwork(path, options);
}

// ── Shapes to networks ("flatten") ────────────────────────────────────────

export function rectangleNetwork(width: number, height: number, radii: CornerRadii = 0, smoothing = 0): VectorNetwork {
  return pathToNetwork(roundedRectPath(0, 0, width, height, radii, smoothing));
}

export function ellipseNetwork(width: number, height: number, start = 0, sweep = Math.PI * 2, innerRatio = 0): VectorNetwork {
  return pathToNetwork(ellipseArcPath(0, 0, width, height, start, sweep, innerRatio), { mergeDistance: -1 });
}

export function polygonNetwork(width: number, height: number, sides: number, cornerRadius = 0): VectorNetwork {
  return pathToNetwork(polygonPath(0, 0, width, height, sides, cornerRadius));
}

export function starNetwork(width: number, height: number, points: number, innerRatio: number, cornerRadius = 0): VectorNetwork {
  return pathToNetwork(starPath(0, 0, width, height, points, innerRatio, cornerRadius));
}

/** A line along the x axis: two vertices, one segment, no region. */
export function lineNetwork(length: number): VectorNetwork {
  return { vertices: [{ x: 0, y: 0 }, { x: length, y: 0 }], segments: [{ start: 0, end: 1 }], regions: [] };
}
