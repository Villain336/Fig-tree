import { closestParam, type Cubic } from "../bezier/cubic";
import { addSegment, addVertex, splitSegment, updateVertex } from "../vector-network/edit";
import { segmentCubic, type HandleMirroring, type Vec, type VectorNetwork } from "../vector-network/network";
import { closePath } from "../vector-network/regions";

/**
 * The pen tool as a framework-free state machine: pointer and key events go
 * in (in the network's coordinate space), and each event returns the new
 * network plus a preview to draw. It never touches the DOM or the document;
 * the editor turns network changes into commands.
 *
 * Behaviour (Figma-like, extended for networks):
 * - Click: add a corner vertex, connected to the previous one.
 * - Drag after pressing: pull out smooth handles. The new vertex's incoming
 *   handle mirrors the drag (angle and length); the drag becomes the
 *   outgoing handle of the next segment. Hold Alt while dragging to break the
 *   handles: only the outgoing one follows.
 * - Press on the last vertex and drag: reshape its outgoing handle.
 * - Click an existing vertex: connect to it (a branch when it already has
 *   segments) and end the path. Clicking the path's first vertex closes the
 *   path and fills the new face.
 * - Click a segment: split it there and connect to the new vertex. With no
 *   path in progress, clicking a vertex or segment starts a branch from it.
 * - Shift constrains segments (and handles) to multiples of `angleStep`
 *   degrees; a `snap` hook can move points (grid, guides, other layers).
 * - Escape or Enter ends the path; Backspace removes the last vertex placed.
 */

export interface PenModifiers {
  readonly shift?: boolean | undefined;
  readonly alt?: boolean | undefined;
}

export interface PenOptions {
  /** Distance (network units) within which a click hits a vertex or segment. Convert from screen pixels with the view scale. */
  readonly hitRadius: number;
  /** Angle increment for Shift-constrained segments, in degrees. Default 15. */
  readonly angleStep?: number;
  /** Drag distance below which a press counts as a click. Default hitRadius / 4. */
  readonly dragThreshold?: number;
  /** Extra snapping (grid, guides, other layers): returns the snapped point, or null for none. */
  readonly snap?: (p: Vec, context: { readonly network: VectorNetwork; readonly from: number | null }) => Vec | null;
}

/**
 * One change the pen made to the network, in the vocabulary of the
 * document's `editVector` operations (same names and fields), so an editor
 * can replay exactly what the pen did as commands. Applying a session's ops
 * in order to the network the pen started from gives {@link PenTool.network}.
 */
export type PenOp =
  | { readonly op: "addVertex"; readonly x: number; readonly y: number }
  | { readonly op: "splitSegment"; readonly segment: number; readonly t: number }
  | { readonly op: "addSegment"; readonly start: number; readonly end: number; readonly tangentStart?: Vec }
  | { readonly op: "closePath"; readonly start: number; readonly end: number; readonly tangentStart?: Vec }
  | { readonly op: "setTangents"; readonly segment: number; readonly tangentStart: Vec | null; readonly tangentEnd: Vec | null }
  | { readonly op: "setVertex"; readonly vertex: number; readonly handleMirroring: HandleMirroring | null };

export type PenHit =
  | { readonly kind: "vertex"; readonly vertex: number }
  | { readonly kind: "segment"; readonly segment: number; readonly t: number; readonly point: Vec };

/** What the editor should draw over the canvas: the rubber-band segment and the handles being dragged. */
export interface PenPreview {
  /** The segment that the next click would create (from the active vertex to the pointer). */
  readonly segment: Cubic | null;
  /** Handles of the vertex being placed or adjusted, absolute. */
  readonly handles: readonly { readonly from: Vec; readonly to: Vec }[];
  /** What the pointer is over (for hover highlights and the close-path cursor). */
  readonly hover: PenHit | null;
  /** Whether a click now would close the path. */
  readonly closes: boolean;
}

export interface PenResult<N extends VectorNetwork> {
  readonly network: N;
  /** Whether the network changed. */
  readonly changed: boolean;
  readonly preview: PenPreview;
  /** True when the path was just ended (closed, connected, Escape or Enter). */
  readonly ended: boolean;
}

interface Drag {
  /** The vertex whose handles the drag shapes. */
  readonly vertex: number;
  /** Segment arriving at the vertex whose end handle mirrors the drag (null for the first vertex or a branch start). */
  readonly incoming: number | null;
  /** Whether the press ended the path (closing or connecting). */
  readonly ends: boolean;
  /** Where the press happened. */
  readonly origin: Vec;
  moved: boolean;
  /** The incoming handle when Alt broke the handles. */
  frozenIn: Vec | null;
}

