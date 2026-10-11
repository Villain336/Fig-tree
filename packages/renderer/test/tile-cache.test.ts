import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PendingTiles, tileViewbox, tilesForRect } from "../src/ported/penpot/tiles";
import { TILE_SIZE, TileCache, groupIntoRegions } from "../src/tile-cache";

describe("ported tile scheduling", () => {
  it("covers a pixel rect with the tiles it touches", () => {
    expect(tilesForRect(0, 0, 256, 256, 256)).toEqual({ x1: 0, y1: 0, x2: 0, y2: 0 });
    expect(tilesForRect(-1, 10, 257, 300, 256)).toEqual({ x1: -1, y1: 0, x2: 1, y2: 1 });
  });

  it("orders visible tiles from the center and defers the interest ring", () => {
    const pending = new PendingTiles();
    const vb = tileViewbox({ x1: 0, y1: 0, x2: 4, y2: 2 }, 1);
    pending.update(vb, () => false, false);
    expect(pending.visibleUncached).toHaveLength(15);
    expect(pending.visibleUncached[0]).toEqual({ x: 2, y: 1 });
    expect(pending.deferredInterest).toHaveLength(7 * 5 - 15);
    pending.update(vb, (t) => t.x === 2, true);
    expect(pending.visibleUncached).toHaveLength(12);
    expect(pending.deferredInterest).toHaveLength(0);
  });
});

describe("TileCache", () => {
  it("renders every visible tile once, then only tiles exposed by a pan", () => {
    const cache = new TileCache(64);
    const first = cache.schedule(0, 0, 600, 300, true);
    const rendered = (f: ReturnType<TileCache["schedule"]>): number => f.regions.reduce((n, r) => n + r.copies.length, 0);
    expect(rendered(first)).toBe(3 * 2);
    expect(first.regions).toHaveLength(1);
    expect(first.placements).toHaveLength(6);
    // Pan left by 200 px: grid pixels [200, 800) now show, exposing column 3.
    const panned = cache.schedule(-200, 0, 600, 300, true);
    expect(rendered(panned)).toBe(2);
    expect(panned.regions).toEqual([
      { x: 3 * TILE_SIZE, y: 0, width: TILE_SIZE, height: 2 * TILE_SIZE, copies: expect.any(Array) },
    ]);
    // Placements follow the pan exactly.
    expect(panned.placements.find((p) => p.x === -200 && p.y === 0)).toBeDefined();
  });

  it("pre-renders interest tiles only while the view is idle", () => {
    const cache = new TileCache(64);
    cache.schedule(0, 0, 512, 512, true);
    expect(cache.schedule(0, 0, 512, 512, true).regions).toEqual([]);
    const idle = cache.schedule(0, 0, 512, 512, false);
    expect(idle.regions.length).toBeGreaterThan(0);
    expect(idle.placements).toHaveLength(4);
  });

  it("evicts least recently used off-screen tiles when full, never visible ones", () => {
    const cache = new TileCache(8);
    cache.schedule(0, 0, 512, 512, true);
    for (let x = 1; x <= 6; x++) cache.schedule(-x * TILE_SIZE, 0, 512, 512, true);
    expect(cache.size).toBeLessThanOrEqual(8);
    const back = cache.schedule(-6 * TILE_SIZE, 0, 512, 512, true);
    expect(back.regions).toEqual([]);
    expect(back.placements).toHaveLength(4);
  });

  it("forgets everything on invalidate", () => {
    const cache = new TileCache(16);
    cache.schedule(0, 0, 300, 300, true);
    cache.invalidate();
    expect(cache.size).toBe(0);
    expect(cache.schedule(0, 0, 300, 300, true).regions[0]!.copies).toHaveLength(4);
  });
});

describe("groupIntoRegions", () => {
  it("covers exactly the given tiles with rectangles", () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.tuple(fc.integer({ min: -3, max: 3 }), fc.integer({ min: -3, max: 3 })), { selector: (t) => `${t[0]},${t[1]}` }), (cells) => {
        const tiles = cells.map(([x, y], slot) => ({ tile: { x, y }, slot }));
        const regions = groupIntoRegions(tiles);
        const covered = new Set<string>();
        for (const r of regions) {
          if (r.copies.length * TILE_SIZE * TILE_SIZE !== r.width * r.height) return false; // full rectangles only
          for (const c of r.copies) {
            const key = `${(r.x + c.dx) / TILE_SIZE},${(r.y + c.dy) / TILE_SIZE}`;
            if (covered.has(key)) return false;
            covered.add(key);
            if (tiles.find((t) => `${t.tile.x},${t.tile.y}` === key)?.slot !== c.slot) return false;
          }
        }
        return covered.size === tiles.length;
      }),
    );
  });

  it("merges an L-shaped band into two regions", () => {
    const tiles = [
      ...[0, 1, 2].map((y) => ({ tile: { x: 3, y }, slot: y })),
      ...[0, 1, 2].map((x) => ({ tile: { x, y: 3 }, slot: 10 + x })),
      { tile: { x: 3, y: 3 }, slot: 20 },
    ];
    expect(groupIntoRegions(tiles)).toHaveLength(2);
  });
});
