import type { Command, Constraints } from "@fig-tree/document";
import type { Mat2D, Point } from "@fig-tree/geometry";
import type { Editor } from "../editor";
import { DRAG_THRESHOLD } from "../editor";
import { frameBox, hitHandle, selectionFrame, type HandleInfo, type SelectionFrame } from "../handles";
import { pickPath } from "../hit-test";
import type { KeyInput } from "../keymap";
import { labelAt } from "../labels";
import { angleOf, boxContainsPoint, boxFromCorners, clean, distance, toLocal, transformPoint, type Box } from "../math";
import type { OverlayItem } from "../overlay";
import { containerAt, flowInsertIndex, layoutDisplay, reparentCommands, snapTargets } from "../placement";
import { clickTarget, marqueeSelect, selectThroughTarget } from "../selection";
import { guidesFor, snapBox, snapValue, type Guide, type SnapTarget, type SpacingMark } from "../snapping";
import {
  boxedNodes,
  capture,
  constrainChild,
  isInFlow,
  moveProps,
  placementProps,
  resizeProps,
  resizeRect,
  rotateProps,
  scaleProps,
  snapAngle,
  type Captured,
  type Handle,
  type PlacementProps,
} from "../transform";
import type { Cursor, Tool, ToolPointer } from "./tool";

/** Pressing on empty space inside a multi-selection's bounds drags the whole selection. */
const SELECTION = "\u0000selection";

interface Press {
  readonly start: ToolPointer;
  readonly target: string | null;
  readonly wasSelected: boolean;
  readonly handle: HandleInfo | null;
}

interface ChildCapture {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly constraints: Constraints;
}

type Gesture =
  | {
      readonly kind: "move";
      readonly ids: string[];
      readonly captured: Captured[];
      readonly start: Box;
      readonly origin: Point;
      readonly targets: SnapTarget[];
      readonly flowParent: string | null;
      readonly layoutParents: Set<string>;
      delta: Point;
      drop: { target: string; index: number | undefined; line: [Point, Point] | null } | null;
      guides: readonly Guide[];
      spacing: readonly SpacingMark[];
    }
  | {
      readonly kind: "resize";
      readonly frame: SelectionFrame;
      readonly handle: Handle;
      readonly captured: Captured[];
      readonly children: ChildCapture[];
      readonly aspectLocked: boolean;
      readonly axisAligned: boolean;
      readonly targets: SnapTarget[];
      guides: readonly Guide[];
    }
  | { readonly kind: "rotate"; readonly pivot: Point; readonly startAngle: number; readonly baseRotation: number; readonly captured: Captured[]; angle: number }
  | { readonly kind: "endpoint"; readonly captured: Captured; readonly endpoint: 0 | 1; readonly fixed: Point }
  | { readonly kind: "marquee"; readonly start: Point; readonly base: readonly string[]; rect: Box };

/**
 * The select tool: click, shift-click and Cmd/Ctrl deep select, double-click
 * select-through and edit modes, marquee selection, moving (with snapping,
 * alt-drag duplicate, reordering inside auto layout and dropping into
 * frames), resizing with the 8 handles and the edges (Shift keeps the
 * aspect ratio, Alt resizes from the center, Cmd/Ctrl ignores
 * constraints), rotating outside the corners (Shift snaps to 15°), line
 * endpoints, and arrow-key nudging.
 */
export class SelectTool implements Tool {
  readonly id = "select";
  readonly label = "Move";
  readonly icon = "MousePointer2";
  readonly action = "tool.select";
  readonly group = "select";
  readonly order = 0;
  private press: Press | null = null;
  private gesture: Gesture | null = null;
  private hoverHandle: HandleInfo | null = null;

  busy(): boolean {
    return this.gesture !== null;
  }

  /** The gesture in progress, for tests and the status bar. */
  get gestureKind(): Gesture["kind"] | null {
    return this.gesture?.kind ?? null;
  }