export class PenTool<N extends VectorNetwork> {
  private net: N;
  /** Vertex the next segment starts from. */
  private active: number | null = null;
  /** First vertex of the current path (clicking it closes the path). */
  private pathStart: number | null = null;
  /** Outgoing handle for the next segment, relative to the active vertex. */
  private pendingOut: Vec | null = null;
  private drag: Drag | null = null;
  private history: { net: N; active: number | null; pathStart: number | null; pendingOut: Vec | null }[] = [];
  private lastPointer: Vec | null = null;
  private log: PenOp[] = [];
  private options: PenOptions;

  constructor(network: N, options: PenOptions) {
    this.net = network;
    this.options = options;
  }

  /**
   * The operations applied since the last call, in order (see {@link PenOp}).
   * Backspace restores an earlier network instead of applying an operation:
   * it clears the log, and callers revert the step themselves.
   */
  takeOps(): PenOp[] {
    const out = this.log;
    this.log = [];
    return out;
  }

  /** Changes the hit radius (and the default drag threshold), e.g. when the view zooms. */
  setHitRadius(hitRadius: number): void {
    this.options = { ...this.options, hitRadius };
  }

  /** The pending outgoing handle of the active vertex (relative to it), shown while drawing. */
  get pendingHandle(): Vec | null {
    return this.pendingOut;
  }

  /** The first vertex of the path in progress. */
  get pathStartVertex(): number | null {
    return this.pathStart;
  }

  get network(): N {
    return this.net;
  }

  /** The vertex the next segment will start from, if a path is in progress. */
  get activeVertex(): number | null {
    return this.active;
  }

  get dragging(): boolean {
    return this.drag !== null;
  }

  /** Starts a new path from an existing vertex (e.g. one selected in vector edit mode). */
  continueFrom(vertex: number): void {
    if (!(vertex >= 0 && vertex < this.net.vertices.length)) throw new RangeError(`vertex ${vertex} does not exist`);
    this.active = vertex;
    this.pathStart = vertex;
    this.pendingOut = null;
  }

