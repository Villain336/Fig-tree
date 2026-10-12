import { layoutOutOfFlow, layoutAbsoluteBox, layoutInitialOutOfFlow } from "./absolute";
import { blockChildWidth, intrinsicBlock, layoutBlock } from "./block";
import { intrinsicFlex, layoutFlex } from "./flex";
import { intrinsicGrid, layoutGrid } from "./grid/grid";
import { intrinsicLeaf, layoutLeaf } from "./leaf";
import { layoutKey, type Edges, type Intrinsic, type LayoutNode, type LayoutResult, type LayoutStats, type Space } from "./node";
import {
  INF,
  aspectRatioOf,
  clamp,
  isOutOfFlow,
  marginOf,
  pbOf,
  ratioHeightFromWidth,
  ratioWidthFromHeight,
  resolveLength,
} from "./sizing";
import { isScrollContainer, resolveLP, type MaxSize, type Size } from "./style";

/** Work counters of the current (or last) {@link computeLayout} call. */
export const stats: LayoutStats = { layouts: 0, cacheHits: 0, intrinsic: 0, placed: 0 };

/** Nodes whose box was written during the current {@link computeLayout} call, when the caller asked for them. */
let touched: Set<LayoutNode> | null = null;

/** @internal Records that a node's box (position or size) was written. */
export function touch(node: LayoutNode): void {
  touched?.add(node);
}

/** What a formatting context gets to lay out a box's content. */
export interface ContentInput {
  /** Content-box width. */
  readonly width: number;
  /** Imposed content-box height, or undefined when the content decides (within min/max). */
  readonly height: number | undefined;
  readonly minHeight: number;
  readonly maxHeight: number;
  /**
   * Content-box height that wrapping column flex lines break at: the imposed
   * or used height when definite, else the `height` or `max-height` the box
   * has even when its content height is being probed.
   */
  readonly breakHeight: number;
  /** Basis for children's percentage heights (the definite content height), if any. */
  readonly percentHeight: number | undefined;
  /** Whether to place children (final layout) or only measure. */
  readonly perform: boolean;
  /** Content-box origin in the border box. */
  readonly left: number;
  readonly top: number;
  readonly padding: Edges;
  readonly border: Edges;
}

export interface ContentResult {
  /** Final content-box height (already clamped when not imposed). */
  readonly height: number;
  /** Baselines in border-box coordinates. */
  readonly firstBaseline: number | undefined;
  readonly lastBaseline: number | undefined;
}

const NONE: LayoutResult = Object.freeze({ width: 0, height: 0, firstBaseline: undefined, lastBaseline: undefined });

/** A space with defaults for the flags. */
export function space(width: number, height: number | undefined, cbWidth: number | undefined, cbHeight: number | undefined, flags: { contentHeight?: boolean; heightIndefinite?: boolean } = {}): Space {
  return { width, height, cbWidth, cbHeight, contentHeight: flags.contentHeight ?? false, heightIndefinite: flags.heightIndefinite ?? false };
}

/**
 * Lays out `node` in `s`. With `perform`, children are positioned and every
 * box's {@link LayoutNode.out} is written; otherwise only the size is
 * computed. Results are cached per constraint space until the node is
 * marked dirty.
 */
export function layout(node: LayoutNode, s: Space, perform: boolean): LayoutResult {
  if (node.style.display === "none") {
    if (perform) hide(node);
    return NONE;
  }
  const key = layoutKey(node, s);
  const cached = node.cacheGet(key);
  if (cached && (!perform || node.placedKey === key)) {
    stats.cacheHits++;
    return cached;
  }
  stats.layouts++;
  node.layoutRuns++;
  const result = computeBox(node, s, perform);
  if (!cached) node.cachePut(key, result);
  if (perform) {
    node.placedKey = key;
    stats.placed++;
    if (node.style.position !== "static") layoutOutOfFlow(node);
  }
  return result;
}

