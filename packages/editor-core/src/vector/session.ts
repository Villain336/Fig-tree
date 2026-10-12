import { newId, type Command, type VectorOp } from "@fig-tree/document";
import {
  PenTool,
  closestParam,
  constrainAngle,
  faceAt,
  flattenPath,
  invert,
  maxScale,
  multiply,
  networkFaces,
  pointAt,
  segmentCubic,
  transformCubic,
  transformPoint,
  Path,
  type Cubic,
  type Mat2D,
  type NetworkFace,
  type Point,
  type Vec,
} from "@fig-tree/geometry";
import type { AnchorRect } from "../anchors";
import type { Editor } from "../editor";
import { DRAG_THRESHOLD } from "../editor";
import { pickPath } from "../hit-test";
import type { KeyInput } from "../keymap";
import { boxFromCorners, boxContainsPoint, distance, type Box } from "../math";
import type { OverlayItem } from "../overlay";
import { snapTargets } from "../placement";
import type { Guide, SnapTarget } from "../snapping";
import type { Cursor, EditSession, ToolPointer } from "../tools/tool";
import { nextName } from "../tools/create";
import { clean, commitVectorOps, editableNetwork, replaceNetworkCommands, translateOp, type Network, type VectorCommit, vectorWorldMatrix } from "./edit";
import { snapPoint, type PointSnapContext } from "./snap";

/** Sub-tools of vector edit mode. */
export type VectorSubTool = "select" | "pen" | "bend" | "bucket";

export type HandleMirroring = "none" | "angle" | "angle-length";

/** What is under the pointer in vector edit mode. */
export type VectorHit =
  | { readonly kind: "handle"; readonly segment: number; readonly end: "start" | "end"; readonly vertex: number }
  | { readonly kind: "vertex"; readonly vertex: number }
  | { readonly kind: "segment"; readonly segment: number; readonly t: number };

/** Hit distances in CSS pixels. */
export const VERTEX_HIT = 6;
export const HANDLE_HIT = 6;
export const SEGMENT_HIT = 5;
/** Vertices and handles drawn (and registered as anchors) at most. */
const MAX_DRAWN_POINTS = 5000;
const MAX_ANCHORS = 400;

const black = { type: "solid" as const, color: { r: 0, g: 0, b: 0, a: 1 } };
const gray = { type: "solid" as const, color: { r: 0.85, g: 0.85, b: 0.85, a: 1 } };

interface PenStep {
  /** Whether the press changed the document (one undo step). */
  recorded: boolean;
  /** The user's undo depth after the step (to revert it only while it is the latest). */
  depthAfter: number;
  /** The pen's offset before the step. */
  readonly offset: Point;
}

/** The pen sub-tool's state: a `PenTool` in a fixed session space mapped to the canvas by `frame`. */
interface PenState {
  readonly tool: PenTool<Network>;
  /** Session space → world (fixed while the pen draws). */
  readonly frame: Mat2D;
  /** Session-space position of the stored network's origin: stored = session − offset. */
  offset: Point;
  /** The stored network after our last write (another value means someone else edited: start over). */
  expected: Network;
  readonly steps: PenStep[];
  step: PenStep | null;
  guides: readonly Guide[];
  targets: SnapTarget[] | null;
}

type Gesture =
  | { readonly kind: "move"; readonly vertices: number[]; readonly ref: number; readonly refStart: Point; readonly origin: Point; readonly ctx: PointSnapContext; guides: readonly Guide[] }
  | { readonly kind: "handle"; readonly segment: number; readonly end: "start" | "end"; readonly vertex: number }
  | { readonly kind: "bend"; readonly segment: number; readonly t: number }
  | { readonly kind: "pull"; readonly vertex: number }
  | { readonly kind: "marquee"; readonly start: Point; rect: Box; readonly baseVertices: readonly number[]; readonly baseSegments: readonly number[] }
  | { readonly kind: "pen" };

interface Press {
  readonly start: ToolPointer;
  readonly hit: VectorHit | null;
  readonly wasSelected: boolean;
  /** Bend (Cmd/Ctrl or the bend sub-tool). */
  readonly bend: boolean;
}

/** Screen-space geometry of the network for one view (cached per network and matrix). */
interface ScreenCache {
  readonly net: Network;
  readonly key: string;
  readonly matrix: Mat2D;
  readonly vertices: Point[];
  readonly cubics: Cubic[];
  readonly polylines: Point[][];
}

const facesCache = new WeakMap<Network, NetworkFace[]>();
function facesOf(net: Network): NetworkFace[] {
  let f = facesCache.get(net);
  if (!f) {
    f = networkFaces(net);
    facesCache.set(net, f);
  }
  return f;
}

/**
 * Vector edit mode: points of one vector network edited on the canvas.
 *
 * - **Select** (V): click, Shift-click and marquee select vertices and
 *   segments; drag them (snapping to other vertices, layers and the pixel
 *   grid; Shift locks an axis; Cmd/Ctrl drags without snapping); arrows nudge
 *   (Shift 10 px); drag handles (each vertex's mirroring applies, Alt drags
 *   one handle alone, Shift snaps its angle to 15°); double-click a segment to
 *   add a vertex; Cmd/Ctrl-drag a segment to bend it, Cmd/Ctrl-drag a vertex
 *   to pull out smooth handles, Cmd/Ctrl-click a vertex to toggle smooth and
 *   sharp.
 * - **Pen** (P): `PenTool` from `@fig-tree/geometry`, adding to this network.
 * - **Bend** (Cmd/Ctrl held, or the tool): as Cmd/Ctrl above.
 * - **Paint bucket** (B): click an enclosed area to fill or unfill it.
 * - Delete keeps the shape (joins the neighbouring segments), Shift+Delete
 *   leaves a gap; Cmd/Ctrl+J joins two vertices, Shift+Cmd/Ctrl+J
 *   disconnects; Shift+H / Shift+V flip the selected points.
 * - Escape or Enter ends a pen path, then leaves the mode.
 *
 * Every edit is an `editVector` command with the box kept tight (see
 * `edit.ts`); a gesture (press to release) is one undo step. Shapes convert
 * to vectors on their first edit.
 */
export class VectorEditSession implements EditSession {
  readonly mode = "vector";
  private _nodeId: string;
  private _subTool: VectorSubTool;
  private selV = new Set<number>();
  private selS = new Set<number>();
  private hover: VectorHit | null = null;
  private hoverFace: { face: NetworkFace; filled: boolean } | null = null;
  private press: Press | null = null;
  private gesture: Gesture | null = null;
  private pen: PenState | null = null;
  /** A vector the pen tool is about to create on the first click (the node does not exist yet). */
  private pendingCreate: { readonly parent: string; readonly id: string } | null;
  /** The session was started by the pen tool: leaving returns to the select tool, and an empty vector is removed. */
  readonly fromPenTool: boolean;
  /** Undo depth before the pen tool created the node (to take an empty vector back without a trace). */
  private createdAtDepth: number | null = null;
  private screen: ScreenCache | null = null;
  private netCache: { version: number; id: string; net: Network | null } | null = null;
  private readonly anchorOffs = new Map<string, () => void>();
  private ended = false;

