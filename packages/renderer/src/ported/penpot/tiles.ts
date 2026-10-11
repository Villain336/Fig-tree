/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) KALEIDOS SUBSIDIARY SL
 * Copyright (c) Fig Tree contributors (TypeScript port and changes)
 *
 * Ported from penpot/render-wasm/src/tiles.rs @5eb33ad
 *
 * Changes from the original: tiles are addressed in device pixels of a grid
 * anchored at the world origin (the caller supplies the visible pixel rect),
 * cache lookups go through a predicate instead of Skia surfaces, and the
 * Skia-specific atlas helpers are not ported.
 */

/** A cell of the screen-space tile grid. */
export interface Tile {
  readonly x: number;
  readonly y: number;
}

/** Inclusive rectangle of tiles: both corners are part of the rect. */
export interface TileRect {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export function tileKey(t: Tile): string {
  return `${t.x},${t.y}`;
}

export function tileRectContains(r: TileRect, t: Tile): boolean {
  return t.x >= r.x1 && t.y >= r.y1 && t.x <= r.x2 && t.y <= r.y2;
}

export function tileRectTiles(r: TileRect): Tile[] {
  const out: Tile[] = [];
  for (let y = r.y1; y <= r.y2; y++) for (let x = r.x1; x <= r.x2; x++) out.push({ x, y });
  return out;
}

/** Tiles covering the half-open pixel rect [x0, x1) x [y0, y1). */
export function tilesForRect(x0: number, y0: number, x1: number, y1: number, tileSize: number): TileRect {
  return {
    x1: Math.floor(x0 / tileSize),
    y1: Math.floor(y0 / tileSize),
    x2: Math.ceil(x1 / tileSize) - 1,
    y2: Math.ceil(y1 / tileSize) - 1,
  };
}

/** The visible tiles plus an "interest" ring of `interest` tiles around them, for pre-rendering. */
export interface TileViewbox {
  readonly visible: TileRect;
  readonly interest: TileRect;
}

export function tileViewbox(visible: TileRect, interest: number): TileViewbox {
  return {
    visible,
    interest: { x1: visible.x1 - interest, y1: visible.y1 - interest, x2: visible.x2 + interest, y2: visible.y2 + interest },
  };
}

/**
 * Tiles still to render, in priority order. Visible tiles come first,
 * ordered from the center outwards so the middle of the screen fills in
 * first; interest-ring tiles are deferred until the viewport is complete and
 * skipped entirely during interaction (`onlyVisible`).
 */
export class PendingTiles {
  /** Uncached visible tiles, closest to the center first. */
  visibleUncached: Tile[] = [];
  /** Interest-ring tiles not yet cached, closest first; rendered after the viewport. */
  deferredInterest: Tile[] = [];

  update(viewbox: TileViewbox, isCached: (t: Tile) => boolean, onlyVisible: boolean): void {
    const rect = onlyVisible ? viewbox.visible : viewbox.interest;
    const cx = Math.floor((rect.x1 + rect.x2) / 2);
    const cy = Math.floor((rect.y1 + rect.y2) / 2);
    const ordered = tileRectTiles(rect)
      .map((t) => ({ t, d: (t.x - cx) ** 2 + (t.y - cy) ** 2 }))
      .sort((a, b) => a.d - b.d)
      .map((o) => o.t);
    this.visibleUncached = [];
    this.deferredInterest = [];
    for (const t of ordered) {
      if (isCached(t)) continue;
      if (tileRectContains(viewbox.visible, t)) this.visibleUncached.push(t);
      else this.deferredInterest.push(t);
    }
  }
}
