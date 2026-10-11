import * as Y from "yjs";
import { applyCommands, type ApplyResult, type Command, type TypedCommand } from "./commands";
import { cryptoRandom } from "./ids";
import { deepFreeze } from "./json";
import type { Random } from "./order";
import { ROOT_ID, defaultProp, type AssetMeta, type NodeType, type TextContent } from "./schema";
import { spansFromYText, spansToContent, type Span } from "./text";
import { Tree, type Placement, type RawNode } from "./tree";

/**
 * Who made a change. Every transaction carries one as its Yjs origin, which
 * scopes undo (each actor undoes only their own changes) and lets the UI
 * show who did what. Actors are interned per document: use
 * {@link FigDocument.actor} to get the instance for an id.
 */
export interface Actor {
  readonly kind: "user" | "agent" | "system";
  readonly id: string;
}

/** Origin of updates received from other replicas. */
export const REMOTE = Object.freeze({ kind: "remote" as const });

/** What changed in one transaction, as seen through the document model. */
export interface DocumentChange {
  /** The transaction origin: an {@link Actor}, {@link REMOTE}, an undo manager, or whatever the caller passed. */
  readonly origin: unknown;
  readonly local: boolean;
  /** Nodes whose stored properties changed (keys exclude placement and text). */
  readonly props: ReadonlyMap<string, ReadonlySet<string>>;
  /** Text nodes whose content or runs changed. */
  readonly text: ReadonlySet<string>;
  /** The effective tree changed (nodes added, removed, moved or reordered). */
  readonly structure: TreeDelta | null;
  readonly assets: boolean;
  readonly meta: boolean;
}

/** Differences between the effective trees before and after a transaction. */
export interface TreeDelta {
  readonly added: ReadonlySet<string>;
  readonly removed: ReadonlySet<string>;
  /** Nodes still in the tree whose parent changed. */
  readonly reparented: ReadonlySet<string>;
  /** Containers whose child list changed (membership or order). `ROOT_ID` for the page list. */
  readonly parents: ReadonlySet<string>;
}

export interface DocumentOptions {
  /** Random source for node ids and order keys (defaults to crypto randomness). */
  readonly random?: Random;
  /** Yjs client id, for reproducible tests. */
  readonly clientId?: number;
}

/**
 * The Fig Tree document: a Yjs CRDT of nodes with CSS-semantic properties.
 *
 * Layout of the Y.Doc:
 * - `nodes`: Y.Map from node id to a Y.Map holding `type`, `placement`
 *   ({@link Placement}), one key per stored property (plain JSON values),
 *   and `content` (a Y.Text) for text nodes;
 * - `assets`: Y.Map from asset id to {@link AssetMeta} (append-only);
 * - `meta`: document name and Y layout version.
 *
 * Read through this class; write only through commands ({@link applyCommands}).
 */
export class FigDocument {
  readonly ydoc: Y.Doc;
  readonly random: Random;
  /** @internal */ readonly nodes: Y.Map<Y.Map<unknown>>;
  /** @internal */ readonly assetsMap: Y.Map<AssetMeta>;
  /** @internal */ readonly meta: Y.Map<unknown>;
  private raw = new Map<string, RawNode>();
  private _tree: Tree | null = null;
  private readonly listeners = new Set<(change: DocumentChange) => void>();
  private readonly actors = new Map<string, Actor>();
  private readonly undoManagers = new Map<Actor, Y.UndoManager>();
  private pending: {
    props: Map<string, Set<string>>;
    text: Set<string>;
    structural: boolean;
    assets: boolean;
    meta: boolean;
  } | null = null;
  private destroyed = false;

  private constructor(ydoc: Y.Doc, options: DocumentOptions) {
    this.ydoc = ydoc;
    this.random = options.random ?? cryptoRandom;
    this.nodes = ydoc.getMap("nodes");
    this.assetsMap = ydoc.getMap("assets");
    this.meta = ydoc.getMap("meta");
    for (const [id, map] of this.nodes) this.raw.set(id, readRaw(map));
    this.nodes.observeDeep(this.onNodes);
    this.assetsMap.observe(() => (this.pendingChange().assets = true));
    this.meta.observe(() => (this.pendingChange().meta = true));
    ydoc.on("afterTransaction", this.onAfterTransaction);
  }

  /** An empty document (no pages). Most callers want {@link FigDocument.create}. */
  static empty(options: DocumentOptions = {}): FigDocument {
    const ydoc = new Y.Doc();
    if (options.clientId !== undefined) ydoc.clientID = options.clientId;
    return new FigDocument(ydoc, options);
  }

  /**
   * A new document with one empty page. Replicas of one document must share
   * history: create it once and load the others with {@link fromUpdate}.
   */
  static create(options: DocumentOptions & { name?: string; pageName?: string } = {}): FigDocument {
    const doc = FigDocument.empty(options);
    const system = doc.actor("init", "system");
    doc.apply(
      [
        { type: "setDocumentName", name: options.name ?? "Untitled" },
        { type: "createNode", node: { type: "page", props: { name: options.pageName ?? "Page 1" } }, parent: ROOT_ID },
      ],
      system,
    );
    return doc;
  }

