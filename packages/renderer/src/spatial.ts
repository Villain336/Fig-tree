import type { Rect } from "@fig-tree/geometry";
import RBush from "rbush";

interface IndexEntry extends Rect {
  readonly item: number;
}

/** R-tree over draw items' world bounds, used for viewport culling and hit-testing. */
export class SpatialIndex {
  private tree = new RBush<IndexEntry>(16);
  /** Current entry of each indexed item, for in-place updates. */
  private entries = new Map<number, IndexEntry>();

  build(items: readonly { index: number; worldBounds: Rect }[]): void {
    this.tree = new RBush<IndexEntry>(16);
    this.entries = new Map();
    const list = items.map((it) => {
      const entry = { minX: it.worldBounds.minX, minY: it.worldBounds.minY, maxX: it.worldBounds.maxX, maxY: it.worldBounds.maxY, item: it.index };
      this.entries.set(it.index, entry);
      return entry;
    });
    this.tree.load(list);
  }

  get size(): number {
    return this.entries.size;
  }

  /** Moves one item to new bounds, or removes it from the index when `bounds` is null. */
  update(item: number, bounds: Rect | null): void {
    const old = this.entries.get(item);
    if (old) {
      this.tree.remove(old);
      this.entries.delete(item);
    }
    if (!bounds) return;
    const entry = { minX: bounds.minX, minY: bounds.minY, maxX: bounds.maxX, maxY: bounds.maxY, item };
    this.entries.set(item, entry);
    this.tree.insert(entry);
  }

  /** Item indices whose bounds intersect `r`, in paint order. */
  query(r: Rect): Uint32Array {
    const found = this.tree.search(r);
    const hits = new Uint32Array(found.length);
    for (let i = 0; i < found.length; i++) hits[i] = found[i]!.item;
    return hits.sort();
  }
}
