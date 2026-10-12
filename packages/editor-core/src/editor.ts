import { AssetStore, type FigDocument, type SceneBridge } from "@fig-tree/document";
import type { Point } from "@fig-tree/geometry";
import { AnchorRegistry, type AnchorRect } from "./anchors";
import { runAction, actionEnabled } from "./actions";
import { CanvasGeometry } from "./geometry";
import { History } from "./history";
import { actionFor, type KeyInput, type Platform } from "./keymap";
import { LocalPresence } from "./presence";
import { normalizeSelection } from "./selection";
import { handleRect, type OverlayItem } from "./overlay";
import { buildOverlay } from "./overlay-build";
import { EditModeRegistry, ToolRegistry, type Cursor, type EditSession, type Tool, type ToolPointer } from "./tools/tool";
import { registerBuiltinTools } from "./tools/builtin";
import { TextEditMode } from "./text/mode";
import { Viewport } from "./viewport";

/** A pointer event as the host reports it: canvas CSS pixels and modifier state. */
export interface PointerInput {
  readonly x: number;
  readonly y: number;
  readonly button?: number;
  readonly shift?: boolean;
  readonly alt?: boolean;
  /** ⌘ on macOS, Ctrl elsewhere. */
  readonly mod?: boolean;
  readonly clickCount?: number;
}

export interface WheelInput {
  readonly x: number;
  readonly y: number;
  readonly deltaX: number;
  readonly deltaY: number;
  /** Ctrl or ⌘ held, or a trackpad pinch (browsers report pinches as ctrl-wheel). */
  readonly zoom: boolean;
  readonly shift?: boolean;
}

export type EditorChange = "view" | "selection" | "hover" | "overlay" | "tool" | "document" | "page" | "settings" | "session";

export interface EditorSettings {
  /** Smart guides: snap to siblings, the parent and equal spacing. */
  snapping: boolean;
  /** Round positions and sizes to whole pixels. */
  pixelSnap: boolean;
  /** Draw the pixel grid at high zoom (800% and above). */
  pixelGrid: boolean;
  rulers: boolean;
}

export interface EditorOptions {
  /** Id of the local user's actor (undo is per actor). Default `local-user`. */
  readonly actorId?: string;
  readonly platform?: Platform;
  /** Bytes of the document's assets (images placed by the user land here). */
  readonly assets?: AssetStore;
  /** Width of overlay label text in CSS px (the host passes canvas `measureText`). */
  readonly measureText?: (text: string) => number;
}

/** Screen distance (CSS px) a press must travel before it becomes a drag. */
export const DRAG_THRESHOLD = 3;
/** Snap distance in CSS px. */
export const SNAP_DISTANCE = 6;

/**
 * The editor: framework-free state and behaviour for one document view.
 * The host (React in apps/editor) forwards input, draws {@link overlay}
 * over the GPU canvas, renders the scene when the view or document changes,
 * and builds panels from the state here. Every edit goes through
 * {@link history} (the command API with the user's actor).
 */
export class Editor {
  readonly geometry: CanvasGeometry;
  readonly viewport = new Viewport();
  readonly presence: LocalPresence;
  readonly history: History;
  readonly anchors = new AnchorRegistry();
  readonly tools = new ToolRegistry();
  readonly editModes = new EditModeRegistry();
  readonly platform: Platform;
  readonly assets: AssetStore;
  readonly measureText: (text: string) => number;
  settings: EditorSettings = { snapping: true, pixelSnap: true, pixelGrid: true, rulers: false };

  private _tool: Tool;
  private _session: EditSession | null = null;
  private readonly listeners = new Set<(changes: ReadonlySet<EditorChange>) => void>();
  private pending = new Set<EditorChange>();
  private batchDepth = 0;
  private readonly disposers: (() => void)[] = [];
  /** Alt is held: hovering measures distances from the selection. */
  measuring = false;
  /** Space is held: drags pan the canvas. */
  spaceHeld = false;
  private pan: { last: Point } | null = null;
  /** The last pointer position on the canvas. */
  lastPointer: ToolPointer | null = null;
  /** Client-space origin of the canvas (for anchor rects); the host sets it. */
  canvasOrigin: () => { x: number; y: number } = () => ({ x: 0, y: 0 });
  /** Overlay items of the last {@link overlay} call (handles are anchors). */
  private lastOverlay: OverlayItem[] = [];
  /** Bumped when the overlay must be redrawn. */
  overlayVersion = 0;
  /** Bumped on document changes seen by the editor. */
  docVersion = 0;
  /** Called when the user asks for something the host provides (file picker, rename field, shortcuts sheet). */
  onRequest: ((request: EditorRequest) => void) | null = null;

