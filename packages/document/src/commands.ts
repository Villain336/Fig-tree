import type { Mat2D } from "@fig-tree/geometry";
import { z } from "zod";
import type { Actor, FigDocument } from "./document";
import { Draft } from "./draft";
import { newId } from "./ids";
import {
  AssetId,
  AssetMeta,
  NodeId,
  NodeType,
  Point,
  ROOT_ID,
  TEXT_STYLE_KEYS,
  TextContent,
  TextStyle,
  assetRefs,
  canContain,
  propSchema,
  typeLabel,
  type AnyNodeProps,
} from "./schema";
import { contentToSpans, encodeStyle, spansLength, type Span } from "./text";
import { boxFromMatrix, invert, multiply } from "./transform";
import {
  BOOLEAN_PAINT_KEYS,
  EditVectorCommand,
  FlattenCommand,
  OutlineStrokeCommand,
  booleanPaintValue,
  editVector,
  flatten,
  outlineStrokeOf,
  type VectorCommandContext,
} from "./vector-commands";

// ── Command schemas ──────────────────────────────────────────────────────

const ParentId = z.union([NodeId, z.literal(ROOT_ID)]);
const Index = z.number().int().min(0);
const Ids = z.array(NodeId).min(1).max(100_000);
/** Property updates: a value sets the property, `null` resets it to its default. */
const PropUpdates = z.record(z.string(), z.unknown());

export const CreateNodeCommand = z.strictObject({
  type: z.literal("createNode"),
  node: z.strictObject({
    id: NodeId.optional(),
    type: NodeType,
    props: PropUpdates.optional(),
    /** Initial content of a text node. */
    text: TextContent.optional(),
  }),
  /** Parent node id, or `"root"` for a page. */
  parent: ParentId,
  /** Position among the parent's children (0 = bottom). Defaults to the top. */
  index: Index.optional(),
});

export const UpdatePropsCommand = z.strictObject({ type: z.literal("updateProps"), id: NodeId, props: PropUpdates });
export const RenameCommand = z.strictObject({ type: z.literal("rename"), id: NodeId, name: z.string().max(1_000) });

export const SetParentCommand = z.strictObject({
  type: z.literal("setParent"),
  /** Nodes to move; they keep their current relative order. */
  ids: Ids,
  parent: NodeId,
  index: Index.optional(),
  /** Adjust x/y/rotation so the nodes stay where they are on the canvas. Default true. */
  keepPosition: z.boolean().optional(),
});

export const ReorderCommand = z.strictObject({ type: z.literal("reorder"), id: NodeId, index: Index });
export const DeleteCommand = z.strictObject({ type: z.literal("delete"), ids: Ids });

export const DuplicateCommand = z.strictObject({
  type: z.literal("duplicate"),
  ids: Ids,
  /** Offset added to each copy's x/y. */
  offset: Point.optional(),
  /** Ids for the copies of `ids`, in order (descendants always get new ids). */
  newIds: z.array(NodeId).optional(),
});

export const GroupCommand = z.strictObject({
  type: z.literal("group"),
  /** Siblings to group (they must share a parent). */
  ids: Ids,
  id: NodeId.optional(),
  name: z.string().max(1_000).optional(),
  /** Makes a boolean group, which takes its paints from the bottom node. */
  booleanOperation: z.enum(["union", "subtract", "intersect", "exclude"]).optional(),
});

export const UngroupCommand = z.strictObject({ type: z.literal("ungroup"), id: NodeId });

export const SetPageCommand = z.strictObject({
  type: z.literal("setPage"),
  /** Nodes to move to the top level of `page`, keeping their position on the canvas. */
  ids: Ids,
  page: NodeId,
  index: Index.optional(),
});

export const SetTextCommand = z.strictObject({ type: z.literal("setText"), id: NodeId, text: TextContent });
export const InsertTextCommand = z.strictObject({
  type: z.literal("insertText"),
  id: NodeId,
  index: Index,
  text: z.string().min(1),
  /** Exact style of the inserted text; omitted, it continues the style of the preceding character. */
  style: TextStyle.optional(),
});
export const DeleteTextCommand = z.strictObject({ type: z.literal("deleteText"), id: NodeId, index: Index, length: z.number().int().min(1) });
export const FormatTextCommand = z.strictObject({
  type: z.literal("formatText"),
  id: NodeId,
  index: Index,
  length: z.number().int().min(1),
  /** Overrides to set; `null` removes an override. */
  style: z.record(z.string(), z.unknown()),
});

