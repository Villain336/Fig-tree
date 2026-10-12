import {
  addSegment,
  addVertex,
  bendSegment,
  booleanOperation,
  closePath,
  contoursToPath,
  curveSegment,
  deleteVertexPreservingShape,
  disconnectVertex,
  fillAllFaces,
  makeCorner,
  mergeVertices,
  moveHandle,
  moveVertices,
  networkBounds,
  networkStrokePath,
  outlineStroke,
  pathContours,
  pathToNetwork,
  removeSegments,
  removeVertices,
  reverseSegment,
  setSegmentTangents,
  setVertexMirroring,
  simplifyNetwork,
  splitSegment,
  straightenSegment,
  toggleFaceFill,
  transformNetwork,
  translation,
  updateVertex,
  type Cubic,
  type Path,
  type VectorNetwork as GeometryNetwork,
} from "@fig-tree/geometry";
import { z } from "zod";
import { outlinePath } from "./bridge/geometry";
import {
  NodeId,
  NonNegative,
  Num,
  Point,
  StrokeCap,
  VectorNetwork,
  hasProp,
  type NodeType,
  type Paint,
  type StrokeWeight,
} from "./schema";
import { booleanContours, localMatrix, nodeNetwork, storedBox, type GeometrySource } from "./vector-geometry";

// ── Schemas ──────────────────────────────────────────────────────────────

const Index = z.number().int().min(0);
const FillRule = z.enum(["nonzero", "evenodd"]);
const Mirroring = z.enum(["none", "angle", "angle-length"]);

/**
 * One editing operation on a vector network (indices refer to the network
 * as it is when the operation runs, so later operations see the effects of
 * earlier ones). These are the operations of `@fig-tree/geometry`'s
 * vector-network module, which the pen tool and vector edit mode use.
 */
export const VectorOp = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("addVertex"), x: Num, y: Num }),
  z.strictObject({ op: z.literal("moveVertices"), vertices: z.array(Index).min(1), dx: Num, dy: Num }),
  z.strictObject({
    op: z.literal("setVertex"),
    vertex: Index,
    x: Num.optional(),
    y: Num.optional(),
    /** `null` removes the vertex's own value. */
    cornerRadius: NonNegative.nullable().optional(),
    strokeCap: StrokeCap.nullable().optional(),
    handleMirroring: Mirroring.nullable().optional(),
  }),
  z.strictObject({ op: z.literal("removeVertices"), vertices: z.array(Index).min(1) }),
  /** Deletes a vertex keeping the curve's shape (joins its two segments into one fitted segment). */
  z.strictObject({ op: z.literal("deleteVertex"), vertex: Index }),
  z.strictObject({ op: z.literal("mergeVertices"), keep: Index, remove: Index }),
  z.strictObject({ op: z.literal("disconnectVertex"), vertex: Index }),
  z.strictObject({ op: z.literal("addSegment"), start: Index, end: Index, tangentStart: Point.optional(), tangentEnd: Point.optional() }),
  /** Adds a segment and fills the face it closes. */
  z.strictObject({ op: z.literal("closePath"), start: Index, end: Index, tangentStart: Point.optional(), tangentEnd: Point.optional(), fillRule: FillRule.optional() }),
  z.strictObject({ op: z.literal("removeSegments"), segments: z.array(Index).min(1) }),
  z.strictObject({ op: z.literal("splitSegment"), segment: Index, t: z.number().gt(0).lt(1) }),
  z.strictObject({ op: z.literal("setTangents"), segment: Index, tangentStart: Point.nullable(), tangentEnd: Point.nullable() }),
  z.strictObject({ op: z.literal("bendSegment"), segment: Index, t: z.number().min(0).max(1), x: Num, y: Num }),
  z.strictObject({ op: z.literal("moveHandle"), segment: Index, end: z.enum(["start", "end"]), x: Num, y: Num, mirroring: Mirroring.optional() }),
  z.strictObject({ op: z.literal("setMirroring"), vertex: Index, mirroring: Mirroring }),
  z.strictObject({ op: z.literal("makeCorner"), vertex: Index }),
  z.strictObject({ op: z.literal("straightenSegment"), segment: Index }),
  z.strictObject({ op: z.literal("curveSegment"), segment: Index }),
  z.strictObject({ op: z.literal("reverseSegment"), segment: Index }),
  /** The fill tool: fills the face at (x, y), or unfills it. */
  z.strictObject({ op: z.literal("toggleFill"), x: Num, y: Num, fillRule: FillRule.optional() }),
  z.strictObject({ op: z.literal("fillAllFaces"), fillRule: FillRule.optional() }),
  z.strictObject({ op: z.literal("setRegionFillRule"), region: Index, fillRule: FillRule }),
  z.strictObject({ op: z.literal("simplify"), tolerance: z.number().positive() }),
]);
export type VectorOp = z.infer<typeof VectorOp>;

