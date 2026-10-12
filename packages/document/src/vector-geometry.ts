import {
  BooleanEvaluator,
  IDENTITY,
  booleanOperation,
  contoursToPath,
  lineNetwork,
  multiply,
  pathContours,
  pathToNetwork,
  regionPath,
  roundNetworkCorners,
  transformCubic,
  type BooleanOperation,
  type Cubic,
  type FillShape,
  type Mat2D,
  type Path,
  type VectorNetwork as GeometryNetwork,
} from "@fig-tree/geometry";
import { outlinePath } from "./bridge/geometry";
import type { NodeType, VectorNetwork } from "./schema";
import { boxMatrix, type BoxTransform } from "./transform";

/**
 * Geometry of document nodes as vector networks and fill shapes: what
 * flattening, outline stroke and boolean groups are computed from. The
 * same code runs on the command layer's draft (boxes from stored
 * properties) and in the renderer bridge (boxes from the layout engine,
 * text outlines from the text engine).
 */

/** Read access to nodes: a `Draft`, or a `FigDocument` through {@link documentSource}. */
export interface GeometrySource {
  typeOf(id: string): NodeType | undefined;
  get<T = unknown>(id: string, key: string): T;
  childrenOf(id: string): readonly string[];
}

export interface GeometryOptions {
  /** A node's box relative to its parent; defaults to its stored x, y, width, height, rotation and flips. */
  readonly box?: (id: string) => BoxTransform | undefined;
  /** Glyph outlines of a text node in its local space, or null when they are not available (no fonts). */
  readonly text?: (id: string) => Path | null;
  /** Incremental evaluator for a boolean group (the bridge keeps one per group). */
  readonly evaluator?: (id: string) => BooleanEvaluator | undefined;
  /** A key that changes whenever a node's own geometry changes (for evaluator caching). */
  readonly key?: (id: string) => string;
  /** Operand shapes by node id, reused while the node's key is unchanged (needs `key`). */
  readonly shapeCache?: Map<string, { key: string; shapes: FillShape[] }>;
}

export function storedBox(src: GeometrySource, id: string): BoxTransform {
  return {
    x: src.get(id, "x"),
    y: src.get(id, "y"),
    width: src.get(id, "width"),
    height: src.get(id, "height"),
    rotation: src.get(id, "rotation"),
    flipX: src.get(id, "flipX"),
    flipY: src.get(id, "flipY"),
  };
}

/** Local-to-parent matrix of a node (identity for groups). */
export function localMatrix(src: GeometrySource, id: string, opts: GeometryOptions = {}): Mat2D {
  const type = src.typeOf(id);
  if (type === "group" || type === "page") return IDENTITY;
  return boxMatrix(opts.box?.(id) ?? storedBox(src, id));
}

export function isBooleanGroup(src: GeometrySource, id: string): boolean {
  return src.typeOf(id) === "group" && src.get<string>(id, "booleanOperation") !== "none";
}

/**
 * A node's own geometry as a vector network in its local space: shapes with
 * their radii, smoothing, arcs and points; vectors with their vertex corner
 * radii applied; text as glyph outlines (when available). Null for groups,
 * pages and text without outlines.
 */
export function nodeNetwork(src: GeometrySource, id: string, opts: GeometryOptions = {}): GeometryNetwork | null {
  const type = src.typeOf(id);
  if (!type) return null;
  const box = opts.box?.(id) ?? storedBox(src, id);
  switch (type) {
    case "vector":
      return roundNetworkCorners(src.get<VectorNetwork>(id, "vectorNetwork") as GeometryNetwork, src.get<number>(id, "cornerRadius"));
    case "line":
      return lineNetwork(box.width);
    case "text": {
      const p = opts.text?.(id);
      return p ? pathToNetwork(p, { mergeDistance: -1 }) : null;
    }
    case "ellipse": {
      const p = outlinePath(src, id, type, box.width, box.height);
      return p ? pathToNetwork(p, { mergeDistance: -1 }) : null;
    }
    case "page":
    case "group":
      return null;
    default: {
      const p = outlinePath(src, id, type, box.width, box.height);
      return p ? pathToNetwork(p) : null;
    }
  }
}

function transformShapes(shapes: readonly FillShape[], m: Mat2D): FillShape[] {
  if (m === IDENTITY || (m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0)) return [...shapes];
  return shapes.map((s) => ({ fillRule: s.fillRule, contours: s.contours.map((c) => c.map((q) => transformCubic(q, m))) }));
}

/**
 * What a node contributes to a boolean: its filled areas as shapes, mapped
 * by `m` (from the node's own coordinate space). Hidden nodes and lines
 * contribute nothing; a vector contributes each region with its own fill
 * rule; a plain group contributes all of its children; a boolean group its
 * result.
 */
export function nodeFillShapes(src: GeometrySource, id: string, m: Mat2D, opts: GeometryOptions = {}): FillShape[] {
  const type = src.typeOf(id);
  if (!type || type === "page" || src.get<boolean>(id, "visible") === false) return [];
  if (type === "group") {
    if (isBooleanGroup(src, id)) return [{ fillRule: "nonzero", contours: booleanContours(src, id, opts).map((c) => c.map((q) => transformCubic(q, m))) }];
    const out: FillShape[] = [];
    for (const c of src.childrenOf(id)) out.push(...nodeFillShapes(src, c, multiply(m, localMatrix(src, c, opts)), opts));
    return out;
  }
  if (type === "line") return [];
  if (type === "vector") {
    const net = nodeNetwork(src, id, opts)!;
    return transformShapes(
      net.regions.map((r, i) => ({ fillRule: r.fillRule, contours: pathContours(regionPath(net, i)) })),
      m,
    );
  }
  if (type === "text") {
    const p = opts.text?.(id);
    return p ? transformShapes([{ fillRule: "nonzero", contours: pathContours(p) }], m) : [];
  }
  const box = opts.box?.(id) ?? storedBox(src, id);
  const p = outlinePath(src, id, type, box.width, box.height);
  return p ? transformShapes([{ fillRule: "nonzero", contours: pathContours(p) }], m) : [];
}

/**
 * The result of a boolean group, as closed contours in the group's
 * coordinate space (which is its parent's: groups have no box of their
 * own). Each visible child is one operand, in paint order.
 */
export function booleanContours(src: GeometrySource, id: string, opts: GeometryOptions = {}): Cubic[][] {
  const op = src.get<string>(id, "booleanOperation") as BooleanOperation | "none";
  if (op === "none") return [];
  const children = src.childrenOf(id).filter((c) => src.get<boolean>(c, "visible") !== false);
  const operands = children.map((c) => {
    if (!opts.key) return { key: c, shapes: nodeFillShapes(src, c, localMatrix(src, c, opts), opts) };
    const key = opts.key(c);
    const hit = opts.shapeCache?.get(c);
    if (hit && hit.key === key) return { key, shapes: hit.shapes };
    const shapes = nodeFillShapes(src, c, localMatrix(src, c, opts), opts);
    opts.shapeCache?.set(c, { key, shapes });
    return { key, shapes };
  });
  // The evaluator caches by operand key: only usable when keys reflect geometry.
  const ev = opts.key ? opts.evaluator?.(id) : undefined;
  return (ev ? ev.evaluate(op, operands) : booleanOperation(op, operands)).contours;
}

/** A boolean group's result as a path (for drawing). */
export function booleanPath(src: GeometrySource, id: string, opts: GeometryOptions = {}): Path {
  return contoursToPath(booleanContours(src, id, opts));
}
