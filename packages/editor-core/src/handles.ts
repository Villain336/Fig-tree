import type { Mat2D, Point } from "@fig-tree/geometry";
import type { Editor } from "./editor";
import { distanceToSegment, quad, transformPoint, type Box } from "./math";
import type { Cursor } from "./tools/tool";
import { HANDLES, type Handle } from "./transform";

/**
 * The selection's transform frame and its handles. A single node with a
 * box is framed by its own (possibly rotated) box; several nodes, or a
 * group, by their axis-aligned world bounds. Lines get two endpoint handles.
 */
export interface SelectionFrame {
  readonly kind: "single" | "multi" | "line";
  readonly ids: readonly string[];
  /** Local-to-world matrix of the frame's box (no scale). */
  readonly world: Mat2D;
  readonly width: number;
  readonly height: number;
  /** World corners: top-left, top-right, bottom-right, bottom-left. */
  readonly quad: readonly [Point, Point, Point, Point];
}

export function selectionFrame(editor: Editor): SelectionFrame | null {
  const ids = editor.selection.filter((id) => editor.doc.has(id));
  if (ids.length === 0) return null;
  const geom = editor.geometry;
  if (ids.length === 1 && geom.hasBox(ids[0]!)) {
    const id = ids[0]!;
    const world = geom.worldMatrix(id);
    const { width, height } = geom.size(id);
    const kind = editor.doc.typeOf(id) === "line" ? "line" : "single";
    return { kind, ids, world, width, height, quad: quad(world, width, height) };
  }
  const b = geom.boundsOf(ids);
  if (!b) return null;
  const world: Mat2D = [1, 0, 0, 1, b.x, b.y];
  return { kind: "multi", ids, world, width: b.width, height: b.height, quad: quad(world, b.width, b.height) };
}

export type HandleKind = "resize" | "rotate" | "endpoint";

export interface HandleInfo {
  readonly id: string;
  readonly kind: HandleKind;
  /** Resize direction (resize handles and edges). */
  readonly handle?: Handle;
  /** Endpoint index for lines. */
  readonly endpoint?: 0 | 1;
  /** Screen center. */
  readonly center: Point;
  /** Drawn size in CSS px (0 = an invisible zone). */
  readonly size: number;
  readonly cursor: Cursor;
}

const CORNER = 8;
const EDGE = 6;
/** Rotation zones sit just outside the corners. */
const ROTATE_OFFSET = 14;
const ROTATE_RADIUS = 10;
const EDGE_REACH = 5;

/** Handles of the current selection frame (screen space). Locked selections have none. */
export function selectionHandles(editor: Editor, frame: SelectionFrame | null = selectionFrame(editor)): HandleInfo[] {
  if (!frame) return [];
  if (frame.ids.some((id) => editor.doc.get<boolean>(id, "locked"))) return [];
  const vp = editor.viewport;
  const s = frame.quad.map((p) => vp.toScreen(p)) as [Point, Point, Point, Point];
  if (frame.kind === "line") {
    return [
      { id: "canvas.handle.endpoint.start", kind: "endpoint", endpoint: 0, center: s[0], size: CORNER, cursor: "crosshair" },
      { id: "canvas.handle.endpoint.end", kind: "endpoint", endpoint: 1, center: s[1], size: CORNER, cursor: "crosshair" },
    ];
  }
  const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const center = mid(s[0], s[2]);
  const out: HandleInfo[] = [];
  const corners: [string, Point][] = [
    ["nw", s[0]],
    ["ne", s[1]],
    ["se", s[2]],
    ["sw", s[3]],
  ];
  // Rotation zones first in the list (they are drawn invisibly and tested last).
  for (const [name, p] of corners) {
    const dx = p.x - center.x;
    const dy = p.y - center.y;
    const len = Math.hypot(dx, dy) || 1;
    out.push({ id: `canvas.handle.rotate.${name}`, kind: "rotate", center: { x: p.x + (dx / len) * ROTATE_OFFSET, y: p.y + (dy / len) * ROTATE_OFFSET }, size: 0, cursor: "rotate" });
  }
  const screenW = Math.hypot(s[1].x - s[0].x, s[1].y - s[0].y);
  const screenH = Math.hypot(s[3].x - s[0].x, s[3].y - s[0].y);
  const edges: [string, Point][] = [
    ["n", mid(s[0], s[1])],
    ["e", mid(s[1], s[2])],
    ["s", mid(s[2], s[3])],
    ["w", mid(s[3], s[0])],
  ];
  for (const [name, p] of edges) {
    // Edge handles only where there is room for them.
    const room = name === "n" || name === "s" ? screenW : screenH;
    if (room < 28) continue;
    out.push({ id: `canvas.handle.resize.${name}`, kind: "resize", handle: HANDLES[name]!, center: p, size: EDGE, cursor: resizeCursor(editor, frame, HANDLES[name]!) });
  }
  for (const [name, p] of corners) {
    out.push({ id: `canvas.handle.resize.${name}`, kind: "resize", handle: HANDLES[name]!, center: p, size: CORNER, cursor: resizeCursor(editor, frame, HANDLES[name]!) });
  }
  return out;
}

