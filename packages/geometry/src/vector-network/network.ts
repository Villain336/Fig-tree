import { cubicBounds, lineCubic, type Cubic } from "../bezier/cubic";
import type { FillRule } from "../flatten";
import { emptyRect, unionRect, type Rect } from "../rect";

/**
 * Vector networks: vertices joined by cubic segments, where any number of
 * segments may meet at a vertex, and regions (filled areas) made of closed
 * loops of segments, each region with its own fill rule.
 *
 * These types mirror the document's `VectorNetwork` schema structurally, so a
 * stored network can be passed in directly and every operation returns the
 * same type it was given (unknown extra fields on vertices and regions, like a
 * region's fills, are carried along untouched). Networks are immutable:
 * operations return new networks and share unchanged vertices, segments and
 * regions with their input.
 */

export interface Vec {
  readonly x: number;
  readonly y: number;
}

/** How a vertex's two handles move together when one is dragged. */
export type HandleMirroring = "none" | "angle" | "angle-length";

export interface NetworkVertex {
  readonly x: number;
  readonly y: number;
  readonly cornerRadius?: number | undefined;
  readonly strokeCap?: "butt" | "round" | "square" | undefined;
  readonly handleMirroring?: HandleMirroring | undefined;
}

/** A cubic from vertex `start` to vertex `end`; tangents are control points relative to their vertex (absent or zero: straight). */
export interface NetworkSegment {
  readonly start: number;
  readonly end: number;
  readonly tangentStart?: Vec | undefined;
  readonly tangentEnd?: Vec | undefined;
}

export interface NetworkRegion {
  /** Closed loops of segment indices, each walked end to end. */
  readonly loops: readonly (readonly number[])[];
  readonly fillRule: FillRule;
}

export interface VectorNetwork {
  readonly vertices: readonly NetworkVertex[];
  readonly segments: readonly NetworkSegment[];
  readonly regions: readonly NetworkRegion[];
}

/** Mutable working copy used inside operations. */
export interface Draft<N extends VectorNetwork> {
  vertices: N["vertices"][number][];
  segments: N["segments"][number][];
  regions: N["regions"][number][];
}

export function draftOf<N extends VectorNetwork>(net: N): Draft<N> {
  return { vertices: [...net.vertices], segments: [...net.segments], regions: [...net.regions] };
}

export function finish<N extends VectorNetwork>(net: N, d: Draft<N>): N {
  return { ...net, vertices: d.vertices, segments: d.segments, regions: d.regions } as N;
}

export const EMPTY_NETWORK: VectorNetwork = { vertices: [], segments: [], regions: [] };

function isZero(v: Vec | undefined): boolean {
  return !v || (v.x === 0 && v.y === 0);
}

export function isStraightSegment(s: NetworkSegment): boolean {
  return isZero(s.tangentStart) && isZero(s.tangentEnd);
}

/** The segment's geometry, walked from start to end (or reversed). */
export function segmentCubic(net: VectorNetwork, index: number, forward = true): Cubic {
  const s = net.segments[index]!;
  const a = net.vertices[s.start]!;
  const b = net.vertices[s.end]!;
  if (isStraightSegment(s)) return forward ? lineCubic(a.x, a.y, b.x, b.y) : lineCubic(b.x, b.y, a.x, a.y);
  const ts = s.tangentStart ?? { x: 0, y: 0 };
  const te = s.tangentEnd ?? { x: 0, y: 0 };
  const c: Cubic = { x0: a.x, y0: a.y, x1: a.x + ts.x, y1: a.y + ts.y, x2: b.x + te.x, y2: b.y + te.y, x3: b.x, y3: b.y, line: false };
  return forward ? c : { x0: c.x3, y0: c.y3, x1: c.x2, y1: c.y2, x2: c.x1, y2: c.y1, x3: c.x0, y3: c.y0, line: false };
}

/** A segment whose geometry is `c` between the given vertices (which must sit at c's endpoints). */
export function segmentFromCubic(start: number, end: number, c: Cubic): NetworkSegment {
  if (c.line) return { start, end };
  return {
    start,
    end,
    tangentStart: { x: c.x1 - c.x0, y: c.y1 - c.y0 },
    tangentEnd: { x: c.x2 - c.x3, y: c.y2 - c.y3 },
  };
}

/** Segments incident to each vertex. A self-loop appears twice. */
export function incidence(net: VectorNetwork): number[][] {
  const out: number[][] = net.vertices.map(() => []);
  net.segments.forEach((s, i) => {
    out[s.start]?.push(i);
    out[s.end]?.push(i);
  });
  return out;
}

export function networkBounds(net: VectorNetwork): Rect {
  let r = emptyRect();
  for (const v of net.vertices) r = unionRect(r, { minX: v.x, minY: v.y, maxX: v.x, maxY: v.y });
  net.segments.forEach((_, i) => {
    r = unionRect(r, cubicBounds(segmentCubic(net, i)));
  });
  return r;
}

