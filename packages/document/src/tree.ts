import { compareOrder } from "./order";
import { ROOT_ID, canContain, type NodeType } from "./schema";

/**
 * Where a node sits: its parent, its order key among siblings, a Lamport
 * clock, and the placement it had before the last move. Stored as one value
 * so that a move is a single last-writer-wins write.
 */
export interface Placement {
  readonly parent: string;
  readonly key: string;
  /** Lamport clock of the write: greater than every clock the writer had seen. */
  readonly clock: number;
  /** Placement before this move; used to undo a move that concurrent edits made invalid. */
  readonly prev?: { readonly parent: string; readonly key: string };
}

export interface RawNode {
  readonly type: NodeType;
  readonly placement: Placement | undefined;
}

/** How a node ended up where the tree shows it, when that is not its stored placement. */
export type Repair = "previous-parent" | "first-page";

/**
 * The effective node tree, derived deterministically from raw placements.
 *
 * Every replica with the same Yjs state computes the same tree. Concurrent
 * moves and deletes can leave raw placements that are not a tree; they are
 * repaired as follows, in rounds until the tree is valid:
 * - A node whose parent no longer exists (or cannot contain it) goes back
 *   to its previous parent; if it has none, it is dropped (deletion wins).
 * - In each cycle, the member whose placement has the highest
 *   (clock, id) — the latest move — goes back to its previous parent, then
 *   to the first page if that fails too.
 * - Descendants of a dropped node are handled like any orphan.
 * Commands always write valid placements, so repairs only follow concurrency.
 */
export class Tree {
  private readonly parents = new Map<string, string>();
  private readonly keys = new Map<string, string>();
  private readonly kids = new Map<string, string[]>();
  /** Nodes placed somewhere other than their stored placement. */
  readonly repaired = new Map<string, Repair>();
  /** Stored nodes that are not part of the tree. */
  readonly dropped = new Set<string>();
  /** Highest placement clock seen. */
  readonly maxClock: number;

  constructor(raw: ReadonlyMap<string, RawNode>) {
    let maxClock = 0;
    for (const n of raw.values()) if (n.placement && n.placement.clock > maxClock) maxClock = n.placement.clock;
    this.maxClock = maxClock;
    resolve(raw, this.parents, this.keys, this.repaired, this.dropped);
    for (const [id, parent] of this.parents) {
      let list = this.kids.get(parent);
      if (!list) this.kids.set(parent, (list = []));
      list.push(id);
    }
    for (const list of this.kids.values()) {
      list.sort((a, b) => compareOrder(this.keys.get(a)!, a, this.keys.get(b)!, b));
    }
  }

  get size(): number {
    return this.parents.size;
  }

  has(id: string): boolean {
    return this.parents.has(id);
  }

  /** Parent id (`ROOT_ID` for pages), or undefined when the node is not in the tree. */
  parentOf(id: string): string | undefined {
    return this.parents.get(id);
  }

  keyOf(id: string): string | undefined {
    return this.keys.get(id);
  }

  /** Children in paint order (index 0 is painted first). `childrenOf(ROOT_ID)` lists the pages. */
  childrenOf(id: string): readonly string[] {
    return this.kids.get(id) ?? EMPTY;
  }

  get pages(): readonly string[] {
    return this.childrenOf(ROOT_ID);
  }

  ids(): IterableIterator<string> {
    return this.parents.keys();
  }

  /** The page a node is on, or undefined. */
  pageOf(id: string): string | undefined {
    let cur: string | undefined = id;
    while (cur !== undefined) {
      const p = this.parents.get(cur);
      if (p === ROOT_ID) return cur;
      cur = p;
    }
    return undefined;
  }

  /** True when `ancestor` is `id` or one of its ancestors. */
  isSelfOrAncestor(ancestor: string, id: string): boolean {
    for (let cur: string | undefined = id; cur !== undefined && cur !== ROOT_ID; cur = this.parents.get(cur)) {
      if (cur === ancestor) return true;
    }
    return ancestor === ROOT_ID && this.parents.has(id);
  }

  /** `id` and all its descendants, parents before children. */
  subtree(id: string): string[] {
    const out = [id];
    for (let i = 0; i < out.length; i++) out.push(...this.childrenOf(out[i]!));
    return out;
  }

  /** Index of `id` among its siblings. */
  indexOf(id: string): number {
    const p = this.parents.get(id);
    return p === undefined ? -1 : this.childrenOf(p).indexOf(id);
  }
}

