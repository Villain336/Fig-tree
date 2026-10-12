import { applyVectorOps, boxMatrix, newId, nodeNetwork, storedBox, type Command, type FigDocument, type GeometrySource, type VectorOp } from "@fig-tree/document";
import { multiply, networkBounds, scaling, transformNetwork, translation, type Mat2D, type VectorNetwork } from "@fig-tree/geometry";
import type { Editor } from "../editor";
import { clean as cleanNumber } from "../math";
import { capture, isInFlow, placementProps, type Captured } from "../transform";

/**
 * Committing vector edits. Every edit of a vector's points is an
 * `editVector` command (the network operations of `@fig-tree/geometry`),
 * followed by the box update that keeps the node's box tight around its
 * network: the network is translated so its bounds start at (0, 0), and the
 * node's x/y/width/height change so nothing moves on the canvas. Both go in
 * one batch, so each edit is atomic and undoes as one step with whatever
 * gesture group is open.
 *
 * Shapes (rectangles, ellipses, polygons, stars, lines) are edited as the
 * network they draw; the first edit converts the shape to a vector with
 * `flatten` (same box, paints and transform) in the same batch.
 */

/** Node types vector edit mode edits: vectors, and shapes that convert to vectors on their first edit. */
export const VECTOR_EDITABLE = ["vector", "rectangle", "ellipse", "polygon", "star", "line"] as const;

export type Network = VectorNetwork;

/** Read access to the document in the shape vector-geometry expects. */
export function documentSource(doc: FigDocument): GeometrySource {
  return { typeOf: (id) => doc.typeOf(id), get: (id, key) => doc.get(id, key), childrenOf: (id) => doc.tree.childrenOf(id) };
}

/**
 * The network edit mode shows for a node: a vector's stored network, or the
 * network a shape becomes when flattened (the same indices the conversion
 * produces), in the node's local box coordinates.
 */
export function editableNetwork(doc: FigDocument, id: string): Network | null {
  const type = doc.typeOf(id);
  if (type === "vector") return doc.get<Network>(id, "vectorNetwork");
  if (!type || !(VECTOR_EDITABLE as readonly string[]).includes(type)) return null;
  const net = nodeNetwork(documentSource(doc), id);
  // Same as what flatten stores (undefined fields dropped).
  return net ? (JSON.parse(JSON.stringify(net)) as Network) : null;
}

const reject = (...issues: string[]): never => {
  throw new Error(issues.join("; "));
};

/** Applies ops to a network locally (what `editVector` will store). Throws on an invalid op. */
export function previewOps(net: Network, ops: readonly VectorOp[]): Network {
  return applyVectorOps(net, ops, reject) as Network;
}

/** Moves an op's absolute coordinates by (dx, dy) (relative handles are unchanged). */
export function translateOp(op: VectorOp, dx: number, dy: number): VectorOp {
  if (dx === 0 && dy === 0) return op;
  switch (op.op) {
    case "addVertex":
    case "bendSegment":
    case "toggleFill":
      return { ...op, x: op.x + dx, y: op.y + dy };
    case "setVertex":
      return { ...op, ...(op.x !== undefined ? { x: op.x + dx } : {}), ...(op.y !== undefined ? { y: op.y + dy } : {}) };
    default:
      return op;
  }
}

export interface VectorCommit {
  /** The edited vector's id (a converted shape gets a new id). */
  readonly id: string;
  /** The network now stored. */
  readonly network: Network;
  /** Where the old network's origin moved in the new network's coordinates was subtracted: new = old − shift. */
  readonly shift: { readonly x: number; readonly y: number };
  readonly converted: boolean;
}

/**
 * The commands that apply `ops` to a vector (or convert a shape and apply
 * them) and keep its box tight. Returns null when the ops are invalid.
 */