  // ── Pointer ──────────────────────────────────────────────────────────

  private pick(editor: Editor, e: ToolPointer): { path: string[] | null; target: string | null; label: boolean } {
    const label = labelAt(editor, e.screen);
    if (label) return { path: [label], target: label, label: true };
    const path = pickPath(editor.geometry, e.world, { tolerance: editor.pickTolerance });
    return { path, target: clickTarget(editor.doc, path ?? [], editor.selection, e.mod), label: false };
  }

  pointerDown(editor: Editor, e: ToolPointer): void {
    this.press = null;
    if (e.button === 2) {
      // A context click selects what is under the pointer unless it is already selected.
      const { target } = this.pick(editor, e);
      if (target && !editor.selection.includes(target)) editor.select([target]);
      return;
    }
    if (e.button !== 0) return;
    const frame = selectionFrame(editor);
    const handle = e.clickCount === 1 ? hitHandle(editor, e.screen, frame) : null;
    if (handle) {
      this.press = { start: e, target: null, wasSelected: true, handle };
      return;
    }
    const { path, target, label } = this.pick(editor, e);
    if (e.clickCount >= 2) {
      this.doubleClick(editor, e, path ?? [], label ? target : null);
      return;
    }
    const sel = editor.selection;
    const wasSelected = target !== null && sel.includes(target);
    let pressTarget = target;
    if (target === null) {
      if (frame && frame.kind === "multi" && boxContainsPoint(frameBox(frame), e.world) && !e.shift) pressTarget = SELECTION;
      else if (!e.shift) editor.select([]);
    } else if (e.shift) {
      if (!wasSelected) editor.select([...sel, target]);
    } else if (!wasSelected) {
      editor.select([target]);
    }
    this.press = { start: e, target: pressTarget, wasSelected, handle: null };
  }

  private doubleClick(editor: Editor, e: ToolPointer, path: string[], label: string | null): void {
    const doc = editor.doc;
    if (label) {
      editor.select([label]);
      editor.request({ kind: "rename", id: label });
      return;
    }
    const target = clickTarget(doc, path, editor.selection, e.mod);
    if (target && editor.selection.includes(target) && editor.editModes.forType(doc.typeOf(target)!)) {
      editor.enterEditMode(target, e);
      return;
    }
    const deeper = selectThroughTarget(doc, path, editor.selection);
    if (deeper) {
      // Going one level down; a text node reached this way goes straight into editing.
      editor.select([deeper]);
      if (doc.typeOf(deeper) === "text" && path[path.length - 1] === deeper) editor.enterEditMode(deeper, e);
      return;
    }
    if (target && editor.editModes.forType(doc.typeOf(target)!)) editor.enterEditMode(target, e);
  }

  pointerMove(editor: Editor, e: ToolPointer): void {
    const g = this.gesture;
    if (g) {
      this.update(editor, g, e);
      editor.emit("overlay");
      return;
    }
    const p = this.press;
    if (p) {
      if (distance(p.start.screen, e.screen) < DRAG_THRESHOLD) return;
      this.begin(editor, p, e);
      if (this.gesture) this.update(editor, this.gesture, e);
      editor.emit("overlay");
      return;
    }
    // Hovering.
    this.hoverHandle = hitHandle(editor, e.screen);
    if (this.hoverHandle) {
      editor.setHover(null);
      editor.emit("overlay");
      return;
    }
    const { target, path } = this.pick(editor, e);
    void path;
    editor.setHover(target);
    editor.emit("overlay");
  }

  pointerUp(editor: Editor, e: ToolPointer): void {
    const g = this.gesture;
    const p = this.press;
    this.gesture = null;
    this.press = null;
    if (g) {
      this.finish(editor, g, e);
      editor.emit("overlay");
      return;
    }
    if (!p || p.handle) return;
    // A click without a drag.
    if (p.target === SELECTION) {
      editor.select([]);
    } else if (p.target && p.wasSelected) {
      if (e.shift) editor.select(editor.selection.filter((id) => id !== p.target));
      else editor.select([p.target]);
    }
  }