const EMPTY: readonly string[] = Object.freeze([]);

/** 0: stored placement, 1: previous placement, 2: first page, 3: dropped. */
type Level = 0 | 1 | 2 | 3;

function resolve(
  raw: ReadonlyMap<string, RawNode>,
  parents: Map<string, string>,
  keys: Map<string, string>,
  repaired: Map<string, Repair>,
  dropped: Set<string>,
): void {
  const level = new Map<string, Level>();
  // Pages always hang off the root; nothing can move them elsewhere.
  let firstPage: string | null = null;
  let firstKey = "";
  let unsettled: string[] = [];
  for (const [id, n] of raw) {
    if (!n.placement) {
      dropped.add(id);
      continue;
    }
    if (n.type !== "page") {
      unsettled.push(id);
      continue;
    }
    parents.set(id, ROOT_ID);
    keys.set(id, n.placement.key);
    if (firstPage === null || compareOrder(n.placement.key, id, firstKey, firstPage) < 0) {
      firstPage = id;
      firstKey = n.placement.key;
    }
  }

  const edge = (id: string): { parent: string; key: string } | null => {
    const p = raw.get(id)!.placement!;
    switch (level.get(id) ?? 0) {
      case 0:
        return p;
      case 1:
        return p.prev ?? null;
      case 2:
        return firstPage === null ? null : { parent: firstPage, key: p.key };
      default:
        return null;
    }
  };
  const advance = (id: string, reason: "missing" | "cycle"): void => {
    const lvl = level.get(id) ?? 0;
    const hasPrev = raw.get(id)!.placement!.prev !== undefined;
    let next: Level;
    if (reason === "missing") next = lvl === 0 && hasPrev ? 1 : 3;
    else next = lvl === 0 ? (hasPrev ? 1 : 2) : lvl === 1 ? 2 : 3;
    level.set(id, next);
  };

  // Rounds: nodes that reach the root are final (later rounds only change
  // nodes that did not), so each round revisits only what is unsettled.
  while (unsettled.length > 0) {
    const color = new Map<string, 1 | 2 | 3>(); // 1 on the current path, 2 reaches the root, 3 blocked
    const missing: string[] = [];
    const cycles: string[][] = [];
    for (const start of unsettled) {
      if (color.has(start) || parents.has(start) || dropped.has(start)) continue;
      const path: string[] = [];
      let cur = start;
      let outcome: 2 | 3;
      for (;;) {
        if (parents.has(cur)) {
          outcome = 2;
          break;
        }
        if (dropped.has(cur)) {
          outcome = 3;
          break;
        }
        const c = color.get(cur);
        if (c === 2 || c === 3) {
          outcome = c;
          break;
        }
        if (c === 1) {
          cycles.push(path.slice(path.indexOf(cur)));
          outcome = 3;
          break;
        }
        const e = edge(cur);
        if (e === null) {
          dropped.add(cur);
          outcome = 3;
          break;
        }
        const type = raw.get(cur)!.type;
        const parentNode = e.parent === ROOT_ID ? undefined : raw.get(e.parent);
        const valid =
          e.parent === ROOT_ID ? canContain(null, type) : parentNode !== undefined && !dropped.has(e.parent) && canContain(parentNode.type, type);
        if (!valid) {
          missing.push(cur);
          color.set(cur, 3);
          outcome = 3;
          break;
        }
        color.set(cur, 1);
        path.push(cur);
        cur = e.parent;
      }
      for (const id of path) {
        color.set(id, outcome);
        if (outcome === 2) {
          const e = edge(id)!;
          parents.set(id, e.parent);
          keys.set(id, e.key);
          const lvl = level.get(id) ?? 0;
          if (lvl === 1) repaired.set(id, "previous-parent");
          else if (lvl === 2) repaired.set(id, "first-page");
        }
      }
    }
    for (const id of missing) advance(id, "missing");
    for (const cycle of cycles) {
      let latest = cycle[0]!;
      for (const id of cycle) {
        const a = raw.get(id)!.placement!.clock;
        const b = raw.get(latest)!.placement!.clock;
        if (a > b || (a === b && id > latest)) latest = id;
      }
      advance(latest, "cycle");
    }
    unsettled = unsettled.filter((id) => !parents.has(id) && !dropped.has(id));
  }
}
