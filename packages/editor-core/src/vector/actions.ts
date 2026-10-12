import { newId, textToVectorNetwork, type Command, type Paint } from "@fig-tree/document";
import { formatSvgPath, multiply, translation, type Mat2D } from "@fig-tree/geometry";
import type { Paint as RenderPaint, SceneNode } from "@fig-tree/renderer";
import type { Editor } from "../editor";
import type { Box } from "../math";
import { normalizeSelection, sortByPaintOrder } from "../selection";
import { clean, type Network } from "./edit";

/**
 * Vector actions on the selection: boolean groups, flatten (text becomes
 * outlines through the bridge, which has its fonts), outline stroke and
 * "copy as SVG". Each is one undo step.
 */

export type BooleanOp = "union" | "subtract" | "intersect" | "exclude";
export const BOOLEAN_OPS: readonly BooleanOp[] = ["union", "subtract", "intersect", "exclude"];

function unlockedSelection(editor: Editor): string[] {
  return normalizeSelection(editor.doc, editor.selection, editor.page).filter((id) => !editor.doc.get<boolean>(id, "locked"));
}

/** Moves nodes to a common parent first when they do not share one (the topmost node's parent). */
function commonParentCommands(editor: Editor, ids: readonly string[]): Command[] {
  const doc = editor.doc;
  const parents = new Set(ids.map((id) => doc.tree.parentOf(id)!));
  if (parents.size === 1) return [];
  const sorted = sortByPaintOrder(doc, ids);
  const parent = doc.tree.parentOf(sorted[sorted.length - 1]!)!;
  return [{ type: "setParent", ids: sorted.filter((id) => doc.tree.parentOf(id) !== parent), parent, keepPosition: true }];
}

/**
 * Makes a live boolean group of the selection (in paint order: the bottom
 * node is what subtract keeps, and it gives the group its paints). With a
 * single boolean group selected, changes its operation instead.
 */
export function booleanSelection(editor: Editor, op: BooleanOp): boolean {
  const doc = editor.doc;
  const ids = unlockedSelection(editor);
  if (ids.length === 0) return false;
  if (ids.length === 1 && doc.typeOf(ids[0]!) === "group" && doc.get<string>(ids[0]!, "booleanOperation") !== "none") return setBooleanOperation(editor, ids[0]!, op);
  const id = newId(doc.random);
  const r = editor.history.apply([...commonParentCommands(editor, ids), { type: "group", ids, id, booleanOperation: op }]);
  if (!r) return false;
  editor.select([id]);
  return true;
}

/** Changes a group's boolean operation ("none" makes it a plain group). */
export function setBooleanOperation(editor: Editor, id: string, op: BooleanOp | "none"): boolean {
  if (editor.doc.typeOf(id) !== "group") return false;
  if (editor.doc.get<string>(id, "booleanOperation") === op) return false;
  return editor.history.apply([{ type: "updateProps", id, props: { booleanOperation: op } }]) !== null;
}

/**
 * Commands that replace a text node by a vector of its glyph outlines
 * (same box, transform and fills), and the new id. Null when the text is
 * not laid out (no fonts) or empty.
 */
export function textOutlineCommands(editor: Editor, id: string): { commands: Command[]; id: string } | null {
  const doc = editor.doc;
  const net = textToVectorNetwork(editor.bridge, id) as Network | null;
  if (!net || net.segments.length === 0) return null;
  const box = editor.bridge.box(id);
  const vid = newId(doc.random);
  const parent = doc.tree.parentOf(id)!;
  const props: Record<string, unknown> = {
    name: doc.get<string>(id, "name"),
    x: doc.get<number>(id, "x"),
    y: doc.get<number>(id, "y"),
    width: box?.width ?? doc.get<number>(id, "width"),
    height: box?.height ?? doc.get<number>(id, "height"),
    rotation: doc.get<number>(id, "rotation"),
    flipX: doc.get<boolean>(id, "flipX"),
    flipY: doc.get<boolean>(id, "flipY"),
    opacity: doc.get<number>(id, "opacity"),
    fills: doc.get<Paint[]>(id, "fills"),
    vectorNetwork: clean(net),
  };
  for (const k of ["position", "constraints"] as const) {
    const v = doc.stored(id, k);
    if (v !== undefined) props[k] = v;
  }
  return {
    id: vid,
    commands: [
      { type: "createNode", node: { id: vid, type: "vector", props }, parent, index: doc.tree.indexOf(id) + 1 },
      { type: "delete", ids: [id] },
    ],
  };
}

