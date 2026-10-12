import { boxFromMatrix, type Constraints, type FigDocument } from "@fig-tree/document";
import type { Mat2D, Point } from "@fig-tree/geometry";
import type { CanvasGeometry } from "./geometry";
import { clean, invert, multiply, transformPoint, type Box } from "./math";

/**
 * Transform math for direct manipulation. Gestures work in world space on
 * the laid-out boxes (what the user sees) and are written back as *deltas*
 * of the stored `x`/`y` (so insets keep their meaning under any
 * constraint, and hug or fill parents) plus absolute sizes, rotation and
 * flips.
 */

/** A node's placement at the start of a gesture. */
export interface Captured {
  readonly id: string;
  /** Local-to-world matrix of the laid-out box. */
  readonly world: Mat2D;
  /** World matrix of the space the node's x/y are stored in. */
  readonly parentSpace: Mat2D;
  readonly width: number;
  readonly height: number;
  readonly stored: { readonly x: number; readonly y: number; readonly rotation: number; readonly flipX: boolean; readonly flipY: boolean };
  /** In a flex or grid parent's flow: layout places it, x/y are ignored. */
  readonly inFlow: boolean;
  /** A vector's network at the start of the gesture (resizing scales it). */
  readonly network?: unknown;
  /**
   * Keys a gesture has written so far. A later step of the same gesture
   * writes them again even when they are back at their captured value.
   */
  readonly touched?: Set<string>;
}

/** Whether a node is placed by its parent's flex or grid layout (its x/y are ignored). */
export function isInFlow(doc: FigDocument, id: string): boolean {
  const parent = doc.tree.parentOf(id);
  if (!parent) return false;
  let p: string | undefined = parent;
  // Groups pass their children through to their parent's layout (display: contents).
  while (p && doc.typeOf(p) === "group") p = doc.tree.parentOf(p);
  if (!p || doc.typeOf(p) === "page") return false;
  const display = doc.get<string>(p, "display");
  const position = doc.get<string>(id, "position");
  return position === "relative" && (display === "flex" || display === "grid");
}

/** Captures a node with a box (not a group) for a gesture. */
export function capture(geom: CanvasGeometry, id: string): Captured {
  const doc = geom.doc;
  const { width, height } = geom.size(id);
  return {
    id,
    world: geom.worldMatrix(id),
    parentSpace: geom.parentSpace(id),
    width,
    height,
    stored: {
      x: doc.get<number>(id, "x"),
      y: doc.get<number>(id, "y"),
      rotation: doc.get<number>(id, "rotation"),
      flipX: doc.get<boolean>(id, "flipX"),
      flipY: doc.get<boolean>(id, "flipY"),
    },
    inFlow: isInFlow(doc, id),
    touched: new Set(),
    ...(doc.typeOf(id) === "vector" ? { network: doc.get(id, "vectorNetwork") } : {}),
  };
}

/**
 * The nodes with boxes that a selection moves: selected nodes themselves,
 * and for selected groups (which have no box) their boxed descendants.
 */
export function boxedNodes(doc: FigDocument, ids: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    if (doc.typeOf(id) === "group") for (const c of doc.tree.childrenOf(id)) add(c);
    else out.push(id);
  };
  ids.forEach(add);
  return out;
}

export interface PlacementProps {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotation?: number;
  flipX?: boolean;
  flipY?: boolean;
}

/**
 * Stored properties that place a captured node's box at `newWorld` with the
 * given size. `newWorld` must be a rotation, optional reflection and
 * translation (no scale or skew).
 */
export function placementProps(c: Captured, newWorld: Mat2D, width: number, height: number): PlacementProps {
  const inv = invert(c.parentSpace);
  if (!inv) return {};
  const before = boxFromMatrix(multiply(inv, c.world), c.width, c.height, c.stored.flipX, c.stored.flipY);
  const after = boxFromMatrix(multiply(inv, newWorld), width, height, c.stored.flipX, c.stored.flipY);
  const out: PlacementProps = {};
  const t = c.touched;
  const put = <K extends keyof PlacementProps>(key: K, value: PlacementProps[K], changed: boolean): void => {
    if (changed || t?.has(key)) {
      out[key] = value;
      t?.add(key);
    }
  };
  if (!c.inFlow) {
    put("x", clean(c.stored.x + (after.x - before.x)), Math.abs(after.x - before.x) > 1e-9);
    put("y", clean(c.stored.y + (after.y - before.y)), Math.abs(after.y - before.y) > 1e-9);
  }
  put("width", clean(width), Math.abs(width - c.width) > 1e-9);
  put("height", clean(height), Math.abs(height - c.height) > 1e-9);
  const rotation = clean(after.rotation, 1e4);
  put("rotation", rotation, Math.abs(angleDiff(rotation, c.stored.rotation)) > 1e-6);
  put("flipX", after.flipX, after.flipX !== c.stored.flipX);
  put("flipY", after.flipY, after.flipY !== c.stored.flipY);
  return out;
}