/**
 * For each segment of a loop, whether it is walked forwards; null when the
 * segments do not form a closed chain. (Same rule as the document schema.)
 */
export function loopDirections(segments: readonly { start: number; end: number }[], loop: readonly number[]): boolean[] | null {
  const first = segments[loop[0]!];
  if (!first) return null;
  if (loop.length === 1) return first.start === first.end ? [true] : null;
  const second = segments[loop[1]!];
  if (!second) return null;
  const forward = first.end === second.start || first.end === second.end;
  const dirs = [forward];
  let at = forward ? first.end : first.start;
  const origin = forward ? first.start : first.end;
  for (let i = 1; i < loop.length; i++) {
    const s = segments[loop[i]!];
    if (!s) return null;
    if (s.start === at) {
      dirs.push(true);
      at = s.end;
    } else if (s.end === at) {
      dirs.push(false);
      at = s.start;
    } else {
      return null;
    }
  }
  return at === origin ? dirs : null;
}

/** The curves of a loop in walking order. */
export function loopCubics(net: VectorNetwork, loop: readonly number[]): Cubic[] | null {
  const dirs = loopDirections(net.segments, loop);
  if (!dirs) return null;
  return loop.map((s, i) => segmentCubic(net, s, dirs[i]!));
}

/**
 * Checks a network's invariants and returns every violation (empty when
 * valid): finite coordinates, segments referencing existing vertices, no
 * zero-length straight self-loops, region loops that close, reference
 * existing segments and do not repeat a segment within a region.
 */
export function validateNetwork(net: VectorNetwork): string[] {
  const issues: string[] = [];
  const nv = net.vertices.length;
  const finite = (v: Vec | undefined): boolean => !v || (Number.isFinite(v.x) && Number.isFinite(v.y));
  net.vertices.forEach((v, i) => {
    if (!finite(v)) issues.push(`vertex ${i} is not finite`);
    if (v.cornerRadius !== undefined && !(v.cornerRadius >= 0)) issues.push(`vertex ${i} has a negative corner radius`);
  });
  net.segments.forEach((s, i) => {
    if (!Number.isInteger(s.start) || s.start < 0 || s.start >= nv) issues.push(`segment ${i} starts at missing vertex ${s.start}`);
    if (!Number.isInteger(s.end) || s.end < 0 || s.end >= nv) issues.push(`segment ${i} ends at missing vertex ${s.end}`);
    if (!finite(s.tangentStart) || !finite(s.tangentEnd)) issues.push(`segment ${i} has non-finite tangents`);
    if (s.start === s.end && isStraightSegment(s)) issues.push(`segment ${i} is a zero-length loop`);
  });
  net.regions.forEach((r, ri) => {
    if (r.loops.length === 0) issues.push(`region ${ri} has no loops`);
    const used = new Set<number>();
    r.loops.forEach((loop, li) => {
      if (loop.length === 0) issues.push(`region ${ri} loop ${li} is empty`);
      for (const s of loop) {
        if (!Number.isInteger(s) || s < 0 || s >= net.segments.length) issues.push(`region ${ri} loop ${li} references missing segment ${s}`);
        if (used.has(s)) issues.push(`region ${ri} uses segment ${s} twice`);
        used.add(s);
      }
      if (loop.every((s) => s >= 0 && s < net.segments.length) && !loopDirections(net.segments, loop)) issues.push(`region ${ri} loop ${li} does not close`);
    });
  });
  return issues;
}

/**
 * Remaps segment indices in regions after segments were removed or
 * reordered. `map` returns the new index, or a list of indices when a segment
 * was split (in its start-to-end order), or null when it is gone. A region
 * that loses a segment from any of its loops is removed: its boundary is
 * broken, and keeping its other loops would fill holes.
 */
export function remapRegions<R extends NetworkRegion>(
  regions: readonly R[],
  map: (segment: number) => number | readonly number[] | null,
  segments?: readonly { start: number; end: number }[],
  oldSegments?: readonly { start: number; end: number }[],
): R[] {
  const out: R[] = [];
  for (const r of regions) {
    const loops: number[][] = [];
    let ok = true;
    for (const loop of r.loops) {
      const dirs = oldSegments ? loopDirections(oldSegments, loop) : null;
      const mapped: number[] = [];
      loop.forEach((s, i) => {
        const m = map(s);
        if (m === null) ok = false;
        else if (typeof m === "number") mapped.push(m);
        else mapped.push(...(dirs && dirs[i] === false ? [...m].reverse() : m));
      });
      if (!ok) break;
      if (segments && !loopDirections(segments, mapped)) {
        ok = false;
        break;
      }
      loops.push(mapped);
    }
    if (ok && loops.length > 0) out.push({ ...r, loops });
  }
  return out;
}
