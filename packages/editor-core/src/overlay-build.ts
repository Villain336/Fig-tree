import { flattenPath, type Point } from "@fig-tree/geometry";
import type { Editor } from "./editor";
import { frameBox, selectionFrame, selectionHandles } from "./handles";
import { frameLabels } from "./labels";
import { gradientOverlay } from "./gradient";
import { boxContainsBox, boxesIntersect, transformPoint, type Box } from "./math";
import type { OverlayItem } from "./overlay";
import { formatNumber } from "./tools/select";

/** Selections larger than this draw only their bounds, not every outline. */
const MAX_OUTLINES = 300;
const MAX_IMAGE_PLACEHOLDERS = 200;
/** The pixel grid appears from this zoom (800%). */
export const PIXEL_GRID_ZOOM = 8;

/** Builds the overlay for the editor's current state (canvas CSS pixels). */
export function buildOverlay(editor: Editor): OverlayItem[] {
  const out: OverlayItem[] = [];
  const vp = editor.viewport;
  const doc = editor.doc;
  if (editor.settings.pixelGrid && vp.scale >= PIXEL_GRID_ZOOM) out.push({ kind: "pixel-grid", scale: vp.scale, offsetX: vp.x, offsetY: vp.y });
  imagePlaceholders(editor, out);
  const selected = new Set(editor.selection);
  for (const l of frameLabels(editor)) out.push({ kind: "label", role: "frame-name", at: l.at, text: l.text, selected: selected.has(l.id) || editor.hover === l.id });
  const busy = editor.tool.busy?.() ?? false;
  const session = editor.session;
  // Hover outline.
  const hover = editor.hover;
  if (hover && !selected.has(hover) && doc.has(hover) && !session) out.push({ kind: "outline", role: "hover", closed: true, points: outline(editor, hover) });
  // Selection.
  const ids = editor.selection.filter((id) => doc.has(id));
  if (ids.length > 0 && !session) {
    if (ids.length <= MAX_OUTLINES) for (const id of ids) out.push({ kind: "outline", role: "selection", closed: doc.typeOf(id) !== "line", points: outline(editor, id) });
    const frame = selectionFrame(editor);
    if (frame) {
      if (frame.kind === "multi") out.push({ kind: "rect", role: "selection-bounds", points: frame.quad.map((p) => vp.toScreen(p)) });
      const gesture = (editor.tool as { gestureKind?: string | null }).gestureKind ?? null;
      if (gesture !== "move" && gesture !== "marquee") {
        for (const h of selectionHandles(editor, frame)) {
          if (h.size > 0) out.push({ kind: "handle", id: h.id, center: h.center, shape: "square", size: h.size });
          else out.push({ kind: "handle", id: h.id, center: h.center, shape: "circle", size: 0 });
        }
      }
      // Size label under the selection.
      const b = frameBox(frame);
      const bottom = vp.toScreen({ x: b.x + b.width / 2, y: b.y + b.height });
      const label = frame.kind === "line" ? formatNumber(frame.width) : `${formatNumber(frame.width)} × ${formatNumber(frame.height)}`;
      if (gesture !== "marquee") out.push({ kind: "label", role: "size", at: { x: bottom.x, y: bottom.y + 20 }, text: label });
    }
  }
  if (editor.measuring && !busy && ids.length > 0 && hover && !selected.has(hover)) measure(editor, ids, hover, out);
  gradientOverlay(editor, out);
  editor.tool.overlay?.(editor, out);
  session?.overlay(out);
  return out;
}

/** A node's outline on screen: its box (or bounds for groups), or its shape for ellipses, polygons, stars and vectors. */
export function outline(editor: Editor, id: string): Point[] {
  const geom = editor.geometry;
  const vp = editor.viewport;
  const type = editor.doc.typeOf(id);
  if (type === "ellipse" || type === "polygon" || type === "star" || type === "vector") {
    const path = editor.bridge.sceneNodeFor(id)?.path;
    if (path) {
      const m = geom.worldMatrix(id);
      const lines = flattenPath(path, [m[0] * vp.scale, m[1] * vp.scale, m[2] * vp.scale, m[3] * vp.scale, m[4] * vp.scale + vp.x, m[5] * vp.scale + vp.y], 0.5);
      // The first contour (the outer one) is enough for an outline.
      const end = lines.contourStarts[1] ?? 0;
      const pts: Point[] = [];
      for (let i = lines.contourStarts[0] ?? 0; i < end; i++) pts.push({ x: lines.points[i * 2]!, y: lines.points[i * 2 + 1]! });
      if (pts.length > 1) return pts;
    }
  }
  if (type === "line") {
    const m = geom.worldMatrix(id);
    const w = geom.size(id).width;
    return [vp.toScreen(transformPoint(m, 0, 0)), vp.toScreen(transformPoint(m, w, 0))];
  }
  return geom.quad(id).map((p) => vp.toScreen(p));
}

