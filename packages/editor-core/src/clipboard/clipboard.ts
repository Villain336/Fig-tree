import { newId, sha256Hex, sniffImage, type Command } from "@fig-tree/document";
import type { Mat2D, Point } from "@fig-tree/geometry";
import type { Editor } from "../editor";
import { boxesIntersect, boxContainsBox, type Box } from "../math";
import { containerAt, layoutDisplay } from "../placement";
import { isContainer } from "../selection";
import { textSession } from "../text/mode";
import { creationProps, nextName } from "../tools/create";
import { fromBase64, payloadFromHtml, payloadText, payloadToHtml, pasteCommands, serializeNodes, type ClipPayload } from "./format";
import { looksLikeSvg, svgToPayload } from "./svg";

/** What the editor puts on the system clipboard. */
export interface ClipboardOut {
  readonly text: string;
  readonly html: string | null;
}

/** What the host read from the system clipboard (or a drop). */
export interface ClipboardIn {
  readonly html?: string;
  readonly text?: string;
  readonly files?: readonly { readonly type: string; readonly name: string; readonly bytes: Uint8Array }[];
}

/**
 * Copy: the selected nodes in our clipboard format (as HTML) plus plain
 * text, or the selected characters while editing text. The payload is also
 * kept in memory, so pasting works when the system clipboard is unavailable.
 */
export function copySelection(editor: Editor): ClipboardOut | null {
  const s = textSession(editor);
  if (s) {
    if (s.collapsed) return null;
    return { text: s.selectedText.replace(/\u2028/g, "\n"), html: null };
  }
  const payload = serializeNodes(editor, editor.selection);
  if (!payload) return null;
  editor.internalClipboard = payload;
  return { text: payloadText(payload), html: payloadToHtml(payload) };
}

export function cutSelection(editor: Editor): ClipboardOut | null {
  const out = copySelection(editor);
  if (!out) return null;
  const s = textSession(editor);
  if (s) s.delete("backward");
  else editor.run("edit.delete");
  return out;
}

/**
 * Paste, in order of preference: our own nodes (from HTML or memory), SVG
 * markup or files (as vectors), image files (as image nodes with the bytes
 * stored as an asset), then plain text (a text node, or typed into the text
 * being edited). Returns the ids of the pasted nodes.
 */
export async function paste(editor: Editor, data: ClipboardIn): Promise<string[]> {
  const s = textSession(editor);
  if (s) {
    const text = data.text ?? "";
    if (text) s.insert(text.replace(/\r\n?/g, "\n"));
    return [];
  }
  const ours = (data.html ? payloadFromHtml(data.html) : null) ?? null;
  if (ours) return pastePayload(editor, ours);
  const svgFile = data.files?.find((f) => f.type === "image/svg+xml");
  if (svgFile) return pasteSvg(editor, new TextDecoder().decode(svgFile.bytes));
  const image = data.files?.find((f) => /^image\/(png|jpeg|gif|webp)$/.test(f.type));
  if (image) {
    const id = await placeImage(editor, image.bytes, image.name);
    return id ? [id] : [];
  }
  const text = data.text ?? "";
  if (looksLikeSvg(text)) return pasteSvg(editor, text);
  if (text.trim() !== "") return [pasteText(editor, text)].filter((x): x is string => x !== null);
  if (!data.html && !data.text && !data.files?.length && editor.internalClipboard) return pastePayload(editor, editor.internalClipboard);
  return [];
}

/** Where pasted nodes go: into a selected container, else the copied nodes' parent if it is on this page, else the page. */
function pasteTarget(editor: Editor, payload: ClipPayload | null): string {
  const doc = editor.doc;
  const sel = editor.selection;
  if (sel.length === 1 && isContainer(doc, sel[0]!) && doc.typeOf(sel[0]!) !== "group") return sel[0]!;
  if (sel.length >= 1) {
    // Pasting while something is selected goes next to it (its parent).
    const p = doc.tree.parentOf(sel[0]!);
    if (p && doc.typeOf(p) !== "group") return p;
  }
  const src = payload?.source.parent;
  if (src && doc.has(src) && doc.tree.pageOf(src) === editor.page) return src;
  return editor.page;
}

function worldOf(editor: Editor, id: string): Mat2D {
  return editor.doc.typeOf(id) === "page" ? [1, 0, 0, 1, 0, 0] : editor.geometry.worldMatrix(id);
}

/**
 * Pastes a payload. Nodes land where they were copied when that spot is
 * visible (and, pasting into a frame, inside it); otherwise they are
 * centered in the view (or in the target frame).
 */
export async function pastePayload(editor: Editor, payload: ClipPayload): Promise<string[]> {
  const doc = editor.doc;
  // Assets the document does not have yet: verify and store the bytes, then declare them.
  const cmds: Command[] = [];
  const known = doc.assets();
  for (const [id, a] of Object.entries(payload.assets ?? {})) {
    if (known.has(id)) continue;
    if (!a.data) continue;
    const bytes = fromBase64(a.data);
    if ((await sha256Hex(bytes)) !== id) continue;
    editor.assets.put(id, bytes);
    cmds.push({ type: "addAsset", id, meta: a.meta });
  }
  const parent = pasteTarget(editor, payload);
  const visible = editor.viewport.visibleWorld;
  const b = payload.bounds;
  let offset = { x: 0, y: 0 };
  const within = parent === editor.page ? visible : editor.geometry.bounds(parent);
  const fits = parent === editor.page ? boxesIntersect(b, visible) : boxContainsBox(within, b) && boxesIntersect(b, visible);
  if (!fits) {
    const area = parent === editor.page ? visible : within;
    offset = { x: Math.round(area.x + area.width / 2 - (b.x + b.width / 2)), y: Math.round(area.y + area.height / 2 - (b.y + b.height / 2)) };
  }
  const plan = pasteCommands(doc, payload, parent, worldOf(editor, parent), offset);
  const r = editor.history.apply([...cmds, ...plan.commands]);
  if (!r) return [];
  editor.select(plan.roots);
  return plan.roots;
}