function computeBox(node: LayoutNode, s: Space, perform: boolean): LayoutResult {
  const style = node.style;
  const pb = pbOf(style, s.cbWidth);
  const contentWidth = Math.max(0, s.width - pb.h);
  let fixed = s.height;
  let definite = fixed !== undefined && !s.heightIndefinite;
  let min = 0;
  let max = INF;
  let ratioHeight: number | undefined;
  let breakHeight = INF;
  if (fixed === undefined && s.contentHeight) {
    breakHeight = resolveLength(style, style.height, s.cbHeight, pb.v) ?? resolveLength(style, style.maxHeight, s.cbHeight, pb.v) ?? INF;
    breakHeight = Math.max(0, breakHeight - pb.v);
  }
  if (fixed === undefined && !s.contentHeight) {
    min = blockSizeBound(node, style.minHeight, s.cbHeight, pb.v) ?? 0;
    max = blockSizeBound(node, style.maxHeight, s.cbHeight, pb.v) ?? INF;
    const h = resolveLength(style, style.height, s.cbHeight, pb.v);
    if (h !== undefined) {
      fixed = clamp(h, min, max);
      definite = true;
    } else {
      const ratio = aspectRatioOf(node);
      if (ratio) ratioHeight = clamp(ratioHeightFromWidth(ratio, s.width, pb.h, pb.v), min, max);
      else if (node.replaced) ratioHeight = clamp((node.replaced.height ?? 150) + pb.v, min, max);
    }
  }
  if (ratioHeight !== undefined) {
    // A ratio-determined height is definite. Non-replaced boxes that are not
    // scroll containers keep an automatic minimum of their content height.
    let h = ratioHeight;
    const autoMin = style.minHeight === "auto" && !node.replaced && !isScrollContainer(style.overflowY);
    if (autoMin && (node.children.length > 0 || node.measure)) {
      const probe = runContent(node, contentWidth, undefined, Math.max(0, min - pb.v), max - pb.v, max - pb.v, undefined, false, pb);
      h = Math.max(h, Math.min(probe.height + pb.v, max));
    }
    fixed = h;
    definite = true;
  }
  const contentHeight = fixed === undefined ? undefined : Math.max(0, fixed - pb.v);
  const r = runContent(node, contentWidth, contentHeight, Math.max(0, min - pb.v), max - pb.v, contentHeight ?? (s.contentHeight ? breakHeight : max - pb.v), definite ? contentHeight : undefined, perform, pb);
  const height = (contentHeight ?? r.height) + pb.v;
  if (perform) {
    touch(node);
    const o = node.out;
    o.width = s.width;
    o.height = height;
    o.padding = pb.padding;
    o.border = pb.border;
    o.baseline = r.firstBaseline;
  }
  return { width: s.width, height, firstBaseline: r.firstBaseline, lastBaseline: r.lastBaseline };
}

function runContent(
  node: LayoutNode,
  width: number,
  height: number | undefined,
  minHeight: number,
  maxHeight: number,
  breakHeight: number,
  percentHeight: number | undefined,
  perform: boolean,
  pb: { padding: Edges; border: Edges },
): ContentResult {
  const input: ContentInput = {
    width,
    height,
    minHeight,
    maxHeight: Math.max(minHeight, maxHeight),
    breakHeight: Math.max(0, breakHeight),
    percentHeight,
    perform,
    left: pb.border.left + pb.padding.left,
    top: pb.border.top + pb.padding.top,
    padding: pb.padding,
    border: pb.border,
  };
  if (node.measure || node.replaced) return layoutLeaf(node, input);
  switch (node.style.display) {
    case "flex":
      return layoutFlex(node, input);
    case "grid":
      return layoutGrid(node, input);
    default:
      return layoutBlock(node, input);
  }
}

/** `min-height`/`max-height` as a border-box bound; intrinsic keywords are content-based and resolved by the algorithm (undefined here). */
function blockSizeBound(node: LayoutNode, v: Size | MaxSize, cbHeight: number | undefined, pbV: number): number | undefined {
  return resolveLength(node.style, v, cbHeight, pbV);
}

/** Zeroes the boxes of a `display: none` subtree. */
export function hide(node: LayoutNode): void {
  touch(node);
  const o = node.out;
  o.x = o.y = o.width = o.height = 0;
  o.baseline = undefined;
  node.placedKey = null;
  for (const c of node.children) hide(c);
}

/** Sets a child's position in its parent's border box, adding `position: relative` offsets (percentages of its containing block). */
export function place(child: LayoutNode, x: number, y: number, cbWidth: number | undefined, cbHeight: number | undefined): void {
  const s = child.style;
  let dx = 0;
  let dy = 0;
  if (s.position === "relative") {
    const l = s.inset.left === "auto" ? undefined : resolveLP(s.inset.left, cbWidth);
    const r = s.inset.right === "auto" ? undefined : resolveLP(s.inset.right, cbWidth);
    const t = s.inset.top === "auto" ? undefined : resolveLP(s.inset.top, cbHeight);
    const b = s.inset.bottom === "auto" ? undefined : resolveLP(s.inset.bottom, cbHeight);
    dx = l ?? (r !== undefined ? -r : 0);
    dy = t ?? (b !== undefined ? -b : 0);
  }
  touch(child);
  child.out.x = x + dx;
  child.out.y = y + dy;
  child.out.margin = marginOf(s, cbWidth);
}

// ── Intrinsic inline sizes ───────────────────────────────────────────────

/** Min-content and max-content widths of a box's content box (cached). */
export function intrinsic(node: LayoutNode): Intrinsic {
  if (node.intrinsicCache) return node.intrinsicCache;
  stats.intrinsic++;
  let r: Intrinsic;
  if (node.style.display === "none") r = { min: 0, max: 0 };
  else if (node.measure || node.replaced) r = intrinsicLeaf(node);
  else if (node.style.display === "flex") r = intrinsicFlex(node);
  else if (node.style.display === "grid") r = intrinsicGrid(node);
  else r = intrinsicBlock(node);
  node.intrinsicCache = r;
  return r;
}