/** Image nodes are not drawn by the renderer yet: outline them with a placeholder cross. */
const imageCache = new WeakMap<Editor, { version: number; page: string; ids: string[] }>();

function imagePlaceholders(editor: Editor, out: OverlayItem[]): void {
  const doc = editor.doc;
  const visible = editor.viewport.visibleWorld;
  let cached = imageCache.get(editor);
  if (!cached || cached.version !== editor.docVersion || cached.page !== editor.page) {
    cached = { version: editor.docVersion, page: editor.page, ids: doc.tree.subtree(editor.page).filter((id) => doc.typeOf(id) === "image") };
    imageCache.set(editor, cached);
  }
  let n = 0;
  for (const id of cached.ids) {
    if (!doc.has(id) || !doc.get<boolean>(id, "visible")) continue;
    if (!boxesIntersect(editor.geometry.bounds(id), visible)) continue;
    out.push({ kind: "image-placeholder", points: editor.geometry.quad(id).map((p) => editor.viewport.toScreen(p)) });
    if (++n >= MAX_IMAGE_PLACEHOLDERS) return;
  }
}

/**
 * Alt-hover measurement: distances from the selection to the hovered node,
 * or to the inner edges of a hovered node that contains the selection.
 */
function measure(editor: Editor, ids: readonly string[], hover: string, out: OverlayItem[]): void {
  const s = editor.geometry.boundsOf(ids);
  if (!s) return;
  const t = editor.geometry.bounds(hover);
  for (const m of measurements(s, t)) {
    const a = editor.viewport.toScreen(m.from);
    const b = editor.viewport.toScreen(m.to);
    out.push({ kind: "line", role: "measure", from: a, to: b });
    out.push({ kind: "label", role: "measure", at: { x: (a.x + b.x) / 2 + (m.axis === "y" ? 22 : 0), y: (a.y + b.y) / 2 + (m.axis === "x" ? 12 : 0) }, text: formatNumber(m.value) });
  }
}

export interface Measurement {
  readonly axis: "x" | "y";
  readonly from: Point;
  readonly to: Point;
  readonly value: number;
}

/** Distances between two boxes (world), as Alt-hover shows them. */
export function measurements(s: Box, t: Box): Measurement[] {
  const out: Measurement[] = [];
  const scx = s.x + s.width / 2;
  const scy = s.y + s.height / 2;
  if (boxContainsBox(t, s)) {
    out.push({ axis: "x", from: { x: t.x, y: scy }, to: { x: s.x, y: scy }, value: s.x - t.x });
    out.push({ axis: "x", from: { x: s.x + s.width, y: scy }, to: { x: t.x + t.width, y: scy }, value: t.x + t.width - (s.x + s.width) });
    out.push({ axis: "y", from: { x: scx, y: t.y }, to: { x: scx, y: s.y }, value: s.y - t.y });
    out.push({ axis: "y", from: { x: scx, y: s.y + s.height }, to: { x: scx, y: t.y + t.height }, value: t.y + t.height - (s.y + s.height) });
    return out.filter((m) => m.value > 0);
  }
  if (boxContainsBox(s, t)) return measurements(t, s);
  // Horizontal gap, measured at the middle of the vertical overlap (or the selection's middle).
  const oy0 = Math.max(s.y, t.y);
  const oy1 = Math.min(s.y + s.height, t.y + t.height);
  const y = oy1 > oy0 ? (oy0 + oy1) / 2 : scy;
  if (s.x + s.width <= t.x) out.push({ axis: "x", from: { x: s.x + s.width, y }, to: { x: t.x, y }, value: t.x - (s.x + s.width) });
  else if (t.x + t.width <= s.x) out.push({ axis: "x", from: { x: t.x + t.width, y }, to: { x: s.x, y }, value: s.x - (t.x + t.width) });
  const ox0 = Math.max(s.x, t.x);
  const ox1 = Math.min(s.x + s.width, t.x + t.width);
  const x = ox1 > ox0 ? (ox0 + ox1) / 2 : scx;
  if (s.y + s.height <= t.y) out.push({ axis: "y", from: { x, y: s.y + s.height }, to: { x, y: t.y }, value: t.y - (s.y + s.height) });
  else if (t.y + t.height <= s.y) out.push({ axis: "y", from: { x, y: t.y + t.height }, to: { x, y: s.y }, value: s.y - (t.y + t.height) });
  return out;
}
