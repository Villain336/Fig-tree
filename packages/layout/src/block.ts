import { fitContentWidth, inlineBounds, inlineContribution, intrinsic, layout, place, space, type ContentInput, type ContentResult } from "./compute";
import { setStatic, type Intrinsic, type LayoutNode } from "./node";
import { INF, aspectRatioOf, clamp, isAuto, isOutOfFlow, marginOf, pbOf, ratioWidthFromHeight, resolveLength } from "./sizing";
import { resolveLPOrZero } from "./style";

/**
 * Block layout. Every block container here establishes an independent
 * formatting context (CSS `display: flow-root`): block-level children stack
 * vertically, adjacent sibling margins collapse (CSS 2 §8.3.1), and the
 * container's own margins never collapse with its children's. There is no
 * inline formatting context: text is a measured leaf.
 */
export function layoutBlock(node: LayoutNode, input: ContentInput): ContentResult {
  let y = input.top;
  let pendingPos = 0;
  let pendingNeg = 0;
  let first: number | undefined;
  let last: number | undefined;
  let any = false;
  for (const child of node.children) {
    const cs = child.style;
    if (cs.display === "none") {
      if (input.perform) layout(child, space(0, 0, input.width, input.percentHeight), true);
      continue;
    }
    if (isOutOfFlow(child)) {
      // Static position: where the box would start in flow (its top margin collapsing with the pending one).
      setStatic(child, input.left, y + (any ? pendingPos + pendingNeg : 0), 0, 0, 0, 0);
      continue;
    }
    const w = blockChildWidth(child, input.width, input.percentHeight);
    const r = layout(child, space(w.width, undefined, input.width, input.percentHeight), input.perform);
    const m = marginOf(cs, input.width);
    // Collapse this top margin with the previous sibling's bottom margin.
    const pos = Math.max(pendingPos, m.top, 0);
    const neg = Math.min(pendingNeg, m.top, 0);
    const childY = y + (any ? pos + neg : m.top);
    if (input.perform) {
      place(child, input.left + w.marginLeft, childY, input.width, input.percentHeight);
      child.out.margin = { top: m.top, right: w.marginRight, bottom: m.bottom, left: w.marginLeft };
    }
    if (first === undefined && r.firstBaseline !== undefined) first = childY + r.firstBaseline;
    if (r.lastBaseline !== undefined) last = childY + r.lastBaseline;
    y = childY + r.height;
    pendingPos = Math.max(0, m.bottom);
    pendingNeg = Math.min(0, m.bottom);
    any = true;
  }
  const natural = Math.max(0, y + pendingPos + pendingNeg - input.top);
  const height = input.height ?? clamp(natural, input.minHeight, input.maxHeight);
  return { height, firstBaseline: first, lastBaseline: last };
}

export function intrinsicBlock(node: LayoutNode): Intrinsic {
  let min = 0;
  let max = 0;
  for (const c of node.children) {
    if (c.style.display === "none" || isOutOfFlow(c)) continue;
    min = Math.max(min, inlineContribution(c, "min"));
    max = Math.max(max, inlineContribution(c, "max"));
  }
  return { min, max };
}

/**
 * Used border-box width and horizontal margins of a block-level box in a
 * containing block `cbWidth` wide (CSS 2 §10.3.3, §10.3.4 for replaced
 * boxes, CSS Sizing 3 for keywords and aspect ratios).
 */
export function blockChildWidth(child: LayoutNode, cbWidth: number, cbHeight: number | undefined): { width: number; marginLeft: number; marginRight: number } {
  const s = child.style;
  const pb = pbOf(s, cbWidth);
  const ml = isAuto(s.margin.left) ? 0 : resolveLPOrZero(s.margin.left, cbWidth);
  const mr = isAuto(s.margin.right) ? 0 : resolveLPOrZero(s.margin.right, cbWidth);
  const available = cbWidth - ml - mr;
  let width = resolveLength(s, s.width, cbWidth, pb.h);
  if (width === undefined) {
    if (s.width === "min-content") width = intrinsic(child).min + pb.h;
    else if (s.width === "max-content") width = intrinsic(child).max + pb.h;
    else if (s.width === "fit-content") width = fitContentWidth(child, available, pb.h);
    else {
      const ratio = aspectRatioOf(child);
      const h = ratio ? resolveLength(s, s.height, cbHeight, pb.v) : undefined;
      if (ratio && h !== undefined) {
        const minH = resolveLength(s, s.minHeight, cbHeight, pb.v) ?? 0;
        const maxH = resolveLength(s, s.maxHeight, cbHeight, pb.v) ?? INF;
        width = ratioWidthFromHeight(ratio, clamp(h, minH, maxH), pb.h, pb.v);
      } else if (child.replaced) {
        width = replacedAutoWidth(child, pb.h);
      } else {
        width = available;
      }
    }
  }
  const b = inlineBounds(child, cbWidth, pb.h);
  width = Math.max(pb.h, clamp(width, b.min, b.max));
  let marginLeft = ml;
  let marginRight = mr;
  const free = cbWidth - width - ml - mr;
  const autoL = isAuto(s.margin.left);
  const autoR = isAuto(s.margin.right);
  if (autoL && autoR) {
    marginLeft = marginRight = Math.max(0, free) / 2;
  } else if (autoL) {
    marginLeft = Math.max(0, free);
  } else {
    // Over-constrained (or margin-right auto): margin-right takes the rest (it does not move the box in LTR).
    marginRight = mr + free;
  }
  return { width, marginLeft, marginRight };
}

/** The used width of a replaced box with `width: auto` (CSS 2 §10.3.2), without a definite height. */
function replacedAutoWidth(child: LayoutNode, pbH: number): number {
  const r = child.replaced!;
  if (r.width !== undefined) return r.width + pbH;
  const ratio = r.ratio ?? (r.height ? undefined : undefined);
  if (ratio && r.height !== undefined) return r.height * ratio + pbH;
  return 300 + pbH;
}