/**
 * Flatten (Cmd/Ctrl+E): the selection becomes one vector that looks the
 * same. Text is converted to its glyph outlines first; a single text node
 * just becomes its outlines.
 */
export function flattenSelection(editor: Editor): boolean {
  const doc = editor.doc;
  const ids = sortByPaintOrder(doc, unlockedSelection(editor));
  if (ids.length === 0) return false;
  const cmds: Command[] = [...commonParentCommands(editor, ids)];
  const flat: string[] = [];
  for (const id of ids) {
    if (doc.typeOf(id) === "text") {
      const t = textOutlineCommands(editor, id);
      if (!t) continue;
      cmds.push(...t.commands);
      flat.push(t.id);
    } else flat.push(id);
  }
  if (flat.length === 0) return false;
  const single = flat.length === 1 && ids.length === 1 && doc.typeOf(ids[0]!) === "text";
  const id = single ? flat[0]! : newId(doc.random);
  if (!single) cmds.push({ type: "flatten", ids: flat, id });
  const r = editor.history.apply(cmds);
  if (!r) return false;
  editor.select([id]);
  return true;
}

/** Outline stroke (Shift+Cmd/Ctrl+O): each selected node's stroke becomes a filled vector; text becomes outlines. */
export function outlineStrokeSelection(editor: Editor): boolean {
  const doc = editor.doc;
  const ids = unlockedSelection(editor);
  const cmds: Command[] = [];
  const created: string[] = [];
  for (const id of ids) {
    const type = doc.typeOf(id);
    if (type === "text") {
      const t = textOutlineCommands(editor, id);
      if (t) {
        cmds.push(...t.commands);
        created.push(t.id);
      }
      continue;
    }
    if (type === "group" || type === "page" || !doc.get<Paint[]>(id, "strokes").some((p) => p.visible !== false)) continue;
    const nid = newId(doc.random);
    cmds.push({ type: "outlineStroke", id, newId: nid });
    created.push(nid);
  }
  if (cmds.length === 0) return false;
  if (!editor.history.apply(cmds)) return false;
  editor.select(created);
  return true;
}

// ── Copy as SVG ─────────────────────────────────────────────────────────

const fmt = (v: number): string => {
  const r = Math.round(v * 1000) / 1000;
  return String(Object.is(r, -0) ? 0 : r);
};

