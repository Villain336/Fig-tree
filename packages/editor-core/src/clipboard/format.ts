import { boxFromMatrix, newId, type AssetMeta, type Command, type FigDocument, type NodeType, type TextContent } from "@fig-tree/document";
import type { Mat2D } from "@fig-tree/geometry";
import type { Editor } from "../editor";
import { boxesIntersect, clean, invert, multiply, transformedBox, unionBoxes, type Box } from "../math";
import { layoutDisplay } from "../placement";
import { normalizeSelection, sortByPaintOrder } from "../selection";

/**
 * The internal clipboard format: copied subtrees with their stored
 * properties and text, the on-canvas (world) placement of every box, and
 * the assets they use (bytes included when small enough), so a paste
 * lands exactly where the copy was, on any page or in another document.
 * It travels as JSON inside an HTML `data-` attribute (browsers keep
 * text/html between apps), next to a plain-text version.
 */
export const CLIPBOARD_FORMAT = "fig-tree/nodes";
export const CLIPBOARD_VERSION = 1;

export interface ClipNode {
  readonly type: NodeType;
  readonly props: Record<string, unknown>;
  readonly text?: TextContent;
  readonly children?: readonly ClipNode[];
  /** World matrix of the box when copied (nodes with a box that are roots or inside root groups). */
  readonly world?: Mat2D;
}

export interface ClipPayload {
  readonly format: typeof CLIPBOARD_FORMAT;
  readonly version: number;
  /** Where the copy came from (to paste in place over the originals). */
  readonly source: { readonly page: string; readonly parent: string | null };
  readonly roots: readonly ClipNode[];
  readonly assets: Readonly<Record<string, { readonly meta: AssetMeta; readonly data?: string }>>;
  /** World bounds of the copied nodes. */
  readonly bounds: Box;
}

const MAX_INLINE_ASSET_BYTES = 8 * 1024 * 1024;

/** Serializes nodes (normalized: no node together with its ancestor), in paint order. */
export function serializeNodes(editor: Editor, ids: readonly string[]): ClipPayload | null {
  const doc = editor.doc;
  const roots = sortByPaintOrder(doc, normalizeSelection(doc, ids, editor.page));
  if (roots.length === 0) return null;
  const geom = editor.geometry;
  const assetIds = new Set<string>();
  const ser = (id: string, withWorld: boolean): ClipNode => {
    const type = doc.typeOf(id)!;
    const props = { ...doc.storedProps(id) };
    collectAssets(props, assetIds);
    const node: { -readonly [K in keyof ClipNode]: ClipNode[K] } = { type, props };
    if (type === "text") {
      node.text = doc.text(id);
      for (const r of node.text.runs) collectAssets(r.style as Record<string, unknown>, assetIds);
    }
    if (withWorld && geom.hasBox(id)) node.world = geom.worldMatrix(id);
    const kids = doc.tree.childrenOf(id);
    // Children of groups live in the group's parent space: they need world placements too.
    if (kids.length) node.children = kids.map((c) => ser(c, withWorld && type === "group"));
    return node;
  };
  const assets: Record<string, { meta: AssetMeta; data?: string }> = {};
  const metas = doc.assets();
  const nodes = roots.map((id) => ser(id, true));
  let inline = 0;
  for (const a of assetIds) {
    const meta = metas.get(a);
    if (!meta) continue;
    const bytes = editor.assets.get(a);
    if (bytes && inline + bytes.length <= MAX_INLINE_ASSET_BYTES) {
      inline += bytes.length;
      assets[a] = { meta, data: toBase64(bytes) };
    } else assets[a] = { meta };
  }
  const parents = new Set(roots.map((id) => doc.tree.parentOf(id)!));
  return {
    format: CLIPBOARD_FORMAT,
    version: CLIPBOARD_VERSION,
    source: { page: editor.page, parent: parents.size === 1 ? [...parents][0]! : null },
    roots: nodes,
    assets,
    bounds: geom.boundsOf(roots) ?? { x: 0, y: 0, width: 0, height: 0 },
  };
}

function collectAssets(v: unknown, out: Set<string>): void {
  if (!v || typeof v !== "object") return;
  if (Array.isArray(v)) {
    v.forEach((x) => collectAssets(x, out));
    return;
  }
  for (const [k, x] of Object.entries(v)) {
    if (k === "asset" && typeof x === "string") out.add(x);
    else collectAssets(x, out);
  }
}

