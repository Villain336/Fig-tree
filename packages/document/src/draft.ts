import * as Y from "yjs";
import type { Mat2D } from "@fig-tree/geometry";
import type { FigDocument } from "./document";
import { frozenCopy } from "./json";
import { compareOrder, keysBetween } from "./order";
import { ROOT_ID, defaultProp, type AssetMeta, type NodeType } from "./schema";
import { applySpanOp, applyYTextOp, writeSpans, type Span, type TextOp } from "./text";
import { boxMatrix, multiply, IDENTITY } from "./transform";
import type { Placement } from "./tree";

const DELETE = Symbol("delete");
type Stored = unknown | typeof DELETE;

interface CreatedNode {
  readonly type: NodeType;
  readonly props: Map<string, unknown>;
  placement: Placement;
  spans: Span[] | null;
}

/**
 * An overlay over a document: commands read and write the draft, and only a
 * fully validated batch is flushed into Yjs, in one transaction. Yjs cannot
 * roll a transaction back, so this is what makes a batch atomic.
 */
export class Draft {
  private readonly created = new Map<string, CreatedNode>();
  private readonly removed = new Set<string>();
  private readonly placements = new Map<string, Placement>();
  private readonly props = new Map<string, Map<string, Stored>>();
  private readonly textOps = new Map<string, TextOp[]>();
  private readonly spanCache = new Map<string, Span[]>();
  private readonly newAssets = new Map<string, AssetMeta>();
  private newName: string | null = null;
  private readonly touchedParents = new Set<string>();
  private readonly childCache = new Map<string, string[]>();
  private clock: number;

  constructor(readonly doc: FigDocument) {
    this.clock = doc.tree.maxClock;
  }

  // ── Reads ────────────────────────────────────────────────────────────

  exists(id: string): boolean {
    if (this.removed.has(id)) return false;
    return this.created.has(id) || this.doc.tree.has(id);
  }

  /** True for ids that are taken, including removed and dropped nodes (ids are never reused). */
  idTaken(id: string): boolean {
    return id === ROOT_ID || this.created.has(id) || this.doc.idUsed(id);
  }

  typeOf(id: string): NodeType | undefined {
    if (!this.exists(id)) return undefined;
    return this.created.get(id)?.type ?? this.doc.typeOf(id);
  }

  parentOf(id: string): string | undefined {
    if (!this.exists(id)) return undefined;
    return this.created.get(id)?.placement.parent ?? this.placements.get(id)?.parent ?? this.doc.tree.parentOf(id);
  }

  keyOf(id: string): string | undefined {
    if (!this.exists(id)) return undefined;
    return this.created.get(id)?.placement.key ?? this.placements.get(id)?.key ?? this.doc.tree.keyOf(id);
  }

  childrenOf(parent: string): readonly string[] {
    if (!this.touchedParents.has(parent)) return this.doc.tree.childrenOf(parent);
    let list = this.childCache.get(parent);
    if (list) return list;
    list = this.doc.tree.childrenOf(parent).filter((c) => this.parentOf(c) === parent);
    for (const [id, n] of this.created) if (!this.removed.has(id) && n.placement.parent === parent) list.push(id);
    for (const [id, p] of this.placements) {
      if (p.parent === parent && !this.removed.has(id) && this.doc.tree.parentOf(id) !== parent) list.push(id);
    }
    list.sort((a, b) => compareOrder(this.keyOf(a)!, a, this.keyOf(b)!, b));
    this.childCache.set(parent, list);
    return list;
  }

  indexOf(id: string): number {
    const p = this.parentOf(id);
    return p === undefined ? -1 : this.childrenOf(p).indexOf(id);
  }

  /** True when `ancestor` is `id` itself or one of its ancestors. */
  isSelfOrAncestor(ancestor: string, id: string): boolean {
    for (let cur: string | undefined = id; cur !== undefined && cur !== ROOT_ID; cur = this.parentOf(cur)) {
      if (cur === ancestor) return true;
    }
    return false;
  }

  subtree(id: string): string[] {
    const out = [id];
    for (let i = 0; i < out.length; i++) out.push(...this.childrenOf(out[i]!));
    return out;
  }

  stored(id: string, key: string): unknown {
    const c = this.created.get(id);
    if (c) return c.props.get(key);
    const v = this.props.get(id)?.get(key);
    if (v === DELETE) return undefined;
    return v !== undefined ? v : this.doc.stored(id, key);
  }

  get<T = unknown>(id: string, key: string): T {
    const v = this.stored(id, key);
    if (v !== undefined) return v as T;
    const type = this.typeOf(id);
    return (type ? defaultProp(type, key) : undefined) as T;
  }

  storedProps(id: string): Record<string, unknown> {
    const c = this.created.get(id);
    if (c) return Object.fromEntries(c.props);
    const out = this.doc.storedProps(id);
    for (const [k, v] of this.props.get(id) ?? []) {
      if (v === DELETE) delete out[k];
      else out[k] = v;
    }
    return out;
  }

  spans(id: string): Span[] {
    const c = this.created.get(id);
    if (c) return c.spans ?? [];
    let s = this.spanCache.get(id);
    if (!s) this.spanCache.set(id, (s = this.doc.spans(id)));
    return s;
  }

  hasAsset(id: string): boolean {
    return this.newAssets.has(id) || this.doc.assetsMap.has(id);
  }

  /** Local-to-page matrix of a node in the draft state (groups and pages are identity). */
  worldMatrix(id: string): Mat2D {
    let m: Mat2D = IDENTITY;
    for (let cur: string | undefined = id; cur !== undefined && cur !== ROOT_ID; cur = this.parentOf(cur)) {
      m = multiply(this.localMatrix(cur), m);
    }
    return m;
  }

