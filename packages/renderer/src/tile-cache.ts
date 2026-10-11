import {
  PendingTiles,
  tileKey,
  tileRectTiles,
  tileViewbox,
  tilesForRect,
  type Tile,
} from "./ported/penpot/tiles";

/** Tile edge in device pixels. Small enough that a pan exposes little new area. */
export const TILE_SIZE = 256;
/** Backends keep tiles in a square atlas texture of this many slots per row (16 x 256 px = 4096 px). */
export const ATLAS_SLOTS_PER_ROW = 16;
export const ATLAS_SLOTS = ATLAS_SLOTS_PER_ROW * ATLAS_SLOTS_PER_ROW;
/** Rings of off-screen tiles pre-rendered while the view is idle. */
const INTEREST = 1;
/** Interest tiles rendered per idle frame, so pre-rendering never stalls a frame. */
const PREFETCH_PER_FRAME = 4;

/** Top-left pixel of an atlas slot. */
export function slotOrigin(slot: number): { x: number; y: number } {
  return { x: (slot % ATLAS_SLOTS_PER_ROW) * TILE_SIZE, y: Math.floor(slot / ATLAS_SLOTS_PER_ROW) * TILE_SIZE };
}

/** Where a cached tile lands on screen (device px, top-left). */
export interface TilePlacement {
  readonly slot: number;
  readonly x: number;
  readonly y: number;
}

/**
 * One rectangle of the tile grid to rasterize this frame. `x, y` is its
 * top-left in grid pixels; each copy moves one tile from the rendered
 * rectangle (at `dx, dy`) into its cache slot.
 */
export interface TileRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly copies: readonly { readonly slot: number; readonly dx: number; readonly dy: number }[];
}

export interface TileFrame {
  readonly regions: readonly TileRegion[];
  readonly placements: readonly TilePlacement[];
}

/**
 * Screen-space tile cache for one zoom level. The grid is anchored at the
 * world origin in device pixels, so panning (by whole device pixels) maps
 * every cached tile to a new screen position without re-rendering it; only
 * tiles that scroll into view are rasterized.
 */
export class TileCache {
  private readonly slotOf = new Map<string, number>();
  private readonly tileOfSlot = new Map<number, Tile>();
  private readonly lastUsed = new Map<number, number>();
  private readonly free: number[];
  private readonly pending = new PendingTiles();
  private frame = 0;

  constructor(readonly capacity: number) {
    this.free = Array.from({ length: capacity }, (_, i) => capacity - 1 - i);
  }

  get size(): number {
    return this.slotOf.size;
  }

  invalidate(): void {
    for (const slot of this.slotOf.values()) this.free.push(slot);
    this.slotOf.clear();
    this.tileOfSlot.clear();
    this.lastUsed.clear();
  }

  /**
   * Plans a frame whose grid pixel (0, 0) sits at device (originX, originY)
   * on a width x height screen. While the view is moving, only visible tiles
   * are rendered; when idle, a few interest-ring tiles are pre-rendered.
   */
  schedule(originX: number, originY: number, width: number, height: number, viewMoving: boolean): TileFrame {
    this.frame++;
    const visible = tilesForRect(-originX, -originY, width - originX, height - originY, TILE_SIZE);
    const viewbox = tileViewbox(visible, INTEREST);
    this.pending.update(viewbox, (t) => this.slotOf.has(tileKey(t)), viewMoving);
    const visibleTiles = tileRectTiles(visible);
    for (const t of visibleTiles) {
      const slot = this.slotOf.get(tileKey(t));
      if (slot !== undefined) this.lastUsed.set(slot, this.frame);
    }
    let toRender = this.pending.visibleUncached;
    if (toRender.length === 0 && !viewMoving) toRender = prefetchStrip(this.pending.deferredInterest);
    const protectedKeys = new Set(visibleTiles.map(tileKey));
    const assigned: { tile: Tile; slot: number }[] = [];
    for (const tile of toRender) {
      const slot = this.allocate(protectedKeys);
      if (slot === null) break;
      this.slotOf.set(tileKey(tile), slot);
      this.tileOfSlot.set(slot, tile);
      this.lastUsed.set(slot, this.frame);
      protectedKeys.add(tileKey(tile));
      assigned.push({ tile, slot });
    }
    const placements = visibleTiles.flatMap((t) => {
      const slot = this.slotOf.get(tileKey(t));
      return slot === undefined ? [] : [{ slot, x: originX + t.x * TILE_SIZE, y: originY + t.y * TILE_SIZE }];
    });
    return { regions: groupIntoRegions(assigned), placements };
  }