export const EditVectorCommand = z.strictObject({
  type: z.literal("editVector"),
  id: NodeId,
  ops: z.array(VectorOp).min(1).max(10_000),
});

export const FlattenCommand = z.strictObject({
  type: z.literal("flatten"),
  /** Siblings to flatten into one vector (shapes, vectors, groups and boolean groups). */
  ids: z.array(NodeId).min(1).max(100_000),
  /** Id of the new vector node. */
  id: NodeId.optional(),
});

export const OutlineStrokeCommand = z.strictObject({
  type: z.literal("outlineStroke"),
  id: NodeId,
  /** Id of the new vector node holding the outlined stroke. */
  newId: NodeId.optional(),
});

// ── Execution ────────────────────────────────────────────────────────────

/** What the command layer gives these commands (a subset of its draft and helpers). */
export interface VectorCommandContext extends GeometrySource {
  set(id: string, key: string, value: unknown): void;
  storedProps(id: string): Record<string, unknown>;
  parentOf(id: string): string | undefined;
  indexOf(id: string): number;
  /** Creates a node at `index` among `parent`'s children; returns nothing (the id is given). */
  createAt(id: string, type: NodeType, props: Record<string, unknown>, parent: string, index: number): void;
  remove(id: string): string[];
  newId(): string;
  idTaken(id: string): boolean;
  reject(...issues: string[]): never;
}

type Net = GeometryNetwork;

/** Applies vector ops to a network, rejecting the first invalid one with its position. */
export function applyVectorOps(net: Net, ops: readonly VectorOp[], reject: (...issues: string[]) => never): Net {
  let n = net;
  ops.forEach((op, i) => {
    try {
      n = applyOp(n, op);
    } catch (e) {
      if (e instanceof RangeError) reject(`op ${i} (${op.op}): ${e.message}`);
      throw e;
    }
  });
  return n;
}

function applyOp(n: Net, op: VectorOp): Net {
  const check = (v: number, kind: "vertex" | "segment" | "region"): void => {
    const len = kind === "vertex" ? n.vertices.length : kind === "segment" ? n.segments.length : n.regions.length;
    if (v >= len) throw new RangeError(`${kind} ${v} does not exist`);
  };
  switch (op.op) {
    case "addVertex":
      return addVertex(n, op.x, op.y).network;
    case "moveVertices":
      op.vertices.forEach((v) => check(v, "vertex"));
      return moveVertices(n, op.vertices, op.dx, op.dy);
    case "setVertex": {
      check(op.vertex, "vertex");
      const v = n.vertices[op.vertex]!;
      let out = n;
      if (op.x !== undefined || op.y !== undefined) out = moveVertices(out, [op.vertex], (op.x ?? v.x) - v.x, (op.y ?? v.y) - v.y);
      const props: Record<string, unknown> = {};
      if (op.cornerRadius !== undefined) props.cornerRadius = op.cornerRadius ?? undefined;
      if (op.strokeCap !== undefined) props.strokeCap = op.strokeCap ?? undefined;
      if (op.handleMirroring !== undefined) props.handleMirroring = op.handleMirroring ?? undefined;
      return Object.keys(props).length ? updateVertex(out, op.vertex, props) : out;
    }
    case "removeVertices":
      op.vertices.forEach((v) => check(v, "vertex"));
      return removeVertices(n, op.vertices);
    case "deleteVertex":
      check(op.vertex, "vertex");
      return deleteVertexPreservingShape(n, op.vertex);
    case "mergeVertices":
      return mergeVertices(n, op.keep, op.remove);
    case "disconnectVertex":
      return disconnectVertex(n, op.vertex);
    case "addSegment":
      return addSegment(n, op.start, op.end, op.tangentStart, op.tangentEnd).network;
    case "closePath":
      return closePath(n, op.start, op.end, { ...(op.tangentStart ? { start: op.tangentStart } : {}), ...(op.tangentEnd ? { end: op.tangentEnd } : {}) }, op.fillRule ?? "nonzero").network;
    case "removeSegments":
      op.segments.forEach((s) => check(s, "segment"));
      return removeSegments(n, op.segments);
    case "splitSegment":
      return splitSegment(n, op.segment, op.t).network;
    case "setTangents":
      return setSegmentTangents(n, op.segment, op.tangentStart ?? undefined, op.tangentEnd ?? undefined);
    case "bendSegment":
      return bendSegment(n, op.segment, op.t, { x: op.x, y: op.y });
    case "moveHandle":
      return moveHandle(n, op.segment, op.end, { x: op.x, y: op.y }, op.mirroring);
    case "setMirroring":
      return setVertexMirroring(n, op.vertex, op.mirroring);
    case "makeCorner":
      return makeCorner(n, op.vertex);
    case "straightenSegment":
      check(op.segment, "segment");
      return straightenSegment(n, op.segment);
    case "curveSegment":
      return curveSegment(n, op.segment);
    case "reverseSegment":
      return reverseSegment(n, op.segment);
    case "toggleFill":
      return toggleFaceFill(n, op.x, op.y, op.fillRule ?? "nonzero");
    case "fillAllFaces":
      return fillAllFaces(n, op.fillRule ?? "nonzero");
    case "setRegionFillRule": {
      check(op.region, "region");
      const regions = [...n.regions];
      regions[op.region] = { ...regions[op.region]!, fillRule: op.fillRule };
      return { ...n, regions };
    }
    case "simplify":
      return simplifyNetwork(n, op.tolerance);
  }
}

