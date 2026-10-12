import type { Box } from "./math";

/**
 * Smart guides: snapping a moving box (world space) to the edges and
 * centers of nearby boxes, to equal spacing between siblings, and to the
 * parent's edges, center and padding. Pure math; the tools pick the
 * targets and the threshold (a few screen pixels divided by the zoom).
 */

export interface SnapTarget {
  readonly box: Box;
  /** `sibling` boxes offer equal spacing; `parent` and `padding` offer only lines. */
  readonly kind: "sibling" | "parent" | "padding";
}

/** A guide line to draw: vertical (`axis: "x"` at `x = at`) or horizontal, spanning `from`–`to` on the other axis. */
export interface Guide {
  readonly axis: "x" | "y";
  readonly at: number;
  readonly from: number;
  readonly to: number;
}

/** An equal gap to mark: on `axis`, from `start` to `end`, drawn at `cross` on the other axis. */
export interface SpacingMark {
  readonly axis: "x" | "y";
  readonly start: number;
  readonly end: number;
  readonly cross: number;
}

export interface SnapResult {
  readonly dx: number;
  readonly dy: number;
  readonly guides: readonly Guide[];
  readonly spacing: readonly SpacingMark[];
}

export interface SnapOptions {
  /** Distance (world units) within which a value snaps. */
  readonly threshold: number;
  /** Edges of the moving box that move (resizing moves only some). Defaults to all (moving). */
  readonly edges?: { readonly x: readonly ("start" | "center" | "end")[]; readonly y: readonly ("start" | "center" | "end")[] };
  /** Look for equal spacing between siblings (moving only). Default true. */
  readonly spacing?: boolean;
}

const EPS = 1e-6;

type Side = "start" | "center" | "end";

function lines(b: Box, axis: "x" | "y"): Record<Side, number> {
  const start = axis === "x" ? b.x : b.y;
  const size = axis === "x" ? b.width : b.height;
  return { start, center: start + size / 2, end: start + size };
}

function span(b: Box, axis: "x" | "y"): [number, number] {
  return axis === "x" ? [b.x, b.x + b.width] : [b.y, b.y + b.height];
}

interface AxisSnap {
  delta: number;
  distance: number;
  spacing: SpacingMark[] | null;
}

/** Best line snap on one axis: the smallest correction that aligns a moving line with a target line. */
function snapLines(moving: Box, targets: readonly SnapTarget[], axis: "x" | "y", sides: readonly Side[], threshold: number): AxisSnap | null {
  const m = lines(moving, axis);
  let best: AxisSnap | null = null;
  for (const t of targets) {
    const tl = lines(t.box, axis);
    const values = t.kind === "padding" ? [tl.start, tl.end] : [tl.start, tl.center, tl.end];
    for (const side of sides) {
      for (const v of values) {
        const d = v - m[side];
        if (Math.abs(d) <= threshold && (!best || Math.abs(d) < best.distance - EPS)) best = { delta: d, distance: Math.abs(d), spacing: null };
      }
    }
  }
  return best;
}

/**
 * Equal spacing on one axis: places the moving box so that its gap to a
 * neighbor equals the gap between two other siblings, or centers it between
 * two neighbors. Only siblings that overlap the moving box on the other
 * axis count, as they are the ones visually in a row (or column).
 */