function angleDiff(a: number, b: number): number {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Moves a captured node by a world-space delta. */
export function moveProps(c: Captured, dx: number, dy: number): PlacementProps {
  if (c.inFlow) return {};
  const inv = invert(c.parentSpace);
  if (!inv) return {};
  // Delta in the parent's space (linear part only).
  const lx = inv[0] * dx + inv[2] * dy;
  const ly = inv[1] * dx + inv[3] * dy;
  c.touched?.add("x").add("y");
  return { x: clean(c.stored.x + lx), y: clean(c.stored.y + ly) };
}

// ── Resize ──────────────────────────────────────────────────────────────

/** A resize handle: -1, 0 or 1 per axis (0 leaves that axis alone). `{x: 1, y: 1}` is the bottom-right corner. */
export interface Handle {
  readonly x: -1 | 0 | 1;
  readonly y: -1 | 0 | 1;
}

export const HANDLES: Readonly<Record<string, Handle>> = {
  nw: { x: -1, y: -1 },
  n: { x: 0, y: -1 },
  ne: { x: 1, y: -1 },
  e: { x: 1, y: 0 },
  se: { x: 1, y: 1 },
  s: { x: 0, y: 1 },
  sw: { x: -1, y: 1 },
  w: { x: -1, y: 0 },
};

export interface ResizeOptions {
  /** Keep the width/height ratio (Shift, or a locked aspect ratio). */
  readonly aspect: boolean;
  /** Resize symmetrically about the center (Alt). */
  readonly fromCenter: boolean;
}

/** A box in a gesture's local frame. Negative sizes mean the box was dragged past its anchor (a flip). */
export interface SignedRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Resizes a `width × height` box (local frame, origin at its top-left) by
 * dragging `handle` to `pointer` (same frame). The opposite edge or corner
 * stays fixed (the center with `fromCenter`). Dragging past the anchor
 * yields negative sizes (a mirror). With `aspect`, corner drags follow the
 * larger relative change and edge drags scale the other axis about its center.
 */
export function resizeRect(width: number, height: number, handle: Handle, pointer: Point, options: ResizeOptions): SignedRect {
  const center = options.fromCenter;
  let x0 = 0, x1 = width, y0 = 0, y1 = height;
  if (handle.x === 1) {
    x1 = pointer.x;
    if (center) x0 = width - pointer.x;
  } else if (handle.x === -1) {
    x0 = pointer.x;
    if (center) x1 = width - pointer.x;
  }
  if (handle.y === 1) {
    y1 = pointer.y;
    if (center) y0 = height - pointer.y;
  } else if (handle.y === -1) {
    y0 = pointer.y;
    if (center) y1 = height - pointer.y;
  }
  let w = x1 - x0;
  let h = y1 - y0;
  if (options.aspect && width > 0 && height > 0) {
    const sx = w / width;
    const sy = h / height;
    let s: number;
    if (handle.x !== 0 && handle.y !== 0) s = Math.abs(sx) >= Math.abs(sy) ? sx : sy;
    else s = handle.x !== 0 ? sx : sy;
    // Each dragged axis keeps the sign of its own drag (a mirror when it crossed the anchor).
    const signX = handle.x !== 0 ? Math.sign(sx) || 1 : 1;
    const signY = handle.y !== 0 ? Math.sign(sy) || 1 : 1;
    w = Math.abs(s) * width * signX;
    h = Math.abs(s) * height * signY;
    // Re-anchor.
    if (center) {
      x0 = (width - w) / 2;
      y0 = (height - h) / 2;
    } else {
      x0 = handle.x === -1 ? width - w : handle.x === 1 ? 0 : (width - w) / 2;
      y0 = handle.y === -1 ? height - h : handle.y === 1 ? 0 : (height - h) / 2;
    }
    return { x: x0, y: y0, width: w, height: h };
  }
  return { x: x0, y: y0, width: w, height: h };
}

/**
 * The world matrix of a resized box: `world` places the original box,
 * `rect` is the new (signed) rectangle in its local frame. A negative size
 * mirrors the box along that axis. Returns the new matrix and the absolute size.
 */
export function resizedWorld(world: Mat2D, rect: SignedRect): { world: Mat2D; width: number; height: number } {
  const fx = rect.width < 0 ? -1 : 1;
  const fy = rect.height < 0 ? -1 : 1;
  // The new box's local u ∈ [0, |width|] runs from rect.x in the direction of the drag
  // (mirrored when the drag crossed the anchor), likewise v.
  const local: Mat2D = [fx, 0, 0, fy, rect.x, rect.y];
  return { world: multiply(world, local), width: Math.abs(rect.width), height: Math.abs(rect.height) };
}

/**
 * Stored properties of a resized node. A mirrored drag toggles `flipX`
 * (a mirror of both axes is a half turn), as boxFromMatrix decides.
 */
export function resizeProps(c: Captured, rect: SignedRect): PlacementProps {
  const r = resizedWorld(c.world, rect);
  return placementProps(c, r.world, r.width, r.height);
}

/**
 * Resizes a group of boxes as one: `from` is their world bounds, `to` the
 * new (signed) world rectangle. Each node keeps its relative position and is
 * scaled along its own axes (exact for unrotated nodes; rotated nodes keep
 * their rotation and are scaled by how much the gesture stretches their axes).
 */
export function scaleProps(c: Captured, from: Box, to: SignedRect): PlacementProps {
  const sx = from.width > 0 ? to.width / from.width : 1;
  const sy = from.height > 0 ? to.height / from.height : 1;
  const map = (p: Point): Point => ({ x: to.x + (p.x - from.x) * sx, y: to.y + (p.y - from.y) * sy });
  const w = c.world;
  const center = map(transformPoint(w, c.width / 2, c.height / 2));
  const u = { x: w[0] * c.width * sx, y: w[1] * c.width * sy };
  const v = { x: w[2] * c.height * sx, y: w[3] * c.height * sy };
  const width = Math.hypot(u.x, u.y);
  const height = Math.hypot(v.x, v.y);
  return placementProps(c, frameAt(u, v, center, width, height), width, height);
}

/**
 * An orthonormal frame (rotation + optional reflection) whose x axis follows
 * `u`, with the handedness of (u, v), placing a `width × height` box centered at `center`.
 */
function frameAt(u: Point, v: Point, center: Point, width: number, height: number): Mat2D {
  const lu = Math.hypot(u.x, u.y) || 1;
  const ax = { x: u.x / lu, y: u.y / lu };
  const cross = u.x * v.y - u.y * v.x;
  const ay = cross >= 0 ? { x: -ax.y, y: ax.x } : { x: ax.y, y: -ax.x };
  const e = center.x - (ax.x * width) / 2 - (ay.x * height) / 2;
  const f = center.y - (ax.y * width) / 2 - (ay.y * height) / 2;
  return [ax.x, ax.y, ay.x, ay.y, e, f];
}

// ── Rotate ──────────────────────────────────────────────────────────────

/** Rotates a captured node by `degrees` (clockwise) about a world pivot. */
export function rotateProps(c: Captured, degrees: number, pivot: Point): PlacementProps {
  const r = (degrees * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const rot: Mat2D = [cos, sin, -sin, cos, pivot.x - cos * pivot.x + sin * pivot.y, pivot.y - sin * pivot.x - cos * pivot.y];
  return placementProps(c, multiply(rot, c.world), c.width, c.height);
}

/** Snaps an angle to multiples of `step` degrees (Shift while rotating). */
export function snapAngle(degrees: number, step = 15): number {
  return Math.round(degrees / step) * step;
}

// ── Constraints ─────────────────────────────────────────────────────────

export interface ChildBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Where a child goes when its parent changes size from `before` to `after`
 * (both width × height), following its constraints: `start` keeps the
 * left/top offset, `end` the right/bottom offset, `start-end` both (the
 * size follows), `center` the offset of its center from the parent's
 * center, and `scale` scales position and size proportionally.
 */
export function constrainChild(child: ChildBox, constraints: Constraints, before: { width: number; height: number }, after: { width: number; height: number }): ChildBox {
  const axis = (kind: Constraints["horizontal"], pos: number, size: number, from: number, to: number): [number, number] => {
    const d = to - from;
    switch (kind) {
      case "start":
        return [pos, size];
      case "end":
        return [pos + d, size];
      case "start-end":
        return [pos, Math.max(0, size + d)];
      case "center":
        return [pos + d / 2, size];
      case "scale": {
        const s = from > 0 ? to / from : 1;
        return [pos * s, size * s];
      }
    }
  };
  const [x, width] = axis(constraints.horizontal, child.x, child.width, before.width, after.width);
  const [y, height] = axis(constraints.vertical, child.y, child.height, before.height, after.height);
  return { x: clean(x), y: clean(y), width: clean(width), height: clean(height) };
}

/** Rounds placement values to whole pixels (pixel grid snapping) when the node is not rotated. */
export function roundToPixels(p: PlacementProps, rotation: number): PlacementProps {
  if (Math.abs(rotation % 90) > 1e-6) return p;
  const out: PlacementProps = { ...p };
  for (const k of ["x", "y", "width", "height"] as const) {
    const v = out[k];
    if (v !== undefined) out[k] = Math.round(v);
  }
  return out;
}