  constructor(
    readonly editor: Editor,
    nodeId: string,
    options: { readonly subTool?: VectorSubTool; readonly fromPenTool?: boolean; readonly create?: { readonly parent: string } } = {},
  ) {
    this._nodeId = nodeId;
    this._subTool = options.subTool ?? "select";
    this.fromPenTool = options.fromPenTool ?? false;
    this.pendingCreate = options.create ? { parent: options.create.parent, id: nodeId } : null;
  }

  /** A session for a vector the pen draws from its first click, inside `parent`. */
  static newVector(editor: Editor, parent: string): VectorEditSession {
    return new VectorEditSession(editor, newId(editor.doc.random), { subTool: "pen", fromPenTool: true, create: { parent } });
  }

  get nodeId(): string {
    return this._nodeId;
  }

  get subTool(): VectorSubTool {
    return this._subTool;
  }

  /** Whether the edited node is still a shape that its first edit converts to a vector. */
  get convertsOnEdit(): boolean {
    const t = this.editor.doc.typeOf(this._nodeId);
    return t !== undefined && t !== "vector";
  }

  setSubTool(tool: VectorSubTool): void {
    if (tool === this._subTool) return;
    this.cancelGesture();
    if (this.pen && this.pen.tool.activeVertex !== null) this.endPenPath();
    this._subTool = tool;
    this.hover = null;
    this.hoverFace = null;
    this.editor.emit("session", "overlay", "tool");
  }

  // ── Network and coordinates ──────────────────────────────────────────

  /** The network being edited (local box coordinates), or an empty one before the pen created the node. */
  get network(): Network {
    const doc = this.editor.doc;
    if (!doc.has(this._nodeId)) return { vertices: [], segments: [], regions: [] };
    if (doc.typeOf(this._nodeId) === "vector") return doc.get<Network>(this._nodeId, "vectorNetwork");
    const c = this.netCache;
    if (c && c.version === this.editor.docVersion && c.id === this._nodeId && c.net) return c.net;
    const net = editableNetwork(doc, this._nodeId) ?? { vertices: [], segments: [], regions: [] };
    this.netCache = { version: this.editor.docVersion, id: this._nodeId, net };
    return net;
  }

  /** Local → world matrix of the node. */
  get world(): Mat2D {
    return vectorWorldMatrix(this.editor, this._nodeId);
  }

  private toLocal(p: Point): Point {
    const inv = invert(this.world);
    return inv ? transformPoint(inv, p.x, p.y) : p;
  }

  private toWorld(p: Point): Point {
    return transformPoint(this.world, p.x, p.y);
  }

  /** Screen-space geometry of the network, recomputed when the network or the view changes. */
  private screenGeometry(): ScreenCache {
    const net = this.network;
    const vp = this.editor.viewport;
    const m = multiply(vp.matrix, this.world);
    const key = m.join(",");
    const c = this.screen;
    if (c && c.net === net && c.key === key) return c;
    const vertices = net.vertices.map((v) => transformPoint(m, v.x, v.y));
    const cubics: Cubic[] = [];
    const polylines: Point[][] = [];
    for (let i = 0; i < net.segments.length; i++) {
      const cu = transformCubic(segmentCubic(net, i), m);
      cubics.push(cu);
      polylines.push(cubicPolyline(cu));
    }
    this.screen = { net, key, matrix: m, vertices, cubics, polylines };
    return this.screen;
  }

  // ── Selection ────────────────────────────────────────────────────────

  /** Selected vertex indices (valid ones, ascending). */
  get selectedVertices(): number[] {
    const n = this.network.vertices.length;
    return [...this.selV].filter((v) => v < n).sort((a, b) => a - b);
  }

  get selectedSegments(): number[] {
    const n = this.network.segments.length;
    return [...this.selS].filter((s) => s < n).sort((a, b) => a - b);
  }

  /** Selects vertices and segments (indices into the current network). */
  selectPoints(vertices: readonly number[], segments: readonly number[] = []): void {
    this.selV = new Set(vertices);
    this.selS = new Set(segments);
    this.editor.emit("session", "overlay");
  }

  /** Vertices a move or nudge moves: the selected ones and the ends of selected segments. */
  private movingVertices(): number[] {
    const net = this.network;
    const out = new Set(this.selectedVertices);
    for (const s of this.selectedSegments) {
      out.add(net.segments[s]!.start);
      out.add(net.segments[s]!.end);
    }
    return [...out].sort((a, b) => a - b);
  }

  // ── Hit-testing ──────────────────────────────────────────────────────

  /** Handles drawn: those of segments at selected vertices, and of selected segments. */
  visibleHandles(): { segment: number; end: "start" | "end"; vertex: number }[] {
    const net = this.network;
    const selV = this.selV;
    const out: { segment: number; end: "start" | "end"; vertex: number }[] = [];
    if (selV.size === 0 && this.selS.size === 0) return out;
    net.segments.forEach((s, i) => {
      if (!(selV.has(s.start) || selV.has(s.end) || this.selS.has(i))) return;
      if (s.tangentStart && (s.tangentStart.x !== 0 || s.tangentStart.y !== 0)) out.push({ segment: i, end: "start", vertex: s.start });
      if (s.tangentEnd && (s.tangentEnd.x !== 0 || s.tangentEnd.y !== 0)) out.push({ segment: i, end: "end", vertex: s.end });
    });
    return out.slice(0, MAX_DRAWN_POINTS);
  }

  /** Screen position of a handle. */
  private handleScreen(h: { segment: number; end: "start" | "end" }): Point {
    const c = this.screenGeometry().cubics[h.segment]!;
    return h.end === "start" ? { x: c.x1, y: c.y1 } : { x: c.x2, y: c.y2 };
  }

