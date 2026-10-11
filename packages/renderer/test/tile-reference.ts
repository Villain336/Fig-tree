/**
 * A line-for-line TypeScript mirror of the WebGPU binning (`bin.wgsl`) and
 * coverage (`coverage.wgsl`) passes, used to property-test the tiling math
 * against exact per-pixel polygon clipping. Keep the two in sync.
 */
export const TILE = 16;
const NO_EDGE = 1e9;

export interface Piece {
  x0: number; y0: number; x1: number; y1: number;
  yEdge: number;
  edgeDelta: number;
}

export interface TileGrid {
  /** Bounding box in tiles: [tx0, ty0, tx1, ty1), relative to the tile grid origin. */
  tx0: number; ty0: number; tx1: number; ty1: number;
  pieces: Piece[][];
  delta: number[];
}

export function makeGrid(tx0: number, ty0: number, tx1: number, ty1: number): TileGrid {
  const n = (tx1 - tx0) * (ty1 - ty0);
  return { tx0, ty0, tx1, ty1, pieces: Array.from({ length: n }, () => []), delta: new Array<number>(n).fill(0) };
}

const f = Math.fround;

function pointAtX(ax: number, ay: number, bx: number, by: number, x: number): [number, number] {
  const t = f(f(x - ax) / f(bx - ax));
  return [x, f(ay + f(t * f(by - ay)))];
}

function pointAtY(ax: number, ay: number, bx: number, by: number, y: number): [number, number] {
  const t = f(f(y - ay) / f(by - ay));
  return [f(ax + f(t * f(bx - ax))), y];
}

export function binSegment(g: TileGrid, ax: number, ay: number, bx: number, by: number): void {
  const bx0 = f(g.tx0 * TILE), by0 = f(g.ty0 * TILE), bx1 = f(g.tx1 * TILE), by1 = f(g.ty1 * TILE);
  ax = f(ax); ay = f(ay); bx = f(bx); by = f(by);
  if (Math.max(ay, by) <= by0 || Math.min(ay, by) >= by1) return;
  if (Math.min(ax, bx) >= bx1) return;
  if (ay !== by) {
    if (ay < by0) [ax, ay] = pointAtY(ax, ay, bx, by, by0);
    else if (ay > by1) [ax, ay] = pointAtY(ax, ay, bx, by, by1);
    if (by < by0) [bx, by] = pointAtY(ax, ay, bx, by, by0);
    else if (by > by1) [bx, by] = pointAtY(ax, ay, bx, by, by1);
    // A sliver clipped flat onto the box edge has no effect.
    if (ay === by) return;
  }
  if (Math.min(ax, bx) >= bx1) return;
  if (ax > bx1) [ax, ay] = pointAtX(ax, ay, bx, by, bx1);
  else if (bx > bx1) [bx, by] = pointAtX(ax, ay, bx, by, bx1);
  if (Math.max(ax, bx) <= bx0) {
    emitPart(g, bx0, ay, bx0, by);
  } else if (Math.min(ax, bx) < bx0) {
    const [mx, my] = pointAtX(ax, ay, bx, by, bx0);
    if (ax < bx0) {
      emitPart(g, bx0, ay, mx, my);
      emitPart(g, mx, my, bx, by);
    } else {
      emitPart(g, ax, ay, mx, my);
      emitPart(g, mx, my, bx0, by);
    }
  } else {
    emitPart(g, ax, ay, bx, by);
  }
}

function emitPart(g: TileGrid, ax: number, ay: number, bx: number, by: number): void {
  if (ax === bx && ay === by) return;
  const by0 = f(g.ty0 * TILE);
  const bh = g.ty1 - g.ty0;
  const dir = by > ay ? 1 : by < ay ? -1 : 0;
  const flipped = by < ay;
  const [px, py, qx, qy] = flipped ? [bx, by, ax, ay] : [ax, ay, bx, by];
  const r0 = clampI(Math.floor(f(py - by0) / TILE), 0, bh - 1);
  let r1 = r0;
  if (qy > py) {
    const fr = f(qy - by0) / TILE;
    r1 = Math.floor(fr);
    if (fr === r1) r1 -= 1;
    r1 = clampI(r1, 0, bh - 1);
  }
  for (let r = r0; r <= r1; r++) {
    const y0 = f(by0 + r * TILE);
    const [sx, sy] = r === r0 ? [px, py] : pointAtY(px, py, qx, qy, y0);
    const [ex, ey] = r === r1 ? [qx, qy] : pointAtY(px, py, qx, qy, f(y0 + TILE));
    if (dir !== 0 && sy === ey) continue;
    walkColumns(g, sx, sy, ex, ey, r, y0, dir !== 0 && sy === y0 ? dir : 0, flipped);
  }
}

