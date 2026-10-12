import { fitContentWidth, inlineBounds, intrinsic, layout, space } from "./compute";
import { LayoutNode, type Rect } from "./node";
import { INF, aspectRatioOf, clamp, isAuto, pbOf, ratioHeightFromWidth, ratioWidthFromHeight, resolveLength } from "./sizing";
import { resolveLP, resolveLPOrZero, type LengthPercentage } from "./style";

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
      if (s.display === "none") continue;
      if (s.position === "absolute") {
        const area = n === cb && c.absArea ? c.absArea : padding;
        layoutAbsoluteBox(c, area, ox + c.staticX, oy + c.staticY);
        c.out.x -= ox;
        c.out.y -= oy;
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
      if (s.display === "none") continue;
      if (s.position === "fixed" || (s.position === "absolute" && !absCaptured)) {
        layoutAbsoluteBox(c, icb, ox + c.staticX, oy + c.staticY);
        c.out.x -= ox;
        c.out.y -= oy;
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

/**
 * Sizes and places one absolutely positioned box in the containing block
 * `cb` (a rectangle in the coordinates the static position is given in).
 * Writes the box's position in those coordinates.
 */
export function layoutAbsoluteBox(node: LayoutNode, cb: Rect, staticX: number, staticY: number): void {
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

  // Vertical size first when it is definite (it may determine the width through the ratio).
  const minH = resolveLength(s, s.minHeight, cbH, pb.v) ?? 0;
  const maxH = resolveLength(s, s.maxHeight, cbH, pb.v) ?? INF;
  let height = resolveLength(s, s.height, cbH, pb.v);
  const stretchH = s.height === "auto" && top !== undefined && bottom !== undefined;
  if (height === undefined && stretchH && !node.replaced) height = cbH - top - bottom - mt - mb;
  if (height !== undefined) height = Math.max(pb.v, clamp(height, minH, maxH));

  // Horizontal: the inset-modified containing block.
  const availW = cbW - (left ?? (right === undefined ? sx : 0)) - (right ?? 0);
  const b = inlineBounds(node, cbW, pb.h);
  let width = resolveLength(s, s.width, cbW, pb.h);
  if (width === undefined) {
    if (s.width === "min-content") width = intrinsic(node).min + pb.h;
    else if (s.width === "max-content") width = intrinsic(node).max + pb.h;
    else if (ratio && height !== undefined && !(stretchH && left !== undefined && right !== undefined)) width = ratioWidthFromHeight(ratio, height, pb.h, pb.v);
    else if (s.width === "auto" && left !== undefined && right !== undefined && !node.replaced) width = availW - ml - mr;
    else if (node.replaced && s.width === "auto") width = replacedWidth(node, pb.h);
    else width = fitContentWidth(node, availW - ml - mr, pb.h);
  }
  width = Math.max(pb.h, clamp(width, b.min, b.max));
  if (height === undefined && ratio) height = Math.max(pb.v, clamp(ratioHeightFromWidth(ratio, width, pb.h, pb.v), minH, maxH));

  let x: number;
  if (left === undefined && right === undefined) x = sx + node.staticAlignX * (node.staticW - (width + ml + mr)) + ml;
  else if (left === undefined) x = cbW - right! - mr - width;
  else if (right === undefined) x = left + ml;
  else {
    const free = cbW - left - right - width - ml - mr;
    if (autoL && autoR) {
      if (free >= 0) ml = mr = free / 2;
      else {
        ml = 0;
        mr = free;
      }
    } else if (autoL) ml = free;
    else if (autoR) mr = free;
    else mr += free;
    x = left + ml;
  }

  const r = layout(node, space(width, height, cbW, cbH), true);
  const h = r.height;
  let y: number;
  if (top === undefined && bottom === undefined) y = sy + node.staticAlignY * (node.staticH - (h + mt + mb)) + mt;
  else if (top === undefined) y = cbH - bottom! - mb - h;
  else if (bottom === undefined) y = top + mt;
  else {
    const free = cbH - top - bottom - h - mt - mb;
    if (autoT && autoB) {
      if (free >= 0) mt = mb = free / 2;
      else {
        mt = 0;
        mb = free;
      }
    } else if (autoT) mt = free;
    else if (autoB) mb = free;
    else mb += free;
    y = top + mt;
  }
  const o = node.out;
  o.x = cb.x + x;
  o.y = cb.y + y;
  o.margin = { top: mt, right: mr, bottom: mb, left: ml };
}

function replacedWidth(node: LayoutNode, pbH: number): number {
  const r = node.replaced!;
  if (r.width !== undefined) return r.width + pbH;
  return intrinsic(node).max + pbH;
}