  constructor(
    readonly doc: FigDocument,
    readonly bridge: SceneBridge,
    options: EditorOptions = {},
  ) {
    this.geometry = new CanvasGeometry(doc, bridge);
    this.presence = new LocalPresence(bridge.page);
    this.history = new History(doc, doc.actor(options.actorId ?? "local-user"));
    this.platform = options.platform ?? "other";
    this.assets = options.assets ?? new AssetStore();
    this.measureText = options.measureText ?? ((t) => t.length * 6.5);
    registerBuiltinTools(this);
    this.editModes.register(new TextEditMode());
    this._tool = this.tools.get("select")!;
    this.disposers.push(
      doc.onChange((change) => {
        this.docVersion++;
        // Drop selected nodes that were deleted (by anyone) or moved to another page.
        const sel = normalizeSelection(doc, this.selection, this.page);
        this.batch(() => {
          if (sel.length !== this.selection.length) this.select(sel);
          if (this.presence.hover && !doc.has(this.presence.hover)) this.presence.setHover(null);
          if (this._session && !doc.has(this._session.nodeId)) this.exitEditMode();
          this.emit("document", "overlay");
        });
        void change;
      }),
      this.presence.subscribe((_s, changed) => {
        if (changed.has("selection")) this.emit("selection", "overlay");
        if (changed.has("hover")) this.emit("hover", "overlay");
        if (changed.has("page")) this.emit("page");
        if (changed.has("text")) this.emit("overlay");
      }),
    );
    this.registerHandleAnchors();
  }

  dispose(): void {
    this.exitEditMode();
    for (const d of this.disposers) d();
    this.listeners.clear();
  }

  // ── Change notification ──────────────────────────────────────────────