function walkColumns(
  g: TileGrid, sx: number, sy: number, ex: number, ey: number, r: number, y0: number, topCrossing: number, flipped: boolean,
): void {
  const bx0 = f(g.tx0 * TILE);
  const bw = g.tx1 - g.tx0;
  const dx = ex - sx;
  const fs = f(sx - bx0) / TILE;
  const fe = f(ex - bx0) / TILE;
  let cs = Math.floor(fs);
  let ce = Math.floor(fe);
  if (dx > 0 && fe === ce) ce -= 1;
  if (dx < 0 && fs === cs) cs -= 1;
  // A vertical piece on an interior column line belongs to the column on its
  // left (at local x = 16, where it covers nothing), so every move between
  // "left of" and "inside" a column shows up as a piece endpoint at that
  // column's local x = 0. On the box's left edge it stays in column 0, where
  // geometry left of the box is projected.
  if (dx === 0) {
    if (fs === cs && cs > 0) cs -= 1;
    ce = cs;
  }
  cs = clampI(cs, 0, bw - 1);
  ce = clampI(ce, 0, bw - 1);
  const step = ce >= cs ? 1 : -1;
  let cx = sx, cy = sy;
  // The band-top crossing belongs to the first column whose piece leaves the
  // top line; pieces lying on it are covered by the same backdrop decision.
  let pending = topCrossing;
  for (let c = cs; ; c += step) {
    const x0 = f(bx0 + c * TILE);
    let nx = ex, ny = ey;
    if (c !== ce) [nx, ny] = pointAtX(sx, sy, ex, ey, dx > 0 ? f(x0 + TILE) : x0);
    const tile = r * bw + c;
    if (pending !== 0 && ny > y0) {
      g.delta[tile]! += pending;
      pending = 0;
    }
    const [ux, uy, vx, vy] = flipped ? [nx, ny, cx, cy] : [cx, cy, nx, ny];
    const piece: Piece = {
      x0: f(ux - x0), y0: f(uy - y0), x1: f(vx - x0), y1: f(vy - y0), yEdge: NO_EDGE, edgeDelta: 0,
    };
    if (c > 0) {
      if (piece.x0 === 0 && piece.x1 > 0 && piece.y0 > 0) {
        piece.yEdge = piece.y0;
        piece.edgeDelta = -1;
      } else if (piece.x1 === 0 && piece.x0 > 0 && piece.y1 > 0) {
        piece.yEdge = piece.y1;
        piece.edgeDelta = 1;
      }
    }
    g.pieces[tile]!.push(piece);
    cx = nx;
    cy = ny;
    if (c === ce) break;
  }
}

function clampI(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Exclusive prefix sum of the per-tile top-edge crossings along each row. */
export function backdrops(g: TileGrid): number[] {
  const bw = g.tx1 - g.tx0;
  const out = new Array<number>(g.delta.length).fill(0);
  for (let r = 0; r < g.ty1 - g.ty0; r++) {
    let acc = 0;
    for (let c = 0; c < bw; c++) {
      out[r * bw + c] = acc;
      acc += g.delta[r * bw + c]!;
    }
  }
  return out;
}

/** Signed area of the winding number over local pixel (px, py) of a tile. */
export function pixelArea(pieces: readonly Piece[], backdrop: number, px: number, py: number): number {
  let area = backdrop;
  for (const p of pieces) {
    if (p.yEdge < NO_EDGE) area += p.edgeDelta * clamp01(py + 1 - p.yEdge);
    if (p.y0 === p.y1) continue;
    const inv = 1 / (p.y1 - p.y0);
    const ta = (py - p.y0) * inv;
    const tb = (py + 1 - p.y0) * inv;
    const t0 = clamp01(Math.min(ta, tb));
    const t1 = clamp01(Math.max(ta, tb));
    if (t1 <= t0) continue;
    const xa = p.x0 + t0 * (p.x1 - p.x0);
    const xb = p.x0 + t1 * (p.x1 - p.x0);
    area += (t1 - t0) * (p.y1 - p.y0) * coverRight(xa, xb, px);
  }
  return area;
}

/** Mean over the edge's x span of the fraction of pixel [px, px+1] right of x. */
function coverRight(xa: number, xb: number, px: number): number {
  if (Math.abs(xb - xa) < 1e-3) return clamp01(px + 1 - (xa + xb) / 2);
  return (antiderivative(xb - px) - antiderivative(xa - px)) / (xb - xa);
}

function antiderivative(u: number): number {
  if (u <= 0) return u;
  if (u >= 1) return 0.5;
  return u - (u * u) / 2;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