export function pasteSvg(editor: Editor, svg: string): Promise<string[]> {
  let payload: ClipPayload;
  try {
    payload = svgToPayload(svg);
  } catch {
    return Promise.resolve([]);
  }
  // SVG has no position of its own: center it in the view (or the target frame).
  const visible = editor.viewport.visibleWorld;
  const parent = pasteTarget(editor, null);
  const area = parent === editor.page ? visible : editor.geometry.bounds(parent);
  const b = payload.bounds;
  const target: Box = { x: Math.round(area.x + area.width / 2 - b.width / 2), y: Math.round(area.y + area.height / 2 - b.height / 2), width: b.width, height: b.height };
  const offset = { x: target.x - b.x, y: target.y - b.y };
  const plan = pasteCommands(editor.doc, payload, parent, worldOf(editor, parent), offset);
  const r = editor.history.apply(plan.commands);
  if (!r) return Promise.resolve([]);
  editor.select(plan.roots);
  return Promise.resolve(plan.roots);
}

/** Pasted plain text becomes a text node at the center of the view (or the target frame). */
export function pasteText(editor: Editor, text: string): string | null {
  const parent = pasteTarget(editor, null);
  const content = text.replace(/\r\n?/g, "\n");
  const visible = editor.viewport.visibleWorld;
  const area = parent === editor.page ? visible : editor.geometry.bounds(parent);
  const at = { x: Math.round(area.x + area.width / 2 - 40), y: Math.round(area.y + area.height / 2 - 10) };
  return createAt(editor, parent, at, "text", { ...creationProps("text"), name: content.split("\n")[0]!.slice(0, 40) || "Text" }, { content, runs: [] });
}

function createAt(editor: Editor, parent: string, world: Point, type: "text" | "image", props: Record<string, unknown>, text?: { content: string; runs: [] }): string | null {
  const id = newId(editor.doc.random);
  const inv = parent === editor.page ? null : editor.geometry.worldMatrix(parent);
  let local = world;
  if (inv) {
    const m = inv;
    const det = m[0] * m[3] - m[1] * m[2];
    const dx = world.x - m[4];
    const dy = world.y - m[5];
    local = { x: (m[3] * dx - m[2] * dy) / det, y: (-m[1] * dx + m[0] * dy) / det };
  }
  const flow = layoutDisplay(editor.doc, parent) !== null;
  const r = editor.history.apply([{ type: "createNode", node: { id, type, props: { ...props, x: Math.round(local.x), y: Math.round(local.y), ...(flow ? { position: "relative" } : {}) }, ...(text ? { text } : {}) }, parent }]);
  if (!r) return null;
  editor.select([id]);
  return id;
}

/**
 * Places an image file: its bytes become a document asset (content
 * addressed) and an image node shows it at its natural size, scaled down
 * to fit 80% of the view, centered at `at` (default: the view's center).
 */
export async function placeImage(editor: Editor, bytes: Uint8Array, name: string, at?: Point): Promise<string | null> {
  const sniffed = sniffImage(bytes);
  if (!sniffed) return null;
  const { id: asset, meta } = await editor.assets.add(bytes, name);
  const vp = editor.viewport.visibleWorld;
  const natural = { width: meta.width ?? 200, height: meta.height ?? 200 };
  const s = Math.min(1, (vp.width * 0.8) / natural.width, (vp.height * 0.8) / natural.height);
  const width = Math.max(1, Math.round(natural.width * s));
  const height = Math.max(1, Math.round(natural.height * s));
  const center = at ?? { x: vp.x + vp.width / 2, y: vp.y + vp.height / 2 };
  const parent = at ? containerAt(editor, at) : pasteTarget(editor, null);
  const id = newId(editor.doc.random);
  const cmds: Command[] = [];
  if (!editor.doc.assets().has(asset)) cmds.push({ type: "addAsset", id: asset, meta });
  const world = { x: Math.round(center.x - width / 2), y: Math.round(center.y - height / 2) };
  let local = world;
  if (parent !== editor.page) {
    const m = editor.geometry.worldMatrix(parent);
    const det = m[0] * m[3] - m[1] * m[2];
    const dx = world.x - m[4];
    const dy = world.y - m[5];
    local = { x: Math.round((m[3] * dx - m[2] * dy) / det), y: Math.round((-m[1] * dx + m[0] * dy) / det) };
  }
  cmds.push({ type: "createNode", node: { id, type: "image", props: { name: name.replace(/\.[a-z0-9]+$/i, "") || nextName(editor, "image"), asset, width, height, x: local.x, y: local.y, ...(layoutDisplay(editor.doc, parent) ? { position: "relative" } : {}) } }, parent });
  const r = editor.history.apply(cmds);
  if (!r) return null;
  editor.select([id]);
  editor.setTool("select");
  return id;
}
