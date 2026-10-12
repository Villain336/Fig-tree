import type { ContentInput, ContentResult } from "./compute";
import type { Intrinsic, LayoutNode } from "./node";
import { clamp, naturalRatio } from "./sizing";

/** Measured (text-like) and replaced leaves. */
export function layoutLeaf(node: LayoutNode, input: ContentInput): ContentResult {
  const m = node.measure;
  if (m) {
    const natural = m.heightForWidth(input.width);
    const height = input.height ?? clamp(natural, input.minHeight, input.maxHeight);
    const fb = m.firstBaseline?.(input.width);
    const lb = m.lastBaseline?.(input.width);
    return { height, firstBaseline: fb === undefined ? undefined : input.top + fb, lastBaseline: lb === undefined ? undefined : input.top + lb };
  }
  // Replaced content has no baseline; its height comes from its ratio or natural height (see computeBox).
  const r = node.replaced!;
  const ratio = naturalRatio(node);
  const natural = ratio ? input.width / ratio : (r.height ?? 150);
  return { height: input.height ?? clamp(natural, input.minHeight, input.maxHeight), firstBaseline: undefined, lastBaseline: undefined };
}

export function intrinsicLeaf(node: LayoutNode): Intrinsic {
  const m = node.measure;
  if (m) return { min: m.minContentWidth(), max: m.maxContentWidth() };
  const r = node.replaced!;
  const ratio = naturalRatio(node);
  const w = r.width ?? (ratio && r.height !== undefined ? r.height * ratio : 300);
  return { min: w, max: w };
}