export const AddAssetCommand = z.strictObject({ type: z.literal("addAsset"), id: AssetId, meta: AssetMeta });
export const SetDocumentNameCommand = z.strictObject({ type: z.literal("setDocumentName"), name: z.string().max(1_000) });

export const Command = z.discriminatedUnion("type", [
  CreateNodeCommand,
  UpdatePropsCommand,
  RenameCommand,
  SetParentCommand,
  ReorderCommand,
  DeleteCommand,
  DuplicateCommand,
  GroupCommand,
  UngroupCommand,
  SetPageCommand,
  SetTextCommand,
  InsertTextCommand,
  DeleteTextCommand,
  FormatTextCommand,
  AddAssetCommand,
  SetDocumentNameCommand,
  EditVectorCommand,
  FlattenCommand,
  OutlineStrokeCommand,
]);
export type Command = z.input<typeof Command>;
export type CommandType = Command["type"];

/** Typed constructor helpers, so callers get autocompletion for property names. */
export type TypedCommand =
  | (Omit<z.input<typeof CreateNodeCommand>, "node"> & { node: { id?: string; type: NodeType; props?: Partial<AnyNodeProps>; text?: TextContent } })
  | (Omit<z.input<typeof UpdatePropsCommand>, "props"> & { props: { [K in keyof AnyNodeProps]?: AnyNodeProps[K] | null } })
  | Exclude<Command, { type: "createNode" } | { type: "updateProps" }>;

// ── Results and errors ───────────────────────────────────────────────────

export interface CommandResult {
  readonly type: CommandType;
  /** Every node the command created, changed, moved or deleted. */
  readonly affected: readonly string[];
  /** New nodes; for `duplicate`, the copies of `ids` come first, in order. */
  readonly created: readonly string[];
  readonly deleted: readonly string[];
}

export interface ApplyResult {
  readonly results: readonly CommandResult[];
  readonly affected: readonly string[];
  readonly created: readonly string[];
  readonly deleted: readonly string[];
}

/** A rejected command. Nothing in its batch was applied. */
export class CommandError extends Error {
  constructor(
    /** Position of the failing command in the batch. */
    readonly index: number,
    readonly command: string,
    readonly issues: readonly string[],
  ) {
    super(`command ${index} (${command}) rejected: ${issues.join("; ")}`);
    this.name = "CommandError";
  }
}

class Rejection extends Error {
  constructor(readonly issues: string[]) {
    super(issues.join("; "));
  }
}

function reject(...issues: string[]): never {
  throw new Rejection(issues);
}

function zodIssues(error: z.ZodError, prefix = ""): string[] {
  return error.issues.map((i) => {
    const path = [prefix, ...i.path.map(String)].filter(Boolean).join(".");
    return path ? `${path}: ${i.message}` : i.message;
  });
}

// ── Application ──────────────────────────────────────────────────────────

export interface ApplyOptions {
  /** Who is making the change; scopes undo. */
  readonly origin: Actor;
}

/**
 * Validates and applies a batch of commands as one Yjs transaction (one
 * undo step). Commands see the effects of earlier commands in the batch.
 * If any command is invalid, nothing is applied and a {@link CommandError}
 * is thrown.
 */
export function applyCommands(doc: FigDocument, commands: readonly (Command | TypedCommand)[], options: ApplyOptions): ApplyResult {
  // The actor's undo manager must exist before its first change to track it.
  if (options.origin.kind !== "system") doc.undoManager(options.origin);
  const draft = new Draft(doc);
  const results = runCommands(draft, commands);
  if (results.some((r) => r.affected.length > 0) || commandsTouchMeta(commands)) draft.commit(options.origin);
  return summarize(results);
}

