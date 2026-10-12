import { boxFromMatrix, type Command, type FigDocument } from "@fig-tree/document";
import type { Mat2D, Point } from "@fig-tree/geometry";
import type { Editor } from "./editor";
import { pickPath } from "./hit-test";
import { boxesIntersect, clean, inflateBox, invert, multiply, type Box } from "./math";
import { isContainer } from "./selection";
import type { SnapTarget } from "./snapping";
import { boxedNodes } from "./transform";

const FRAMES = new Set(["frame", "component", "instance"]);

/**
 * The container a drop or a new node at a world point goes into: the
 * deepest frame under the point that is not being moved (nor inside a
 * moved node), else the page. Locked and hidden frames are skipped.
 */
export function containerAt(editor: Editor, world: Point, skip: ReadonlySet<string> = new Set()): string {
  const path = pickPath(editor.geometry, world, { tolerance: 0, skip });
  if (path) {
    for (let i = path.length - 1; i >= 0; i--) {
      const id = path[i]!;
      if (FRAMES.has(editor.doc.typeOf(id) ?? "")) return id;
    }
  }
  return editor.page;
}

/** Whether a node's parent lays it out (flex or grid display). */
export function layoutDisplay(doc: FigDocument, id: string): "flex" | "grid" | null {
  if (!FRAMES.has(doc.typeOf(id) ?? "")) return null;
  const d = doc.get<string>(id, "display");
  return d === "flex" || d === "grid" ? d : null;
}

/**
 * Snap targets for moving or resizing nodes inside `parent`: its other
 * children (that are visible and on screen), the parent's own box and,
 * when it has padding, its content box. On the page, the other top-level
 * nodes on screen.
 */
export function snapTargets(editor: Editor, parents: ReadonlySet<string>, exclude: ReadonlySet<string>, limit = 400): SnapTarget[] {
  const doc = editor.doc;
  const geom = editor.geometry;
  const visible = inflateBox(editor.viewport.visibleWorld, 200 / editor.viewport.scale);
  const out: SnapTarget[] = [];
  for (const parent of parents) {
    let space = parent;
    while (doc.typeOf(space) === "group") space = doc.tree.parentOf(space) ?? editor.page;
    const kids = collectSiblings(doc, space);
    for (const id of kids) {
      if (out.length >= limit) break;
      if (exclude.has(id) || isAncestorIn(doc, id, exclude)) continue;
      if (!doc.get<boolean>(id, "visible")) continue;
      const b = geom.bounds(id);
      if (!boxesIntersect(b, visible)) continue;
      out.push({ box: b, kind: "sibling" });
    }
    if (doc.typeOf(space) !== "page") {
      const b = geom.bounds(space);
      out.push({ box: b, kind: "parent" });
      const box = editor.bridge.box(space);
      if (box && (box.padding.top || box.padding.right || box.padding.bottom || box.padding.left) && geom.localMatrix(space)[1] === 0) {
        out.push({
          kind: "padding",
          box: { x: b.x + box.padding.left + box.border.left, y: b.y + box.padding.top + box.border.top, width: b.width - box.padding.left - box.padding.right - box.border.left - box.border.right, height: b.height - box.padding.top - box.padding.bottom - box.border.top - box.border.bottom },
        });
      }
    }
  }
  return out;
}

/** Children of a container, looking through groups (their members are siblings in layout terms). */
function collectSiblings(doc: FigDocument, parent: string): string[] {
  const out: string[] = [];
  for (const c of doc.tree.childrenOf(parent)) {
    out.push(c);
    if (doc.typeOf(c) === "group") out.push(...collectSiblings(doc, c));
  }
  return out;
}

function isAncestorIn(doc: FigDocument, id: string, set: ReadonlySet<string>): boolean {
  for (let p = doc.tree.parentOf(id); p !== undefined && p !== "root"; p = doc.tree.parentOf(p)) if (set.has(p)) return true;
  return false;
}

/**
 * Index (among `parent`'s children, excluding `moving`) at which nodes
 * dropped at `world` join the flow of a flex or grid container: before the
 * nearest in-flow child whose center is past the pointer along the main axis.
 */