function hex(c: { r: number; g: number; b: number }): string {
  const h = (v: number): string => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

interface SvgContext {
  defs: string[];
  next: number;
}

/** An SVG paint attribute value for a renderer paint (gradients become defs in user space). */
function svgPaint(ctx: SvgContext, p: RenderPaint, m: Mat2D, opacity: number): { value: string; opacity: number } {
  if (p.type === "solid") return { value: hex(p.color), opacity: p.color.a * opacity };
  const id = `g${ctx.next++}`;
  const stops = p.stops.map((s) => `<stop offset="${fmt(s.offset)}" stop-color="${hex(s.color)}"${s.color.a < 1 ? ` stop-opacity="${fmt(s.color.a)}"` : ""}/>`).join("");
  const gt = p.transform ? multiply(m, p.transform) : m;
  const tr = `gradientTransform="matrix(${gt.map(fmt).join(" ")})" gradientUnits="userSpaceOnUse"`;
  if (p.type === "linear-gradient") ctx.defs.push(`<linearGradient id="${id}" x1="${fmt(p.start.x)}" y1="${fmt(p.start.y)}" x2="${fmt(p.end.x)}" y2="${fmt(p.end.y)}" ${tr}>${stops}</linearGradient>`);
  else ctx.defs.push(`<radialGradient id="${id}" cx="${fmt(p.center.x)}" cy="${fmt(p.center.y)}" r="${fmt(p.radius)}" ${tr}>${stops}</radialGradient>`);
  return { value: `url(#${id})`, opacity };
}

/** Elements for one scene node and its descendants (what the renderer draws), in the given space. */
function sceneElements(ctx: SvgContext, node: SceneNode, parent: Mat2D, opacity: number, out: string[]): void {
  if (!node.visible) return;
  const m = multiply(parent, node.transform);
  const alpha = opacity * node.opacity;
  const path = node.glyphs ? null : node.path;
  if (path && !path.isEmpty()) {
    const d = formatSvgPath(path.transform(m), { precision: 3 });
    if (node.fill) {
      const f = svgPaint(ctx, node.fill, m, alpha);
      out.push(`<path d="${d}" fill="${f.value}"${f.opacity < 1 ? ` fill-opacity="${fmt(f.opacity)}"` : ""}${node.fillRule === "evenodd" ? ` fill-rule="evenodd"` : ""}/>`);
    }
    const s = node.stroke;
    if (s && s.width > 0) {
      const p = svgPaint(ctx, s.paint, m, alpha);
      const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
      const attrs = [`fill="none"`, `stroke="${p.value}"`, `stroke-width="${fmt(s.width * scale)}"`];
      if (p.opacity < 1) attrs.push(`stroke-opacity="${fmt(p.opacity)}"`);
      if (s.join && s.join !== "miter") attrs.push(`stroke-linejoin="${s.join}"`);
      if (s.cap && s.cap !== "butt") attrs.push(`stroke-linecap="${s.cap}"`);
      if (s.dash && s.dash.length) attrs.push(`stroke-dasharray="${s.dash.map((v) => fmt(v * scale)).join(" ")}"`);
      out.push(`<path d="${d}" ${attrs.join(" ")}/>`);
    }
  }
  if (node.glyphs && node.fill) {
    // Glyph runs: their outlines as one path.
    const outline = node.path;
    if (outline && !outline.isEmpty()) {
      const f = svgPaint(ctx, node.fill, m, alpha);
      out.push(`<path d="${formatSvgPath(outline.transform(m), { precision: 3 })}" fill="${f.value}"${f.opacity < 1 ? ` fill-opacity="${fmt(f.opacity)}"` : ""}/>`);
    }
  }
  for (const c of node.children) sceneElements(ctx, c, m, alpha, out);
}

/**
 * The selection as an SVG document, drawn exactly as the canvas draws it
 * (from the renderer bridge's scene: boolean results, vector regions with
 * their fill rules, strokes, text outlines), positioned at the selection's
 * top-left corner. Null when nothing is selected.
 */
export function selectionToSvg(editor: Editor): string | null {
  const doc = editor.doc;
  const ids = sortByPaintOrder(doc, normalizeSelection(doc, editor.selection, editor.page));
  if (ids.length === 0) return null;
  const b: Box | null = editor.geometry.boundsOf(ids);
  if (!b) return null;
  const ctx: SvgContext = { defs: [], next: 1 };
  const body: string[] = [];
  const origin = translation(-b.x, -b.y);
  for (const id of ids) {
    const node = editor.bridge.sceneNodeFor(id);
    if (!node) continue;
    const parentWorld = node.parent ? worldOf(node.parent) : ([1, 0, 0, 1, 0, 0] as Mat2D);
    sceneElements(ctx, node, multiply(origin, parentWorld), 1, body);
  }
  const w = fmt(b.width), h = fmt(b.height);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="none">${ctx.defs.length ? `<defs>${ctx.defs.join("")}</defs>` : ""}${body.join("")}</svg>`;
}

function worldOf(n: SceneNode): Mat2D {
  let m: Mat2D = [1, 0, 0, 1, 0, 0];
  for (let c: SceneNode | null = n; c; c = c.parent) m = multiply(c.transform, m);
  return m;
}

