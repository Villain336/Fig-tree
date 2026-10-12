import { fitContentWidth, inlineBounds, intrinsic, layout, space, touch } from "./compute";
import { LayoutNode, type Rect } from "./node";
import { INF, aspectRatioOf, clamp, isAuto, pbOf, ratioHeightFromWidth, ratioWidthFromHeight, resolveLength } from "./sizing";
import { resolveLP, resolveLPOrZero, splitAlignment, type LengthPercentage } from "./style";

/**
 * Absolutely positioned boxes (CSS Positioned Layout 3, CSS 2 §10.3.7 and
 * §10.6.4). A box's containing block is the padding box of its nearest
 * positioned ancestor (or a grid area, for children of a positioned grid
 * container that place themselves), `position: fixed` uses the initial
 * containing block. Insets that are both `auto` use the static position the
 * parent's formatting context computed.
 */

/** Lays out the absolutely positioned descendants whose containing block is `cb` (called after `cb`'s own layout). */
export function layoutOutOfFlow(cb: LayoutNode): void {
  const b = cb.out.border;
  const padding: Rect = { x: b.left, y: b.top, width: Math.max(0, cb.out.width - b.left - b.right), height: Math.max(0, cb.out.height - b.top - b.bottom) };
  const visit = (n: LayoutNode, ox: number, oy: number): void => {
    for (const c of n.children) {
      const s = c.style;
      if (s.display === "none" || c.outOfFlowInSubtree === 0) continue;
      if (s.position === "absolute") {
        const area = n === cb && c.absArea ? c.absArea : padding;
        layoutAbsoluteBox(c, area, ox + c.staticX, oy + c.staticY, ox, oy);
      } else if (s.position === "static") {
        if (!c.measure && !c.replaced) visit(c, ox + c.out.x, oy + c.out.y);
      }
    }
  };
  visit(cb, 0, 0);
}

/** Out-of-flow boxes of the initial containing block: absolutes without a positioned ancestor, and fixed boxes. */
export function layoutInitialOutOfFlow(root: LayoutNode, width: number, height: number): void {
  const icb: Rect = { x: 0, y: 0, width, height };
  const visit = (n: LayoutNode, ox: number, oy: number, absCaptured: boolean): void => {
    for (const c of n.children) {
      const s = c.style;
      if (s.display === "none" || c.outOfFlowInSubtree === 0) continue;
      if (s.position === "fixed" || (s.position === "absolute" && !absCaptured)) {
        layoutAbsoluteBox(c, icb, ox + c.staticX, oy + c.staticY, ox, oy);
      }
      if (c.measure || c.replaced) continue;
      const captured = absCaptured || s.position !== "static";
      // Below a positioned box only fixed boxes still belong to the viewport.
      if (captured && LayoutNode.fixedCount === 0) continue;
      visit(c, ox + c.out.x, oy + c.out.y, captured);
    }
  };
  if (root.style.display === "none") return;
  visit(root, root.out.x, root.out.y, root.style.position !== "static");
}

function inset(v: LengthPercentage | "auto", basis: number): number | undefined {
  return v === "auto" ? undefined : resolveLP(v, basis);
}

/** A box's own `justify-self`/`align-self` for positioning (`auto` is `normal` for absolutely positioned boxes). */
function selfAlignment(v: string): { value: string; unsafe: boolean } {
  const { overflow, value } = splitAlignment(v === "auto" ? "normal" : v);
  return { value: value === "first baseline" ? "baseline" : value, unsafe: overflow === "unsafe" };
}

/** `normal` and `stretch` stretch an auto-sized box between two insets. */
function stretchy(value: string): boolean {
  return value === "normal" || value === "stretch";
}

/**
 * Where a value aligns a box in an axis: 0 start, 0.5 center, 1 end, or
 * null for `normal` (CSS 2 rules). `stretch` aligns a box that could not be
 * stretched (a definite size) like `start`.
 */
function alignFraction(value: string, horizontal: boolean): number | null {
  switch (value) {
    case "normal":
      return null;
    case "center":
      return 0.5;
    case "end":
    case "self-end":
    case "flex-end":
    case "last baseline":
      return 1;
    case "right":
      return horizontal ? 1 : 0;
    default:
      return 0;
  }
}

/**
 * Position of a margin box of `outer` size between insets `a` and `b` of a
 * containing block `size` long (CSS Positioned Layout 3 §4): `normal` keeps
 * CSS 2's start alignment; other values align in the inset-modified
 * containing block and, unless `unsafe`, a box that overflows it is shifted
 * back inside the containing block (to its start when it cannot fit).
 */
function alignInInsets(a: number, b: number, size: number, outer: number, align: { value: string; unsafe: boolean }, horizontal: boolean): number {
  const frac = alignFraction(align.value, horizontal) ?? 0;
  const imcb = size - a - b;
  let p = a + frac * (imcb - outer);
  if (alignFraction(align.value, horizontal) !== null && !align.unsafe && outer > imcb) {
    p = outer > size ? 0 : Math.max(0, Math.min(p, size - outer));
  }
  return p;
}

/**
 * Sizes and places one absolutely positioned box in the containing block
 * `cb` (a rectangle in the coordinates the static position is given in).
 * `(ox, oy)` is the box's parent's origin in those coordinates; the box's
 * position is written relative to its parent. A box whose inputs did not
 * change since its last placement (and that is not dirty) is left alone.
 */