  /** What is under a screen point: handles first, then vertices, then segments. */
  hitTest(screen: Point): VectorHit | null {
    const g = this.screenGeometry();
    let best: VectorHit | null = null;
    let bestD = HANDLE_HIT;
    for (const h of this.visibleHandles()) {
      const d = distance(this.handleScreen(h), screen);
      if (d <= bestD) {
        bestD = d;
        best = { kind: "handle", ...h };
      }
    }
    if (best) return best;
    bestD = VERTEX_HIT;
    g.vertices.forEach((v, i) => {
      const d = distance(v, screen);
      if (d <= bestD) {
        bestD = d;
        best = { kind: "vertex", vertex: i };
      }
    });
    if (best) return best;
    let seg = -1, segT = 0, segD = SEGMENT_HIT * SEGMENT_HIT;
    g.cubics.forEach((c, i) => {
      const minX = Math.min(c.x0, c.x1, c.x2, c.x3) - SEGMENT_HIT, maxX = Math.max(c.x0, c.x1, c.x2, c.x3) + SEGMENT_HIT;
      const minY = Math.min(c.y0, c.y1, c.y2, c.y3) - SEGMENT_HIT, maxY = Math.max(c.y0, c.y1, c.y2, c.y3) + SEGMENT_HIT;
      if (screen.x < minX || screen.x > maxX || screen.y < minY || screen.y > maxY) return;
      const q = closestParam(c, screen.x, screen.y);
      if (q.dist2 <= segD) {
        segD = q.dist2;
        seg = i;
        segT = q.t;
      }
    });
    if (seg >= 0) return { kind: "segment", segment: seg, t: Math.min(1 - 1e-6, Math.max(1e-6, segT)) };
    return null;
  }

  /** Whether a press outside the network lands on another layer (which ends the mode). */
  private otherLayerAt(e: ToolPointer): boolean {
    const path = pickPath(this.editor.geometry, e.world, { tolerance: this.editor.pickTolerance });
    if (!path) return false;
    return !path.includes(this._nodeId) && !this.editor.doc.tree.isSelfOrAncestor(path[path.length - 1]!, this._nodeId);
  }

  // ── Input ────────────────────────────────────────────────────────────

  pointerDown(e: ToolPointer): boolean {
    if (this.ended) return false;
    if (e.button === 2) return true;
    if (e.button !== 0) return true;
    if (this._subTool === "pen") return this.penDown(e);
    if (this._subTool === "bucket") return this.bucketClick(e);
    const hit = this.hitTest(e.screen);
    const bend = this._subTool === "bend" || e.mod;
    if (e.clickCount >= 2) {
      if (hit?.kind === "segment") {
        this.addVertexAt(hit.segment, hit.t);
        return true;
      }
      // A quick second press on a point or handle is a press like any other (it may start a drag).
      if (!hit) return !this.otherLayerAt(e) && this.insideNode(e.world);
    }
    if (!hit && this.otherLayerAt(e)) return false;
    let wasSelected = false;
    if (hit?.kind === "vertex" && !bend) {
      wasSelected = this.selV.has(hit.vertex);
      if (e.shift) {
        if (!wasSelected) this.selectPoints([...this.selV, hit.vertex], [...this.selS]);
      } else if (!wasSelected) this.selectPoints([hit.vertex]);
    } else if (hit?.kind === "segment" && !bend) {
      wasSelected = this.selS.has(hit.segment);
      if (e.shift) {
        if (!wasSelected) this.selectPoints([...this.selV], [...this.selS, hit.segment]);
      } else if (!wasSelected) this.selectPoints([], [hit.segment]);
    }
    this.press = { start: e, hit, wasSelected, bend };
    return true;
  }

  pointerMove(e: ToolPointer): void {
    if (this.ended) return;
    if (this._subTool === "pen") {
      this.penMove(e);
      return;
    }
    const g = this.gesture;
    if (g) {
      this.updateGesture(g, e);
      return;
    }
    const p = this.press;
    if (p) {
      if (distance(p.start.screen, e.screen) < DRAG_THRESHOLD) return;
      this.beginGesture(p, e);
      if (this.gesture) this.updateGesture(this.gesture, e);
      return;
    }
    if (this._subTool === "bucket") {
      this.hoverFace = this.faceUnder(e.world);
      return;
    }
    this.hover = this.hitTest(e.screen);
  }

  pointerUp(e: ToolPointer): void {
    if (this.ended) return;
    if (this._subTool === "pen") {
      this.penUp(e);
      return;
    }
    const g = this.gesture;
    const p = this.press;
    this.gesture = null;
    this.press = null;
    if (g) {
      this.editor.history.end();
      this.editor.emit("session", "overlay");
      return;
    }
    if (!p) return;
    // A click without a drag.
    const hit = p.hit;
    if (p.bend && hit?.kind === "vertex") {
      this.toggleSmooth(hit.vertex);
      return;
    }
    if (!hit) {
      if (!e.shift) this.selectPoints([]);
      return;
    }
    if (hit.kind === "vertex" && p.wasSelected) {
      if (e.shift) this.selectPoints([...this.selV].filter((v) => v !== hit.vertex), [...this.selS]);
      else this.selectPoints([hit.vertex]);
    } else if (hit.kind === "segment" && p.wasSelected) {
      if (e.shift) this.selectPoints([...this.selV], [...this.selS].filter((s) => s !== hit.segment));
      else this.selectPoints([], [hit.segment]);
    }
  }

  keyDown(e: KeyInput): boolean {
    if (this.ended) return false;
    const plain = !e.mod && !e.alt;
    if (e.key === "Escape" || e.key === "Enter") {
      if (this.gesture || this.press) {
        this.cancelGesture();
        return true;
      }
      if (this.pen && this.pen.tool.activeVertex !== null) {
        this.endPenPath();
        return true;
      }
      this.leave();
      return true;
    }
    if (e.key === "Backspace" || e.key === "Delete") {
      if (this._subTool === "pen" && this.pen && this.pen.tool.activeVertex !== null) {
        if (e.key === "Backspace") this.penBackspace();
        return true;
      }
      this.deleteSelection(e.shift ? "gap" : "keep-shape");
      return true;
    }
    if (plain && !e.shift && (e.code === "KeyV" || e.code === "KeyP" || e.code === "KeyB")) {
      this.setSubTool(e.code === "KeyV" ? "select" : e.code === "KeyP" ? "pen" : "bucket");
      return true;
    }
    const dir = e.key === "ArrowLeft" ? [-1, 0] : e.key === "ArrowRight" ? [1, 0] : e.key === "ArrowUp" ? [0, -1] : e.key === "ArrowDown" ? [0, 1] : null;
    if (dir && plain) {
      const step = e.shift ? 10 : 1;
      this.nudge(dir[0]! * step, dir[1]! * step);
      return true;
    }
    if (e.mod && !e.alt && e.code === "KeyA" && !e.shift) {
      this.selectPoints(this.network.vertices.map((_, i) => i), this.network.segments.map((_, i) => i));
      return true;
    }
    if (e.mod && !e.alt && e.code === "KeyJ") {
      if (e.shift) this.disconnect();
      else this.join();
      return true;
    }
    if (e.shift && !e.mod && !e.alt && (e.code === "KeyH" || e.code === "KeyV")) {
      this.flip(e.code === "KeyH" ? "x" : "y");
      return true;
    }
    return false;
  }