export function vectorEditCommands(editor: Editor, id: string, ops: readonly VectorOp[], options: { readonly newId?: string; readonly normalize?: boolean } = {}): { commands: Command[]; commit: VectorCommit } | null {
  const doc = editor.doc;
  const type = doc.typeOf(id);
  if (!type) return null;
  const before = editableNetwork(doc, id);
  if (!before) return null;
  let after: Network;
  try {
    after = ops.length ? previewOps(before, ops) : before;
  } catch {
    return null;
  }
  const commands: Command[] = [];
  let target = id;
  const converted = type !== "vector";
  if (converted) {
    target = options.newId ?? newId(doc.random);
    commands.push({ type: "flatten", ids: [id], id: target });
  }
  const finalOps: VectorOp[] = [...ops];
  let shift = { x: 0, y: 0 };
  const c = capture(editor.geometry, id);
  if (options.normalize !== false && !c.inFlow && after.vertices.length > 0) {
    const b = networkBounds(after);
    const w = Math.max(0, b.maxX - b.minX);
    const h = Math.max(0, b.maxY - b.minY);
    // The shift is rounded like stored positions are (1e-6), so the box moves by exactly what the points move.
    const sx = cleanNumber(b.minX), sy = cleanNumber(b.minY);
    if (Number.isFinite(b.minX) && (sx !== 0 || sy !== 0 || Math.abs(w - c.width) > 1e-9 || Math.abs(h - c.height) > 1e-9)) {
      if (sx !== 0 || sy !== 0) {
        finalOps.push({ op: "moveVertices", vertices: after.vertices.map((_, i) => i), dx: -sx, dy: -sy });
        after = transformNetwork(after, translation(-sx, -sy));
        shift = { x: sx, y: sy };
      }
      if (finalOps.length) commands.push({ type: "editVector", id: target, ops: finalOps });
      const props = boxProps(c, shift, w, h);
      if (Object.keys(props).length) commands.push({ type: "updateProps", id: target, props });
      return { commands, commit: { id: target, network: after, shift, converted } };
    }
  }
  if (finalOps.length) commands.push({ type: "editVector", id: target, ops: finalOps });
  return { commands, commit: { id: target, network: after, shift, converted } };
}

/**
 * A vector's local → world matrix for editing. Absolutely positioned nodes
 * use their stored box (the layout engine rounds positions to 1e-4 px, and
 * edits that move the box every step must not accumulate that); nodes in
 * flex or grid flow use the laid-out box.
 */
export function vectorWorldMatrix(editor: Editor, id: string): Mat2D {
  const doc = editor.doc;
  if (!doc.has(id) || isInFlow(doc, id)) return editor.geometry.worldMatrix(id);
  return multiply(editor.geometry.parentSpace(id), boxMatrix(storedBox(documentSource(doc), id)));
}

/** Stored placement of a node whose local origin moves by `shift` (local units) and whose size becomes w × h. */
function boxProps(c: Captured, shift: { x: number; y: number }, w: number, h: number): Record<string, unknown> {
  const world: Mat2D = multiply(c.world, translation(shift.x, shift.y));
  return placementProps({ ...c, touched: new Set() }, world, w, h) as Record<string, unknown>;
}

/**
 * Applies vector ops as the user (one batch: conversion, edit and box
 * update). Returns what was committed, or null when nothing was applied.
 */
export function commitVectorOps(editor: Editor, id: string, ops: readonly VectorOp[], options: { readonly newId?: string; readonly normalize?: boolean } = {}): VectorCommit | null {
  const r = vectorEditCommands(editor, id, ops, options);
  if (!r || r.commands.length === 0) return null;
  if (!editor.history.apply(r.commands)) return null;
  return r.commit;
}

/**
 * Commands that replace a vector's network wholesale (used to restore a
 * state, e.g. Backspace while drawing when the step cannot be reverted),
 * keeping the box tight.
 */
export function replaceNetworkCommands(editor: Editor, id: string, net: Network): Command[] {
  const c = capture(editor.geometry, id);
  const b = networkBounds(net);
  if (!Number.isFinite(b.minX) || c.inFlow) return [{ type: "updateProps", id, props: { vectorNetwork: clean(net) } }];
  const moved = transformNetwork(net, translation(-b.minX, -b.minY));
  return [{ type: "updateProps", id, props: { vectorNetwork: clean(moved), ...boxProps(c, { x: b.minX, y: b.minY }, b.maxX - b.minX, b.maxY - b.minY) } }];
}

/** Drops undefined fields (the schema is strict about unknown keys). */
export function clean(net: Network): Network {
  return JSON.parse(JSON.stringify(net)) as Network;
}

/** A vector's network scaled along its own axes (resizing a vector scales its points). */
export function scaledNetwork(net: Network, sx: number, sy: number): Network {
  if (sx === 1 && sy === 1) return net;
  return clean(transformNetwork(net, scaling(Number.isFinite(sx) ? sx : 1, Number.isFinite(sy) ? sy : 1)));
}

/**
 * The scaled network of a captured vector whose box a resize changes to
 * `props` width/height (a resize scales a vector's points with its box).
 */
export function vectorResizeProps(c: Captured, props: { width?: number; height?: number }): Record<string, unknown> {
  const net = c.network as Network | undefined;
  if (!net || (props.width === undefined && props.height === undefined)) return {};
  const sx = c.width > 0 ? (props.width ?? c.width) / c.width : 1;
  const sy = c.height > 0 ? (props.height ?? c.height) / c.height : 1;
  return { vectorNetwork: scaledNetwork(net, sx, sy) };
}