function snapSpacing(moving: Box, targets: readonly SnapTarget[], axis: "x" | "y", threshold: number): AxisSnap | null {
  const other = axis === "x" ? "y" : "x";
  const [ms, me] = span(moving, other);
  const row = targets
    .filter((t) => t.kind === "sibling")
    .map((t) => t.box)
    .filter((b) => {
      const [s, e] = span(b, other);
      return s < me && e > ms;
    })
    .sort((a, b) => span(a, axis)[0] - span(b, axis)[0]);
  const [m0, m1] = span(moving, axis);
  const size = m1 - m0;
  const mid = (m0 + m1) / 2;
  const cross = (b: Box): number => {
    const [s, e] = span(b, other);
    return (Math.max(s, ms) + Math.min(e, me)) / 2;
  };
  let best: AxisSnap | null = null;
  const consider = (start: number, marks: SpacingMark[]): void => {
    const d = start - m0;
    if (Math.abs(d) <= threshold && (!best || Math.abs(d) < best.distance - EPS)) best = { delta: d, distance: Math.abs(d), spacing: marks };
  };
  const before = row.filter((b) => span(b, axis)[1] <= mid);
  const after = row.filter((b) => span(b, axis)[0] >= mid);
  const nearestBefore = before.reduce<Box | null>((acc, b) => (!acc || span(b, axis)[1] > span(acc, axis)[1] ? b : acc), null);
  const nearestAfter = after.reduce<Box | null>((acc, b) => (!acc || span(b, axis)[0] < span(acc, axis)[0] ? b : acc), null);
  // Centered between the two nearest neighbors.
  if (nearestBefore && nearestAfter) {
    const l = span(nearestBefore, axis)[1];
    const r = span(nearestAfter, axis)[0];
    const gap = (r - l - size) / 2;
    if (gap >= 0) {
      const start = l + gap;
      consider(start, [
        { axis, start: l, end: start, cross: cross(nearestBefore) },
        { axis, start: start + size, end: r, cross: cross(nearestAfter) },
      ]);
    }
  }
  // Gaps between consecutive siblings (in a row, not overlapping each other).
  const gaps: { a: Box; b: Box; gap: number }[] = [];
  for (let i = 0; i + 1 < row.length; i++) {
    const a = row[i]!;
    const b = row[i + 1]!;
    const gap = span(b, axis)[0] - span(a, axis)[1];
    if (gap > 0) gaps.push({ a, b, gap });
  }
  for (const { a, b, gap } of gaps) {
    const mark = { axis, start: span(a, axis)[1], end: span(b, axis)[0], cross: (cross(a) + cross(b)) / 2 };
    // After the pair's last box (the nearest box before the moving one).
    if (nearestBefore && b === nearestBefore) consider(span(b, axis)[1] + gap, [mark, { axis, start: span(b, axis)[1], end: span(b, axis)[1] + gap, cross: cross(b) }]);
    // Before the pair's first box (the nearest box after the moving one).
    if (nearestAfter && a === nearestAfter) consider(span(a, axis)[0] - gap - size, [{ axis, start: span(a, axis)[0] - gap, end: span(a, axis)[0], cross: cross(a) }, mark]);
  }
  return best;
}

/**
 * Snaps a moving box. Returns the correction to add on each axis, the
 * guides (every target line the snapped box lines up with) and the equal
 * spacing marks.
 */
export function snapBox(moving: Box, targets: readonly SnapTarget[], options: SnapOptions): SnapResult {
  const sides = options.edges ?? { x: ["start", "center", "end"], y: ["start", "center", "end"] };
  const pick = (axis: "x" | "y"): AxisSnap | null => {
    const s = sides[axis];
    if (s.length === 0) return null;
    const line = snapLines(moving, targets, axis, s, options.threshold);
    const spacing = options.spacing !== false && s.length === 3 ? snapSpacing(moving, targets, axis, options.threshold) : null;
    if (line && spacing) return spacing.distance < line.distance - EPS ? spacing : line;
    return line ?? spacing;
  };
  const sx = pick("x");
  const sy = pick("y");
  const dx = sx?.delta ?? 0;
  const dy = sy?.delta ?? 0;
  const snapped: Box = { x: moving.x + dx, y: moving.y + dy, width: moving.width, height: moving.height };
  return {
    dx,
    dy,
    guides: [...(sx ? guidesFor(snapped, targets, "x", sides.x) : []), ...(sy ? guidesFor(snapped, targets, "y", sides.y) : [])],
    spacing: [...(sx?.spacing ?? []), ...(sy?.spacing ?? [])],
  };
}

/** Guide lines through every target line that a (snapped) moving line now coincides with. */
export function guidesFor(moving: Box, targets: readonly SnapTarget[], axis: "x" | "y", sides: readonly Side[]): Guide[] {
  const other = axis === "x" ? "y" : "x";
  const m = lines(moving, axis);
  const [ms, me] = span(moving, other);
  const out = new Map<number, Guide>();
  for (const t of targets) {
    const tl = lines(t.box, axis);
    const values = t.kind === "padding" ? [tl.start, tl.end] : [tl.start, tl.center, tl.end];
    const [ts, te] = span(t.box, other);
    for (const side of sides) {
      for (const v of values) {
        if (Math.abs(v - m[side]) > 1e-6) continue;
        const key = Math.round(v * 1000) / 1000;
        const g = out.get(key);
        const from = Math.min(ms, ts, g?.from ?? Infinity);
        const to = Math.max(me, te, g?.to ?? -Infinity);
        out.set(key, { axis, at: v, from, to });
      }
    }
  }
  return [...out.values()];
}

/** Rounds a coordinate to the pixel grid. */
export function snapToPixel(v: number): number {
  return Math.round(v);
}

/**
 * Snaps a single coordinate (a dragged edge or a pointer) to the nearest
 * target line on an axis within `threshold`; returns the value unchanged
 * when nothing is close.
 */
export function snapValue(value: number, targets: readonly SnapTarget[], axis: "x" | "y", threshold: number): number {
  let best = value;
  let bestD = threshold + EPS;
  for (const t of targets) {
    const tl = lines(t.box, axis);
    const values = t.kind === "padding" ? [tl.start, tl.end] : [tl.start, tl.center, tl.end];
    for (const v of values) {
      const d = Math.abs(v - value);
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    }
  }
  return best;
}
