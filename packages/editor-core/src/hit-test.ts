import { containsPoint, type Mat2D, type Point, type Polylines } from "@fig-tree/geometry";
import type { CanvasGeometry } from "./geometry";
import { boxContainsPoint, distanceToSegment, invert, multiply, quad, quadContains, transformPoint, transformedBox } from "./math";

/** Nodes hit by their box rather than their painted geometry. */
const BOX_HIT = new Set(["frame", "component", "instance", "text", "image"]);
const CONTAINERS = new Set(["frame", "component", "instance"]);

export interface PickOptions {
  /** Extra reach, in world units, for strokes and lines (a few screen pixels / zoom). */
  readonly tolerance: number;
  /** Ids to ignore (with their subtrees), for example nodes being dragged. */
  readonly skip?: ReadonlySet<string>;
  /** Also hit locked nodes (layers panel and context menus may want them). */
  readonly includeLocked?: boolean;
}

/**
 * The stack of nodes under a world point, from the top-level node down to
 * the deepest hit, or null. Hidden and locked nodes (and their subtrees) are
 * transparent to clicks; a container that clips only hits children inside
 * its box. Frames, text and images are hit anywhere in their box; shapes
 * by their filled area and their strokes (with `tolerance`), like the
 * pixels show them.
 */
export function pickPath(geom: CanvasGeometry, p: Point, options: PickOptions): string[] | null {
  return pickIn(geom, geom.page, [1, 0, 0, 1, 0, 0], p, options);
}

function pickIn(geom: CanvasGeometry, parent: string, space: Mat2D, p: Point, options: PickOptions): string[] | null {
  const doc = geom.doc;
  const kids = doc.tree.childrenOf(parent);
  for (let i = kids.length - 1; i >= 0; i--) {
    const id = kids[i]!;
    if (options.skip?.has(id)) continue;
    if (!doc.get<boolean>(id, "visible")) continue;
    if (!options.includeLocked && doc.get<boolean>(id, "locked")) continue;
    const type = doc.typeOf(id)!;
    if (type === "group") {
      const hit = pickIn(geom, id, space, p, options);
      if (hit) return [id, ...hit];
      continue;
    }
    const m = multiply(space, geom.localMatrix(id));
    const { width, height } = geom.size(id);
    if (CONTAINERS.has(type)) {
      const clips = doc.get<string>(id, "overflowX") !== "visible" || doc.get<string>(id, "overflowY") !== "visible";
      if (!clips || quadContains(quad(m, width, height), p)) {
        const hit = pickIn(geom, id, m, p, options);
        if (hit) return [id, ...hit];
      }
    }
    if (hitsNode(geom, id, type, m, width, height, p, options.tolerance)) return [id];
  }
  return null;
}

/** Whether a single node (not its children) is under a world point, given its world matrix and size. */
export function hitsNode(geom: CanvasGeometry, id: string, type: string, m: Mat2D, width: number, height: number, p: Point, tolerance: number): boolean {
  if (BOX_HIT.has(type)) return quadContains(quad(m, width, height), p);
  const weight = geom.doc.get<unknown>(id, "strokeWeight");
  const reach = tolerance + (typeof weight === "number" ? weight : 0);
  // Cheap reject on the inflated bounds.
  const b = transformedBox(m, width, height);
  if (!boxContainsPoint({ x: b.x - reach, y: b.y - reach, width: b.width + 2 * reach, height: b.height + 2 * reach }, p)) return false;
  const inv = invert(m);
  if (!inv) return false;
  // Rotations and flips keep lengths, so the tolerance holds in local units too.
  const local = transformPoint(inv, p.x, p.y);
  if (type === "line") {
    const half = Math.max((typeof weight === "number" ? weight : 1) / 2, tolerance);
    return distanceToSegment(local, { x: 0, y: 0 }, { x: width, y: 0 }) <= half;
  }
  // Paint scene nodes (fills, strokes, regions) share the main node's local space.
  let painted = false;
  for (const n of geom.ownSceneNodes(id)) {
    const path = n.path;
    if (!path || n.glyphs) continue;
    if (n.fill) {
      painted = true;
      if (containsPoint(geom.polylines(path), local.x, local.y, n.fillRule)) return true;
    }
    if (n.stroke) {
      painted = true;
      if (distanceToPolylines(geom.polylines(path), local) <= Math.max(n.stroke.width / 2, tolerance)) return true;
    }
  }
  if (!painted) {
    // Unpainted shapes are hit inside their outline, so they stay selectable on the canvas.
    const path = geom.bridge.sceneNodeFor(id)?.path;
    if (path) {
      const lines = geom.polylines(path);
      return containsPoint(lines, local.x, local.y, "nonzero") || distanceToPolylines(lines, local) <= tolerance;
    }
  }
  return false;
}

/** Shortest distance from a point to the segments of flattened polylines. */
export function distanceToPolylines(lines: Polylines, p: Point): number {
  let best = Infinity;
  const pts = lines.points;
  const at = (i: number): Point => ({ x: pts[i * 2]!, y: pts[i * 2 + 1]! });
  for (let c = 0; c + 1 < lines.contourStarts.length; c++) {
    const start = lines.contourStarts[c]!;
    const end = lines.contourStarts[c + 1]!;
    for (let i = start; i + 1 < end; i++) best = Math.min(best, distanceToSegment(p, at(i), at(i + 1)));
    if (lines.closed[c] && end - start > 1) best = Math.min(best, distanceToSegment(p, at(end - 1), at(start)));
  }
  return best;
}