/** Validates a network against the document schema. */
export function checkNetwork(net: unknown, reject: (...issues: string[]) => never, where: string): z.infer<typeof VectorNetwork> {
  const r = VectorNetwork.safeParse(net);
  if (!r.success) reject(...r.error.issues.map((i) => `${where}: ${[...i.path.map(String)].join(".")}: ${i.message}`));
  return r.data!;
}

export function editVector(ctx: VectorCommandContext, cmd: z.output<typeof EditVectorCommand>): void {
  const type = ctx.typeOf(cmd.id);
  if (!type) ctx.reject(`node ${cmd.id} does not exist`);
  if (type !== "vector") ctx.reject(`${cmd.id} is a ${type}, not a vector`);
  const net = ctx.get<Net>(cmd.id, "vectorNetwork");
  const out = applyVectorOps(net, cmd.ops, ctx.reject);
  ctx.set(cmd.id, "vectorNetwork", checkNetwork(out, ctx.reject, `vector ${cmd.id}`));
}

/** Properties of a node that a vector made from it keeps (those a vector has). */
function vectorProps(ctx: VectorCommandContext, id: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx.storedProps(id))) if (hasProp("vector", k) && k !== "cornerRadius" && k !== "vectorNetwork") out[k] = v;
  // Per-side stroke weights of boxes become one weight.
  const w = ctx.get<StrokeWeight>(id, "strokeWeight");
  if (typeof w !== "number") out.strokeWeight = Math.max(w.top, w.right, w.bottom, w.left);
  return out;
}

/** The network of one node in its parent's space, with its fills as region fills when `keepFills`. */
function networkInParent(ctx: VectorCommandContext, id: string, keepFills: boolean): Net[] {
  const type = ctx.typeOf(id)!;
  if (ctx.get<boolean>(id, "visible") === false) return [];
  if (type === "text") ctx.reject(`${id} is a text node: flatten text through the renderer bridge (textToVectorNetwork), which has its fonts`);
  if (type === "group" && ctx.get<string>(id, "booleanOperation") === "none") {
    return ctx.childrenOf(id).flatMap((c) => networkInParent(ctx, c, keepFills));
  }
  let net: Net;
  if (type === "group") {
    const contours = booleanContours(ctx, id);
    net = pathToNetwork(contoursToPath(contours));
  } else {
    const local = nodeNetwork(ctx, id);
    if (!local) return [];
    net = transformNetwork(local, localMatrix(ctx, id));
  }
  if (keepFills) {
    const fills = ctx.get<Paint[]>(id, "fills");
    net = { ...net, regions: net.regions.map((r) => ({ ...r, fills })) };
  }
  return [net];
}

