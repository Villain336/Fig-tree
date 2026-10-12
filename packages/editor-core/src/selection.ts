import type { FigDocument } from "@fig-tree/document";
import type { CanvasGeometry } from "./geometry";
import { boxContainsBox, boxesIntersect, type Box } from "./math";

const FRAMES = new Set(["frame", "component", "instance"]);
const CONTAINERS = new Set(["frame", "component", "instance", "group"]);

export function isContainer(doc: FigDocument, id: string): boolean {
  const t = doc.typeOf(id);
  return t !== undefined && CONTAINERS.has(t);
}

/**
 * Top-level frames act as boards: clicking inside one selects its children
 * directly, its own background does not select it (that starts a marquee
 * instead), and it is picked by its name label or when it has no children.
 */
export function isBoard(doc: FigDocument, id: string): boolean {
  const t = doc.typeOf(id);
  return t !== undefined && FRAMES.has(t) && doc.typeOf(doc.tree.parentOf(id) ?? "") === "page";
}

/** Strict ancestors of the selected nodes: the containers the user has "entered". */
export function enteredContainers(doc: FigDocument, selection: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const id of selection) {
    for (let p = doc.tree.parentOf(id); p !== undefined && doc.typeOf(p) !== "page" && p !== "root"; p = doc.tree.parentOf(p)) out.add(p);
  }
  return out;
}

/**
 * Which node a click selects, given the stack of nodes under the pointer
 * (top-level first) and the current selection.
 *
 * - `deep` (Cmd/Ctrl held) selects the deepest node.
 * - Otherwise the click goes down through boards and through the containers
 *   the selection is inside (so siblings of selected nodes are picked
 *   directly) and stops at the first other node: clicking a child of an
 *   unselected group selects the group.
 * - A board's own background is not a target unless the board is selected
 *   or empty.
 */
export function clickTarget(doc: FigDocument, path: readonly string[], selection: readonly string[], deep: boolean): string | null {
  if (path.length === 0) return null;
  const entered = enteredContainers(doc, selection);
  let i = 0;
  if (deep) i = path.length - 1;
  else while (i + 1 < path.length && (isBoard(doc, path[i]!) || entered.has(path[i]!))) i++;
  const target = path[i]!;
  if (i === path.length - 1 && isBoard(doc, target) && doc.tree.childrenOf(target).length > 0 && !selection.includes(target)) return null;
  return target;
}

/**
 * Double-click "select through": the next level down along the hit stack
 * from the node that a single click would select. Returns null when there
 * is nothing deeper (the caller may then enter an edit mode).
 */
export function selectThroughTarget(doc: FigDocument, path: readonly string[], selection: readonly string[]): string | null {
  const target = clickTarget(doc, path, selection, false) ?? (path[0] && isBoard(doc, path[0]) ? path[0] : null);
  if (!target) return null;
  const i = path.indexOf(target);
  if (i < 0 || i + 1 >= path.length) return null;
  return path[i + 1]!;
}

export interface MarqueeOptions {
  /** Select the deepest nodes the marquee touches (Cmd/Ctrl held). */
  readonly deep: boolean;
}

/**
 * Nodes selected by a marquee rectangle (world space). Starting from the
 * page's top-level nodes: a board fully inside the marquee is selected;
 * a board the marquee only crosses contributes its children instead (the
 * same rule applied one level down); any other node is selected when the
 * marquee intersects it. With `deep`, containers are always looked into and
 * the deepest intersecting nodes are selected. Hidden and locked nodes are
 * skipped.
 */
export function marqueeSelect(geom: CanvasGeometry, rect: Box, options: MarqueeOptions): string[] {
  const doc = geom.doc;
  const out: string[] = [];
  const visit = (parent: string): void => {
    for (const id of doc.tree.childrenOf(parent)) {
      if (!doc.get<boolean>(id, "visible") || doc.get<boolean>(id, "locked")) continue;
      const b = geom.bounds(id);
      if (!boxesIntersect(rect, b)) continue;
      const hasKids = isContainer(doc, id) && doc.tree.childrenOf(id).length > 0;
      if (options.deep && hasKids) {
        const before = out.length;
        visit(id);
        if (out.length === before && doc.typeOf(id) !== "group") out.push(id);
        continue;
      }
      if (isBoard(doc, id) && hasKids && !boxContainsBox(rect, b)) {
        visit(id);
        continue;
      }
      out.push(id);
    }
  };
  visit(geom.page);
  return out;
}

/** The parent whose children "select all" and Tab navigation work on: the selection's parent, or the page. */
export function selectionScope(doc: FigDocument, selection: readonly string[], page: string): string {
  const first = selection.find((id) => doc.has(id));
  if (!first) return page;
  return doc.tree.parentOf(first) ?? page;
}

/** Selectable children of a container (visible and unlocked). */
export function selectableChildren(doc: FigDocument, parent: string): string[] {
  return doc.tree.childrenOf(parent).filter((c) => doc.get<boolean>(c, "visible") && !doc.get<boolean>(c, "locked"));
}

/** Removes ids that are gone, on another page, or descendants of other selected ids. */
export function normalizeSelection(doc: FigDocument, ids: readonly string[], page: string): string[] {
  const alive = ids.filter((id) => doc.has(id) && doc.tree.pageOf(id) === page && id !== page);
  const set = new Set(alive);
  return alive.filter((id) => {
    for (let p = doc.tree.parentOf(id); p !== undefined && p !== page; p = doc.tree.parentOf(p)) if (set.has(p)) return false;
    return true;
  });
}

/** Ids sorted in paint order (bottom first) across the tree. */
export function sortByPaintOrder(doc: FigDocument, ids: readonly string[]): string[] {
  const path = (id: string): number[] => {
    const out: number[] = [];
    for (let cur: string | undefined = id; cur !== undefined && cur !== "root"; cur = doc.tree.parentOf(cur)) {
      const parent = doc.tree.parentOf(cur);
      if (parent === undefined) break;
      out.unshift(doc.tree.childrenOf(parent).indexOf(cur));
    }
    return out;
  };
  const paths = new Map(ids.map((id) => [id, path(id)]));
  return [...ids].sort((a, b) => {
    const pa = paths.get(a)!;
    const pb = paths.get(b)!;
    for (let i = 0; i < Math.min(pa.length, pb.length); i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
    return pa.length - pb.length;
  });
}