/** The handle under a screen point: corners, then edge handles, then edges, then rotation zones. */
export function hitHandle(editor: Editor, screen: Point, frame: SelectionFrame | null = selectionFrame(editor)): HandleInfo | null {
  const handles = selectionHandles(editor, frame);
  if (handles.length === 0 || !frame) return null;
  const within = (h: HandleInfo, r: number): boolean => Math.abs(screen.x - h.center.x) <= r && Math.abs(screen.y - h.center.y) <= r;
  for (const h of handles) if ((h.kind === "endpoint" || (h.kind === "resize" && h.size === CORNER)) && within(h, h.size / 2 + 3)) return h;
  for (const h of handles) if (h.kind === "resize" && h.size === EDGE && within(h, h.size / 2 + 3)) return h;
  if (frame.kind !== "line") {
    // Anywhere along an edge resizes that edge.
    const vp = editor.viewport;
    const s = frame.quad.map((p) => vp.toScreen(p));
    const names = ["n", "e", "s", "w"] as const;
    for (let i = 0; i < 4; i++) {
      if (distanceToSegment(screen, s[i]!, s[(i + 1) % 4]!) <= EDGE_REACH) {
        const handle = HANDLES[names[i]!]!;
        return { id: `canvas.handle.resize.${names[i]}`, kind: "resize", handle, center: screen, size: 0, cursor: resizeCursor(editor, frame, handle) };
      }
    }
  }
  for (const h of handles) if (h.kind === "rotate" && Math.hypot(screen.x - h.center.x, screen.y - h.center.y) <= ROTATE_RADIUS) return h;
  return null;
}

/** A resize cursor matching the handle's on-screen direction. */
function resizeCursor(editor: Editor, frame: SelectionFrame, handle: Handle): Cursor {
  const w = frame.world;
  // Direction of the handle from the box center, in screen space (uniform zoom keeps angles).
  const d = { x: w[0] * handle.x + w[2] * handle.y, y: w[1] * handle.x + w[3] * handle.y };
  void editor;
  const angle = ((Math.atan2(d.y, d.x) * 180) / Math.PI + 360) % 180;
  const cursors: Cursor[] = ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"];
  return cursors[Math.round(angle / 45) % 4]!;
}

/** The world point of a handle direction on a frame's box (corners and edge midpoints). */
export function handlePoint(frame: SelectionFrame, handle: Handle): Point {
  return transformPoint(frame.world, ((handle.x + 1) / 2) * frame.width, ((handle.y + 1) / 2) * frame.height);
}

export function frameBox(frame: SelectionFrame): Box {
  const xs = frame.quad.map((p) => p.x);
  const ys = frame.quad.map((p) => p.y);
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}