  cancel(editor: Editor): boolean {
    const g = this.gesture;
    this.press = null;
    if (!g) return false;
    this.gesture = null;
    // Revert the gesture's edits (one undo step), leaving no redo behind.
    if (g.kind !== "marquee") editor.history.abort();
    else editor.select(g.base);
    editor.emit("overlay");
    return true;
  }

  cursor(editor: Editor): Cursor {
    const g = this.gesture;
    if (g?.kind === "rotate") return "rotate";
    if (g?.kind === "move") return editor.lastPointer?.alt ? "copy" : "default";
    if (this.press?.handle) return this.press.handle.cursor;
    if (this.hoverHandle) return this.hoverHandle.cursor;
    return "default";
  }

  // ── Gestures ─────────────────────────────────────────────────────────

  private begin(editor: Editor, p: Press, e: ToolPointer): void {
    const doc = editor.doc;
    const geom = editor.geometry;
    if (p.handle) {
      const frame = selectionFrame(editor);
      if (!frame) return;
      const ids = [...editor.selection];
      editor.history.begin();
      const captured = boxedNodes(doc, ids).map((id) => capture(geom, id));
      if (p.handle.kind === "rotate") {
        const pivot = transformPoint(frame.world, frame.width / 2, frame.height / 2);
        this.gesture = {
          kind: "rotate",
          pivot,
          startAngle: angleOf(p.start.world.x - pivot.x, p.start.world.y - pivot.y),
          baseRotation: frame.kind === "single" ? doc.get<number>(ids[0]!, "rotation") : 0,
          captured,
          angle: 0,
        };
      } else if (p.handle.kind === "endpoint") {
        const c = captured[0]!;
        const fixed = transformPoint(c.world, p.handle.endpoint === 1 ? 0 : c.width, 0);
        this.gesture = { kind: "endpoint", captured: c, endpoint: p.handle.endpoint!, fixed };
      } else {
        const single = frame.kind === "single";
        const id0 = ids[0]!;
        const children: ChildCapture[] = [];
        if (single && ["frame", "component", "instance"].includes(doc.typeOf(id0)!)) {
          for (const c of boxedNodes(doc, doc.tree.childrenOf(id0))) {
            if (isInFlow(doc, c)) continue;
            children.push({ id: c, x: doc.get(c, "x"), y: doc.get(c, "y"), width: doc.get(c, "width"), height: doc.get(c, "height"), constraints: doc.get(c, "constraints") });
          }
        }
        const w = frame.world;
        const axisAligned = Math.abs(w[1]) < 1e-9 && Math.abs(w[2]) < 1e-9 && w[0] > 0 && w[3] > 0;
        const parents = new Set(ids.map((id) => doc.tree.parentOf(id)!));
        this.gesture = {
          kind: "resize",
          frame,
          handle: p.handle.handle!,
          captured,
          children,
          aspectLocked: single && doc.stored(id0, "aspectRatio") !== undefined,
          axisAligned,
          targets: axisAligned && editor.settings.snapping ? snapTargets(editor, parents, new Set(ids)) : [],
          guides: [],
        };
      }
      return;
    }
    if (p.target === null) {
      this.gesture = { kind: "marquee", start: p.start.world, base: e.shift ? [...editor.selection] : [], rect: boxFromCorners(p.start.world, p.start.world) };
      return;
    }
    // Move (Alt duplicates first). Locked nodes stay put.
    let ids = editor.selection.filter((id) => !doc.get<boolean>(id, "locked"));
    if (ids.length === 0) return;
    editor.history.begin();
    if (e.alt) {
      const r = editor.history.apply([{ type: "duplicate", ids }]);
      if (r) {
        ids = r.results[0]!.created.slice(0, ids.length);
        editor.select(ids);
      }
    }
    const parents = new Set(ids.map((id) => doc.tree.parentOf(id)!));
    const allInFlow = ids.every((id) => isInFlow(doc, id));
    const layoutParents = new Set(ids.map((id) => layoutParentOf(editor, id)));
    this.gesture = {
      kind: "move",
      ids,
      captured: boxedNodes(doc, ids).map((id) => capture(geom, id)),
      start: geom.boundsOf(ids) ?? { x: p.start.world.x, y: p.start.world.y, width: 0, height: 0 },
      origin: p.start.world,
      targets: editor.settings.snapping ? snapTargets(editor, parents, new Set(ids)) : [],
      flowParent: allInFlow && parents.size === 1 ? [...parents][0]! : null,
      layoutParents,
      delta: { x: 0, y: 0 },
      drop: null,
      guides: [],
      spacing: [],
    };
  }

