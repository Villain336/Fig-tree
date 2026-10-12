import { DEFAULT_STYLE, makeStyle, type Style } from "./style";
import type { Measurer, ReplacedSize } from "./measure";

/** A rectangle in some box's border-box coordinates. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Margin, border or padding widths in px. */
export interface Edges {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** A node's computed box, relative to its parent's border box (x, y) and in px. */
export interface Box {
  /** Border-box left edge relative to the parent's border-box left edge, including relative offsets. */
  readonly x: number;
  readonly y: number;
  /** Border-box size. */
  readonly width: number;
  readonly height: number;
  readonly margin: Readonly<Edges>;
  readonly border: Readonly<Edges>;
  readonly padding: Readonly<Edges>;
  /** First baseline from the border-box top, when the box has one. */
  readonly baseline: number | undefined;
}

/**
 * What the parent asks of a box: its border-box width (always definite in
 * horizontal-tb), optionally an imposed border-box height, and the
 * containing block for percentages.
 */
export interface Space {
  readonly width: number;
  /** Imposed border-box height (stretched, flexed, grid area…). Undefined: the box sizes its own height. */
  readonly height: number | undefined;
  /**
   * With an undefined `height`: ignore the `height`, `min-height` and
   * `max-height` properties and return the content-based height (flex basis
   * `content`, automatic minimum sizes).
   */
  readonly contentHeight: boolean;
  /** An imposed `height` that children may not use as a percentage basis (it is not definite). */
  readonly heightIndefinite: boolean;
  /** Containing block size: the basis of this box's own percentages. */
  readonly cbWidth: number | undefined;
  readonly cbHeight: number | undefined;
}

export interface LayoutResult {
  /** Border-box size. */
  readonly width: number;
  readonly height: number;
  /** First and last baselines from the border-box top. */
  readonly firstBaseline: number | undefined;
  readonly lastBaseline: number | undefined;
}

/** Min-content and max-content inline sizes of a box's content box. */
export interface Intrinsic {
  readonly min: number;
  readonly max: number;
}

/** Counters for tests and benchmarks: how much work the last `computeLayout` did. */
export interface LayoutStats {
  /** Layout passes that missed the cache (each lays out the node's content). */
  layouts: number;
  /** Layout requests answered from a cache. */
  cacheHits: number;
  /** Intrinsic inline-size computations that missed the cache. */
  intrinsic: number;
  /** Nodes whose final position or size was (re)written. */
  placed: number;
}

const CACHE_SIZE = 8;

interface CacheEntry {
  readonly key: string;
  readonly result: LayoutResult;
}

let nextId = 1;

/**
 * A box in the layout tree. Set its style, children and (for leaves) a
 * {@link Measurer}; {@link computeLayout} fills in {@link LayoutNode.box}.
 * Mutations mark the node and its ancestors dirty, and only dirty nodes, or
 * nodes whose constraints changed, are laid out again.
 */
export class LayoutNode {
  readonly id = nextId++;
  private _style: Style = DEFAULT_STYLE;
  private _parent: LayoutNode | null = null;
  private _children: LayoutNode[] = [];
  private _measure: Measurer | null = null;
  private _replaced: ReplacedSize | null = null;
  /** A caller-defined tag (document node id, test id…). */
  tag: unknown = undefined;

  /** @internal Layout cache (content of the last few constraint spaces). */
  cache: CacheEntry[] = [];
  /** @internal Cached intrinsic inline sizes. */
  intrinsicCache: Intrinsic | null = null;
  /** @internal Key of the space of the last final (placing) layout, or null when stale. */
  placedKey: string | null = null;
  /**
   * @internal Static position of an out-of-flow box, computed by its parent's
   * formatting context: an area (relative to the parent's border box) and
   * where in it the box's margin box aligns (0 start, 0.5 center, 1 end).
   * Block parents use an empty area at the would-be flow position; flex and
   * grid parents use their content box and the alignment properties.
   */
  staticX = 0;
  staticY = 0;
  staticW = 0;
  staticH = 0;
  staticAlignX = 0;
  staticAlignY = 0;
  /** @internal Containing block a grid container computed for this absolutely positioned child (its grid area), in the grid's border-box coordinates. */
  absArea: Rect | null = null;
  /** Number of nodes styled `position: fixed` (they belong to the initial containing block). */
  static fixedCount = 0;

  /** @internal Mutable result written by the layout pass. */
  readonly out = {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    margin: { top: 0, right: 0, bottom: 0, left: 0 } as Edges,
    border: { top: 0, right: 0, bottom: 0, left: 0 } as Edges,
    padding: { top: 0, right: 0, bottom: 0, left: 0 } as Edges,
    baseline: undefined as number | undefined,
  };

