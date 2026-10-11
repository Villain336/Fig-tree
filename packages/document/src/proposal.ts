import { runCommands, summarize, type ApplyResult, type Command, type TypedCommand } from "./commands";
import { FigDocument, type Actor } from "./document";
import { Draft } from "./draft";
import { jsonEqual } from "./json";
import { ROOT_ID, type AssetMeta, type NodeType, type TextContent } from "./schema";

/**
 * Proposals: a command batch applied to a fork of the document, reviewed as
 * a structured diff, then either merged (accept) or discarded (reject). The
 * AI teammate and external agents propose; a person reviews.
 *
 * The fork is a separate Y.Doc with the main document's full history and
 * its own client id, so accepting merges the fork's update into the main
 * document like any remote change: concurrent edits made meanwhile merge
 * by the usual CRDT rules.
 */

export interface PropertyChange {
  readonly key: string;
  /** Stored value before (undefined = unset, i.e. the default). */
  readonly before: unknown;
  readonly after: unknown;
}

export interface Location {
  readonly parent: string;
  readonly index: number;
}

export interface DocumentDiff {
  /** New nodes, parents before children. `props` are the stored properties. */
  readonly created: readonly { id: string; type: NodeType; at: Location; props: Record<string, unknown>; text?: TextContent }[];
  /** Removed nodes, parents before children. */
  readonly deleted: readonly { id: string; type: NodeType; at: Location; name: string }[];
  /** Nodes moved to another parent or re-ordered among siblings. */
  readonly moved: readonly { id: string; type: NodeType; from: Location; to: Location }[];
  /** Property and text changes of nodes present before and after. */
  readonly updated: readonly { id: string; type: NodeType; changes: readonly PropertyChange[]; text?: { before: TextContent; after: TextContent } }[];
  readonly assets: readonly { id: string; meta: AssetMeta }[];
  readonly name?: { before: string; after: string };
}

export function isEmptyDiff(d: DocumentDiff): boolean {
  return d.created.length + d.deleted.length + d.moved.length + d.updated.length + d.assets.length === 0 && !d.name;
}

function location(doc: FigDocument, id: string): Location {
  return { parent: doc.tree.parentOf(id)!, index: doc.tree.indexOf(id) };
}

/** Ids in depth-first paint order (pages first, parents before children). */
function treeOrder(doc: FigDocument): Map<string, number> {
  const order = new Map<string, number>();
  const walk = (id: string): void => {
    for (const c of doc.tree.childrenOf(id)) {
      order.set(c, order.size);
      walk(c);
    }
  };
  walk(ROOT_ID);
  return order;
}

/**
 * Structured diff from `base` to `next`. With `ids`, only those nodes are
 * compared (a proposal passes the nodes its draft wrote); otherwise every
 * node of both documents is.
 */
export function diffDocuments(base: FigDocument, next: FigDocument, ids?: Iterable<string>): DocumentDiff {
  const candidates = new Set<string>(ids ?? [...base.tree.ids(), ...next.tree.ids()]);
  const created: DocumentDiff["created"][number][] = [];
  const deleted: DocumentDiff["deleted"][number][] = [];
  const moved: DocumentDiff["moved"][number][] = [];
  const updated: DocumentDiff["updated"][number][] = [];
  for (const id of candidates) {
    const inBase = base.tree.has(id);
    const inNext = next.tree.has(id);
    if (!inBase && inNext) {
      const type = next.typeOf(id)!;
      created.push({ id, type, at: location(next, id), props: next.storedProps(id), ...(type === "text" ? { text: next.text(id) } : {}) });
    } else if (inBase && !inNext) {
      deleted.push({ id, type: base.typeOf(id)!, at: location(base, id), name: base.get<string>(id, "name") });
    } else if (inBase && inNext) {
      const type = next.typeOf(id)!;
      if (base.tree.parentOf(id) !== next.tree.parentOf(id) || base.tree.keyOf(id) !== next.tree.keyOf(id)) {
        moved.push({ id, type, from: location(base, id), to: location(next, id) });
      }
      const a = base.storedProps(id);
      const b = next.storedProps(id);
      const changes: PropertyChange[] = [];
      for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
        if (!jsonEqual(a[key], b[key])) changes.push({ key, before: a[key], after: b[key] });
      }
      let text: { before: TextContent; after: TextContent } | undefined;
      if (type === "text") {
        const before = base.text(id);
        const after = next.text(id);
        if (!jsonEqual(before, after)) text = { before, after };
      }
      if (changes.length > 0 || text) updated.push({ id, type, changes, ...(text ? { text } : {}) });
    }
  }
  const baseOrder = treeOrder(base);
  const nextOrder = treeOrder(next);
  created.sort((x, y) => nextOrder.get(x.id)! - nextOrder.get(y.id)!);
  moved.sort((x, y) => nextOrder.get(x.id)! - nextOrder.get(y.id)!);
  updated.sort((x, y) => nextOrder.get(x.id)! - nextOrder.get(y.id)!);
  deleted.sort((x, y) => baseOrder.get(x.id)! - baseOrder.get(y.id)!);
  const baseAssets = base.assets();
  const assets = [...next.assets()].filter(([id]) => !baseAssets.has(id)).map(([id, meta]) => ({ id, meta }));
  assets.sort((x, y) => (x.id < y.id ? -1 : 1));
  const name = base.name !== next.name ? { before: base.name, after: next.name } : undefined;
  return { created, deleted, moved, updated, assets, ...(name ? { name } : {}) };
}

