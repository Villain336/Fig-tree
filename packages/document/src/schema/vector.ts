import { z } from "zod";
import { PaintStack, StrokeCap } from "./paint";
import { Num, NonNegative, Point } from "./primitives";

/**
 * A vector network: vertices joined by Bézier segments, where any number of
 * segments may meet at a vertex (not just two, as in a path). Closed loops
 * of segments form regions that are filled with their own fill rule.
 * Coordinates are in the node's local space, relative to its box origin.
 */

export const Vertex = z.strictObject({
  x: Num,
  y: Num,
  /** Rounds the corner at this vertex, in px. */
  cornerRadius: NonNegative.optional(),
  /** Cap drawn when a stroke ends at this vertex. Defaults to the node's `strokeCap`. */
  strokeCap: StrokeCap.optional(),
  /** How the two handles at this vertex move together in vector editing (absent: independent). */
  handleMirroring: z.enum(["none", "angle", "angle-length"]).optional(),
});

/**
 * A cubic segment from `start` to `end` (vertex indices). Tangents are
 * control-point offsets relative to their vertex; zero tangents make a line.
 */
export const Segment = z.strictObject({
  start: z.number().int().min(0),
  end: z.number().int().min(0),
  tangentStart: Point.optional(),
  tangentEnd: Point.optional(),
});

/** A filled area: one or more closed loops, each a list of segment indices walked end to end. */
export const Region = z.strictObject({
  loops: z.array(z.array(z.number().int().min(0)).min(1)).min(1),
  fillRule: z.enum(["nonzero", "evenodd"]),
  /** Region-specific fills; the node's `fills` apply when absent. */
  fills: PaintStack.optional(),
});

export const VectorNetwork = z
  .strictObject({
    vertices: z.array(Vertex).max(100_000),
    segments: z.array(Segment).max(100_000),
    regions: z.array(Region).max(10_000),
  })
  .superRefine((net, ctx) => {
    const nv = net.vertices.length;
    net.segments.forEach((s, i) => {
      for (const key of ["start", "end"] as const) {
        if (s[key] >= nv) ctx.addIssue({ code: "custom", path: ["segments", i, key], message: `vertex ${s[key]} does not exist (${nv} vertices)` });
      }
    });
    net.regions.forEach((region, r) => {
      region.loops.forEach((loop, l) => {
        const path = ["regions", r, "loops", l];
        const bad = loop.find((s) => s >= net.segments.length);
        if (bad !== undefined) {
          ctx.addIssue({ code: "custom", path, message: `segment ${bad} does not exist (${net.segments.length} segments)` });
          return;
        }
        if (!loopIsClosed(net.segments, loop)) ctx.addIssue({ code: "custom", path, message: "loop segments must connect end to end and close" });
      });
    });
  })
  .meta({ id: "VectorNetwork" });
export type VectorNetwork = z.infer<typeof VectorNetwork>;
export type VectorSegment = z.infer<typeof Segment>;

/**
 * Orders a loop's vertices: returns, for each segment of the loop, whether it
 * is walked forwards, or null when the segments do not form a closed chain.
 */
export function loopDirections(segments: readonly { start: number; end: number }[], loop: readonly number[]): boolean[] | null {
  const first = segments[loop[0]!];
  if (!first) return null;
  if (loop.length === 1) return first.start === first.end ? [true] : null;
  // Pick the first segment's direction so that it connects to the second.
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

function loopIsClosed(segments: readonly { start: number; end: number }[], loop: readonly number[]): boolean {
  return loopDirections(segments, loop) !== null;
}