  cursor(e: ToolPointer): Cursor | null {
    if (this._subTool === "bucket") return "bucket";
    if (this._subTool === "pen") {
      const pen = this.pen;
      const hit = pen ? pen.tool.preview().hover : null;
      if (pen?.tool.preview().closes) return "pen-close";
      if (hit?.kind === "segment") return "pen-add";
      return "pen";
    }
    if (this._subTool === "bend" || e.mod) return this.hover?.kind === "segment" || this.hover?.kind === "vertex" ? "bend" : "default";
    if (this.gesture?.kind === "move" || this.gesture?.kind === "handle") return "move";
    return this.hover ? "pointer" : "default";
  }

  // ── Gestures ─────────────────────────────────────────────────────────

  private beginGesture(p: Press, e: ToolPointer): void {
    void e;
    const net = this.network;
    const hit = p.hit;
    if (!hit) {
      this.gesture = { kind: "marquee", start: p.start.screen, rect: boxFromCorners(p.start.screen, p.start.screen), baseVertices: p.start.shift ? [...this.selV] : [], baseSegments: p.start.shift ? [...this.selS] : [] };
      return;
    }
    this.editor.history.begin();
    if (hit.kind === "handle") {
      this.gesture = { kind: "handle", segment: hit.segment, end: hit.end, vertex: hit.vertex };
      return;
    }
    if (p.bend && hit.kind === "segment") {
      this.gesture = { kind: "bend", segment: hit.segment, t: hit.t };
      return;
    }
    if (p.bend && hit.kind === "vertex") {
      this.gesture = { kind: "pull", vertex: hit.vertex };
      return;
    }
    // Move the selection.
    const vertices = this.movingVertices();
    if (vertices.length === 0) {
      this.editor.history.end();
      return;
    }
    const ref = hit.kind === "vertex" ? hit.vertex : vertices[0]!;
    const refStart = this.toWorld(net.vertices[ref]!);
    const origin = hit.kind === "vertex" ? refStart : this.toWorld(pointAt(segmentCubic(net, hit.segment), hit.t));
    const moving = new Set(vertices);
    const points: Point[] = [];
    net.vertices.forEach((v, i) => {
      if (!moving.has(i)) points.push(this.toWorld(v));
    });
    const parent = this.editor.doc.tree.parentOf(this._nodeId) ?? this.editor.page;
    const targets = this.editor.settings.snapping ? snapTargets(this.editor, new Set([parent]), new Set([this._nodeId])) : [];
    this.gesture = { kind: "move", vertices, ref, refStart, origin, ctx: { points, targets }, guides: [] };
  }

  private updateGesture(g: Gesture, e: ToolPointer): void {
    switch (g.kind) {
      case "marquee": {
        g.rect = boxFromCorners(g.start, e.screen);
        const sc = this.screenGeometry();
        const net = this.network;
        const inside = new Set<number>();
        sc.vertices.forEach((v, i) => {
          if (boxContainsPoint(g.rect, v)) inside.add(i);
        });
        const segs = net.segments.flatMap((s, i) => (inside.has(s.start) && inside.has(s.end) ? [i] : []));
        this.selectPoints([...new Set([...g.baseVertices, ...inside])], [...new Set([...g.baseSegments, ...segs])]);
        return;
      }
      case "move": {
        let dx = e.world.x - g.origin.x;
        let dy = e.world.y - g.origin.y;
        if (e.shift) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        // Snap the pressed point (the dragged vertex) as a whole.
        const anchor = { x: g.refStart.x + dx, y: g.refStart.y + dy };
        const s = snapPoint(this.editor, anchor, g.ctx, { snapping: this.editor.settings.snapping && !e.mod });
        const target = e.shift ? { x: dx === 0 ? g.refStart.x : s.point.x, y: dy === 0 ? g.refStart.y : s.point.y } : s.point;
        g.guides = s.guides;
        const local = this.toLocal(target);
        const cur = this.network.vertices[g.ref]!;
        const step = { x: local.x - cur.x, y: local.y - cur.y };
        if (Math.abs(step.x) < 1e-12 && Math.abs(step.y) < 1e-12) return;
        this.commit([{ op: "moveVertices", vertices: g.vertices, dx: step.x, dy: step.y }]);
        return;
      }
      case "handle": {
        const net = this.network;
        const v = net.vertices[g.vertex]!;
        const vw = this.toWorld(v);
        let d = { x: e.world.x - vw.x, y: e.world.y - vw.y };
        if (e.shift) d = constrainAngle(d, 15);
        const local = this.toLocal({ x: vw.x + d.x, y: vw.y + d.y });
        this.commit([{ op: "moveHandle", segment: g.segment, end: g.end, x: local.x - v.x, y: local.y - v.y, ...(e.alt ? { mirroring: "none" as const } : {}) }]);
        return;
      }
      case "bend": {
        const local = this.toLocal(e.world);
        this.commit([{ op: "bendSegment", segment: g.segment, t: g.t, x: local.x, y: local.y }]);
        return;
      }
      case "pull": {
        this.commit(this.pullOps(g.vertex, this.toLocal(e.world)));
        return;
      }
      case "pen":
        return;
    }
  }

  /** Ops that pull smooth handles out of a vertex towards `to` (local). */
  private pullOps(v: number, to: Point): VectorOp[] {
    const net = this.network;
    const p = net.vertices[v]!;
    const d = { x: to.x - p.x, y: to.y - p.y };
    if (Math.hypot(d.x, d.y) < 1e-9) return [];
    const ends: { segment: number; end: "start" | "end"; far: Vec }[] = [];
    net.segments.forEach((s, i) => {
      if (s.start === s.end) return;
      if (s.start === v) ends.push({ segment: i, end: "start", far: net.vertices[s.end]! });
      if (s.end === v) ends.push({ segment: i, end: "end", far: net.vertices[s.start]! });
    });
    if (ends.length === 0) return [];
    // The handle following the pointer is the one on the side it is pulled towards.
    ends.sort((a, b) => (b.far.x - p.x) * d.x + (b.far.y - p.y) * d.y - ((a.far.x - p.x) * d.x + (a.far.y - p.y) * d.y));
    const lead = ends[0]!;
    if (ends.length === 2) return [{ op: "setVertex", vertex: v, handleMirroring: "angle-length" }, { op: "moveHandle", segment: lead.segment, end: lead.end, x: d.x, y: d.y, mirroring: "angle-length" }];
    return [{ op: "moveHandle", segment: lead.segment, end: lead.end, x: d.x, y: d.y, mirroring: "none" }];
  }

  private cancelGesture(): void {
    const g = this.gesture;
    this.press = null;
    if (!g) return;
    this.gesture = null;
    if (g.kind === "marquee") this.selectPoints(g.baseVertices, g.baseSegments);
    else this.editor.history.abort();
    this.editor.emit("session", "overlay");
  }

  // ── Commits ──────────────────────────────────────────────────────────

  /**
   * Applies ops as one batch (a shape converts first). Returns false when
   * rejected. Inside a gesture the batch joins the gesture's undo step.
   */
  commit(ops: readonly VectorOp[]): boolean {
    return this.commitOps(ops) !== null;
  }