export function layoutAbsoluteBox(node: LayoutNode, cb: Rect, staticX: number, staticY: number, ox = 0, oy = 0): void {
  const key = `${cb.x},${cb.y},${cb.width},${cb.height},${staticX},${staticY},${node.staticW},${node.staticH},${node.staticAlignX},${node.staticAlignY},${ox},${oy}`;
  if (node.placedKey !== null && node.absKey === key) return;
  node.absKey = key;
  const s = node.style;
  const cbW = cb.width;
  const cbH = cb.height;
  const pb = pbOf(s, cbW);
  const left = inset(s.inset.left, cbW);
  const right = inset(s.inset.right, cbW);
  const top = inset(s.inset.top, cbH);
  const bottom = inset(s.inset.bottom, cbH);
  const m = s.margin;
  const autoL = isAuto(m.left);
  const autoR = isAuto(m.right);
  const autoT = isAuto(m.top);
  const autoB = isAuto(m.bottom);
  let ml = autoL ? 0 : resolveLPOrZero(m.left as LengthPercentage, cbW);
  let mr = autoR ? 0 : resolveLPOrZero(m.right as LengthPercentage, cbW);
  let mt = autoT ? 0 : resolveLPOrZero(m.top as LengthPercentage, cbW);
  let mb = autoB ? 0 : resolveLPOrZero(m.bottom as LengthPercentage, cbW);
  // Static position relative to the containing block.
  const sx = staticX - cb.x;
  const sy = staticY - cb.y;
  const ratio = aspectRatioOf(node);
  const justify = selfAlignment(s.justifySelf);
  const alignSelf = selfAlignment(s.alignSelf);

  // Vertical size first when it is definite (it may determine the width through the ratio).
  const minH = resolveLength(s, s.minHeight, cbH, pb.v) ?? 0;
  const maxH = resolveLength(s, s.maxHeight, cbH, pb.v) ?? INF;
  let height = resolveLength(s, s.height, cbH, pb.v);
  const stretchH = s.height === "auto" && top !== undefined && bottom !== undefined;
  // Stretch into the inset-modified containing block (its size floored at 0 before margins, as Chromium does).
  if (height === undefined && stretchH && !node.replaced && stretchy(alignSelf.value)) height = Math.max(0, cbH - top - bottom) - mt - mb;
  if (height !== undefined) height = Math.max(pb.v, clamp(height, minH, maxH));

  // Horizontal: the inset-modified containing block.
  const availW = cbW - (left ?? (right === undefined ? sx : 0)) - (right ?? 0);
  const b = inlineBounds(node, cbW, pb.h);
  let width = resolveLength(s, s.width, cbW, pb.h);
  if (width === undefined) {
    if (s.width === "min-content") width = intrinsic(node).min + pb.h;
    else if (s.width === "max-content") width = intrinsic(node).max + pb.h;
    else if (ratio && height !== undefined && !(stretchH && left !== undefined && right !== undefined)) width = ratioWidthFromHeight(ratio, height, pb.h, pb.v);
    else if (s.width === "auto" && left !== undefined && right !== undefined && !node.replaced && stretchy(justify.value)) width = Math.max(0, availW) - ml - mr;
    else if (node.replaced && s.width === "auto") width = replacedWidth(node, pb.h);
    else width = fitContentWidth(node, availW - ml - mr, pb.h);
  }
  width = Math.max(pb.h, clamp(width, b.min, b.max));
  if (height === undefined && ratio) height = Math.max(pb.v, clamp(ratioHeightFromWidth(ratio, width, pb.h, pb.v), minH, maxH));

  let x: number;
  if (left === undefined && right === undefined) x = sx + node.staticAlignX * (node.staticW - (width + ml + mr)) + ml;
  else if (left === undefined) x = cbW - right! - mr - width;
  else if (right === undefined) x = left + ml;
  else if (autoL || autoR) {
    const free = cbW - left - right - width - ml - mr;
    if (autoL && autoR) {
      if (free >= 0) ml = mr = free / 2;
      else {
        ml = 0;
        mr = free;
      }
    } else if (autoL) ml = free;
    else mr = free;
    x = left + ml;
  } else {
    x = alignInInsets(left, right, cbW, width + ml + mr, justify, true) + ml;
  }

  const r = layout(node, space(width, height, cbW, cbH), true);
  const h = r.height;
  let y: number;
  if (top === undefined && bottom === undefined) y = sy + node.staticAlignY * (node.staticH - (h + mt + mb)) + mt;
  else if (top === undefined) y = cbH - bottom! - mb - h;
  else if (bottom === undefined) y = top + mt;
  else if (autoT || autoB) {
    const free = cbH - top - bottom - h - mt - mb;
    if (autoT && autoB) {
      if (free >= 0) mt = mb = free / 2;
      else {
        mt = 0;
        mb = free;
      }
    } else if (autoT) mt = free;
    else mb = free;
    y = top + mt;
  } else {
    y = alignInInsets(top, bottom, cbH, h + mt + mb, alignSelf, false) + mt;
  }
  const o = node.out;
  touch(node);
  o.x = cb.x + x - ox;
  o.y = cb.y + y - oy;
  o.margin = { top: mt, right: mr, bottom: mb, left: ml };
}

function replacedWidth(node: LayoutNode, pbH: number): number {
  const r = node.replaced!;
  if (r.width !== undefined) return r.width + pbH;
  return intrinsic(node).max + pbH;
}