  /** A free slot, evicting the least recently used tile that is not protected. */
  private allocate(protectedKeys: ReadonlySet<string>): number | null {
    const slot = this.free.pop();
    if (slot !== undefined) return slot;
    let victim: number | null = null;
    let oldest = Infinity;
    for (const [s, used] of this.lastUsed) {
      const tile = this.tileOfSlot.get(s)!;
      if (used < oldest && !protectedKeys.has(tileKey(tile))) {
        oldest = used;
        victim = s;
      }
    }
    if (victim === null) return null;
    this.slotOf.delete(tileKey(this.tileOfSlot.get(victim)!));
    this.tileOfSlot.delete(victim);
    this.lastUsed.delete(victim);
    return victim;
  }
}

/** Up to PREFETCH_PER_FRAME deferred tiles from the same row or column as the closest one. */
function prefetchStrip(deferred: readonly Tile[]): Tile[] {
  const first = deferred[0];
  if (!first) return [];
  const row = deferred.filter((t) => t.y === first.y);
  const column = deferred.filter((t) => t.x === first.x);
  const strip = row.length >= column.length ? row : column;
  return strip.slice(0, PREFETCH_PER_FRAME);
}

/**
 * Covers the tiles with few rectangles: horizontal runs per row, merged with
 * identical runs in the rows below. A column band or a full screen becomes
 * one region; an L-shaped band after a diagonal pan becomes two.
 */
export function groupIntoRegions(tiles: readonly { tile: Tile; slot: number }[]): TileRegion[] {
  const byRow = new Map<number, { tile: Tile; slot: number }[]>();
  for (const t of tiles) {
    const row = byRow.get(t.tile.y) ?? [];
    row.push(t);
    byRow.set(t.tile.y, row);
  }
  interface Run { x1: number; x2: number; y1: number; y2: number; members: { tile: Tile; slot: number }[] }
  const open = new Map<string, Run>();
  const done: Run[] = [];
  for (const y of [...byRow.keys()].sort((a, b) => a - b)) {
    const row = byRow.get(y)!.sort((a, b) => a.tile.x - b.tile.x);
    const runs: Run[] = [];
    for (const t of row) {
      const last = runs.at(-1);
      if (last && last.x2 === t.tile.x - 1) {
        last.x2 = t.tile.x;
        last.members.push(t);
      } else {
        runs.push({ x1: t.tile.x, x2: t.tile.x, y1: y, y2: y, members: [t] });
      }
    }
    const next = new Map<string, Run>();
    for (const run of runs) {
      const key = `${run.x1}:${run.x2}`;
      const above = open.get(key);
      if (above && above.y2 === y - 1) {
        above.y2 = y;
        above.members.push(...run.members);
        next.set(key, above);
        open.delete(key);
      } else {
        next.set(key, run);
      }
    }
    for (const run of open.values()) done.push(run);
    open.clear();
    for (const [k, v] of next) open.set(k, v);
  }
  done.push(...open.values());
  return done.map((r) => ({
    x: r.x1 * TILE_SIZE,
    y: r.y1 * TILE_SIZE,
    width: (r.x2 - r.x1 + 1) * TILE_SIZE,
    height: (r.y2 - r.y1 + 1) * TILE_SIZE,
    copies: r.members.map((m) => ({ slot: m.slot, dx: (m.tile.x - r.x1) * TILE_SIZE, dy: (m.tile.y - r.y1) * TILE_SIZE })),
  }));
}