  private commitOps(ops: readonly VectorOp[]): VectorCommit | null {
    if (ops.length === 0) return null;
    const editor = this.editor;
    const old = this._nodeId;
    const converting = this.convertsOnEdit;
    const next = converting ? newId(editor.doc.random) : old;
    // The editor drops a session whose node disappears: name the new vector before the batch lands.
    this._nodeId = next;
    const r = commitVectorOps(editor, old, ops, converting ? { newId: next } : {});
    if (!r) {
      this._nodeId = old;
      return null;
    }
    if (converting) editor.select([next]);
    this.netCache = null;
    editor.emit("session", "overlay");
    return r;
  }

  // ── Editing operations (also used by the design panel and actions) ───

  addVertexAt(segment: number, t: number): void {
    const n = this.network.vertices.length;
    if (this.commit([{ op: "splitSegment", segment, t }])) this.selectPoints([n]);
  }

  toggleSmooth(v: number): void {
    const net = this.network;
    if (!net.vertices[v]) return;
    const smooth = net.segments.some((s) => (s.start === v && s.tangentStart && (s.tangentStart.x || s.tangentStart.y)) || (s.end === v && s.tangentEnd && (s.tangentEnd.x || s.tangentEnd.y)));
    this.commit([smooth ? { op: "makeCorner", vertex: v } : { op: "setMirroring", vertex: v, mirroring: "angle" }]);
  }

  /** Deletes the selected points: keeping the shape (neighbouring segments joined) or leaving a gap. */
  deleteSelection(how: "keep-shape" | "gap"): boolean {
    const vs = this.selectedVertices;
    const ss = this.selectedSegments;
    if (vs.length === 0 && ss.length === 0) return false;
    let ops: VectorOp[];
    if (vs.length > 0 && how === "keep-shape") {
      // Highest index first: deleting a vertex shifts the ones above it.
      ops = [...vs].reverse().map((v) => ({ op: "deleteVertex" as const, vertex: v }));
    } else if (vs.length > 0) {
      ops = [];
      if (ss.length) ops.push({ op: "removeSegments", segments: ss });
      ops.push({ op: "removeVertices", vertices: vs });
    } else {
      ops = [{ op: "removeSegments", segments: ss }];
    }
    const removesAll = vs.length === this.network.vertices.length && how === "gap";
    if (removesAll) {
      // Nothing would be left: delete the layer.
      this.selectPoints([]);
      const id = this._nodeId;
      this.leave();
      this.editor.history.apply([{ type: "delete", ids: [id] }]);
      this.editor.select([]);
      return true;
    }
    const ok = this.commit(ops);
    this.selectPoints([]);
    return ok;
  }

  /** Moves the selected points by a world delta (arrow keys). */
  nudge(dx: number, dy: number): void {
    const vs = this.movingVertices();
    if (vs.length === 0) return;
    const inv = invert(this.world);
    if (!inv) return;
    this.commit([{ op: "moveVertices", vertices: vs, dx: inv[0] * dx + inv[2] * dy, dy: inv[1] * dx + inv[3] * dy }]);
  }

  /**
   * Joins two selected vertices: those within a few pixels of each other
   * merge into one at their midpoint; otherwise a segment connects them
   * (filling the area it closes).
   */
  join(): boolean {
    const vs = this.selectedVertices;
    if (vs.length !== 2) return false;
    const [a, b] = vs as [number, number];
    const sc = this.screenGeometry();
    const net = this.network;
    if (distance(sc.vertices[a]!, sc.vertices[b]!) <= 8) {
      const pa = net.vertices[a]!, pb = net.vertices[b]!;
      const ok = this.commit([{ op: "setVertex", vertex: a, x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 }, { op: "mergeVertices", keep: a, remove: b }]);
      if (ok) this.selectPoints([a]);
      return ok;
    }
    if (net.segments.some((s) => (s.start === a && s.end === b) || (s.start === b && s.end === a))) return false;
    const ok = this.commit([{ op: "closePath", start: a, end: b }]);
    if (ok) this.selectPoints([a, b], [net.segments.length]);
    return ok;
  }

  /** Detaches the segments meeting at each selected vertex. */
  disconnect(): boolean {
    const vs = this.selectedVertices;
    if (vs.length === 0) return false;
    return this.commit(vs.map((v) => ({ op: "disconnectVertex" as const, vertex: v })));
  }

  /** Mirrors the selected points about their center (local axes). */
  flip(axis: "x" | "y"): boolean {
    const vs = this.movingVertices();
    if (vs.length < 2) return false;
    const net = this.network;
    let lo = Infinity, hi = -Infinity;
    for (const v of vs) {
      lo = Math.min(lo, net.vertices[v]![axis]);
      hi = Math.max(hi, net.vertices[v]![axis]);
    }
    const c = lo + hi;
    const set = new Set(vs);
    const ops: VectorOp[] = vs.map((v) => ({ op: "setVertex" as const, vertex: v, [axis]: c - net.vertices[v]![axis] }));
    const flipT = (t: Vec | undefined): Vec | null => (t && (t.x || t.y) ? (axis === "x" ? { x: -t.x, y: t.y } : { x: t.x, y: -t.y }) : null);
    const keepT = (t: Vec | undefined): Vec | null => (t && (t.x || t.y) ? { x: t.x, y: t.y } : null);
    net.segments.forEach((s, i) => {
      const a = set.has(s.start), b = set.has(s.end);
      if (!a && !b) return;
      if (!s.tangentStart && !s.tangentEnd) return;
      ops.push({ op: "setTangents", segment: i, tangentStart: a ? flipT(s.tangentStart) : keepT(s.tangentStart), tangentEnd: b ? flipT(s.tangentEnd) : keepT(s.tangentEnd) });
    });
    return this.commit(ops);
  }

  /** The common mirroring of the selected vertices (null when none are selected, "mixed" when they differ). */
  get mirroring(): HandleMirroring | "mixed" | null {
    const vs = this.selectedVertices;
    if (vs.length === 0) return null;
    const net = this.network;
    const modes = new Set(vs.map((v) => net.vertices[v]!.handleMirroring ?? "none"));
    return modes.size === 1 ? [...modes][0]! : "mixed";
  }

  setMirroring(mode: HandleMirroring): boolean {
    const vs = this.selectedVertices;
    if (vs.length === 0) return false;
    return this.commit(vs.map((v) => ({ op: "setMirroring" as const, vertex: v, mirroring: mode })));
  }

  /** The selected vertices' corner radius (their own, else the node's), or "mixed". */
  get cornerRadius(): number | "mixed" | null {
    const vs = this.selectedVertices;
    if (vs.length === 0) return null;
    const net = this.network;
    const base = this.editor.doc.typeOf(this._nodeId) === "vector" ? this.editor.doc.get<number>(this._nodeId, "cornerRadius") : 0;
    const values = new Set(vs.map((v) => net.vertices[v]!.cornerRadius ?? (typeof base === "number" ? base : 0)));
    return values.size === 1 ? [...values][0]! : "mixed";
  }