/** @internal Runs commands against a draft without committing. */
export function runCommands(draft: Draft, commands: readonly (Command | TypedCommand)[]): CommandResult[] {
  return commands.map((raw, index) => {
    const parsed = Command.safeParse(raw);
    const type = (raw as { type?: unknown })?.type;
    const name = typeof type === "string" ? type : "unknown";
    if (!parsed.success) throw new CommandError(index, name, zodIssues(parsed.error));
    try {
      return execute(draft, parsed.data);
    } catch (e) {
      if (e instanceof Rejection) throw new CommandError(index, name, e.issues);
      throw e;
    }
  });
}

function commandsTouchMeta(commands: readonly (Command | TypedCommand)[]): boolean {
  return commands.some((c) => c.type === "addAsset" || c.type === "setDocumentName");
}

export function summarize(results: readonly CommandResult[]): ApplyResult {
  const affected = new Set<string>();
  const created = new Set<string>();
  const deleted = new Set<string>();
  for (const r of results) {
    r.affected.forEach((id) => affected.add(id));
    r.created.forEach((id) => created.add(id));
    r.deleted.forEach((id) => deleted.add(id));
  }
  for (const id of deleted) created.delete(id);
  return { results, affected: [...affected], created: [...created], deleted: [...deleted] };
}

type ParsedCommand = z.output<typeof Command>;

class Recorder {
  readonly affected = new Set<string>();
  readonly created: string[] = [];
  readonly deleted: string[] = [];
  constructor(private readonly type: CommandType) {}
  touch(...ids: string[]): this {
    ids.forEach((id) => this.affected.add(id));
    return this;
  }
  result(): CommandResult {
    return { type: this.type, affected: [...this.affected], created: this.created, deleted: this.deleted };
  }
}

function execute(d: Draft, cmd: ParsedCommand): CommandResult {
  const rec = new Recorder(cmd.type);
  switch (cmd.type) {
    case "createNode":
      createNode(d, rec, cmd);
      break;
    case "updateProps": {
      const type = requireNode(d, cmd.id);
      const props = validateProps(d, type, cmd.props, `${type} ${cmd.id}`);
      for (const [k, v] of Object.entries(props)) d.set(cmd.id, k, v);
      rec.touch(cmd.id);
      break;
    }
    case "rename": {
      requireNode(d, cmd.id);
      d.set(cmd.id, "name", cmd.name);
      rec.touch(cmd.id);
      break;
    }
    case "setParent":
      moveNodes(d, rec, cmd.ids, cmd.parent, cmd.index, cmd.keepPosition ?? true);
      break;
    case "reorder": {
      requireNode(d, cmd.id);
      const parent = d.parentOf(cmd.id)!;
      const [key] = d.keysAt(parent, cmd.index, 1, new Set([cmd.id]));
      d.place(cmd.id, parent, key!);
      rec.touch(cmd.id);
      break;
    }
    case "delete":
      deleteNodes(d, rec, cmd.ids);
      break;
    case "duplicate":
      duplicate(d, rec, cmd.ids, cmd.offset, cmd.newIds);
      break;
    case "group":
      group(d, rec, cmd.ids, cmd.id, cmd.name, cmd.booleanOperation);
      break;
    case "editVector":
      editVector(vectorContext(d), cmd);
      rec.touch(cmd.id);
      break;
    case "flatten": {
      const r = flatten(vectorContext(d), cmd);
      rec.touch(r.created, ...r.deleted);
      rec.created.push(r.created);
      rec.deleted.push(...r.deleted);
      break;
    }
    case "outlineStroke": {
      const r = outlineStrokeOf(vectorContext(d), cmd);
      rec.touch(cmd.id, r.created, ...r.deleted);
      rec.created.push(r.created);
      rec.deleted.push(...r.deleted);
      break;
    }
    case "ungroup":
      ungroup(d, rec, cmd.id);
      break;
    case "setPage": {
      const pageType = requireNode(d, cmd.page);
      if (pageType !== "page") reject(`${cmd.page} is a ${pageType}, not a page`);
      moveNodes(d, rec, cmd.ids, cmd.page, cmd.index, true);
      break;
    }
    case "setText": {
      requireText(d, cmd.id);
      const length = spansLength(d.spans(cmd.id));
      validateRunsAssets(d, cmd.text);
      if (length > 0) d.text(cmd.id, { op: "delete", index: 0, length });
      let at = 0;
      for (const span of contentToSpans(cmd.text)) {
        d.text(cmd.id, { op: "insert", index: at, text: span.text, attrs: span.attrs });
        at += span.text.length;
      }
      rec.touch(cmd.id);
      break;
    }
    case "insertText": {
      requireText(d, cmd.id);
      const length = spansLength(d.spans(cmd.id));
      if (cmd.index > length) reject(`index ${cmd.index} is past the end of the text (${length})`);
      if (cmd.style) checkStyleAssets(d, cmd.style);
      d.text(cmd.id, cmd.style ? { op: "insert", index: cmd.index, text: cmd.text, attrs: encodeStyle(cmd.style) } : { op: "insert", index: cmd.index, text: cmd.text });
      rec.touch(cmd.id);
      break;
    }
    case "deleteText": {
      requireText(d, cmd.id);
      const length = spansLength(d.spans(cmd.id));
      if (cmd.index + cmd.length > length) reject(`range [${cmd.index}, ${cmd.index + cmd.length}) is past the end of the text (${length})`);
      d.text(cmd.id, { op: "delete", index: cmd.index, length: cmd.length });
      rec.touch(cmd.id);
      break;
    }
    case "formatText": {
      requireText(d, cmd.id);
      const length = spansLength(d.spans(cmd.id));
      if (cmd.index + cmd.length > length) reject(`range [${cmd.index}, ${cmd.index + cmd.length}) is past the end of the text (${length})`);
      d.text(cmd.id, { op: "format", index: cmd.index, length: cmd.length, attrs: validateStyleUpdate(d, cmd.style) });
      rec.touch(cmd.id);
      break;
    }
    case "addAsset":
      d.addAsset(cmd.id, cmd.meta);
      break;
    case "setDocumentName":
      d.setName(cmd.name);
      break;
  }
  return rec.result();
}

