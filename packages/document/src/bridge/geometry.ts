import { Path, ellipseArcPath, polygonPath, roundedRectPath, starPath, type CornerRadii } from "@fig-tree/geometry";
import type { FigDocument } from "../document";
import { loopDirections, type CornerRadius, type NodeType, type Point, type VectorNetwork } from "../schema";

const DEG = Math.PI / 180;

export function cornerRadii(r: CornerRadius): CornerRadii {
  return typeof r === "number" ? r : [r.topLeft, r.topRight, r.bottomRight, r.bottomLeft];
}

/** Properties that determine a node's outline, as a cache key. */
export function geometryKey(doc: FigDocument, id: string, type: NodeType): string {
  const g = (k: string): unknown => doc.get(id, k);
  switch (type) {
    case "frame":
    case "component":
    case "instance":
    case "rectangle":
    case "image":
      return JSON.stringify([type, g("width"), g("height"), g("cornerRadius"), g("cornerSmoothing")]);
    case "ellipse":
      return JSON.stringify([type, g("width"), g("height"), g("arcStart"), g("arcSweep"), g("innerRadius")]);
    case "polygon":
      return JSON.stringify([type, g("width"), g("height"), g("pointCount"), g("cornerRadius")]);
    case "star":
      return JSON.stringify([type, g("width"), g("height"), g("pointCount"), g("innerRadius"), g("cornerRadius")]);
    case "line":
      return JSON.stringify([type, g("width")]);
    case "vector":
      return JSON.stringify([type, g("vectorNetwork")]);
    default:
      return type;
  }
}

/** The outline of a node in its local space (null for nodes without one: pages, groups, text). */
export function outlinePath(doc: FigDocument, id: string, type: NodeType): Path | null {
  const n = (k: string): number => doc.get<number>(id, k);
  const w = n("width");
  const h = n("height");
  switch (type) {
    case "frame":
    case "component":
    case "instance":
    case "rectangle":
    case "image":
      return roundedRectPath(0, 0, w, h, cornerRadii(doc.get<CornerRadius>(id, "cornerRadius")), n("cornerSmoothing"));
    case "ellipse":
      return ellipseArcPath(0, 0, w, h, n("arcStart") * DEG, n("arcSweep") * DEG, n("innerRadius"));
    case "polygon":
      return polygonPath(0, 0, w, h, n("pointCount"), n("cornerRadius"));
    case "star":
      return starPath(0, 0, w, h, n("pointCount"), n("innerRadius"), n("cornerRadius"));
    case "line":
      return new Path().moveTo(0, 0).lineTo(w, 0);
    default:
      return null;
  }
}

function appendSegment(path: Path, net: VectorNetwork, index: number, forward: boolean): void {
  const s = net.segments[index]!;
  const a = net.vertices[forward ? s.start : s.end]!;
  const b = net.vertices[forward ? s.end : s.start]!;
  const ta: Point | undefined = forward ? s.tangentStart : s.tangentEnd;
  const tb: Point | undefined = forward ? s.tangentEnd : s.tangentStart;
  const straight = (!ta || (ta.x === 0 && ta.y === 0)) && (!tb || (tb.x === 0 && tb.y === 0));
  if (straight) path.lineTo(b.x, b.y);
  else path.cubicTo(a.x + (ta?.x ?? 0), a.y + (ta?.y ?? 0), b.x + (tb?.x ?? 0), b.y + (tb?.y ?? 0), b.x, b.y);
}

/** One closed path per region (all of its loops), for filling with the region's rule. */
export function regionPaths(net: VectorNetwork): Path[] {
  return net.regions.map((region) => {
    const path = new Path();
    for (const loop of region.loops) {
      const dirs = loopDirections(net.segments, loop);
      if (!dirs) continue;
      const first = net.segments[loop[0]!]!;
      const start = net.vertices[dirs[0] ? first.start : first.end]!;
      path.moveTo(start.x, start.y);
      loop.forEach((seg, i) => appendSegment(path, net, seg, dirs[i]!));
      path.close();
    }
    return path;
  });
}

/**
 * All segments as stroke contours. Chains of segments through vertices of
 * degree two become single contours (so they get joins, not caps); closed
 * chains are closed contours. Junctions of three or more segments end chains.
 */
export function strokeOutline(net: VectorNetwork): Path {
  const path = new Path();
  const degree = new Map<number, number[]>();
  net.segments.forEach((s, i) => {
    for (const v of [s.start, s.end]) {
      let list = degree.get(v);
      if (!list) degree.set(v, (list = []));
      list.push(i);
    }
  });
  const used = new Set<number>();
  const walk = (startVertex: number, firstSeg: number): void => {
    let v = startVertex;
    let seg = firstSeg;
    const origin = net.vertices[v]!;
    path.moveTo(origin.x, origin.y);
    for (;;) {
      used.add(seg);
      const s = net.segments[seg]!;
      const forward = s.start === v;
      appendSegment(path, net, seg, forward);
      v = forward ? s.end : s.start;
      const next = degree.get(v)!;
      if (v === startVertex && next.length === 2) {
        path.close();
        return;
      }
      if (next.length !== 2) return;
      const cont = next.find((x) => !used.has(x));
      if (cont === undefined) return;
      seg = cont;
    }
  };
  // Open chains start at endpoints and junctions…
  for (const [v, segs] of degree) {
    if (segs.length === 2) continue;
    for (const seg of segs) if (!used.has(seg)) walk(v, seg);
  }
  // …and what is left are closed loops through degree-two vertices.
  net.segments.forEach((s, i) => {
    if (!used.has(i)) walk(s.start, i);
  });
  return path;
}