  private update(editor: Editor, g: Gesture, e: ToolPointer): void {
    switch (g.kind) {
      case "marquee": {
        g.rect = boxFromCorners(g.start, e.world);
        const hits = marqueeSelect(editor.geometry, g.rect, { deep: e.mod });
        editor.select([...g.base, ...hits.filter((h) => !g.base.includes(h))]);
        return;
      }
      case "move":
        return this.updateMove(editor, g, e);
      case "resize":
        return this.updateResize(editor, g, e);
      case "rotate": {
        let a = angleOf(e.world.x - g.pivot.x, e.world.y - g.pivot.y) - g.startAngle;
        if (e.shift) a = snapAngle(g.baseRotation + a) - g.baseRotation;
        g.angle = a;
        editor.history.apply(g.captured.map((c) => ({ type: "updateProps", id: c.id, props: rotateProps(c, a, g.pivot) }) as Command));
        return;
      }
      case "endpoint": {
        let p = e.world;
        if (e.shift) {
          const len = distance(g.fixed, p);
          const a = (snapAngle(angleOf(p.x - g.fixed.x, p.y - g.fixed.y), 45) * Math.PI) / 180;
          p = { x: g.fixed.x + Math.cos(a) * len, y: g.fixed.y + Math.sin(a) * len };
        } else if (editor.settings.pixelSnap) {
          p = { x: Math.round(p.x), y: Math.round(p.y) };
        }
        const len = distance(g.fixed, p);
        if (len < 1e-6) return;
        const from = g.endpoint === 1 ? g.fixed : p;
        const to = g.endpoint === 1 ? p : g.fixed;
        const ax = (to.x - from.x) / len;
        const ay = (to.y - from.y) / len;
        const world: Mat2D = [ax, ay, -ay, ax, from.x, from.y];
        editor.history.apply([{ type: "updateProps", id: g.captured.id, props: placementProps(g.captured, world, clean(len), 0) as Record<string, unknown> }]);
        return;
      }
    }
  }

