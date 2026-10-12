import type { Point } from "@fig-tree/geometry";
import type { Editor } from "../editor";
import type { Guide, SnapTarget } from "../snapping";

/**
 * Snapping for points (pen clicks, dragged vertices), in world space:
 *
 * 1. onto another vertex of the network (both axes) within the threshold;
 * 2. per axis, onto the x or y of another vertex, or a target line of the
 *    nearby layers (edges and centers, as smart guides offer for boxes);
 * 3. otherwise onto the pixel grid, when pixel snapping is on.
 *
 * Returns the snapped point and the guide lines to draw.
 */
export interface PointSnapContext {
  /** Other vertices (world), excluding the ones being moved. */
  readonly points: readonly Point[];
  /** Lines of nearby layers (see `snapTargets`). */
  readonly targets: readonly SnapTarget[];
}

export interface PointSnap {
  readonly point: Point;
  readonly guides: readonly Guide[];
  /** The vertex snapped onto, if any (index into `points`). */
  readonly vertex: number | null;
}

export function snapPoint(editor: Editor, p: Point, ctx: PointSnapContext, options: { readonly snapping?: boolean } = {}): PointSnap {
  const threshold = editor.snapThreshold;
  const snapping = options.snapping ?? editor.settings.snapping;
  if (snapping) {
    let best = -1;
    let bestD = threshold;
    ctx.points.forEach((q, i) => {
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d <= bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best >= 0) return { point: { ...ctx.points[best]! }, guides: [], vertex: best };
  }
  const guides: Guide[] = [];
  const axis = (a: "x" | "y"): number | null => {
    if (!snapping) return null;
    const v = p[a];
    let found: number | null = null;
    let bestD = threshold;
    const consider = (c: number): void => {
      const d = Math.abs(c - v);
      if (d <= bestD) {
        bestD = d;
        found = c;
      }
    };
    for (const q of ctx.points) consider(q[a]);
    for (const t of ctx.targets) {
      const start = a === "x" ? t.box.x : t.box.y;
      const size = a === "x" ? t.box.width : t.box.height;
      consider(start);
      if (t.kind !== "padding") consider(start + size / 2);
      consider(start + size);
    }
    return found;
  };
  const sx = axis("x");
  const sy = axis("y");
  let x = sx ?? p.x;
  let y = sy ?? p.y;
  if (sx === null && editor.settings.pixelSnap) x = Math.round(x);
  if (sy === null && editor.settings.pixelSnap) y = Math.round(y);
  // Guides run from the snapped point to the farthest point sharing the line.
  if (sx !== null) guides.push(guideThrough("x", sx, y, ctx));
  if (sy !== null) guides.push(guideThrough("y", sy, x, ctx));
  return { point: { x, y }, guides, vertex: null };
}

function guideThrough(axis: "x" | "y", at: number, cross: number, ctx: PointSnapContext): Guide {
  const other = axis === "x" ? "y" : "x";
  let from = cross;
  let to = cross;
  const eps = 1e-6;
  for (const q of ctx.points) {
    if (Math.abs(q[axis] - at) > eps) continue;
    from = Math.min(from, q[other]);
    to = Math.max(to, q[other]);
  }
  for (const t of ctx.targets) {
    const start = axis === "x" ? t.box.x : t.box.y;
    const size = axis === "x" ? t.box.width : t.box.height;
    if (![start, start + size / 2, start + size].some((v) => Math.abs(v - at) <= eps)) continue;
    const s0 = other === "x" ? t.box.x : t.box.y;
    const s1 = s0 + (other === "x" ? t.box.width : t.box.height);
    from = Math.min(from, s0);
    to = Math.max(to, s1);
  }
  return { axis, at, from, to };
}