export function flowInsertIndex(editor: Editor, parent: string, world: Point, moving: ReadonlySet<string>): { index: number; line: [Point, Point] | null } {
  const doc = editor.doc;
  const geom = editor.geometry;
  const kids = doc.tree.childrenOf(parent).filter((c) => !moving.has(c));
  const dir = doc.get<string>(parent, "flexDirection");
  const display = doc.get<string>(parent, "display");
  const row = display === "grid" ? true : dir === "row" || dir === "row-reverse";
  const reverse = display !== "grid" && (dir === "row-reverse" || dir === "column-reverse");
  let best: { i: number; d: number; b: Box } | null = null;
  kids.forEach((c, i) => {
    if (doc.get<string>(c, "position") !== "relative" || !doc.get<boolean>(c, "visible")) return;
    const b = geom.bounds(c);
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    const d = Math.hypot(world.x - cx, world.y - cy);
    if (!best || d < best.d) best = { i, d, b };
  });
  if (!best) return { index: kids.length, line: null };
  const { i, b } = best as { i: number; d: number; b: Box };
  const after = row ? world.x > b.x + b.width / 2 : world.y > b.y + b.height / 2;
  const before = reverse ? after : !after;
  const index = before ? i : i + 1;
  const edge = row ? (after ? b.x + b.width : b.x) : after ? b.y + b.height : b.y;
  const line: [Point, Point] = row ? [{ x: edge, y: b.y }, { x: edge, y: b.y + b.height }] : [{ x: b.x, y: edge }, { x: b.x + b.width, y: edge }];
  return { index, line };
}

/**
 * Commands that move `ids` into `target` at `index`, keeping every moved
 * box where it is on screen (computed from the laid-out world matrices, so
 * flex and grid children land where they were drawn), plus `delta` (world)
 * for nodes the layout placed (their stored x/y were not dragged).
 * Nodes entering a flex or grid container join its flow; nodes leaving
 * become absolutely positioned.
 */
export function reparentCommands(editor: Editor, ids: readonly string[], target: string, index: number | undefined, delta: Point = { x: 0, y: 0 }, inFlowDelta: ReadonlySet<string> = new Set()): Command[] {
  const doc = editor.doc;
  const geom = editor.geometry;
  const targetWorld = target === editor.page ? ([1, 0, 0, 1, 0, 0] as Mat2D) : geom.worldMatrix(target);
  const inv = invert(targetWorld);
  if (!inv) return [];
  const flow = layoutDisplay(doc, target) !== null;
  const cmds: Command[] = [{ type: "setParent", ids: [...ids], parent: target, ...(index !== undefined ? { index } : {}), keepPosition: false }];
  for (const id of boxedNodes(doc, ids)) {
    const w = geom.worldMatrix(id);
    const moved: Mat2D = inFlowDelta.has(id) || inFlowDelta.has(rootOf(doc, id, ids)) ? [w[0], w[1], w[2], w[3], w[4] + delta.x, w[5] + delta.y] : w;
    const { width, height } = geom.size(id);
    const b = boxFromMatrix(multiply(inv, moved), width, height, doc.get<boolean>(id, "flipX"), doc.get<boolean>(id, "flipY"));
    const props: Record<string, unknown> = { x: clean(b.x), y: clean(b.y), rotation: clean(b.rotation, 1e4), flipX: b.flipX, flipY: b.flipY };
    if (ids.includes(id) && doc.typeOf(id) !== "group") props.position = flow ? "relative" : "absolute";
    cmds.push({ type: "updateProps", id, props });
  }
  for (const id of ids) if (doc.typeOf(id) === "group") cmds.push({ type: "updateProps", id, props: { position: flow ? "relative" : "absolute" } });
  return cmds;
}

function rootOf(doc: FigDocument, id: string, roots: readonly string[]): string {
  for (let cur: string | undefined = id; cur !== undefined; cur = doc.tree.parentOf(cur)) if (roots.includes(cur)) return cur;
  return id;
}

export { isContainer };