  private updateMove(editor: Editor, g: Extract<Gesture, { kind: "move" }>, e: ToolPointer): void {
    let dx = e.world.x - g.origin.x;
    let dy = e.world.y - g.origin.y;
    if (e.shift) {
      if (Math.abs(dx) > Math.abs(dy)) dy = 0;
      else dx = 0;
    }
    g.guides = [];
    g.spacing = [];
    if (g.targets.length > 0 && !e.mod) {
      const moving = { ...g.start, x: g.start.x + dx, y: g.start.y + dy };
      const s = snapBox(moving, g.targets, { threshold: editor.snapThreshold });
      if (!(e.shift && dx === 0)) dx += s.dx;
      if (!(e.shift && dy === 0)) dy += s.dy;
      g.guides = s.guides;
      g.spacing = s.spacing;
    }
    if (editor.settings.pixelSnap) {
      dx = Math.round(g.start.x + dx) - g.start.x;
      dy = Math.round(g.start.y + dy) - g.start.y;
    }
    g.delta = { x: dx, y: dy };
    const skip = new Set(g.ids);
    const container = containerAt(editor, e.world, skip);
    if (g.flowParent && container === g.flowParent) {
      const { index, line } = flowInsertIndex(editor, g.flowParent, e.world, skip);
      g.drop = { target: g.flowParent, index, line };
      g.guides = [];
      g.spacing = [];
      return;
    }
    const cmds: Command[] = [];
    for (const c of g.captured) {
      if (c.inFlow) continue;
      cmds.push({ type: "updateProps", id: c.id, props: moveProps(c, dx, dy) as Record<string, unknown> });
    }
    editor.history.apply(cmds);
    if (g.layoutParents.size === 1 && g.layoutParents.has(container) && !g.flowParent) g.drop = null;
    else if (layoutDisplay(editor.doc, container)) {
      const { index, line } = flowInsertIndex(editor, container, e.world, skip);
      g.drop = { target: container, index, line };
    } else g.drop = g.layoutParents.size === 1 && g.layoutParents.has(container) ? null : { target: container, index: undefined, line: null };
  }

  private updateResize(editor: Editor, g: Extract<Gesture, { kind: "resize" }>, e: ToolPointer): void {
    const doc = editor.doc;
    let p = e.world;
    if (g.axisAligned) {
      if (g.targets.length > 0) {
        p = {
          x: g.handle.x !== 0 ? snapValue(p.x, g.targets, "x", editor.snapThreshold) : p.x,
          y: g.handle.y !== 0 ? snapValue(p.y, g.targets, "y", editor.snapThreshold) : p.y,
        };
      }
      if (editor.settings.pixelSnap) p = { x: Math.round(p.x), y: Math.round(p.y) };
    }
    const local = toLocal(g.frame.world, p);
    if (!local) return;
    const rect = resizeRect(g.frame.width, g.frame.height, g.handle, local, { aspect: e.shift || g.aspectLocked, fromCenter: e.alt });
    const cmds: Command[] = [];
    if (g.frame.kind === "single" || g.frame.kind === "line") {
      const c = g.captured[0]!;
      let props = resizeProps(c, rect);
      if (editor.settings.pixelSnap && g.axisAligned) props = roundPlacement(props);
      cmds.push({ type: "updateProps", id: c.id, props: { ...props, ...sizingModes(editor, c.id, props, g.handle) } as Record<string, unknown> });
      if (!e.mod && g.children.length > 0) {
        const before = { width: c.width, height: c.height };
        const after = { width: props.width ?? c.width, height: props.height ?? c.height };
        for (const child of g.children) {
          const next = constrainChild(child, child.constraints, before, after);
          const out: Record<string, number> = {};
          for (const k of ["x", "y", "width", "height"] as const) if (next[k] !== child[k]) out[k] = next[k];
          cmds.push({ type: "updateProps", id: child.id, props: out });
        }
      } else if (e.mod && g.children.length > 0) {
        // Ignoring constraints keeps children where they were.
        for (const child of g.children) cmds.push({ type: "updateProps", id: child.id, props: { x: child.x, y: child.y, width: child.width, height: child.height } });
      }
      g.guides = g.axisAligned && g.targets.length > 0 ? this.resizeGuides(editor, c.id, g) : [];
    } else {
      const from = frameBox(g.frame);
      const to = { x: g.frame.world[4] + rect.x, y: g.frame.world[5] + rect.y, width: rect.width, height: rect.height };
      for (const c of g.captured) {
        let props = scaleProps(c, from, to);
        if (editor.settings.pixelSnap) props = roundPlacement(props, doc.get<number>(c.id, "rotation"));
        cmds.push({ type: "updateProps", id: c.id, props: { ...props, ...sizingModes(editor, c.id, props, g.handle) } as Record<string, unknown> });
      }
      g.guides = [];
    }
    editor.history.apply(cmds);
  }