  setCornerRadius(fn: (old: number) => number): boolean {
    const vs = this.selectedVertices;
    if (vs.length === 0) return false;
    const net = this.network;
    return this.commit(vs.map((v) => ({ op: "setVertex" as const, vertex: v, cornerRadius: Math.max(0, fn(net.vertices[v]!.cornerRadius ?? 0)) })));
  }

  /**
   * Position of the selected points' bounds in the node's parent space (what
   * the design panel shows), or null.
   */
  pointPosition(): { x: number; y: number } | null {
    const vs = this.movingVertices();
    if (vs.length === 0) return null;
    const net = this.network;
    const inv = invert(this.editor.geometry.parentSpace(this._nodeId));
    if (!inv) return null;
    const m = multiply(inv, this.world);
    let x = Infinity, y = Infinity;
    for (const v of vs) {
      const p = transformPoint(m, net.vertices[v]!.x, net.vertices[v]!.y);
      x = Math.min(x, p.x);
      y = Math.min(y, p.y);
    }
    return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
  }

  /** Moves the selected points so their bounds' x (or y) in parent space becomes `value`. */
  setPointPosition(axis: "x" | "y", value: number): boolean {
    const pos = this.pointPosition();
    if (!pos || !Number.isFinite(value)) return false;
    const d = value - pos[axis];
    if (Math.abs(d) < 1e-9) return false;
    const ps = this.editor.geometry.parentSpace(this._nodeId);
    const wd = axis === "x" ? { x: ps[0] * d, y: ps[1] * d } : { x: ps[2] * d, y: ps[3] * d };
    this.nudge(wd.x, wd.y);
    return true;
  }

  // ── Paint bucket ─────────────────────────────────────────────────────

  private faceUnder(world: Point): { face: NetworkFace; filled: boolean } | null {
    const net = this.network;
    if (net.segments.length === 0) return null;
    const p = this.toLocal(world);
    const face = faceAt(net, p.x, p.y, facesOf(net));
    if (!face) return null;
    const key = (ls: readonly (readonly number[])[]): string => ls.map((l) => [...l].sort((a, b) => a - b).join(",")).sort().join("|");
    const k = key(face.loops);
    return { face, filled: net.regions.some((r) => key(r.loops) === k) };
  }

  private bucketClick(e: ToolPointer): boolean {
    const f = this.faceUnder(e.world);
    if (!f) return !this.otherLayerAt(e);
    const p = this.toLocal(e.world);
    this.commit([{ op: "toggleFill", x: p.x, y: p.y }]);
    this.hoverFace = this.faceUnder(e.world);
    return true;
  }

  // ── Pen ──────────────────────────────────────────────────────────────

  /** The pen's state, (re)started from the stored network when someone else changed it. */
  private penState(): PenState {
    const net = this.network;
    const st = this.pen;
    if (st && st.expected === net) return st;
    const tool = new PenTool<Network>(net, { hitRadius: 1 });
    this.pen = { tool, frame: this.world, offset: { x: 0, y: 0 }, expected: net, steps: [], step: null, guides: [], targets: null };
    return this.pen;
  }

  private toPenSpace(st: PenState, world: Point): Point {
    const inv = invert(st.frame);
    return inv ? transformPoint(inv, world.x, world.y) : world;
  }

  /** The pointer snapped for the pen (to vertices, layers and pixels), in world space. */
  private penSnapped(st: PenState, e: ToolPointer): Point {
    if (e.mod) {
      st.guides = [];
      return e.world;
    }
    if (!st.targets) {
      const parent = this.editor.doc.tree.parentOf(this._nodeId) ?? this.pendingCreate?.parent ?? this.editor.page;
      st.targets = this.editor.settings.snapping ? snapTargets(this.editor, new Set([parent]), new Set([this._nodeId])) : [];
    }
    const points = st.tool.network.vertices.map((v) => transformPoint(st.frame, v.x, v.y));
    const s = snapPoint(this.editor, e.world, { points, targets: st.targets });
    st.guides = s.guides;
    return s.point;
  }

  private penHitRadius(st: PenState): void {
    const scale = this.editor.viewport.scale * maxScale(st.frame);
    st.tool.setHitRadius(VERTEX_HIT / (scale || 1));
  }

  private penDown(e: ToolPointer): boolean {
    const editor = this.editor;
    editor.history.begin();
    const depthBefore = editor.history.undoDepth;
    if (this.pendingCreate) {
      if (!this.createVector(e.world)) {
        editor.history.end();
        return true;
      }
      this.createdAtDepth = depthBefore;
    }
    const st = this.penState();
    this.penHitRadius(st);
    const snapped = this.penSnapped(st, e);
    st.step = { recorded: false, depthAfter: depthBefore, offset: { ...st.offset } };
    st.tool.pointerDown(this.toPenSpace(st, snapped), { shift: e.shift, alt: e.alt });
    this.flushPen(st);
    this.gesture = { kind: "pen" };
    return true;
  }

  private penMove(e: ToolPointer): void {
    const st = this.pen && this.pen.expected === this.network ? this.pen : this.pendingCreate ? null : this.penState();
    if (!st) return;
    this.penHitRadius(st);
    if (st.tool.dragging) {
      st.guides = [];
      st.tool.pointerMove(this.toPenSpace(st, e.world), { shift: e.shift, alt: e.alt });
      this.flushPen(st);
    } else {
      st.tool.pointerMove(this.toPenSpace(st, this.penSnapped(st, e)), { shift: e.shift, alt: e.alt });
    }
  }

  private penUp(e: ToolPointer): void {
    const st = this.pen;
    if (!st || this.gesture?.kind !== "pen") return;
    this.gesture = null;
    const r = st.tool.pointerUp(this.toPenSpace(st, e.world), { shift: e.shift, alt: e.alt });
    this.flushPen(st);
    this.editor.history.end();
    const step = st.step;
    st.step = null;
    if (step) {
      step.depthAfter = this.editor.history.undoDepth;
      st.steps.push(step);
    }
    if (r.ended) st.steps.length = 0;
    const active = st.tool.activeVertex;
    if (active !== null) this.selectPoints([active]);
    st.targets = null;
    this.editor.emit("session", "overlay");
  }

  /** Writes the pen's latest operations to the document. */
  private flushPen(st: PenState): void {
    const ops = st.tool.takeOps();
    if (ops.length === 0) return;
    const translated = ops.map((op) => translateOp(op as VectorOp, -st.offset.x, -st.offset.y));
    const r = this.commitOps(translated);
    if (!r) {
      // Out of sync (should not happen): start over from the document.
      this.pen = null;
      return;
    }
    if (st.step) st.step.recorded = true;
    st.offset = { x: st.offset.x + r.shift.x, y: st.offset.y + r.shift.y };
    st.expected = this.network;
  }