// ── Helpers ──────────────────────────────────────────────────────────────

function requireNode(d: Draft, id: string): NodeType {
  const type = d.typeOf(id);
  if (!type) reject(`node ${id} does not exist`);
  return type;
}

function requireText(d: Draft, id: string): void {
  const type = requireNode(d, id);
  if (type !== "text") reject(`${id} is a ${type}, not a text node`);
}

/** Validates property updates for a node type; returns them with `null` meaning "reset". */
function validateProps(d: Draft, type: NodeType, props: Record<string, unknown>, where: string): Record<string, unknown> {
  const issues: string[] = [];
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    const schema = propSchema(type, key);
    if (!schema) {
      issues.push(`${where}: property "${key}" does not apply to ${type} nodes`);
      continue;
    }
    if (value === null || value === undefined) {
      out[key] = null;
      continue;
    }
    const r = schema.safeParse(value);
    if (!r.success) {
      issues.push(...zodIssues(r.error, `${where}: ${key}`));
      continue;
    }
    out[key] = r.data;
  }
  for (const ref of assetRefs(out)) if (!d.hasAsset(ref)) issues.push(`${where}: asset ${ref} has not been added (use addAsset first)`);
  if (issues.length) reject(...issues);
  return out;
}

function checkStyleAssets(d: Draft, style: TextStyle): void {
  for (const ref of assetRefs({ fills: style.fills })) if (!d.hasAsset(ref)) reject(`asset ${ref} has not been added`);
}

function validateRunsAssets(d: Draft, text: TextContent): void {
  for (const run of text.runs) checkStyleAssets(d, run.style);
}

function validateStyleUpdate(d: Draft, style: Record<string, unknown>): Span["attrs"] {
  const issues: string[] = [];
  const set: Record<string, unknown> = {};
  const attrs: Span["attrs"] = {};
  for (const [k, v] of Object.entries(style)) {
    if (!(TEXT_STYLE_KEYS as string[]).includes(k)) {
      issues.push(`"${k}" is not a text style property`);
      continue;
    }
    if (v === null) attrs[k] = null;
    else set[k] = v;
  }
  const r = TextStyle.safeParse(set);
  if (!r.success) issues.push(...zodIssues(r.error, "style"));
  if (issues.length) reject(...issues);
  checkStyleAssets(d, r.data!);
  return { ...attrs, ...encodeStyle(r.data!) };
}

