import { containsPoint, invert, maxScale, transformPoint, type Point } from "@fig-tree/geometry";
import type { DrawItem, DrawList } from "./compile";
import type { SceneNode } from "./scene";

/**
 * Topmost node whose fill or stroke contains `world`, honouring ancestor
 * clips. Uses the same flattened geometry the GPU renders, so hits agree with
 * pixels to within the flattening tolerance.
 */
export function hitTest(list: DrawList, world: Point): SceneNode | null {
  const candidates = list.index.query({ minX: world.x, minY: world.y, maxX: world.x, maxY: world.y });
  for (let i = candidates.length - 1; i >= 0; i--) {
    const item = list.items[candidates[i]!]!;
    if (!contains(item, world)) continue;
    if (list.clipChain(item).every((clip) => contains(clip, world))) return item.node;
  }
  return null;
}

function contains(item: DrawItem, world: Point): boolean {
  const slot = item.geometry;
  if (!slot) return false;
  const inv = invert(item.world);
  if (!inv) return false;
  const local = transformPoint(inv, world.x, world.y);
  const geometry = slot.current() ?? slot.at(maxScale(item.world));
  return containsPoint(geometry.polylines, local.x, local.y, item.fillRule);
}
