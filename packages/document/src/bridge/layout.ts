import { FixedMeasurer, LayoutNode, computeLayout, parseDeclarations, makeStyle, type LayoutStats } from "@fig-tree/layout";
import { cssDeclarations } from "../css";
import type { DocumentChange, FigDocument } from "../document";
import type { NodeType } from "../schema";

/** A node's computed layout box, relative to its parent's border box (groups have no box: their children use the group's parent space). */
export interface ComputedBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly padding: { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number };
  readonly border: { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number };
  readonly margin: { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number };
}

/** Properties that never affect layout (paint, compositing, effects, typography of runs, metadata). */
const PAINT_KEYS = new Set([
  "name", "locked", "opacity", "blendMode", "isolation", "effects", "componentRef", "overrides", "fills", "strokes", "strokeAlign", "strokeCap",
  "strokeJoin", "strokeMiterLimit", "strokeDashes", "strokeDashOffset", "cornerRadius", "cornerSmoothing", "rotation", "flipX", "flipY",
  "arcStart", "arcSweep", "innerRadius", "pointCount", "vectorNetwork", "objectFit", "description", "propertyDefinitions", "propertyValues", "backgroundColor",
]);

/** Properties of a node whose change can alter its children's CSS (their sizing-mode mapping and insets). */
const PARENT_KEYS = new Set(["display", "flexDirection", "width", "height", "strokeWeight", "strokesInLayout"]);

/**
 * Computes the layout of one page with the layout engine. Each node's style
 * is the CSS that `cssDeclarations` states for it, so what renders is
 * exactly what code export emits. Layout is derived, never written back to
 * the document.
 *
 * Mapping notes:
 * - Groups have no box: their children join the group's parent (as with
 *   CSS `display: contents`) and keep the group's parent space.
 * - Top-level nodes are absolutely positioned on the page at their `x`/`y`.
 * - Text is not shaped yet (module 4): text nodes measure as their stored
 *   width and height. Images use their asset's natural size and ratio.
 * - `position: fixed` lays out like `absolute` and `sticky` like
 *   `relative` without offsets (scrolling is a prototype concern).
 *
 * Changes are incremental: changed nodes (and the children whose CSS
 * depends on a changed parent) get new styles, the layout engine relays out
 * only what they affect, and {@link update} reports the nodes whose box moved.
 */
export class DocumentLayout {
  private readonly nodes = new Map<string, LayoutNode>();
  private readonly boxes = new Map<string, ComputedBox>();
  /** The CSS each node was last styled from, to skip restyling when it did not change. */
  private readonly cssKeys = new Map<string, string>();
  private root: LayoutNode | null = null;
  /** Counters of the last layout pass. */
  lastStats: LayoutStats = { layouts: 0, cacheHits: 0, intrinsic: 0, placed: 0 };

  constructor(
    readonly doc: FigDocument,
    private page: string,
  ) {
    this.build(page);
  }

  /** The computed box of a node on the page (undefined for groups, the page and unknown nodes). */
  box(id: string): ComputedBox | undefined {
    return this.boxes.get(id);
  }

  /** The layout node of a document node (for tests and tools). */
  layoutNode(id: string): LayoutNode | undefined {
    return this.nodes.get(id);
  }

  /** Rebuilds the layout tree for `page` and lays it out. */
  build(page: string): void {
    this.page = page;
    this.nodes.clear();
    this.boxes.clear();
    this.cssKeys.clear();
    this.root = null;
    if (!this.doc.has(page)) return;
    this.root = new LayoutNode(makeStyle({ position: "relative", width: 0, height: 0 }));
    this.root.tag = page;
    this.root.setChildren(this.layoutChildren(page).map((c) => this.create(c)));
    this.run();
  }

  /** Applies a document change. Returns the nodes whose computed box changed. */
  update(change: DocumentChange): Set<string> {
    const root = this.root;
    if (!root) return new Set();
    const tree = this.doc.tree;
    const restyle = new Set<string>();
    const relink = new Set<string>();
    const s = change.structure;
    if (s) {
      for (const id of s.removed) this.drop(id);
      for (const id of s.reparented) {
        if (tree.pageOf(id) !== this.page) this.drop(id);
        else restyle.add(id);
      }
      for (const p of s.parents) if (p === this.page || this.nodes.has(p) || this.doc.typeOf(p) === "group") relink.add(p);
      for (const id of s.added) if (tree.pageOf(id) === this.page) relink.add(tree.parentOf(id)!);
    }
    for (const [id, keys] of change.props) {
      if (!tree.has(id) || tree.pageOf(id) !== this.page) continue;
      let layoutKey = false;
      for (const k of keys) if (!PAINT_KEYS.has(k)) layoutKey = true;
      if (!layoutKey) continue;
      restyle.add(id);
      let parentAffecting = false;
      for (const k of keys) if (PARENT_KEYS.has(k)) parentAffecting = true;
      if (parentAffecting) for (const c of tree.childrenOf(id)) restyle.add(c);
      // A group's visibility hides its children.
      if (this.doc.typeOf(id) === "group" && keys.has("visible")) for (const c of tree.subtree(id)) restyle.add(c);
    }
    // Relink containers (a group's children live in its nearest boxed ancestor).
    for (const p of relink) {
      const host = this.hostOf(p);
      if (host === undefined) continue;
      const hostNode = host === this.page ? root : this.nodes.get(host);
      if (!hostNode) continue;
      hostNode.setChildren(this.layoutChildren(host).map((c) => this.nodes.get(c) ?? this.create(c)));
    }
    for (const id of restyle) {
      const n = this.nodes.get(id);
      if (!n) continue;
      const css = this.cssOf(id);
      const key = JSON.stringify(css);
      if (key !== this.cssKeys.get(id)) {
        this.cssKeys.set(id, key);
        n.setStyle(makeStyle(parseDeclarations(css)));
      }
      this.setLeaf(n, id);
    }
    return this.run();
  }