/** Defaults a fresh node gets from the command layer (not schema defaults). */
function creationDefaults(d: Draft, type: NodeType, parent: string): Record<string, unknown> {
  const out: Record<string, unknown> = { name: typeLabel(type) };
  if (type === "page") return out;
  // Children of flex and grid containers join the flow.
  const parentDisplay = parent === ROOT_ID ? "block" : d.get<string>(parent, "display");
  if (parentDisplay === "flex" || parentDisplay === "grid") out.position = "relative";
  if (type === "group" || type === "text") return out;
  Object.assign(out, { width: 100, height: type === "line" ? 0 : 100 });
  // Frames clip their content, as designers expect; CSS's initial value is visible.
  if (type === "frame" || type === "component" || type === "instance") Object.assign(out, { overflowX: "hidden", overflowY: "hidden" });
  return out;
}

function checkParent(d: Draft, parent: string, childType: NodeType): void {
  if (parent === ROOT_ID) {
    if (childType !== "page") reject(`only pages can be added to the document root`);
    return;
  }
  const parentType = requireNode(d, parent);
  if (!canContain(parentType, childType)) {
    reject(childType === "page" ? `pages can only be added to the document root` : `${parentType} nodes cannot have children`);
  }
}

function createNode(d: Draft, rec: Recorder, cmd: Extract<ParsedCommand, { type: "createNode" }>): void {
  const { node, parent } = cmd;
  checkParent(d, parent, node.type);
  const id = node.id ?? newId(d.doc.random);
  if (d.idTaken(id)) reject(`id ${id} is already in use`);
  if (node.text && node.type !== "text") reject(`only text nodes have text content`);
  const props = validateProps(d, node.type, node.props ?? {}, `new ${node.type}`);
  if (node.text) validateRunsAssets(d, node.text);
  const initial = { ...creationDefaults(d, node.type, parent), ...props };
  const [key] = d.keysAt(parent, cmd.index ?? Number.MAX_SAFE_INTEGER, 1, new Set());
  d.create(id, node.type, initial, parent, key!, node.text ? contentToSpans(node.text) : null);
  rec.touch(id);
  rec.created.push(id);
}

function moveNodes(d: Draft, rec: Recorder, ids: readonly string[], parent: string, index: number | undefined, keepPosition: boolean): void {
  const unique = [...new Set(ids)];
  for (const id of unique) {
    const type = requireNode(d, id);
    checkParent(d, parent, type);
    if (type === "page") reject(`pages cannot be moved into other nodes`);
    if (d.isSelfOrAncestor(id, parent)) reject(`cannot move ${id} into itself or its own descendant ${parent}`);
  }
  // Move in current paint order so relative order is kept.
  const ordered = sortByTreeOrder(d, unique);
  const oldParents = new Set(ordered.map((id) => d.parentOf(id)!));
  const targetWorld = keepPosition ? d.worldMatrix(parent) : null;
  const worlds = new Map<string, Mat2D>();
  if (keepPosition) for (const id of ordered) captureWorlds(d, id, worlds);
  const keys = d.keysAt(parent, index ?? Number.MAX_SAFE_INTEGER, ordered.length, new Set(ordered));
  ordered.forEach((id, i) => {
    d.place(id, parent, keys[i]!);
    rec.touch(id);
    if (targetWorld) relocate(d, rec, id, targetWorld, worlds);
  });
  for (const p of oldParents) removeIfEmptyGroup(d, rec, p);
}

/** Records the world matrix of a node, and of the children of groups (which have no box of their own). */
function captureWorlds(d: Draft, id: string, out: Map<string, Mat2D>): void {
  out.set(id, d.worldMatrix(id));
  if (d.typeOf(id) === "group") for (const c of d.childrenOf(id)) captureWorlds(d, c, out);
}

/**
 * Rewrites a moved node's box so it keeps the world placement captured in
 * `worlds` under a parent whose world matrix is now `parentWorld`.
 */