  /** Listens for state changes (batched per input event). */
  subscribe(listener: (changes: ReadonlySet<EditorChange>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(...kinds: EditorChange[]): void {
    for (const k of kinds) this.pending.add(k);
    if (kinds.includes("overlay") || kinds.includes("view") || kinds.includes("selection") || kinds.includes("hover")) this.overlayVersion++;
    if (this.batchDepth === 0) this.flush();
  }

  /** Runs `fn` and sends one notification for everything it changed. */
  batch<T>(fn: () => T): T {
    this.batchDepth++;
    try {
      return fn();
    } finally {
      if (--this.batchDepth === 0) this.flush();
    }
  }

  private flush(): void {
    if (this.pending.size === 0) return;
    const changes = this.pending;
    this.pending = new Set();
    for (const l of this.listeners) l(changes);
  }

  // ── State ────────────────────────────────────────────────────────────

  get page(): string {
    return this.bridge.page;
  }

  get selection(): readonly string[] {
    return this.presence.selection;
  }

  get hover(): string | null {
    return this.presence.hover;
  }

  get tool(): Tool {
    return this._tool;
  }

  get session(): EditSession | null {
    return this._session;
  }

  /** Selects nodes (ids not on this page are dropped). */
  select(ids: readonly string[]): void {
    this.presence.setSelection(normalizeSelection(this.doc, ids, this.page));
  }

  setHover(id: string | null): void {
    this.presence.setHover(id);
  }

  /** Shows another page. */
  setPage(id: string): void {
    if (id === this.page || this.doc.typeOf(id) !== "page") return;
    this.batch(() => {
      this.exitEditMode();
      this.bridge.setPage(id);
      this.presence.update({ page: id, selection: [], hover: null });
      this.emit("page", "document", "overlay");
    });
  }

  setTool(id: string): void {
    const next = this.tools.get(id);
    if (!next) return;
    this.batch(() => {
      this.exitEditMode();
      if (next === this._tool) return;
      this._tool.cancel?.(this);
      this._tool.deactivate?.(this);
      this._tool = next;
      next.activate?.(this);
      this.emit("tool", "overlay");
    });
  }

  updateSettings(patch: Partial<EditorSettings>): void {
    this.settings = { ...this.settings, ...patch };
    this.emit("settings", "overlay");
  }

  // ── Edit modes ───────────────────────────────────────────────────────

  /** Enters the edit mode registered for a node's type (text editing, vector editing). */
  enterEditMode(id: string, at?: ToolPointer): boolean {
    const type = this.doc.typeOf(id);
    if (!type) return false;
    const mode = this.editModes.forType(type);
    if (!mode) return false;
    this.exitEditMode();
    const session = mode.enter(this, id, at);
    if (!session) return false;
    this._session = session;
    this.select([id]);
    this.emit("session", "overlay");
    return true;
  }

  exitEditMode(): void {
    const s = this._session;
    if (!s) return;
    this._session = null;
    s.exit();
    this.presence.update({ text: null });
    this.emit("session", "overlay");
  }

  // ── Input ────────────────────────────────────────────────────────────

  toPointer(raw: PointerInput): ToolPointer {
    const screen = { x: raw.x, y: raw.y };
    return {
      screen,
      world: this.viewport.toWorld(screen),
      button: raw.button ?? 0,
      shift: raw.shift ?? false,
      alt: raw.alt ?? false,
      mod: raw.mod ?? false,
      clickCount: raw.clickCount ?? 1,
    };
  }

  pointerDown(raw: PointerInput): void {
    const e = this.toPointer(raw);
    this.lastPointer = e;
    this.batch(() => {
      if (e.button === 1 || (this.spaceHeld && e.button === 0)) {
        this.pan = { last: e.screen };
        this.emit("overlay");
        return;
      }
      if (this._session) {
        if (this._session.pointerDown(e)) return;
        this.exitEditMode();
      }
      this._tool.pointerDown(this, e);
    });
  }

  pointerMove(raw: PointerInput): void {
    const e = this.toPointer(raw);
    this.lastPointer = e;
    this.batch(() => {
      this.presence.update({ cursor: { x: e.world.x, y: e.world.y } });
      if (this.pan) {
        this.viewport.panBy(e.screen.x - this.pan.last.x, e.screen.y - this.pan.last.y);
        this.pan = { last: e.screen };
        this.emit("view");
        return;
      }
      if (this._session) {
        this._session.pointerMove(e);
        this.emit("overlay");
        return;
      }
      this._tool.pointerMove(this, e);
      if (this.measuring) this.emit("overlay");
    });
  }

  pointerUp(raw: PointerInput): void {
    const e = this.toPointer(raw);
    this.lastPointer = e;
    this.batch(() => {
      if (this.pan) {
        this.pan = null;
        this.emit("overlay");
        return;
      }
      if (this._session) {
        this._session.pointerUp(e);
        this.emit("overlay");
        return;
      }
      this._tool.pointerUp(this, e);
    });
  }

  /** The pointer left the canvas. */
  pointerLeave(): void {
    this.batch(() => {
      this.presence.update({ cursor: null });
      if (!this._tool.busy?.()) this.setHover(null);
    });
  }

  wheel(w: WheelInput): void {
    this.batch(() => {
      if (w.zoom) {
        const factor = Math.exp(-w.deltaY * 0.01);
        this.viewport.zoomBy(factor, { x: w.x, y: w.y });
      } else if (w.shift && w.deltaX === 0) {
        this.viewport.panBy(-w.deltaY, 0);
      } else {
        this.viewport.panBy(-w.deltaX, -w.deltaY);
      }
      this.emit("view");
    });
  }

  /** A key press. Returns true when the editor used it (the host then prevents the default). */
  keyDown(e: KeyInput): boolean {
    return this.batch(() => {
      if (this._session && this._session.keyDown(e)) {
        this.emit("overlay");
        return true;
      }
      if (e.key === "Alt" || e.code === "AltLeft" || e.code === "AltRight") {
        if (!this.measuring) {
          this.measuring = true;
          this.emit("overlay");
        }
        return true;
      }
      if (e.code === "Space" && !e.mod && !e.alt) {
        if (!this.spaceHeld) {
          this.spaceHeld = true;
          this.emit("overlay");
        }
        return true;
      }
      if (this._tool.keyDown?.(this, e)) return true;
      if (e.key === "Escape" && this._tool.cancel?.(this)) return true;
      const action = actionFor(e);
      if (!action) return false;
      return this.run(action);
    });
  }

  keyUp(e: KeyInput): void {
    this.batch(() => {
      if (e.key === "Alt" || e.code === "AltLeft" || e.code === "AltRight") {
        this.measuring = false;
        this.emit("overlay");
      }
      if (e.code === "Space") {
        this.spaceHeld = false;
        this.pan = null;
        this.emit("overlay");
      }
      this._tool.keyUp?.(this, e);
    });
  }

  /** The window lost focus: modifier keys may have been released unseen. */
  blur(): void {
    this.batch(() => {
      this.measuring = false;
      this.spaceHeld = false;
      this.pan = null;
      this.emit("overlay");
    });
  }

  // ── Actions ──────────────────────────────────────────────────────────

  /** Runs an action by id (see keymap and actions). Returns false when it does not apply. */
  run(action: string): boolean {
    return this.batch(() => runAction(this, action));
  }

  /** Whether an action applies to the current state (for menus). */
  canRun(action: string): boolean {
    return actionEnabled(this, action);
  }

  /** Asks the host for UI it owns. */
  request(request: EditorRequest): void {
    this.onRequest?.(request);
  }

  // ── Output ───────────────────────────────────────────────────────────

  get cursor(): Cursor {
    if (this.pan) return "grabbing";
    if (this.spaceHeld) return "grab";
    if (this._session && this.lastPointer) {
      const c = this._session.cursor?.(this.lastPointer);
      if (c) return c;
    }
    return this._tool.cursor?.(this) ?? "default";
  }

  /** The overlay to draw, in canvas CSS pixels. */
  overlay(): OverlayItem[] {
    this.lastOverlay = buildOverlay(this);
    return this.lastOverlay;
  }

  /** Screen size of the tolerance used for picking strokes and lines, in world units. */
  get pickTolerance(): number {
    return 4 / this.viewport.scale;
  }

  get snapThreshold(): number {
    return SNAP_DISTANCE / this.viewport.scale;
  }

  private registerHandleAnchors(): void {
    const ids = [
      ...["nw", "n", "ne", "e", "se", "s", "sw", "w"].map((h) => `canvas.handle.resize.${h}`),
      ...["nw", "ne", "se", "sw"].map((h) => `canvas.handle.rotate.${h}`),
      "canvas.handle.endpoint.start",
      "canvas.handle.endpoint.end",
      "canvas.handle.gradient.start",
      "canvas.handle.gradient.end",
      "canvas.handle.gradient.center",
      "canvas.handle.gradient.radiusX",
      "canvas.handle.gradient.radiusY",
    ];
    for (const id of ids) {
      const label = id.split(".").slice(2).join(" ");
      this.disposers.push(this.anchors.register(id, "handle", label, () => this.handleClientRect(id)));
    }
  }

  private handleClientRect(id: string): AnchorRect | null {
    const h = this.lastOverlay.find((i): i is Extract<OverlayItem, { kind: "handle" }> => i.kind === "handle" && i.id === id);
    if (!h) return null;
    const r = handleRect(h);
    const o = this.canvasOrigin();
    return { x: r.x + o.x, y: r.y + o.y, width: r.width, height: r.height };
  }
}

/** Things the editor asks the host UI to do. */
export type EditorRequest =
  | { readonly kind: "place-image" }
  | { readonly kind: "rename"; readonly id: string }
  | { readonly kind: "shortcuts" }
  | { readonly kind: "copy" }
  | { readonly kind: "cut" }
  | { readonly kind: "paste" };