  /** Loads a document from a Yjs update (v1 or v2 encoding is detected). */
  static fromUpdate(update: Uint8Array, options: DocumentOptions = {}): FigDocument {
    const doc = FigDocument.empty(options);
    try {
      Y.applyUpdateV2(doc.ydoc, update, REMOTE);
    } catch {
      Y.applyUpdate(doc.ydoc, update, REMOTE);
    }
    return doc;
  }

  // ── Writes ───────────────────────────────────────────────────────────

  /**
   * Validates and applies a batch of commands as one transaction and one
   * undo step for `origin`. Throws a `CommandError` (and changes nothing) if
   * any command is invalid.
   */
  apply(commands: readonly (Command | TypedCommand)[], origin: Actor): ApplyResult {
    return applyCommands(this, commands, { origin });
  }

  // ── Actors and change notification ───────────────────────────────────

  /** The interned actor for `(kind, id)`; pass it as the origin of commands. */
  actor(id: string, kind: Actor["kind"] = "user"): Actor {
    const key = `${kind}:${id}`;
    let a = this.actors.get(key);
    if (!a) this.actors.set(key, (a = Object.freeze({ kind, id })));
    return a;
  }

  /** Subscribes to per-transaction changes. Returns an unsubscribe function. */
  onChange(listener: (change: DocumentChange) => void): () => void {
    // Listeners get tree deltas, which need the tree from before each change.
    void this.tree;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private pendingChange(): NonNullable<FigDocument["pending"]> {
    this.pending ??= { props: new Map(), text: new Set(), structural: false, assets: false, meta: false };
    return this.pending;
  }

  private readonly onNodes = (events: Y.YEvent<Y.AbstractType<unknown>>[]): void => {
    const p = this.pendingChange();
    for (const event of events) {
      if (event.target === this.nodes) {
        for (const id of (event as Y.YMapEvent<unknown>).keysChanged) {
          const map = this.nodes.get(id);
          if (map) this.raw.set(id, readRaw(map));
          else this.raw.delete(id);
        }
        p.structural = true;
        continue;
      }
      const id = event.path[0] as string;
      if (event.target instanceof Y.Text || event.path.length > 1) {
        p.text.add(id);
        continue;
      }
      const keys = (event as Y.YMapEvent<unknown>).keysChanged;
      let set = p.props.get(id);
      for (const key of keys) {
        if (key === "placement") {
          const map = this.nodes.get(id);
          if (map) this.raw.set(id, readRaw(map));
          p.structural = true;
        } else if (key === "content") {
          p.text.add(id);
        } else if (key !== "type") {
          if (!set) p.props.set(id, (set = new Set()));
          set.add(key);
        }
      }
    }
  };

  private readonly onAfterTransaction = (tr: Y.Transaction): void => {
    const p = this.pending;
    this.pending = null;
    if (!p || this.destroyed) return;
    let structure: TreeDelta | null = null;
    if (p.structural) {
      const before = this._tree;
      this._tree = null;
      // Without listeners nobody needs the delta: resolve the tree lazily on the next read.
      if (this.listeners.size === 0) return;
      structure = before ? diffTrees(before, this.tree) : fullDelta(this.tree);
      if (structure.added.size + structure.removed.size + structure.reparented.size + structure.parents.size === 0) structure = null;
    }
    if (this.listeners.size === 0) return;
    // Property changes of nodes that are not (or no longer) in the tree are irrelevant to readers.
    for (const id of [...p.props.keys()]) if (!this.tree.has(id)) p.props.delete(id);
    for (const id of [...p.text]) if (!this.tree.has(id)) p.text.delete(id);
    if (!structure && p.props.size === 0 && p.text.size === 0 && !p.assets && !p.meta) return;
    const change: DocumentChange = { origin: tr.origin, local: tr.local, props: p.props, text: p.text, structure, assets: p.assets, meta: p.meta };
    for (const l of this.listeners) l(change);
  };

  // ── Reads ────────────────────────────────────────────────────────────

  /** The effective node tree (cycles and orphans from concurrent edits repaired). */
  get tree(): Tree {
    this._tree ??= new Tree(this.raw);
    return this._tree;
  }

  get name(): string {
    const n = this.meta.get("name");
    return typeof n === "string" ? n : "Untitled";
  }

  get pages(): readonly string[] {
    return this.tree.pages;
  }

  has(id: string): boolean {
    return this.tree.has(id);
  }

  typeOf(id: string): NodeType | undefined {
    return this.tree.has(id) ? this.raw.get(id)?.type : undefined;
  }

  /**
   * Whether a node id was ever used in this document, including deleted
   * nodes. Ids are never reused: undoing a delete restores the old node
   * under its id. (Yjs keeps the last item of every map key, deleted or not.)
   */
  idUsed(id: string): boolean {
    return (this.nodes as unknown as { _map: Map<string, unknown> })._map.has(id);
  }

  /** @internal Raw node info, including nodes the tree dropped. */
  rawNode(id: string): RawNode | undefined {
    return this.raw.get(id);
  }

  /** @internal */
  placementOf(id: string): Placement | undefined {
    return this.raw.get(id)?.placement;
  }

  /** A stored property value, or undefined when the property is unset. Values are frozen. */
  stored(id: string, key: string): unknown {
    return deepFreeze(this.nodes.get(id)?.get(key));
  }

  /** A property value: the stored one, or the type's default. */
  get<T = unknown>(id: string, key: string): T {
    const v = this.stored(id, key);
    if (v !== undefined) return v as T;
    const type = this.raw.get(id)?.type;
    return (type ? defaultProp(type, key) : undefined) as T;
  }

  /** All stored properties of a node (excluding type, placement and text). */
  storedProps(id: string): Record<string, unknown> {
    const map = this.nodes.get(id);
    const out: Record<string, unknown> = {};
    if (!map) return out;
    for (const [k, v] of map) {
      if (k === "type" || k === "placement" || k === "content") continue;
      out[k] = deepFreeze(v);
    }
    return out;
  }

  /** @internal The Y.Text of a text node. */
  ytext(id: string): Y.Text | undefined {
    const t = this.nodes.get(id)?.get("content");
    return t instanceof Y.Text ? t : undefined;
  }

  /** @internal Text content as spans. */
  spans(id: string): Span[] {
    const t = this.ytext(id);
    return t ? spansFromYText(t) : [];
  }

  /** Content and style runs of a text node. */
  text(id: string): TextContent {
    return spansToContent(this.spans(id));
  }

  assets(): ReadonlyMap<string, AssetMeta> {
    return new Map(this.assetsMap.entries());
  }

  // ── Undo ─────────────────────────────────────────────────────────────

  /**
   * The undo manager of one actor. It tracks only transactions whose origin
   * is that actor, so undo never reverts anyone else's edits. Each command
   * batch is one undo step.
   */
  undoManager(actor: Actor): Y.UndoManager {
    let um = this.undoManagers.get(actor);
    if (!um) {
      um = new Y.UndoManager([this.nodes, this.meta], { trackedOrigins: new Set([actor]), captureTimeout: 0 });
      this.undoManagers.set(actor, um);
    }
    return um;
  }

  undo(actor: Actor): boolean {
    return this.undoManager(actor).undo() !== null;
  }

  redo(actor: Actor): boolean {
    return this.undoManager(actor).redo() !== null;
  }

  canUndo(actor: Actor): boolean {
    return this.undoManager(actor).canUndo();
  }

  canRedo(actor: Actor): boolean {
    return this.undoManager(actor).canRedo();
  }

  // ── Sync ─────────────────────────────────────────────────────────────

  /** The full state as a Yjs update (v2 encoding). */
  encodeState(since?: Uint8Array): Uint8Array {
    return Y.encodeStateAsUpdateV2(this.ydoc, since);
  }

  stateVector(): Uint8Array {
    return Y.encodeStateVector(this.ydoc);
  }

  /** Applies an update from another replica (v2 encoding). */
  applyUpdate(update: Uint8Array, origin: unknown = REMOTE): void {
    Y.applyUpdateV2(this.ydoc, update, origin);
  }

  /** @internal Runs `fn` in one Yjs transaction. */
  transact(fn: () => void, origin: unknown): void {
    this.ydoc.transact(fn, origin);
  }

  destroy(): void {
    this.destroyed = true;
    for (const um of this.undoManagers.values()) um.destroy();
    this.nodes.unobserveDeep(this.onNodes);
    this.ydoc.off("afterTransaction", this.onAfterTransaction);
    this.listeners.clear();
  }
}

function readRaw(map: Y.Map<unknown>): RawNode {
  return { type: map.get("type") as NodeType, placement: deepFreeze(map.get("placement") as Placement | undefined) };
}

function diffTrees(before: Tree, after: Tree): TreeDelta {
  const added = new Set<string>();
  const removed = new Set<string>();
  const reparented = new Set<string>();
  const parents = new Set<string>();
  for (const id of after.ids()) {
    const pb = before.parentOf(id);
    const pa = after.parentOf(id)!;
    if (pb === undefined) {
      added.add(id);
      parents.add(pa);
    } else if (pb !== pa) {
      reparented.add(id);
      parents.add(pa);
      parents.add(pb);
    } else if (before.keyOf(id) !== after.keyOf(id)) {
      parents.add(pa);
    }
  }
  for (const id of before.ids()) {
    if (!after.has(id)) {
      removed.add(id);
      const pb = before.parentOf(id)!;
      if (after.has(pb) || pb === ROOT_ID) parents.add(pb);
    }
  }
  return { added, removed, reparented, parents };
}

function fullDelta(tree: Tree): TreeDelta {
  const parents = new Set<string>([ROOT_ID]);
  for (const id of tree.ids()) parents.add(tree.parentOf(id)!);
  return { added: new Set(tree.ids()), removed: new Set(), reparented: new Set(), parents };
}