  private resizeGuides(editor: Editor, id: string, g: Extract<Gesture, { kind: "resize" }>): Guide[] {
    const b = editor.geometry.bounds(id);
    const sx = g.handle.x === 1 ? (["end"] as const) : g.handle.x === -1 ? (["start"] as const) : ([] as const);
    const sy = g.handle.y === 1 ? (["end"] as const) : g.handle.y === -1 ? (["start"] as const) : ([] as const);
    return [...(sx.length ? guidesFor(b, g.targets, "x", sx) : []), ...(sy.length ? guidesFor(b, g.targets, "y", sy) : [])];
  }

  private finish(editor: Editor, g: Gesture, e: ToolPointer): void {
    void e;
    if (g.kind === "marquee") return;
    if (g.kind === "move" && g.drop) {
      const inFlow = new Set(g.captured.filter((c) => c.inFlow).map((c) => c.id));
      const cmds = reparentCommands(editor, g.ids, g.drop.target, g.drop.index, g.delta, inFlow);
      editor.history.apply(cmds);
    }
    editor.history.end();
  }

  // ── Keyboard ─────────────────────────────────────────────────────────

  keyDown(editor: Editor, e: KeyInput): boolean {
    const dir = e.key === "ArrowLeft" ? [-1, 0] : e.key === "ArrowRight" ? [1, 0] : e.key === "ArrowUp" ? [0, -1] : e.key === "ArrowDown" ? [0, 1] : null;
    if (!dir || e.mod || e.alt) return false;
    if (editor.selection.length === 0) return false;
    nudge(editor, dir[0]! * (e.shift ? 10 : 1), dir[1]! * (e.shift ? 10 : 1));
    return true;
  }

  // ── Overlay ──────────────────────────────────────────────────────────

  overlay(editor: Editor, out: OverlayItem[]): void {
    const g = this.gesture;
    if (!g) return;
    const vp = editor.viewport;
    if (g.kind === "marquee") {
      const r = g.rect;
      out.push({ kind: "rect", role: "marquee", points: [vp.toScreen({ x: r.x, y: r.y }), vp.toScreen({ x: r.x + r.width, y: r.y }), vp.toScreen({ x: r.x + r.width, y: r.y + r.height }), vp.toScreen({ x: r.x, y: r.y + r.height })] });
      return;
    }
    if (g.kind === "move" || g.kind === "resize") {
      for (const guide of g.guides) {
        const a = guide.axis === "x" ? { x: guide.at, y: guide.from } : { x: guide.from, y: guide.at };
        const b = guide.axis === "x" ? { x: guide.at, y: guide.to } : { x: guide.to, y: guide.at };
        out.push({ kind: "line", role: "snap", from: vp.toScreen(a), to: vp.toScreen(b) });
      }
    }
    if (g.kind === "move") {
      for (const m of g.spacing) {
        const a = m.axis === "x" ? { x: m.start, y: m.cross } : { x: m.cross, y: m.start };
        const b = m.axis === "x" ? { x: m.end, y: m.cross } : { x: m.cross, y: m.end };
        const sa = vp.toScreen(a);
        const sb = vp.toScreen(b);
        out.push({ kind: "line", role: "spacing", from: sa, to: sb });
        out.push({ kind: "label", role: "spacing", at: { x: (sa.x + sb.x) / 2, y: (sa.y + sb.y) / 2 + (m.axis === "x" ? 12 : 0) }, text: formatNumber(m.end - m.start) });
      }
      if (g.drop) {
        if (g.drop.target !== editor.page) out.push({ kind: "outline", role: "drop-target", closed: true, points: editor.geometry.quad(g.drop.target).map((p) => vp.toScreen(p)) });
        if (g.drop.line) out.push({ kind: "line", role: "drop", from: vp.toScreen(g.drop.line[0]), to: vp.toScreen(g.drop.line[1]) });
      }
    }
    if (g.kind === "rotate" && editor.lastPointer) {
      const total = g.baseRotation + g.angle;
      let shown = ((total % 360) + 360) % 360;
      if (shown > 180) shown -= 360;
      out.push({ kind: "label", role: "size", at: { x: editor.lastPointer.screen.x + 24, y: editor.lastPointer.screen.y + 20 }, text: `${formatNumber(shown)}°` });
    }
  }
}

