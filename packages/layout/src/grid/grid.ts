import { intrinsicBlock, layoutBlock } from "../block";
import type { ContentInput, ContentResult } from "../compute";
import type { Intrinsic, LayoutNode } from "../node";

export function layoutGrid(node: LayoutNode, input: ContentInput): ContentResult {
  return layoutBlock(node, input);
}

export function intrinsicGrid(node: LayoutNode): Intrinsic {
  return intrinsicBlock(node);
}