function concatNetworks(nets: readonly Net[]): Net {
  const vertices: Net["vertices"][number][] = [];
  const segments: Net["segments"][number][] = [];
  const regions: Net["regions"][number][] = [];
  for (const n of nets) {
    const vo = vertices.length, so = segments.length;
    vertices.push(...n.vertices);
    segments.push(...n.segments.map((s) => ({ ...s, start: s.start + vo, end: s.end + vo })));
    regions.push(...n.regions.map((r) => ({ ...r, loops: r.loops.map((l) => l.map((s) => s + so)) })));
  }
  return { vertices, segments, regions };
}

/**
 * Flattens nodes into one vector node that looks the same: a single shape
 * keeps its box and transform (its geometry becomes the network); several
 * nodes, groups and boolean groups are baked into their parent's space,
 * each keeping its fills as region fills. The new node takes the place of
 * the topmost node; the originals are deleted. Returns the new id and the
 * deleted ids.
 */
export function flatten(ctx: VectorCommandContext, cmd: z.output<typeof FlattenCommand>): { created: string; deleted: string[] } {
  const ids = [...new Set(cmd.ids)];
  for (const id of ids) {
    const t = ctx.typeOf(id);
    if (!t) ctx.reject(`node ${id} does not exist`);
    if (t === "page") ctx.reject(`pages cannot be flattened`);
  }
  const parent = ctx.parentOf(ids[0]!)!;
  if (ids.some((id) => ctx.parentOf(id) !== parent)) ctx.reject(`flattened nodes must share a parent`);
  const ordered = [...ids].sort((a, b) => ctx.indexOf(a) - ctx.indexOf(b));
  const top = ordered[ordered.length - 1]!;
  const newId = cmd.id ?? ctx.newId();
  if (ctx.idTaken(newId)) ctx.reject(`id ${newId} is already in use`);
  const single = ordered.length === 1 && ctx.typeOf(top) !== "group";
  let props: Record<string, unknown>;
  let net: Net;
  if (single) {
    const local = ctx.typeOf(top) === "text" ? null : nodeNetwork(ctx, top);
    if (ctx.typeOf(top) === "text") ctx.reject(`${top} is a text node: flatten text through the renderer bridge (textToVectorNetwork), which has its fonts`);
    net = local!;
    props = { ...vectorProps(ctx, top) };
    const box = storedBox(ctx, top);
    Object.assign(props, { x: box.x, y: box.y, width: box.width, height: box.height, rotation: box.rotation, flipX: box.flipX, flipY: box.flipY });
  } else {
    // Each node keeps its own fills as region fills unless they all agree.
    const fillsOf = ordered.map((id) => JSON.stringify(ctx.get<Paint[]>(id, "fills")));
    const keep = new Set(fillsOf).size > 1 || ordered.some((id) => ctx.typeOf(id) === "group");
    net = concatNetworks(ordered.flatMap((id) => networkInParent(ctx, id, keep)));
    const b = networkBounds(net);
    const minX = Number.isFinite(b.minX) ? b.minX : 0, minY = Number.isFinite(b.minY) ? b.minY : 0;
    net = transformNetwork(net, translation(-minX, -minY));
    props = { ...vectorProps(ctx, top), x: minX, y: minY, width: Math.max(0, b.maxX - b.minX) || 0, height: Math.max(0, b.maxY - b.minY) || 0, rotation: 0, flipX: false, flipY: false };
    if (!keep) props.fills = ctx.get<Paint[]>(top, "fills");
    if (ctx.typeOf(top) === "group") for (const k of ["strokes", "strokeWeight", "strokeAlign", "strokeCap", "strokeJoin", "strokeMiterLimit", "strokeDashes", "strokeDashOffset"]) {
      const v = ctx.get(top, k);
      if (v !== undefined) props[k] = v;
    }
  }
  props.name = ctx.get<string>(top, "name");
  props.vectorNetwork = checkNetwork(stripEmpty(net), ctx.reject, `flatten`);
  const index = ctx.indexOf(top) + 1;
  ctx.createAt(newId, "vector", props, parent, index);
  const deleted: string[] = [];
  for (const id of ordered) deleted.push(...ctx.remove(id));
  return { created: newId, deleted };
}

/** Drops undefined optional fields (the schema is strict about unknown keys, not about undefined). */
function stripEmpty(net: Net): Net {
  return JSON.parse(JSON.stringify(net)) as Net;
}

/**
 * Outline stroke: a new vector node right above `id` whose fill is the area
 * its stroke paints (the stroke's paints become its fills). Centered strokes
 * are outlined directly; inside and outside strokes are the double-width
 * outline intersected with, or minus, the node's own area. The original
 * keeps its fills and loses its strokes; a node without visible fills is
 * replaced.
 */
