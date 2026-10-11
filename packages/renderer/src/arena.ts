/** A half-open range `[offset, offset + size)` in allocator units. */
export interface Range {
  readonly offset: number;
  readonly size: number;
}

/**
 * First-fit range allocator with coalescing free list. It only does the
 * bookkeeping; owners map units to GPU buffer bytes and grow the buffer when
 * `allocate` reports that more capacity is needed.
 */
export class RangeAllocator {
  /** Sorted, non-adjacent free ranges. */
  private free: { offset: number; size: number }[] = [];
  private _capacity = 0;
  private _used = 0;

  constructor(capacity: number) {
    this.grow(capacity);
  }

  get capacity(): number {
    return this._capacity;
  }

  get used(): number {
    return this._used;
  }

  /** Allocates `size` units, or returns null if the caller must `grow` first. */
  allocate(size: number): Range | null {
    if (size <= 0) return { offset: 0, size: 0 };
    for (let i = 0; i < this.free.length; i++) {
      const f = this.free[i]!;
      if (f.size < size) continue;
      const r = { offset: f.offset, size };
      f.offset += size;
      f.size -= size;
      if (f.size === 0) this.free.splice(i, 1);
      this._used += size;
      return r;
    }
    return null;
  }

  release(r: Range): void {
    if (r.size <= 0) return;
    this._used -= r.size;
    let i = 0;
    while (i < this.free.length && this.free[i]!.offset < r.offset) i++;
    this.free.splice(i, 0, { offset: r.offset, size: r.size });
    // Merge with neighbours.
    if (i + 1 < this.free.length) {
      const cur = this.free[i]!;
      const next = this.free[i + 1]!;
      if (cur.offset + cur.size === next.offset) {
        cur.size += next.size;
        this.free.splice(i + 1, 1);
      }
    }
    if (i > 0) {
      const prev = this.free[i - 1]!;
      const cur = this.free[i]!;
      if (prev.offset + prev.size === cur.offset) {
        prev.size += cur.size;
        this.free.splice(i, 1);
      }
    }
  }

  /** Extends capacity to `capacity` units; existing ranges keep their offsets. */
  grow(capacity: number): void {
    if (capacity <= this._capacity) return;
    this.release({ offset: this._capacity, size: capacity - this._capacity });
    this._used += capacity - this._capacity; // release() above counted the new space as freed
    this._capacity = capacity;
  }
}