/** The frame (or page) whose space a node is laid out in: its nearest non-group ancestor. */
function layoutParentOf(editor: Editor, id: string): string {
  let p = editor.doc.tree.parentOf(id) ?? editor.page;
  while (editor.doc.typeOf(p) === "group") p = editor.doc.tree.parentOf(p) ?? editor.page;
  return p;
}

/**
 * Sizing modes after a resize: a dimension the user resized becomes fixed.
 * Text that hugged both ways becomes fixed width with auto height when only
 * its width was dragged.
 */
function sizingModes(editor: Editor, id: string, props: PlacementProps, handle: Handle): Record<string, string> {
  const doc = editor.doc;
  const out: Record<string, string> = {};
  if (!["frame", "component", "instance", "text", "rectangle", "ellipse", "polygon", "star", "line", "vector", "image"].includes(doc.typeOf(id)!)) return out;
  const wm = doc.get<string>(id, "widthMode");
  const hm = doc.get<string>(id, "heightMode");
  const isText = doc.typeOf(id) === "text";
  if (props.width !== undefined && wm !== "fixed") out.widthMode = "fixed";
  if (props.height !== undefined && hm !== "fixed") {
    if (!(isText && handle.y === 0)) out.heightMode = "fixed";
  }
  if (isText && handle.y === 0 && props.width !== undefined && wm === "hug" && hm === "hug") out.heightMode = "hug";
  return out;
}

function roundPlacement(p: PlacementProps, rotation = 0): PlacementProps {
  if (Math.abs(rotation % 90) > 1e-6) return p;
  const out: PlacementProps = { ...p };
  for (const k of ["x", "y", "width", "height"] as const) {
    const v = out[k];
    if (v !== undefined) out[k] = Math.round(v);
  }
  return out;
}

/**
 * Moves the selection by a world delta (arrow keys). Nodes laid out by a
 * flex or grid parent are reordered along the flow instead.
 */
export function nudge(editor: Editor, dx: number, dy: number): void {
  const doc = editor.doc;
  const ids = editor.selection.filter((id) => !doc.get<boolean>(id, "locked"));
  if (ids.length === 0) return;
  const cmds: Command[] = [];
  const flow = ids.filter((id) => isInFlow(doc, id));
  for (const id of flow) {
    const parent = doc.tree.parentOf(id)!;
    const dir = doc.get<string>(parent, "flexDirection");
    const row = doc.get<string>(parent, "display") === "grid" || dir.startsWith("row");
    const step = Math.sign(row ? dx : dy);
    if (step === 0) continue;
    const reverse = dir.endsWith("reverse") ? -1 : 1;
    const i = doc.tree.indexOf(id);
    const n = doc.tree.childrenOf(parent).length;
    const next = Math.max(0, Math.min(n - 1, i + step * reverse));
    if (next !== i) cmds.push({ type: "reorder", id, index: next });
  }
  for (const id of boxedNodes(doc, ids.filter((x) => !flow.includes(x)))) {
    const c = capture(editor.geometry, id);
    if (c.inFlow) continue;
    cmds.push({ type: "updateProps", id, props: moveProps(c, dx, dy) as Record<string, unknown> });
  }
  editor.history.apply(cmds);
}

export function formatNumber(v: number): string {
  const r = Math.round(v * 100) / 100;
  return String(Object.is(r, -0) ? 0 : r);
}