  /** What is under a point: vertices first (nearest within the hit radius), then segments. */
  hitTest(p: Vec): PenHit | null {
    const r = this.options.hitRadius;
    let best = -1, bestD = r;
    this.net.vertices.forEach((v, i) => {
      const d = Math.hypot(v.x - p.x, v.y - p.y);
      if (d <= bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best >= 0) return { kind: "vertex", vertex: best };
    let seg = -1, segT = 0, segD = r * r;
    for (let i = 0; i < this.net.segments.length; i++) {
      const c = segmentCubic(this.net, i);
      const q = closestParam(c, p.x, p.y);
      if (q.dist2 <= segD) {
        segD = q.dist2;
        seg = i;
        segT = q.t;
      }
    }
    if (seg >= 0 && segT > 1e-6 && segT < 1 - 1e-6) {
      const c = segmentCubic(this.net, seg);
      const mt = 1 - segT;
      const point = {
        x: mt * mt * mt * c.x0 + 3 * mt * mt * segT * c.x1 + 3 * mt * segT * segT * c.x2 + segT * segT * segT * c.x3,
        y: mt * mt * mt * c.y0 + 3 * mt * mt * segT * c.y1 + 3 * mt * segT * segT * c.y2 + segT * segT * segT * c.y3,
      };
      return { kind: "segment", segment: seg, t: segT, point };
    }
    return null;
  }

  pointerDown(p: Vec, mods: PenModifiers = {}): PenResult<N> {
    this.lastPointer = p;
    const before = this.net;
    const hit = this.hitTest(p);
    this.history.push({ net: this.net, active: this.active, pathStart: this.pathStart, pendingOut: this.pendingOut });
    if (this.history.length > 256) this.history.shift();
    let vertex: number;
    let incoming: number | null = null;
    let ends = false;
    if (this.active === null) {
      // Start a path: from an existing vertex, a point on a segment, or a new vertex.
      if (hit?.kind === "vertex") vertex = hit.vertex;
      else if (hit?.kind === "segment") vertex = this.split(hit);
      else vertex = this.place(this.snapPoint(p, mods, null));
      this.pathStart = vertex;
      this.active = vertex;
      this.pendingOut = null;
    } else if (hit?.kind === "vertex" && hit.vertex === this.active) {
      // Reshape the last vertex's outgoing handle.
      vertex = this.active;
    } else {
      const from = this.active;
      if (hit?.kind === "vertex") {
        vertex = hit.vertex;
        ends = true;
        if (vertex === this.pathStart) {
          const r = closePath(this.net, from, vertex, this.pendingOut ? { start: this.pendingOut } : {});
          this.net = r.network;
          this.log.push({ op: "closePath", start: from, end: vertex, ...(this.pendingOut ? { tangentStart: this.pendingOut } : {}) });
          incoming = r.segment;
        } else {
          incoming = this.connect(from, vertex);
        }
      } else if (hit?.kind === "segment") {
        vertex = this.split(hit);
        incoming = this.connect(from, vertex);
        ends = true;
      } else {
        vertex = this.place(this.snapPoint(p, mods, from));
        incoming = this.connect(from, vertex);
      }
      this.pendingOut = null;
      if (!ends) this.active = vertex;
    }
    const origin = this.net.vertices[vertex]!;
    this.drag = { vertex, incoming, ends, origin: { x: origin.x, y: origin.y }, moved: false, frozenIn: null };
    return this.result(before, false);
  }

  pointerMove(p: Vec, mods: PenModifiers = {}): PenResult<N> {
    this.lastPointer = p;
    const before = this.net;
    const drag = this.drag;
    if (drag) {
      const threshold = this.options.dragThreshold ?? this.options.hitRadius / 4;
      let d = { x: p.x - drag.origin.x, y: p.y - drag.origin.y };
      if (!drag.moved && Math.hypot(d.x, d.y) < threshold) return this.result(before, false);
      drag.moved = true;
      if (mods.shift) d = constrainAngle(d, this.options.angleStep ?? 15);
      this.shapeHandles(drag, d, mods.alt === true);
    }
    return this.result(before, false);
  }

  pointerUp(p: Vec, mods: PenModifiers = {}): PenResult<N> {
    this.lastPointer = p;
    const before = this.net;
    const drag = this.drag;
    this.drag = null;
    if (!drag) return this.result(before, false);
    void mods;
    if (drag.ends) {
      this.endPath();
      return this.result(before, true);
    }
    return this.result(before, false);
  }

  keyDown(key: "Escape" | "Enter" | "Backspace"): PenResult<N> {
    const before = this.net;
    if (key === "Backspace") {
      const prev = this.history.pop();
      this.log = [];
      if (prev && this.active !== null) {
        this.net = prev.net;
        this.active = prev.active;
        this.pathStart = prev.pathStart;
        this.pendingOut = prev.pendingOut;
        this.drag = null;
      }
      return this.result(before, false);
    }
    const wasActive = this.active !== null;
    this.endPath();
    return this.result(before, wasActive);
  }

  /** Ends the current path without changing the network. */
  endPath(): void {
    this.active = null;
    this.pathStart = null;
    this.pendingOut = null;
    this.drag = null;
    this.history = [];
  }

  private place(p: Vec): number {
    const r = addVertex(this.net, p.x, p.y);
    this.net = r.network;
    this.log.push({ op: "addVertex", x: p.x, y: p.y });
    return r.vertex;
  }

  private split(hit: Extract<PenHit, { kind: "segment" }>): number {
    const r = splitSegment(this.net, hit.segment, hit.t);
    this.net = r.network;
    this.log.push({ op: "splitSegment", segment: hit.segment, t: hit.t });
    return r.vertex;
  }

  private connect(from: number, to: number): number {
    const r = addSegment(this.net, from, to, this.pendingOut ?? undefined, undefined);
    this.net = r.network;
    this.log.push({ op: "addSegment", start: from, end: to, ...(this.pendingOut ? { tangentStart: this.pendingOut } : {}) });
    return r.segment;
  }

  /** Applies a drag vector d (pointer − vertex) to the handles at the dragged vertex. */
  private shapeHandles(drag: Drag, d: Vec, broken: boolean): void {
    const zero = d.x === 0 && d.y === 0;
    if (broken && drag.frozenIn === null && drag.incoming !== null) {
      const seg = this.net.segments[drag.incoming]!;
      drag.frozenIn = (seg.end === drag.vertex ? seg.tangentEnd : seg.tangentStart) ?? { x: 0, y: 0 };
    }
    // Incoming handle: the end of the segment arriving at the vertex mirrors the drag.
    if (drag.incoming !== null) {
      const seg = this.net.segments[drag.incoming]!;
      const h = broken ? drag.frozenIn ?? { x: 0, y: 0 } : { x: -d.x, y: -d.y };
      const atEnd = seg.end === drag.vertex;
      const ts = atEnd ? seg.tangentStart : h;
      const te = atEnd ? h : seg.tangentEnd;
      this.net = setTangents(this.net, drag.incoming, ts, te);
      const nz = (v: Vec | undefined): Vec | null => (v && (v.x !== 0 || v.y !== 0) ? { x: v.x, y: v.y } : null);
      this.log.push({ op: "setTangents", segment: drag.incoming, tangentStart: nz(ts), tangentEnd: nz(te) });
    }
    if (!drag.ends) this.pendingOut = zero ? null : { x: d.x, y: d.y };
    const mirroring = broken || zero ? undefined : "angle-length";
    this.net = updateVertex(this.net, drag.vertex, { handleMirroring: mirroring });
    this.log.push({ op: "setVertex", vertex: drag.vertex, handleMirroring: mirroring ?? null });
  }

  private snapPoint(p: Vec, mods: PenModifiers, from: number | null): Vec {
    let q = this.options.snap?.(p, { network: this.net, from }) ?? p;
    if (mods.shift && from !== null) {
      const a = this.net.vertices[from]!;
      const d = constrainAngle({ x: q.x - a.x, y: q.y - a.y }, this.options.angleStep ?? 15);
      q = { x: a.x + d.x, y: a.y + d.y };
    }
    return q;
  }

  private result(before: N, ended: boolean): PenResult<N> {
    return { network: this.net, changed: this.net !== before, preview: this.preview(), ended };
  }

  /** The preview for the pointer's last position. */
  preview(): PenPreview {
    const p = this.lastPointer;
    const hover = p ? this.hitTest(p) : null;
    const handles: { from: Vec; to: Vec }[] = [];
    if (this.drag) {
      const v = this.net.vertices[this.drag.vertex]!;
      if (this.pendingOut) handles.push({ from: v, to: { x: v.x + this.pendingOut.x, y: v.y + this.pendingOut.y } });
      if (this.drag.incoming !== null) {
        const seg = this.net.segments[this.drag.incoming]!;
        const h = seg.end === this.drag.vertex ? seg.tangentEnd : seg.tangentStart;
        if (h) handles.push({ from: v, to: { x: v.x + h.x, y: v.y + h.y } });
      }
    }
    let segment: Cubic | null = null;
    let closes = false;
    if (this.active !== null && !this.drag && p) {
      const a = this.net.vertices[this.active]!;
      const target = hover?.kind === "vertex" ? this.net.vertices[hover.vertex]! : hover?.kind === "segment" ? hover.point : p;
      closes = hover?.kind === "vertex" && hover.vertex === this.pathStart && hover.vertex !== this.active;
      const out = this.pendingOut ?? { x: 0, y: 0 };
      segment = this.pendingOut
        ? { x0: a.x, y0: a.y, x1: a.x + out.x, y1: a.y + out.y, x2: target.x, y2: target.y, x3: target.x, y3: target.y, line: false }
        : { x0: a.x, y0: a.y, x1: a.x + (target.x - a.x) / 3, y1: a.y + (target.y - a.y) / 3, x2: target.x - (target.x - a.x) / 3, y2: target.y - (target.y - a.y) / 3, x3: target.x, y3: target.y, line: true };
    }
    return { segment, handles, hover, closes };
  }
}

function setTangents<N extends VectorNetwork>(net: N, s: number, ts: Vec | undefined, te: Vec | undefined): N {
  const segments = [...net.segments];
  const copy: Record<string, unknown> = { ...segments[s]! };
  delete copy.tangentStart;
  delete copy.tangentEnd;
  if (ts && (ts.x !== 0 || ts.y !== 0)) copy.tangentStart = ts;
  if (te && (te.x !== 0 || te.y !== 0)) copy.tangentEnd = te;
  segments[s] = copy as unknown as N["segments"][number];
  return { ...net, segments };
}

/** Rounds a vector's direction to the nearest multiple of `step` degrees, keeping its projected length. */
export function constrainAngle(d: Vec, step: number): Vec {
  const len = Math.hypot(d.x, d.y);
  if (len === 0) return d;
  const s = (step * Math.PI) / 180;
  const a = Math.round(Math.atan2(d.y, d.x) / s) * s;
  const ux = Math.cos(a), uy = Math.sin(a);
  const proj = d.x * ux + d.y * uy;
  // Clean up rounding so axis-aligned constraints are exact.
  const clean = (v: number): number => (Math.abs(v) < 1e-12 ? 0 : v);
  return { x: clean(ux * proj), y: clean(uy * proj) };
}