export function outlineStrokeOf(ctx: VectorCommandContext, cmd: z.output<typeof OutlineStrokeCommand>): { created: string; deleted: string[] } {
  const type = ctx.typeOf(cmd.id);
  if (!type) ctx.reject(`node ${cmd.id} does not exist`);
  if (type === "page" || type === "group" || type === "text") ctx.reject(`${type} nodes have no outlinable stroke here`);
  const strokes = ctx.get<Paint[]>(cmd.id, "strokes").filter((p) => p.visible !== false);
  if (strokes.length === 0) ctx.reject(`${cmd.id} has no visible strokes`);
  const weight = ctx.get<StrokeWeight>(cmd.id, "strokeWeight");
  if (typeof weight !== "number" && !(weight.top === weight.right && weight.right === weight.bottom && weight.bottom === weight.left)) {
    ctx.reject(`per-side stroke weights cannot be outlined yet`);
  }
  const w = typeof weight === "number" ? weight : weight.top;
  if (!(w > 0)) ctx.reject(`the stroke weight is 0`);
  const box = storedBox(ctx, cmd.id);
  let geometry: Path;
  let area: Path | null = null;
  if (type === "vector") {
    const net = nodeNetwork(ctx, cmd.id)!;
    geometry = networkStrokePath(net);
  } else if (type === "line") {
    geometry = outlinePath(ctx, cmd.id, type, box.width, box.height)!;
  } else {
    geometry = outlinePath(ctx, cmd.id, type, box.width, box.height)!;
    area = geometry;
  }
  let align = ctx.get<string>(cmd.id, "strokeAlign");
  if (!area) align = "center";
  const style = {
    width: align === "center" ? w : 2 * w,
    join: ctx.get<"miter" | "round" | "bevel">(cmd.id, "strokeJoin"),
    cap: ctx.get<"butt" | "round" | "square">(cmd.id, "strokeCap"),
    miterLimit: ctx.get<number>(cmd.id, "strokeMiterLimit"),
    dash: ctx.get<number[]>(cmd.id, "strokeDashes"),
    dashOffset: ctx.get<number>(cmd.id, "strokeDashOffset"),
  };
  let contours: Cubic[][] = outlineStroke(geometry, style);
  if (area && align !== "center") {
    const shape = { contours: pathContours(area), fillRule: "nonzero" as const };
    contours = booleanOperation(align === "inside" ? "intersect" : "subtract", [{ shapes: [{ contours, fillRule: "nonzero" }] }, { shapes: [shape] }]).contours;
  }
  const net = pathToNetwork(contoursToPath(contours));
  const newId = cmd.newId ?? ctx.newId();
  if (ctx.idTaken(newId)) ctx.reject(`id ${newId} is already in use`);
  const props: Record<string, unknown> = {
    ...vectorProps(ctx, cmd.id),
    name: `${ctx.get<string>(cmd.id, "name")} stroke`,
    fills: strokes,
    strokes: [],
    vectorNetwork: checkNetwork(stripEmpty(net), ctx.reject, "outline stroke"),
  };
  const parent = ctx.parentOf(cmd.id)!;
  ctx.createAt(newId, "vector", props, parent, ctx.indexOf(cmd.id) + 1);
  const fills = type === "line" ? [] : ctx.get<Paint[]>(cmd.id, "fills").filter((p) => p.visible !== false);
  if (fills.length === 0) return { created: newId, deleted: ctx.remove(cmd.id) };
  ctx.set(cmd.id, "strokes", []);
  return { created: newId, deleted: [] };
}

/** Paint properties a new boolean group takes from its bottom operand. */
export const BOOLEAN_PAINT_KEYS = ["fills", "strokes", "strokeWeight", "strokeAlign", "strokeCap", "strokeJoin", "strokeMiterLimit", "strokeDashes", "strokeDashOffset"] as const;

/** A paint property of a node as a boolean group stores it (per-side weights become one). */
export function booleanPaintValue(ctx: GeometrySource, id: string, key: (typeof BOOLEAN_PAINT_KEYS)[number]): unknown {
  const type = ctx.typeOf(id);
  if (!type || !hasProp(type, key)) return undefined;
  const v = ctx.get<unknown>(id, key);
  if (key === "strokeWeight" && typeof v !== "number") {
    const s = v as { top: number; right: number; bottom: number; left: number };
    return Math.max(s.top, s.right, s.bottom, s.left);
  }
  return v;
}

