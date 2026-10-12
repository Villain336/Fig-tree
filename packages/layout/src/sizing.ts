import type { Edges, LayoutNode } from "./node";
import { resolveLP, resolveLPOrZero, type LengthPercentage, type MaxSize, type Size, type Style } from "./style";

/**
 * Box-model helpers shared by the formatting contexts (CSS Box Model 3,
 * CSS Sizing 3). Sizes here are border-box sizes unless a name says
 * otherwise; `box-sizing` is applied when a property is resolved.
 */

export const INF = Number.POSITIVE_INFINITY;

/** Padding in px. Percentages resolve against the containing block's width (also vertically); indefinite resolves against 0. */
export function paddingOf(style: Style, cbWidth: number | undefined): Edges {
  const p = style.padding;
  return {
    top: Math.max(0, resolveLPOrZero(p.top, cbWidth)),
    right: Math.max(0, resolveLPOrZero(p.right, cbWidth)),
    bottom: Math.max(0, resolveLPOrZero(p.bottom, cbWidth)),
    left: Math.max(0, resolveLPOrZero(p.left, cbWidth)),
  };
}

export function borderOf(style: Style): Edges {
  return { top: style.border.top, right: style.border.right, bottom: style.border.bottom, left: style.border.left };
}

/** Margins in px with `auto` as 0 (callers that honour auto margins check {@link isAuto}). */
export function marginOf(style: Style, cbWidth: number | undefined): Edges {
  const m = style.margin;
  const r = (v: LengthPercentage | "auto"): number => (v === "auto" ? 0 : resolveLPOrZero(v, cbWidth));
  return { top: r(m.top), right: r(m.right), bottom: r(m.bottom), left: r(m.left) };
}

export function isAuto(v: unknown): v is "auto" {
  return v === "auto";
}

/** Padding plus border, horizontally and vertically. */
export function pbOf(style: Style, cbWidth: number | undefined): { h: number; v: number; padding: Edges; border: Edges } {
  const padding = paddingOf(style, cbWidth);
  const border = borderOf(style);
  return { h: padding.left + padding.right + border.left + border.right, v: padding.top + padding.bottom + border.top + border.bottom, padding, border };
}

/** Converts a used size of the `box-sizing` box to a border-box size. */
export function toBorderBox(style: Style, size: number, pb: number): number {
  return style.boxSizing === "border-box" ? Math.max(size, pb) : Math.max(0, size) + pb;
}

/**
 * Resolves a length-percentage size property to a border-box size, or
 * undefined when it is `auto`, `none`, a keyword, or a percentage of an
 * indefinite basis.
 */
export function resolveLength(style: Style, v: Size | MaxSize, basis: number | undefined, pb: number): number | undefined {
  if (typeof v === "string") return undefined;
  const r = resolveLP(v, basis);
  return r === undefined ? undefined : toBorderBox(style, r, pb);
}

/** `min(max, max(min, v))` with min winning, as CSS clamps sizes. */
export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(v, max));
}

/**
 * A preferred aspect ratio (width / height) and the box it applies to:
 * `aspect-ratio: <ratio>` applies to the `box-sizing` box, a natural ratio
 * (and the `auto && <ratio>` form) to the content box.
 */
export interface Ratio {
  readonly value: number;
  readonly contentBox: boolean;
}

export function ratioWidthFromHeight(r: Ratio, borderBoxHeight: number, pbH: number, pbV: number): number {
  if (!r.contentBox) return Math.max(pbH, borderBoxHeight * r.value);
  return Math.max(0, borderBoxHeight - pbV) * r.value + pbH;
}

export function ratioHeightFromWidth(r: Ratio, borderBoxWidth: number, pbH: number, pbV: number): number {
  if (!r.contentBox) return Math.max(pbV, borderBoxWidth / r.value);
  return Math.max(0, borderBoxWidth - pbH) / r.value + pbV;
}

/** The preferred aspect ratio of a node: `aspect-ratio`, or a replaced element's natural ratio. */
export function aspectRatioOf(node: LayoutNode): Ratio | null {
  const s = node.style;
  const natural = naturalRatio(node);
  if (s.aspectRatio !== null) {
    if (s.aspectRatioAuto) return { value: natural ?? s.aspectRatio, contentBox: true };
    return { value: s.aspectRatio, contentBox: s.boxSizing === "content-box" };
  }
  return natural === null ? null : { value: natural, contentBox: true };
}

export function naturalRatio(node: LayoutNode): number | null {
  const r = node.replaced;
  if (!r) return null;
  if (r.ratio !== undefined && r.ratio > 0) return r.ratio;
  if (r.width !== undefined && r.height !== undefined && r.width > 0 && r.height > 0) return r.width / r.height;
  return null;
}

/** In-flow children (laid out by the container's algorithm). */
export function isOutOfFlow(node: LayoutNode): boolean {
  const p = node.style.position;
  return p === "absolute" || p === "fixed";
}