function relocate(d: Draft, rec: Recorder, id: string, parentWorld: Mat2D, worlds: ReadonlyMap<string, Mat2D>): void {
  if (d.typeOf(id) === "group") {
    // Groups have no box: their children live in the group's parent space.
    for (const c of d.childrenOf(id)) relocate(d, rec, c, parentWorld, worlds);
    return;
  }
  const world = worlds.get(id);
  const inv = invert(parentWorld);
  if (!world || !inv) return;
  rec.touch(id);
  const local = multiply(inv, world);
  const box = boxFromMatrix(local, d.get(id, "width"), d.get(id, "height"), d.get(id, "flipX"), d.get(id, "flipY"));
  for (const key of ["x", "y", "rotation", "flipX", "flipY"] as const) {
    const before = d.get(id, key);
    if (before !== box[key]) d.set(id, key, box[key]);
  }
}

function removeIfEmptyGroup(d: Draft, rec: Recorder, id: string): void {
  for (let cur: string | undefined = id; cur !== undefined && cur !== ROOT_ID; ) {
    if (d.typeOf(cur) !== "group" || d.childrenOf(cur).length > 0) return;
    const parent = d.parentOf(cur);
    rec.deleted.push(...d.remove(cur));
    rec.touch(cur);
    cur = parent;
  }
}

