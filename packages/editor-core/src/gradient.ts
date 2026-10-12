import type { Paint } from "@fig-tree/document";
import type { Point } from "@fig-tree/geometry";
import type { Editor } from "./editor";
import { invert, transformPoint } from "./math";
import type { OverlayItem } from "./overlay";

/**
 * On-canvas gradient editing. While the color picker edits a gradient
 * paint of one node (`editor.paintEdit`), its handles show on the canvas:
 * start and end for linear gradients; center and the two radius handles for
 * radial ones; and a marker per color stop along the gradient line. Handle
 * positions are normalized to the node's box, as the paint stores them.
 */
export interface PaintTarget {
  readonly id: string;
  readonly key: "fills" | "strokes";
  readonly index: number;
}

export type GradientHandleKind = "start" | "end" | "center" | "radiusX" | "radiusY" | "stop";

export interface GradientHandle {
  readonly id: string;
  readonly kind: GradientHandleKind;
  readonly stop?: number;
  /** Screen position. */
  readonly center: Point;
}

type GradientPaint = Extract<Paint, { type: "linear-gradient" | "radial-gradient" | "angular-gradient" | "diamond-gradient" }>;

export const MAX_STOP_ANCHORS = 16;

/** The gradient being edited, if the target still holds one. */
export function editedGradient(editor: Editor): { target: PaintTarget; paint: GradientPaint } | null {
  const t = editor.paintEdit;
  if (!t || !editor.doc.has(t.id) || !editor.geometry.hasBox(t.id)) return null;
  const paints = editor.doc.get<Paint[]>(t.id, t.key);
  const p = paints[t.index];
  if (!p || p.type === "solid" || p.type === "image" || p.type === "shader") return null;
  return { target: t, paint: p };
}

function toScreen(editor: Editor, id: string, u: Point): Point {
  const { width, height } = editor.geometry.size(id);
  return editor.viewport.toScreen(transformPoint(editor.geometry.worldMatrix(id), u.x * width, u.y * height));
}

/** Handles of the edited gradient (screen space). */
export function gradientHandles(editor: Editor): GradientHandle[] {
  const g = editedGradient(editor);
  if (!g) return [];
  const { paint, target } = g;
  const out: GradientHandle[] = [];
  const [a, b] = paint.type === "linear-gradient" ? [paint.start, paint.end] : [paint.center, paint.radiusX];
  const sa = toScreen(editor, target.id, a);
  const sb = toScreen(editor, target.id, b);
  paint.stops.forEach((s, i) => {
    if (i >= MAX_STOP_ANCHORS) return;
    out.push({ id: `canvas.handle.gradient.stop.${i}`, kind: "stop", stop: i, center: { x: sa.x + (sb.x - sa.x) * s.position, y: sa.y + (sb.y - sa.y) * s.position } });
  });
  if (paint.type === "linear-gradient") {
    out.push({ id: "canvas.handle.gradient.start", kind: "start", center: sa });
    out.push({ id: "canvas.handle.gradient.end", kind: "end", center: sb });
  } else {
    out.push({ id: "canvas.handle.gradient.center", kind: "center", center: sa });
    out.push({ id: "canvas.handle.gradient.radiusX", kind: "radiusX", center: sb });
    out.push({ id: "canvas.handle.gradient.radiusY", kind: "radiusY", center: toScreen(editor, target.id, paint.radiusY) });
  }
  return out;
}

export function gradientOverlay(editor: Editor, out: OverlayItem[]): void {
  const g = editedGradient(editor);
  if (!g) return;
  const handles = gradientHandles(editor);
  const ends = handles.filter((h) => h.kind !== "stop");
  out.push({ kind: "rect", role: "gradient-line", points: [ends[0]!.center, ends[1]!.center] });
  if (g.paint.type !== "linear-gradient") out.push({ kind: "rect", role: "gradient-line", points: [ends[0]!.center, ends[2]!.center] });
  for (const h of handles) {
    if (h.kind === "stop") {
      const c = g.paint.stops[h.stop!]!.color;
      out.push({ kind: "handle", id: h.id, center: h.center, shape: "diamond", size: 12, color: `rgb(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)})` });
    } else out.push({ kind: "handle", id: h.id, center: h.center, shape: "circle", size: 10 });
  }
}

/** The gradient handle under a screen point (stops win over the line's ends they sit on). */
export function hitGradientHandle(editor: Editor, screen: Point): GradientHandle | null {
  const hs = gradientHandles(editor);
  let best: GradientHandle | null = null;
  let bestD = 8;
  for (const h of hs) {
    const d = Math.hypot(screen.x - h.center.x, screen.y - h.center.y) - (h.kind === "stop" ? 1 : 0);
    if (d < bestD) {
      best = h;
      bestD = d;
    }
  }
  return best;
}

/** The paint after dragging a handle to a world point. */
export function dragGradientHandle(editor: Editor, handle: GradientHandle, world: Point): Paint[] | null {
  const g = editedGradient(editor);
  if (!g) return null;
  const { target, paint } = g;
  const inv = invert(editor.geometry.worldMatrix(target.id));
  if (!inv) return null;
  const { width, height } = editor.geometry.size(target.id);
  const l = transformPoint(inv, world.x, world.y);
  const u = { x: round(width > 0 ? l.x / width : 0), y: round(height > 0 ? l.y / height : 0) };
  let next: Paint;
  if (handle.kind === "stop") {
    const [a, b] = paint.type === "linear-gradient" ? [paint.start, paint.end] : [paint.center, paint.radiusX];
    const dx = (b.x - a.x) * width;
    const dy = (b.y - a.y) * height;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? ((l.x - a.x * width) * dx + (l.y - a.y * height) * dy) / len2 : 0;
    const stops = paint.stops.map((s, i) => (i === handle.stop ? { ...s, position: round(Math.min(1, Math.max(0, t))) } : s));
    next = { ...paint, stops };
  } else if (paint.type === "linear-gradient") {
    next = handle.kind === "start" ? { ...paint, start: u } : { ...paint, end: u };
  } else if (handle.kind === "center") {
    // The radius handles move with the center.
    const d = { x: u.x - paint.center.x, y: u.y - paint.center.y };
    next = { ...paint, center: u, radiusX: { x: round(paint.radiusX.x + d.x), y: round(paint.radiusX.y + d.y) }, radiusY: { x: round(paint.radiusY.x + d.x), y: round(paint.radiusY.y + d.y) } };
  } else next = handle.kind === "radiusX" ? { ...paint, radiusX: u } : { ...paint, radiusY: u };
  const paints = [...editor.doc.get<Paint[]>(target.id, target.key)];
  paints[target.index] = next;
  return paints;
}

function round(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}
