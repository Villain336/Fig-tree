import type { Rect } from "@fig-tree/geometry";
import RBush from "rbush";

interface IndexEntry extends Rect {
  readonly item: number;
}

/** R-tree over draw items' world bounds, used for viewport culling and hit-testing. */
export class SpatialIndex {
  private tree = new RBush<IndexEntry>(16);

  build(items: readonly { index: number; worldBounds: Rect }[]): void {
    this.tree = new RBush<IndexEntry>(16);
    this.tree.load(items.map((it) => ({ ...it.worldBounds, item: it.index })));
  }

  /** Item indices whose bounds intersect `r`, in paint order. */
  query(r: Rect): Uint32Array {
    const found = this.tree.search(r);
    const hits = new Uint32Array(found.length);
    for (let i = 0; i < found.length; i++) hits[i] = found[i]!.item;
    return hits.sort();
  }
}