/** The plain-text version of a payload: text contents, else layer names. */
export function payloadText(p: ClipPayload): string {
  const texts: string[] = [];
  const walk = (n: ClipNode): void => {
    if (n.text) texts.push(n.text.content);
    n.children?.forEach(walk);
  };
  p.roots.forEach(walk);
  if (texts.length) return texts.join("\n");
  return p.roots.map((r) => String(r.props.name ?? r.type)).join("\n");
}

export function payloadToHtml(p: ClipPayload): string {
  const json = JSON.stringify(p);
  return `<meta charset="utf-8"><div data-fig-tree="${toBase64(new TextEncoder().encode(json))}"></div>`;
}

/** Reads a payload from clipboard HTML, or null when there is none (or it is not ours). */
export function payloadFromHtml(html: string): ClipPayload | null {
  const m = /data-fig-tree="([A-Za-z0-9+/=]+)"/.exec(html);
  if (!m) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(fromBase64(m[1]!))) as ClipPayload;
    if (p.format !== CLIPBOARD_FORMAT || typeof p.version !== "number" || p.version > CLIPBOARD_VERSION || !Array.isArray(p.roots)) return null;
    return p;
  } catch {
    return null;
  }
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export interface PastePlan {
  readonly commands: Command[];
  readonly roots: string[];
}

/**
 * Commands that recreate a payload under `parent`: fresh ids, every box
 * placed at its copied world position moved by `offset`, roots entering a
 * flex or grid container joining its flow. Invalid stored data is rejected
 * by the command layer (the paste then fails as a whole).
 */
export function pasteCommands(doc: FigDocument, payload: ClipPayload, parent: string, parentWorld: Mat2D, offset: { x: number; y: number }): PastePlan {
  const inv = invert(parentWorld) ?? ([1, 0, 0, 1, 0, 0] as Mat2D);
  const flow = layoutDisplay(doc, parent) !== null;
  const commands: Command[] = [];
  const roots: string[] = [];
  const place = (n: ClipNode, props: Record<string, unknown>): void => {
    if (!n.world) return;
    const w = n.world;
    const moved: Mat2D = [w[0], w[1], w[2], w[3], w[4] + offset.x, w[5] + offset.y];
    const b = boxFromMatrix(multiply(inv, moved), Number(props.width ?? 0), Number(props.height ?? 0), props.flipX === true, props.flipY === true);
    props.x = clean(b.x);
    props.y = clean(b.y);
    if (b.rotation !== 0 || props.rotation !== undefined) props.rotation = clean(b.rotation, 1e4);
    if (b.flipX || props.flipX !== undefined) props.flipX = b.flipX;
    if (b.flipY || props.flipY !== undefined) props.flipY = b.flipY;
  };
  const add = (n: ClipNode, into: string, root: boolean): void => {
    const id = newId(doc.random);
    const props = { ...n.props };
    // Ids of components and instances are not carried over (module 7 decides how copies link).
    delete props.componentRef;
    if (root) {
      if (flow) props.position = "relative";
      else if (props.position === "relative") props.position = "absolute";
      roots.push(id);
    }
    if (root || n.world) place(n, props);
    commands.push({ type: "createNode", node: { id, type: n.type, props, ...(n.text ? { text: n.text } : {}) }, parent: into });
    for (const c of n.children ?? []) add(c, id, false);
  };
  for (const r of payload.roots) add(r, parent, true);
  return { commands, roots };
}

/** World bounds of a payload moved by `offset`. */
export function payloadBounds(p: ClipPayload, offset: { x: number; y: number }): Box {
  return { x: p.bounds.x + offset.x, y: p.bounds.y + offset.y, width: p.bounds.width, height: p.bounds.height };
}

/** Bounds of every placed box in a payload (recomputed, for payloads built by importers). */
export function computeBounds(roots: readonly ClipNode[]): Box {
  const boxes: Box[] = [];
  const walk = (n: ClipNode): void => {
    if (n.world) boxes.push(transformedBox(n.world, Number(n.props.width ?? 0), Number(n.props.height ?? 0)));
    else n.children?.forEach(walk);
  };
  roots.forEach(walk);
  return unionBoxes(boxes) ?? { x: 0, y: 0, width: 0, height: 0 };
}

export { boxesIntersect };