  constructor(style?: Partial<Style> | Style, options: { measure?: Measurer; replaced?: ReplacedSize } = {}) {
    if (style) this.assignStyle(makeStyle(style));
    this._measure = options.measure ?? null;
    this._replaced = options.replaced ?? null;
  }

  get style(): Style {
    return this._style;
  }

  /** Replaces the style (a partial style takes initial values for the rest). */
  setStyle(style: Partial<Style> | Style): void {
    this.assignStyle(makeStyle(style));
    this.markDirty();
  }

  /** Changes some properties, keeping the others. */
  updateStyle(changes: Partial<Style>): void {
    this.assignStyle(makeStyle({ ...this._style, ...changes }));
    this.markDirty();
  }

  private assignStyle(style: Style): void {
    LayoutNode.fixedCount += (style.position === "fixed" ? 1 : 0) - (this._style.position === "fixed" ? 1 : 0);
    this._style = style;
  }

  get parent(): LayoutNode | null {
    return this._parent;
  }

  get children(): readonly LayoutNode[] {
    return this._children;
  }

  get measure(): Measurer | null {
    return this._measure;
  }

  /** Leaf content measured by a callback (text). */
  setMeasure(measure: Measurer | null): void {
    this._measure = measure;
    this.markDirty();
  }

  get replaced(): ReplacedSize | null {
    return this._replaced;
  }

  /** Replaced content (images) with a natural size and/or ratio. */
  setReplaced(replaced: ReplacedSize | null): void {
    this._replaced = replaced;
    this.markDirty();
  }

  appendChild(child: LayoutNode): this {
    return this.insertChild(child, this._children.length);
  }

  insertChild(child: LayoutNode, index: number): this {
    if (child._parent) child._parent.removeChild(child);
    for (let p: LayoutNode | null = this; p; p = p._parent) if (p === child) throw new Error("layout: cycle");
    this._children.splice(Math.max(0, Math.min(index, this._children.length)), 0, child);
    child._parent = this;
    child.placedKey = null;
    this.markDirty();
    return this;
  }

  removeChild(child: LayoutNode): this {
    const i = this._children.indexOf(child);
    if (i < 0) return this;
    this._children.splice(i, 1);
    child._parent = null;
    this.markDirty();
    return this;
  }

  /** Replaces the child list (keeping nodes that stay). */
  setChildren(children: readonly LayoutNode[]): void {
    for (const c of this._children) if (!children.includes(c)) c._parent = null;
    for (const c of children) {
      if (c._parent && c._parent !== this) c._parent.removeChild(c);
      c._parent = this;
    }
    this._children = [...children];
    this.markDirty();
  }

  /**
   * Invalidates this node's cached layout and that of its ancestors. Call it
   * when a measured leaf's content changes; style and tree setters call it
   * themselves.
   */
  markDirty(): void {
    for (let n: LayoutNode | null = this; n; n = n._parent) {
      n.cache = [];
      n.intrinsicCache = null;
      n.placedKey = null;
    }
  }

  /** The computed box (valid after {@link computeLayout}). */
  get box(): Box {
    const o = this.out;
    return {
      x: o.x,
      y: o.y,
      width: o.width,
      height: o.height,
      margin: { ...o.margin },
      border: { ...o.border },
      padding: { ...o.padding },
      baseline: o.baseline,
    };
  }

  /** @internal */
  cacheGet(key: string): LayoutResult | undefined {
    for (const e of this.cache) if (e.key === key) return e.result;
    return undefined;
  }

  /** @internal */
  cachePut(key: string, result: LayoutResult): void {
    if (this.cache.length >= CACHE_SIZE) this.cache.shift();
    this.cache.push({ key, result });
  }
}

/** Cache key of a constraint space. */
export function spaceKey(s: Space): string {
  return `${s.width}|${s.height}|${s.contentHeight ? 1 : 0}${s.heightIndefinite ? 1 : 0}|${s.cbWidth}|${s.cbHeight}`;
}

/** @internal Records an out-of-flow child's static position (see {@link LayoutNode.staticX}). */
export function setStatic(node: LayoutNode, x: number, y: number, w: number, h: number, alignX: number, alignY: number): void {
  node.staticX = x;
  node.staticY = y;
  node.staticW = w;
  node.staticH = h;
  node.staticAlignX = alignX;
  node.staticAlignY = alignY;
}