  /** Lays out the page and returns the nodes whose box changed. */
  private run(): Set<string> {
    const changed = new Set<string>();
    if (!this.root) return changed;
    const touched = new Set<LayoutNode>();
    this.lastStats = computeLayout(this.root, 0, 0, { touched });
    for (const n of touched) {
      const id = n.tag as string;
      if (id === this.page || !this.nodes.has(id)) continue;
      const o = n.out;
      const prev = this.boxes.get(id);
      if (prev && prev.x === o.x && prev.y === o.y && prev.width === o.width && prev.height === o.height) continue;
      this.boxes.set(id, { x: o.x, y: o.y, width: o.width, height: o.height, padding: { ...o.padding }, border: { ...o.border }, margin: { ...o.margin } });
      changed.add(id);
    }
    return changed;
  }

  private create(id: string): LayoutNode {
    const css = this.cssOf(id);
    this.cssKeys.set(id, JSON.stringify(css));
    const n = new LayoutNode(makeStyle(parseDeclarations(css)));
    n.tag = id;
    this.nodes.set(id, n);
    this.setLeaf(n, id);
    if (isContainer(this.doc.typeOf(id))) n.setChildren(this.layoutChildren(id).map((c) => this.create(c)));
    return n;
  }

  private drop(id: string): void {
    const n = this.nodes.get(id);
    if (!n) return;
    n.parent?.removeChild(n);
    const visit = (m: LayoutNode): void => {
      const tag = m.tag as string;
      this.nodes.delete(tag);
      this.boxes.delete(tag);
      this.cssKeys.delete(tag);
      for (const c of m.children) visit(c);
    };
    visit(n);
  }

  /** The ids laid out as children of `id`: its children, with groups replaced by theirs. */
  private layoutChildren(id: string): string[] {
    const out: string[] = [];
    for (const c of this.doc.tree.childrenOf(id)) {
      if (this.doc.typeOf(c) === "group") out.push(...this.layoutChildren(c));
      else out.push(c);
    }
    return out;
  }

  /** The nearest ancestor-or-self that has a box (groups do not). */
  private hostOf(id: string): string | undefined {
    for (let p: string | undefined = id; p !== undefined; p = this.doc.tree.parentOf(p)) {
      if (p === this.page) return p;
      if (this.doc.typeOf(p) !== "group") return p;
    }
    return undefined;
  }

  /** The CSS a node is laid out with. */
  private cssOf(id: string): Record<string, string> {
    const css = cssDeclarations(this.doc, id);
    if (css.position === "fixed") css.position = "absolute";
    if (css.position === "sticky") {
      css.position = "relative";
      for (const k of ["left", "right", "top", "bottom"]) delete css[k];
    }
    // A hidden group hides its children.
    for (let p = this.doc.tree.parentOf(id); p !== undefined && this.doc.typeOf(p) === "group"; p = this.doc.tree.parentOf(p)) {
      if (this.doc.get<boolean>(p, "visible") === false) css.display = "none";
    }
    return css;
  }

  /** Leaf content: text measures as its stored box until text shaping exists; images use their natural size. */
  private setLeaf(n: LayoutNode, id: string): void {
    const type = this.doc.typeOf(id);
    if (type === "text") {
      const w = this.doc.get<number>(id, "width");
      const h = this.doc.get<number>(id, "height");
      const m = n.measure;
      if (!(m instanceof FixedMeasurer) || m.width !== w || m.height !== h) n.setMeasure(new FixedMeasurer(w, h));
    } else if (type === "image") {
      const meta = this.doc.assets().get(this.doc.get<string>(id, "asset"));
      const width = meta?.width;
      const height = meta?.height;
      const r = n.replaced;
      if (!r || r.width !== width || r.height !== height) n.setReplaced({ ...(width ? { width } : {}), ...(height ? { height } : {}) });
    }
  }
}

function isContainer(type: NodeType | undefined): boolean {
  return type === "frame" || type === "component" || type === "instance" || type === "group" || type === "page";
}