  private endPenPath(): void {
    const st = this.pen;
    if (!st) return;
    st.tool.keyDown("Escape");
    st.tool.takeOps();
    st.steps.length = 0;
    this.selectPoints([]);
    this.editor.emit("session", "overlay");
  }

  /** Backspace while drawing: takes the last point back (its undo step is reverted, leaving no redo). */
  private penBackspace(): void {
    const st = this.pen;
    if (!st) return;
    const step = st.steps.pop();
    st.tool.keyDown("Backspace");
    st.tool.takeOps();
    if (!step || !step.recorded) return;
    if (this.editor.history.revertLast(step.depthAfter)) {
      st.offset = step.offset;
      st.expected = this.network;
    } else {
      // The step is no longer the latest: write the pen's network back instead.
      const net = st.tool.network;
      const stored = clean({ ...net, vertices: net.vertices.map((v) => ({ ...v, x: v.x - st.offset.x, y: v.y - st.offset.y })) });
      this.editor.history.apply(replaceNetworkCommands(this.editor, this._nodeId, stored));
      this.pen = null;
    }
    const active = st.tool.activeVertex;
    this.selectPoints(active !== null ? [active] : []);
  }

  /** Creates the vector the pen draws (at the first click). */
  private createVector(world: Point): boolean {
    const c = this.pendingCreate!;
    const editor = this.editor;
    const ps = c.parent === editor.page ? null : editor.geometry.worldMatrix(c.parent);
    const inv = ps ? invert(ps) : null;
    const snapped = editor.settings.pixelSnap ? { x: Math.round(world.x), y: Math.round(world.y) } : world;
    const local = inv ? transformPoint(inv, snapped.x, snapped.y) : snapped;
    const cmds: Command[] = [
      {
        type: "createNode",
        node: { id: c.id, type: "vector", props: { name: nextName(editor, "vector"), x: local.x, y: local.y, width: 0, height: 0, fills: [gray], strokes: [black], strokeWeight: 1, vectorNetwork: { vertices: [], segments: [], regions: [] } } },
        parent: c.parent,
      },
    ];
    if (!editor.history.apply(cmds)) return false;
    this.pendingCreate = null;
    editor.select([c.id]);
    return true;
  }

  // ── Leaving ──────────────────────────────────────────────────────────

  /** Leaves the mode with the vector selected (and the select tool, when the pen tool started it). */
  private leave(): void {
    const editor = this.editor;
    const id = this._nodeId;
    editor.exitEditMode();
    if (editor.doc.has(id)) editor.select([id]);
    if (this.fromPenTool && editor.tool.id === "pen") editor.setTool("select");
  }