function sortByTreeOrder(d: Draft, ids: readonly string[]): string[] {
  const path = (id: string): number[] => {
    const out: number[] = [];
    for (let cur: string | undefined = id; cur !== undefined && cur !== ROOT_ID; cur = d.parentOf(cur)) out.unshift(d.indexOf(cur));
    return out;
  };
  const paths = new Map(ids.map((id) => [id, path(id)]));
  return [...ids].sort((a, b) => {
    const pa = paths.get(a)!, pb = paths.get(b)!;
    for (let i = 0; i < Math.min(pa.length, pb.length); i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
    return pa.length - pb.length;
  });
}

function deleteNodes(d: Draft, rec: Recorder, ids: readonly string[]): void {
  const unique = [...new Set(ids)];
  for (const id of unique) requireNode(d, id);
  const pagesLeft = d.childrenOf(ROOT_ID).filter((p) => !unique.includes(p));
  if (unique.some((id) => d.typeOf(id) === "page") && pagesLeft.length === 0) reject(`a document must keep at least one page`);
  const parents = new Set<string>();
  for (const id of unique) {
    if (!d.exists(id)) continue; // already removed with an ancestor
    parents.add(d.parentOf(id)!);
    const removed = d.remove(id);
    rec.deleted.push(...removed);
    rec.touch(...removed);
  }
  for (const p of parents) if (d.exists(p)) removeIfEmptyGroup(d, rec, p);
}

function duplicate(d: Draft, rec: Recorder, ids: readonly string[], offset: { x: number; y: number } | undefined, newIds: readonly string[] | undefined): void {
  const unique = [...new Set(ids)];
  if (newIds && newIds.length !== unique.length) reject(`newIds must give one id per duplicated node`);
  for (const id of unique) {
    const type = requireNode(d, id);
    if (type === "page") reject(`pages cannot be duplicated with this command`);
  }
  const rootIdFor = new Map(unique.map((id, i) => [id, newIds?.[i]]));
  const descendants: string[] = [];
  for (const id of unique) {
    // A node whose ancestor is also duplicated is copied with that ancestor.
    if (unique.some((other) => other !== id && d.isSelfOrAncestor(other, id))) continue;
    const copyId = rootIdFor.get(id) ?? newId(d.doc.random);
    if (d.idTaken(copyId)) reject(`id ${copyId} is already in use`);
    const parent = d.parentOf(id)!;
    // The copy goes right above the original.
    const [key] = d.keysAt(parent, d.indexOf(id) + 1, 1, new Set());
    rec.created.push(copyId);
    copyTree(d, rec, id, copyId, parent, key!, offset, descendants);
  }
  // Copies of `ids` first (in order), then their descendants.
  rec.created.push(...descendants);
}

/** Copies a subtree; children keep their order keys (the new parent has no other children). */
function copyTree(
  d: Draft,
  rec: Recorder,
  source: string,
  id: string,
  parent: string,
  key: string,
  offset: { x: number; y: number } | undefined,
  descendants: string[] | null,
): void {
  const type = d.typeOf(source)!;
  const props = d.storedProps(source);
  if (offset && type !== "group") {
    props.x = d.get<number>(source, "x") + offset.x;
    props.y = d.get<number>(source, "y") + offset.y;
  }
  const spans = type === "text" ? d.spans(source).map((s) => ({ text: s.text, attrs: { ...s.attrs } })) : null;
  d.create(id, type, props, parent, key, spans);
  rec.touch(id);
  // Children of a group share the group's coordinate space, so they take the offset too.
  const childOffset = type === "group" ? offset : undefined;
  for (const child of d.childrenOf(source)) {
    const copy = newId(d.doc.random);
    (descendants ?? rec.created).push(copy);
    copyTree(d, rec, child, copy, id, d.keyOf(child)!, childOffset, descendants);
  }
}

/** The draft as the vector commands see it. */
function vectorContext(d: Draft): VectorCommandContext {
  return {
    typeOf: (id) => d.typeOf(id),
    get: <T>(id: string, key: string) => d.get<T>(id, key),
    childrenOf: (id) => d.childrenOf(id),
    set: (id, key, value) => d.set(id, key, value),
    storedProps: (id) => d.storedProps(id),
    parentOf: (id) => d.parentOf(id),
    indexOf: (id) => d.indexOf(id),
    createAt: (id, type, props, parent, index) => {
      const [key] = d.keysAt(parent, index, 1, new Set());
      d.create(id, type, props, parent, key!, null);
    },
    remove: (id) => d.remove(id),
    newId: () => newId(d.doc.random),
    idTaken: (id) => d.idTaken(id),
    reject: (...issues) => reject(...issues),
  };
}

function group(d: Draft, rec: Recorder, ids: readonly string[], groupId: string | undefined, name: string | undefined, booleanOperation?: string): void {
  const unique = [...new Set(ids)];
  for (const id of unique) {
    const type = requireNode(d, id);
    if (type === "page") reject(`pages cannot be grouped`);
  }
  const parent = d.parentOf(unique[0]!)!;
  if (unique.some((id) => d.parentOf(id) !== parent)) reject(`grouped nodes must share a parent`);
  const id = groupId ?? newId(d.doc.random);
  if (d.idTaken(id)) reject(`id ${id} is already in use`);
  const ordered = sortByTreeOrder(d, unique);
  // The group takes the place of the topmost member.
  const top = ordered[ordered.length - 1]!;
  const index = d.indexOf(top) + 1;
  const [key] = d.keysAt(parent, index, 1, new Set());
  const props: Record<string, unknown> = { name: name ?? typeLabel("group") };
  if (booleanOperation) {
    props.booleanOperation = booleanOperation;
    if (!name) props.name = booleanOperation[0]!.toUpperCase() + booleanOperation.slice(1);
    // Paints come from the bottom operand, which is also what "subtract" keeps.
    for (const k of BOOLEAN_PAINT_KEYS) {
      const v = booleanPaintValue(d, ordered[0]!, k);
      if (v !== undefined) props[k] = v;
    }
  }
  d.create(id, "group", props, parent, key!, null);
  rec.touch(id);
  rec.created.push(id);
  const keys = d.keysAt(id, 0, ordered.length, new Set());
  ordered.forEach((child, i) => {
    d.place(child, id, keys[i]!);
    rec.touch(child);
  });
}

function ungroup(d: Draft, rec: Recorder, id: string): void {
  const type = requireNode(d, id);
  if (type !== "group" && type !== "frame") reject(`only groups and frames can be ungrouped, not ${type} nodes`);
  const parent = d.parentOf(id)!;
  const children = [...d.childrenOf(id)];
  const parentWorld = d.worldMatrix(parent);
  const worlds = new Map<string, Mat2D>();
  for (const c of children) captureWorlds(d, c, worlds);
  const keys = d.keysAt(parent, d.indexOf(id), children.length, new Set([id]));
  children.forEach((child, i) => {
    d.place(child, parent, keys[i]!);
    rec.touch(child);
    if (type === "frame") relocate(d, rec, child, parentWorld, worlds);
  });
  rec.deleted.push(...d.remove(id));
  rec.touch(id);
}