  localMatrix(id: string): Mat2D {
    const type = this.typeOf(id);
    if (type === "page" || type === "group") return IDENTITY;
    return boxMatrix({
      x: this.get(id, "x"),
      y: this.get(id, "y"),
      width: this.get(id, "width"),
      height: this.get(id, "height"),
      rotation: this.get(id, "rotation"),
      flipX: this.get(id, "flipX"),
      flipY: this.get(id, "flipY"),
    });
  }

  // ── Order keys ───────────────────────────────────────────────────────

  /**
   * Order keys for `count` nodes inserted at `index` among `parent`'s
   * children (ignoring `moving`, the nodes being inserted). Siblings that
   * share a key with the left neighbour are re-keyed so the result is
   * strictly ordered.
   */
  keysAt(parent: string, index: number, count: number, moving: ReadonlySet<string>): string[] {
    const siblings = this.childrenOf(parent).filter((c) => !moving.has(c));
    const i = Math.max(0, Math.min(index, siblings.length));
    const left = i > 0 ? this.keyOf(siblings[i - 1]!)! : null;
    // Siblings at and after the insertion point that tie with the left key must move after the new nodes.
    let j = i;
    while (j < siblings.length && left !== null && this.keyOf(siblings[j]!)! <= left) j++;
    const right = j < siblings.length ? this.keyOf(siblings[j]!)! : null;
    // New nodes first, then the tied siblings, all strictly between left and right.
    const keys = keysBetween(left, right, count + (j - i), this.doc.random);
    for (let k = i; k < j; k++) this.place(siblings[k]!, parent, keys[count + (k - i)]!);
    keys.length = count;
    return keys;
  }

  // ── Writes ───────────────────────────────────────────────────────────

  create(id: string, type: NodeType, props: Record<string, unknown>, parent: string, key: string, spans: Span[] | null): void {
    const map = new Map<string, unknown>();
    for (const [k, v] of Object.entries(props)) if (v !== undefined && v !== null) map.set(k, frozenCopy(v));
    this.created.set(id, { type, props: map, placement: { parent, key, clock: ++this.clock }, spans });
    this.touch(parent);
  }

  set(id: string, key: string, value: unknown): void {
    const c = this.created.get(id);
    if (c) {
      if (value === undefined || value === null) c.props.delete(key);
      else c.props.set(key, frozenCopy(value));
      return;
    }
    let m = this.props.get(id);
    if (!m) this.props.set(id, (m = new Map()));
    m.set(key, value === undefined || value === null ? DELETE : frozenCopy(value));
  }

  /** Moves a node (or re-keys it in place). */
  place(id: string, parent: string, key: string): void {
    const oldParent = this.parentOf(id)!;
    const c = this.created.get(id);
    if (c) {
      c.placement = { parent, key, clock: ++this.clock };
    } else {
      const prev = { parent: oldParent, key: this.keyOf(id)! };
      this.placements.set(id, { parent, key, clock: ++this.clock, prev });
    }
    this.touch(oldParent);
    this.touch(parent);
  }

  /** Removes a node and its subtree; returns the removed ids. */
  remove(id: string): string[] {
    const ids = this.subtree(id);
    const parent = this.parentOf(id);
    for (const r of ids) this.removed.add(r);
    if (parent !== undefined) this.touch(parent);
    for (const r of ids) this.touch(r);
    return ids;
  }

  text(id: string, op: TextOp): void {
    const c = this.created.get(id);
    if (c) {
      c.spans = applySpanOp(c.spans ?? [], op);
      return;
    }
    this.spanCache.set(id, applySpanOp(this.spans(id), op));
    let ops = this.textOps.get(id);
    if (!ops) this.textOps.set(id, (ops = []));
    ops.push(op);
  }

  addAsset(id: string, meta: AssetMeta): void {
    this.newAssets.set(id, frozenCopy(meta));
  }

  setName(name: string): void {
    this.newName = name;
  }

  private touch(parent: string): void {
    this.touchedParents.add(parent);
    this.childCache.delete(parent);
  }

  // ── Flush ────────────────────────────────────────────────────────────

  /** Writes the draft into the document in one transaction. */
  commit(origin: unknown): void {
    const doc = this.doc;
    doc.transact(() => {
      for (const [id, meta] of this.newAssets) if (!doc.assetsMap.has(id)) doc.assetsMap.set(id, meta);
      if (this.newName !== null) doc.meta.set("name", this.newName);
      for (const [id, n] of this.created) {
        if (this.removed.has(id)) continue;
        const map = new Y.Map<unknown>();
        map.set("type", n.type);
        map.set("placement", n.placement);
        for (const [k, v] of n.props) map.set(k, v);
        if (n.type === "text") map.set("content", new Y.Text());
        doc.nodes.set(id, map);
        if (n.type === "text" && n.spans) writeSpans(map.get("content") as Y.Text, n.spans);
      }
      for (const [id, writes] of this.props) {
        if (this.removed.has(id)) continue;
        const map = doc.nodes.get(id);
        if (!map) continue;
        for (const [k, v] of writes) {
          if (v === DELETE) map.delete(k);
          else map.set(k, v);
        }
      }
      for (const [id, p] of this.placements) {
        if (this.removed.has(id)) continue;
        doc.nodes.get(id)?.set("placement", p);
      }
      for (const [id, ops] of this.textOps) {
        if (this.removed.has(id)) continue;
        const t = doc.ytext(id);
        if (t) for (const op of ops) applyYTextOp(t, op);
      }
      for (const id of this.removed) if (!this.created.has(id)) doc.nodes.delete(id);
    }, origin);
  }
}