  exit(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.gesture && this.gesture.kind !== "marquee") this.editor.history.end();
    if (this.pen && this.pen.tool.activeVertex !== null) this.pen.tool.keyDown("Escape");
    this.gesture = null;
    this.press = null;
    for (const off of this.anchorOffs.values()) off();
    this.anchorOffs.clear();
    // A vector the pen created that never got a segment is taken back.
    const doc = this.editor.doc;
    if (this.fromPenTool && this.createdAtDepth !== null && doc.has(this._nodeId) && doc.typeOf(this._nodeId) === "vector") {
      const net = doc.get<Network>(this._nodeId, "vectorNetwork");
      if (net.segments.length === 0) {
        // Normally the creating click is the latest step: revert it. Otherwise delete the empty vector.
        if (!(this.editor.history.undoDepth === this.createdAtDepth + 1 && this.editor.history.revertLast(this.createdAtDepth + 1)) && doc.has(this._nodeId)) {
          this.editor.history.apply([{ type: "delete", ids: [this._nodeId] }]);
        }
      }
    }
  }

  // ── Overlay ──────────────────────────────────────────────────────────

  /** Whether a world point is inside the node's box (double-click there stays in the mode). */
  private insideNode(world: Point): boolean {
    const p = this.toLocal(world);
    const { width, height } = this.editor.geometry.size(this._nodeId);
    const pad = 8 / this.editor.viewport.scale;
    return p.x >= -pad && p.y >= -pad && p.x <= width + pad && p.y <= height + pad;
  }

  overlay(out: OverlayItem[]): void {
    if (this.ended) return;
    const editor = this.editor;
    const doc = editor.doc;
    if (!doc.has(this._nodeId) && !this.pendingCreate) return;
    const sc = this.screenGeometry();
    const net = sc.net;
    const vp = editor.viewport;
    if (this.hoverFace && this._subTool === "bucket") {
      const contours = this.hoverFace.face.loops.map((loop) => loopScreen(net, loop, sc.matrix));
      out.push({ kind: "region", role: this.hoverFace.filled ? "region-hover-filled" : "region-hover", contours });
    }
    if (sc.polylines.length) out.push({ kind: "path", role: "vector", contours: sc.polylines });
    const selSegs = this.selectedSegments;
    if (selSegs.length) out.push({ kind: "path", role: "vector-selected", contours: selSegs.map((s) => sc.polylines[s]!) });
    const hv = this.hover;
    if (hv?.kind === "segment" && !this.gesture && this._subTool !== "pen" && sc.polylines[hv.segment]) out.push({ kind: "path", role: "vector-hover", contours: [sc.polylines[hv.segment]!] });
    // Snap guides of a move or of the pen.
    const guides = this.gesture?.kind === "move" ? this.gesture.guides : this._subTool === "pen" && this.pen ? this.pen.guides : [];
    for (const guide of guides) {
      const a = guide.axis === "x" ? { x: guide.at, y: guide.from } : { x: guide.from, y: guide.at };
      const b = guide.axis === "x" ? { x: guide.at, y: guide.to } : { x: guide.to, y: guide.at };
      out.push({ kind: "line", role: "snap", from: vp.toScreen(a), to: vp.toScreen(b) });
    }
    // Handles.
    for (const h of this.visibleHandles()) {
      const v = sc.vertices[h.vertex]!;
      const hp = this.handleScreen(h);
      out.push({ kind: "line", role: "handle", from: v, to: hp });
      out.push({ kind: "handle", id: `canvas.vector.handle.${h.segment}.${h.end}`, center: hp, shape: "diamond", size: 7 });
    }
    // The pen's preview: the next segment and the handles being pulled.
    if (this._subTool === "pen" && this.pen && this.pen.expected === net) {
      const st = this.pen;
      const pv = st.tool.preview();
      const m = multiply(vp.matrix, st.frame);
      if (pv.segment) out.push({ kind: "path", role: "pen-preview", contours: [cubicPolyline(transformCubic(pv.segment, m))] });
      for (const h of pv.handles) {
        const a = transformPoint(m, h.from.x, h.from.y);
        const b = transformPoint(m, h.to.x, h.to.y);
        out.push({ kind: "line", role: "handle", from: a, to: b });
        out.push({ kind: "handle", id: "canvas.vector.pen.handle", center: b, shape: "diamond", size: 7 });
      }
      const pending = st.tool.pendingHandle;
      const active = st.tool.activeVertex;
      if (pending && active !== null && !st.tool.dragging) {
        const v = st.tool.network.vertices[active]!;
        const a = transformPoint(m, v.x, v.y);
        const b = transformPoint(m, v.x + pending.x, v.y + pending.y);
        out.push({ kind: "line", role: "handle", from: a, to: b });
        out.push({ kind: "handle", id: "canvas.vector.pen.pending", center: b, shape: "diamond", size: 7 });
      }
      if (pv.hover?.kind === "segment") {
        const p = transformPoint(m, pv.hover.point.x, pv.hover.point.y);
        out.push({ kind: "handle", id: "canvas.vector.pen.add", center: p, shape: "circle", size: 7, color: "#2563eb" });
      }
    }
    // Vertices.
    const selV = this.selV;
    const firstOfPath = this.pen?.tool.pathStartVertex ?? null;
    const n = Math.min(sc.vertices.length, MAX_DRAWN_POINTS);
    for (let i = 0; i < n; i++) {
      const selected = selV.has(i);
      const hovered = hv?.kind === "vertex" && hv.vertex === i;
      const big = this._subTool === "pen" && i === firstOfPath;
      out.push({ kind: "handle", id: `canvas.vector.vertex.${i}`, center: sc.vertices[i]!, shape: "circle", size: big || hovered ? 9 : 7, ...(selected ? { color: "#2563eb" } : {}) });
    }
    if (this.gesture?.kind === "marquee") {
      const r = this.gesture.rect;
      out.push({ kind: "rect", role: "marquee", points: [{ x: r.x, y: r.y }, { x: r.x + r.width, y: r.y }, { x: r.x + r.width, y: r.y + r.height }, { x: r.x, y: r.y + r.height }] });
    }
    if (this.convertsOnEdit) {
      const b = editor.geometry.bounds(this._nodeId);
      const at = vp.toScreen({ x: b.x + b.width / 2, y: b.y + b.height });
      out.push({ kind: "label", role: "size", at: { x: at.x, y: at.y + 22 }, text: `Editing points turns this ${doc.typeOf(this._nodeId)} into a vector` });
    }
    this.syncAnchors(sc);
  }

  // ── Anchors ──────────────────────────────────────────────────────────

  /**
   * Registers the canvas controls of the mode (vertices, segment midpoints,
   * visible handles) with the anchor registry, so agents can point at them.
   */
  private syncAnchors(sc: ScreenCache): void {
    const wanted = new Map<string, { label: string; at: () => Point | null }>();
    const nv = Math.min(sc.vertices.length, MAX_ANCHORS);
    for (let i = 0; i < nv; i++) wanted.set(`canvas.vector.vertex.${i}`, { label: `vertex ${i}`, at: () => this.screenGeometry().vertices[i] ?? null });
    const ns = Math.min(sc.cubics.length, MAX_ANCHORS);
    for (let i = 0; i < ns; i++) {
      wanted.set(`canvas.vector.segment.${i}`, {
        label: `segment ${i}`,
        at: () => {
          const c = this.screenGeometry().cubics[i];
          return c ? pointAt(c, 0.5) : null;
        },
      });
    }
    for (const h of this.visibleHandles().slice(0, MAX_ANCHORS)) {
      wanted.set(`canvas.vector.handle.${h.segment}.${h.end}`, {
        label: `handle ${h.end} of segment ${h.segment}`,
        at: () => (this.visibleHandles().some((x) => x.segment === h.segment && x.end === h.end) ? this.handleScreen(h) : null),
      });
    }
    if (this._subTool === "pen" && this.pen) {
      // The outgoing handle of the point being drawn, while it shows.
      wanted.set("canvas.vector.pen.pending", {
        label: "outgoing handle of the point being drawn",
        at: () => {
          const st = this.pen;
          const h = st?.tool.pendingHandle;
          const a = st?.tool.activeVertex;
          if (!st || !h || a === null || a === undefined) return null;
          const v = st.tool.network.vertices[a]!;
          return transformPoint(multiply(this.editor.viewport.matrix, st.frame), v.x + h.x, v.y + h.y);
        },
      });
    }
    for (const [id, off] of this.anchorOffs) {
      if (!wanted.has(id)) {
        off();
        this.anchorOffs.delete(id);
      }
    }
    for (const [id, w] of wanted) {
      if (this.anchorOffs.has(id)) continue;
      this.anchorOffs.set(id, this.editor.anchors.register(id, "handle", w.label, () => this.anchorRect(w.at())));
    }
  }

  private anchorRect(p: Point | null): AnchorRect | null {
    if (!p || this.ended) return null;
    const o = this.editor.canvasOrigin();
    const size = 10;
    return { x: p.x - size / 2 + o.x, y: p.y - size / 2 + o.y, width: size, height: size };
  }

  /** The current gesture, for tests. */
  get gestureKind(): Gesture["kind"] | null {
    return this.gesture?.kind ?? null;
  }

  /** The pen's preview, for tests and the overlay. */
  get penActive(): boolean {
    return !!this.pen && this.pen.tool.activeVertex !== null;
  }
}

/** A screen cubic as a polyline (0.25 px tolerance). */
function cubicPolyline(c: Cubic): Point[] {
  if (c.line) return [{ x: c.x0, y: c.y0 }, { x: c.x3, y: c.y3 }];
  const p = new Path().moveTo(c.x0, c.y0).cubicTo(c.x1, c.y1, c.x2, c.y2, c.x3, c.y3);
  const f = flattenPath(p, [1, 0, 0, 1, 0, 0], 0.25);
  const out: Point[] = [];
  for (let i = 0; i < f.points.length / 2; i++) out.push({ x: f.points[i * 2]!, y: f.points[i * 2 + 1]! });
  return out;
}

function loopScreen(net: Network, loop: readonly number[], m: Mat2D): Point[] {
  const out: Point[] = [];
  const segs = net.segments;
  // Walk the loop in order (each segment forwards or backwards).
  let at: number | null = null;
  loop.forEach((s, i) => {
    const seg = segs[s]!;
    let forward = true;
    if (i === 0) {
      const next = segs[loop[1] ?? s]!;
      forward = loop.length === 1 || seg.end === next.start || seg.end === next.end;
    } else forward = seg.start === at;
    const c = transformCubic(segmentCubic(net, s, forward), m);
    const pts = cubicPolyline(c);
    out.push(...(out.length ? pts.slice(1) : pts));
    at = forward ? seg.end : seg.start;
  });
  return out;
}