export type ProposalStatus = "open" | "accepted" | "rejected";

export class Proposal {
  private _status: ProposalStatus = "open";

  /** @internal Use {@link propose}. */
  constructor(
    /** The document the proposal targets. */
    readonly doc: FigDocument,
    /** The forked document with the commands applied. */
    readonly fork: FigDocument,
    readonly commands: readonly (Command | TypedCommand)[],
    /** Who proposed it. */
    readonly author: Actor,
    readonly result: ApplyResult,
    readonly diff: DocumentDiff,
    private readonly baseVector: Uint8Array,
  ) {}

  get status(): ProposalStatus {
    return this._status;
  }

  /** True when the main document changed after the fork was taken. */
  isStale(): boolean {
    const now = this.doc.stateVector();
    return now.length !== this.baseVector.length || now.some((b, i) => b !== this.baseVector[i]);
  }

  /** The fork's changes as one Yjs update (v2), relative to the base it was forked from. */
  update(): Uint8Array {
    return this.fork.encodeState(this.baseVector);
  }

  /**
   * Merges the proposal into the document as one transaction attributed to
   * `by` (default: the author), which can undo it as one step.
   */
  accept(by: Actor = this.doc.actor(this.author.id, this.author.kind)): ApplyResult {
    this.ensureOpen();
    if (by.kind !== "system") this.doc.undoManager(by);
    this.doc.applyUpdate(this.update(), by);
    this.close("accepted");
    return this.result;
  }

  /** Discards the proposal; the document is not touched. */
  reject(): void {
    this.ensureOpen();
    this.close("rejected");
  }

  /** Re-applies the same commands to a fresh fork of the current document (after the document moved on). */
  rebase(): Proposal {
    this.ensureOpen();
    this.close("rejected");
    return propose(this.doc, this.commands, this.author);
  }

  private ensureOpen(): void {
    if (this._status !== "open") throw new Error(`proposal already ${this._status}`);
  }

  private close(status: ProposalStatus): void {
    this._status = status;
    this.fork.destroy();
  }
}

/**
 * Applies `commands` to a fork of `doc` and returns the proposal with its
 * diff. Invalid commands throw a `CommandError`; `doc` is never modified.
 */
export function propose(doc: FigDocument, commands: readonly (Command | TypedCommand)[], author: Actor): Proposal {
  const baseVector = doc.stateVector();
  const fork = FigDocument.fromUpdate(doc.encodeState(), { random: doc.random });
  while (fork.ydoc.clientID === doc.ydoc.clientID) fork.ydoc.clientID = Math.floor(Math.random() * 2 ** 31);
  const draft = new Draft(fork);
  const results = runCommands(draft, commands);
  draft.commit(fork.actor(author.id, author.kind));
  const diff = diffDocuments(doc, fork, draft.written);
  return new Proposal(doc, fork, commands, author, summarize(results), diff, baseVector);
}