export type IntrinsicKind = "min" | "max";

/**
 * A box's preferred border-box width for an intrinsic contribution: its
 * `width` when that is definite, otherwise its min-content or max-content
 * size (or the width its aspect ratio gives a definite height).
 */
export function preferredInlineSize(node: LayoutNode, kind: IntrinsicKind, cbWidth: number | undefined, cbHeight: number | undefined, pbH: number, pbV: number): number {
  const s = node.style;
  const w = resolveLength(s, s.width, cbWidth, pbH);
  if (w !== undefined) return w;
  if (s.width === "min-content") return intrinsic(node).min + pbH;
  if (s.width === "max-content") return intrinsic(node).max + pbH;
  if (s.width === "fit-content") return (kind === "min" ? intrinsic(node).min : intrinsic(node).max) + pbH;
  const ratio = aspectRatioOf(node);
  if (ratio) {
    const h = resolveLength(s, s.height, cbHeight, pbV);
    if (h !== undefined) {
      const minH = resolveLength(s, s.minHeight, cbHeight, pbV) ?? 0;
      const maxH = resolveLength(s, s.maxHeight, cbHeight, pbV) ?? INF;
      return ratioWidthFromHeight(ratio, clamp(h, minH, maxH), pbH, pbV);
    }
  }
  const i = intrinsic(node);
  return (kind === "min" ? i.min : i.max) + pbH;
}

/** `min-width`/`max-width` as border-box sizes (`auto` is `autoMin`, `none` is infinite). */
export function inlineBounds(node: LayoutNode, cbWidth: number | undefined, pbH: number, autoMin = 0): { min: number; max: number } {
  const s = node.style;
  const kw = (v: Size | MaxSize): number | undefined => {
    if (v === "min-content") return intrinsic(node).min + pbH;
    if (v === "max-content") return intrinsic(node).max + pbH;
    if (v === "fit-content") return intrinsic(node).max + pbH;
    return resolveLength(s, v, cbWidth, pbH);
  };
  const min = s.minWidth === "auto" ? autoMin : kw(s.minWidth) ?? 0;
  const max = s.maxWidth === "none" ? INF : kw(s.maxWidth) ?? INF;
  return { min, max };
}

/**
 * The outer (margin-box) min-content or max-content contribution of a box
 * to its parent's inline size. Percentages of the indefinite containing
 * block behave as `auto` for sizes and as 0 for margins and padding.
 */
export function inlineContribution(node: LayoutNode, kind: IntrinsicKind, cbWidth?: number, cbHeight?: number, autoMin = 0): number {
  const s = node.style;
  if (s.display === "none" || isOutOfFlow(node)) return 0;
  const pb = pbOf(s, cbWidth);
  const m = marginOf(s, cbWidth);
  const b = inlineBounds(node, cbWidth, pb.h, autoMin);
  const w = Math.max(pb.h, clamp(preferredInlineSize(node, kind, cbWidth, cbHeight, pb.h, pb.v), b.min, b.max));
  return w + m.left + m.right;
}

/** `fit-content` inline size into `available` (border-box): `min(max-content, max(min-content, available))`. */
export function fitContentWidth(node: LayoutNode, available: number, pbH: number): number {
  const i = intrinsic(node);
  return Math.min(i.max + pbH, Math.max(i.min + pbH, available));
}

// ── Entry point ──────────────────────────────────────────────────────────

/**
 * Lays out the tree rooted at `root` in an initial containing block of
 * `width` × `height` px (the viewport), as a block-level box placed at its
 * margins, or as an absolutely positioned box when it is one. Afterwards
 * every node's {@link LayoutNode.box} holds its box relative to its parent
 * (the root's is relative to the viewport). Only dirty nodes, or nodes whose
 * constraints changed, are laid out again. `options.touched` collects the
 * nodes whose box was written (a superset of those whose box changed).
 */
export function computeLayout(root: LayoutNode, width: number, height: number, options: { touched?: Set<LayoutNode> } = {}): LayoutStats {
  touched = options.touched ?? null;
  try {
    return run(root, width, height);
  } finally {
    touched = null;
  }
}

function run(root: LayoutNode, width: number, height: number): LayoutStats {
  touch(root);
  stats.layouts = 0;
  stats.cacheHits = 0;
  stats.intrinsic = 0;
  stats.placed = 0;
  if (root.style.display === "none") {
    hide(root);
  } else if (isOutOfFlow(root)) {
    layoutAbsoluteBox(root, { x: 0, y: 0, width, height }, 0, 0);
  } else {
    const w = blockChildWidth(root, width, height);
    layout(root, space(w.width, undefined, width, height), true);
    const m = marginOf(root.style, width);
    place(root, w.marginLeft, m.top, width, height);
    root.out.margin = { top: m.top, right: w.marginRight, bottom: m.bottom, left: w.marginLeft };
  }
  layoutInitialOutOfFlow(root, width, height);
  return { ...stats };
}

export { INF };
