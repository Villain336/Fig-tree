/**
 * WGSL for the tiled analytic-coverage rasterizer. Frame pipeline:
 *
 *   bin        one thread per line segment: transform to device space, clip
 *              to the entry's tile box, split into per-tile pieces (linked
 *              lists) and record top-edge crossings for backdrops.
 *   tiles      one thread per (entry, tile row): prefix-sum backdrops,
 *              allocate coverage masks for tiles with pieces, and set the
 *              entry's bit in each screen tile's z-ordered bitmap.
 *   lists      one thread per screen tile: scan the bitmap once and write a
 *              compact, ordered entry list, starting at the topmost opaque
 *              fill that covers the whole tile (everything below is hidden).
 *   indirect   size the coverage dispatch from the GPU-side mask count.
 *   coverage   one workgroup per edge tile: exact signed-area coverage per
 *              pixel, fill rule applied, packed to 8-bit masks.
 *   composite  one workgroup per 16x16 screen tile: walk the tile's list in
 *              paint order, evaluate paints and blend premultiplied, with a
 *              small register stack for clip/opacity layers.
 *
 * `packages/renderer/test/tile-reference.ts` mirrors `bin` and `coverage` in
 * TypeScript and is property-tested against exact polygon clipping.
 */

import { blendWgsl, imageWgsl, noiseWgsl, shaderLibWgsl } from "../shaders/wgsl";

const common = /* wgsl */ `
const TILE: f32 = 16.0;
const NO_EDGE: f32 = 1e9;
const KIND_FILL: u32 = 0u;
const KIND_BEGIN: u32 = 1u;
const KIND_END: u32 = 2u;
const FLAG_EVENODD: u32 = 4u;
const FLAG_CLIP: u32 = 8u;
const FLAG_OPAQUE: u32 = 16u;
const FLAG_GLYPHS: u32 = 32u;
const FLAG_TEXTURE: u32 = 64u;
const FLAG_SHAPE: u32 = 128u;
const FLAG_BACKDROP: u32 = 256u;
const NO_EXTRAS: u32 = 0xffffffffu;
const MODE_GROUP: u32 = 0u;
const MODE_CLIP: u32 = 1u;
const MODE_MASK_GROUP: u32 = 2u;
const MODE_MASK_SOURCE: u32 = 3u;

fn blendOf(flags: u32) -> u32 { return (flags >> 10u) & 31u; }
fn layerModeOf(flags: u32) -> u32 { return (flags >> 16u) & 7u; }
fn maskTypeOf(flags: u32) -> u32 { return (flags >> 19u) & 3u; }

struct Config {
  viewport: vec2<u32>,
  tiles: vec2<u32>,
  entryCount: u32,
  chunkCount: u32,
  segmentTotal: u32,
  rowTotal: u32,
  pieceCapacity: u32,
  maskCapacity: u32,
  firstPass: u32,
  // Index of this pass's first entry tile in the frame-wide glyph tile lists.
  glyphBase: u32,
  background: vec4<f32>,
  time: f32,
  _c0: f32,
  _c1: f32,
  _c2: f32,
}

struct Entry {
  m: vec4<f32>,
  t: vec2<f32>,
  flags: u32,
  paint: u32,
  bbox: vec4<u32>,
  tileOffset: u32,
  segPrefix: u32,
  rowPrefix: u32,
  opacity: f32,
  segBase: u32,
  segCount: u32,
  _pad0: u32,
  // Index of the entry's words in frameData (textures, backdrops, images), or NO_EXTRAS.
  extras: u32,
}

struct Piece {
  p: vec4<f32>,
  yEdge: f32,
  edgeDelta: f32,
  next: u32,
  _pad: u32,
}
`;

export const binShader = /* wgsl */ `
${common}
struct PathTile {
  head: atomic<u32>,
  delta: atomic<i32>,
  backdrop: i32,
  mask: u32,
}

struct Counters {
  pieces: atomic<u32>,
  edgeTiles: atomic<u32>,
  overflow: atomic<u32>,
  lists: u32,
}

@group(0) @binding(0) var<uniform> config: Config;
@group(0) @binding(1) var<storage, read> entries: array<Entry>;
@group(0) @binding(2) var<storage, read> segments: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> tiles: array<PathTile>;
@group(0) @binding(4) var<storage, read_write> pieces: array<Piece>;
@group(0) @binding(5) var<storage, read_write> counters: Counters;

// Per-invocation copy of the entry's tile box.
var<private> boxX0: f32;
var<private> boxY0: f32;
var<private> boxX1: f32;
var<private> boxY1: f32;
var<private> boxW: i32;
var<private> boxH: i32;
var<private> tileBase: u32;

fn findEntry(i: u32) -> u32 {
  // Largest entry whose segment prefix is <= i (entries with no segments share
  // their successor's prefix and are skipped by taking the largest).
  var lo = 0u;
  var hi = config.entryCount - 1u;
  loop {
    if (lo >= hi) { break; }
    let mid = (lo + hi + 1u) / 2u;
    if (entries[mid].segPrefix <= i) { lo = mid; } else { hi = mid - 1u; }
  }
  return lo;
}

fn atX(a: vec2<f32>, b: vec2<f32>, x: f32) -> vec2<f32> {
  let t = (x - a.x) / (b.x - a.x);
  return vec2<f32>(x, a.y + t * (b.y - a.y));
}

fn atY(a: vec2<f32>, b: vec2<f32>, y: f32) -> vec2<f32> {
  let t = (y - a.y) / (b.y - a.y);
  return vec2<f32>(a.x + t * (b.x - a.x), y);
}

fn pushPiece(tile: u32, u: vec2<f32>, v: vec2<f32>, column: i32) {
  var yEdge = NO_EDGE;
  var edgeDelta = 0.0;
  if (column > 0) {
    if (u.x == 0.0 && v.x > 0.0 && u.y > 0.0) {
      yEdge = u.y;
      edgeDelta = -1.0;
    } else if (v.x == 0.0 && u.x > 0.0 && v.y > 0.0) {
      yEdge = v.y;
      edgeDelta = 1.0;
    }
  }
  let slot = atomicAdd(&counters.pieces, 1u);
  if (slot >= config.pieceCapacity) {
    atomicOr(&counters.overflow, 1u);
    return;
  }
  let prev = atomicExchange(&tiles[tile].head, slot + 1u);
  pieces[slot] = Piece(vec4<f32>(u, v), yEdge, edgeDelta, prev, 0u);
}

fn walkColumns(s: vec2<f32>, e: vec2<f32>, row: i32, y0: f32, topCrossing: i32, flipped: bool) {
  let dx = e.x - s.x;
  let fs = (s.x - boxX0) / TILE;
  let fe = (e.x - boxX0) / TILE;
  var cs = i32(floor(fs));
  var ce = i32(floor(fe));
  if (dx > 0.0 && fe == f32(ce)) { ce -= 1; }
  if (dx < 0.0 && fs == f32(cs)) { cs -= 1; }
  if (dx == 0.0) {
    // Vertical pieces on an interior column line belong to the column on
    // their left; see tile-reference.ts for why.
    if (fs == f32(cs) && cs > 0) { cs -= 1; }
    ce = cs;
  }
  cs = clamp(cs, 0, boxW - 1);
  ce = clamp(ce, 0, boxW - 1);
  let dirStep = select(-1, 1, ce >= cs);
  var cur = s;
  var pending = topCrossing;
  var c = cs;
  loop {
    let x0 = boxX0 + f32(c) * TILE;
    var nxt = e;
    if (c != ce) { nxt = atX(s, e, select(x0, x0 + TILE, dx > 0.0)); }
    let tile = tileBase + u32(row * boxW + c);
    if (pending != 0 && nxt.y > y0) {
      atomicAdd(&tiles[tile].delta, pending);
      pending = 0;
    }
    let origin = vec2<f32>(x0, y0);
    if (flipped) {
      pushPiece(tile, nxt - origin, cur - origin, c);
    } else {
      pushPiece(tile, cur - origin, nxt - origin, c);
    }
    cur = nxt;
    if (c == ce) { break; }
    c += dirStep;
  }
}

fn emitPart(a: vec2<f32>, b: vec2<f32>) {
  if (a.x == b.x && a.y == b.y) { return; }
  var dir = 0;
  if (b.y > a.y) { dir = 1; } else if (b.y < a.y) { dir = -1; }
  let flipped = b.y < a.y;
  let p = select(a, b, flipped);
  let q = select(b, a, flipped);
  let r0 = clamp(i32(floor((p.y - boxY0) / TILE)), 0, boxH - 1);
  var r1 = r0;
  if (q.y > p.y) {
    let fr = (q.y - boxY0) / TILE;
    r1 = i32(floor(fr));
    if (fr == f32(r1)) { r1 -= 1; }
    r1 = clamp(r1, 0, boxH - 1);
  }
  for (var r = r0; r <= r1; r++) {
    let y0 = boxY0 + f32(r) * TILE;
    var s = p;
    var e = q;
    if (r != r0) { s = atY(p, q, y0); }
    if (r != r1) { e = atY(p, q, y0 + TILE); }
    if (dir != 0 && s.y == e.y) { continue; }
    var top = 0;
    if (dir != 0 && s.y == y0) { top = dir; }
    walkColumns(s, e, r, y0, top, flipped);
  }
}

fn binSegment(a0: vec2<f32>, b0: vec2<f32>) {
  var a = a0;
  var b = b0;
  if (max(a.y, b.y) <= boxY0 || min(a.y, b.y) >= boxY1) { return; }
  if (min(a.x, b.x) >= boxX1) { return; }
  if (a.y != b.y) {
    if (a.y < boxY0) { a = atY(a, b, boxY0); } else if (a.y > boxY1) { a = atY(a, b, boxY1); }
    if (b.y < boxY0) { b = atY(a, b, boxY0); } else if (b.y > boxY1) { b = atY(a, b, boxY1); }
    if (a.y == b.y) { return; }
  }
  if (min(a.x, b.x) >= boxX1) { return; }
  if (a.x > boxX1) { a = atX(a, b, boxX1); } else if (b.x > boxX1) { b = atX(a, b, boxX1); }
  // Geometry left of the box only matters through its winding: project it
  // onto the box's left edge.
  if (max(a.x, b.x) <= boxX0) {
    emitPart(vec2<f32>(boxX0, a.y), vec2<f32>(boxX0, b.y));
  } else if (min(a.x, b.x) < boxX0) {
    let m = atX(a, b, boxX0);
    if (a.x < boxX0) {
      emitPart(vec2<f32>(boxX0, a.y), m);
      emitPart(m, b);
    } else {
      emitPart(a, m);
      emitPart(m, vec2<f32>(boxX0, b.y));
    }
  } else {
    emitPart(a, b);
  }
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let i = gid.x + gid.y * nwg.x * 256u;
  if (i >= config.segmentTotal) { return; }
  let e = entries[findEntry(i)];
  let seg = segments[e.segBase + (i - e.segPrefix)];
  let a = vec2<f32>(e.m.x * seg.x + e.m.z * seg.y + e.t.x, e.m.y * seg.x + e.m.w * seg.y + e.t.y);
  let b = vec2<f32>(e.m.x * seg.z + e.m.z * seg.w + e.t.x, e.m.y * seg.z + e.m.w * seg.w + e.t.y);
  boxX0 = f32(e.bbox.x) * TILE;
  boxY0 = f32(e.bbox.y) * TILE;
  boxX1 = f32(e.bbox.z) * TILE;
  boxY1 = f32(e.bbox.w) * TILE;
  boxW = i32(e.bbox.z - e.bbox.x);
  boxH = i32(e.bbox.w - e.bbox.y);
  tileBase = e.tileOffset;
  binSegment(a, b);
}
`;

export const tilesShader = /* wgsl */ `
${common}
struct PathTile {
  head: u32,
  delta: i32,
  backdrop: i32,
  mask: u32,
}

struct Counters {
  pieces: u32,
  edgeTiles: atomic<u32>,
  overflow: atomic<u32>,
  lists: u32,
}

@group(0) @binding(0) var<uniform> config: Config;
@group(0) @binding(1) var<storage, read> entries: array<Entry>;
@group(0) @binding(2) var<storage, read_write> tiles: array<PathTile>;
@group(0) @binding(3) var<storage, read_write> edgeTiles: array<vec2<u32>>;
@group(0) @binding(4) var<storage, read_write> bitmaps: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> counters: Counters;
// Glyph data: per entry tile of glyph entries (first ref word, ref count), then the refs.
@group(0) @binding(6) var<storage, read> glyphData: array<u32>;

fn findEntry(i: u32) -> u32 {
  var lo = 0u;
  var hi = config.entryCount - 1u;
  loop {
    if (lo >= hi) { break; }
    let mid = (lo + hi + 1u) / 2u;
    if (entries[mid].rowPrefix <= i) { lo = mid; } else { hi = mid - 1u; }
  }
  return lo;
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let i = gid.x + gid.y * nwg.x * 256u;
  if (i >= config.rowTotal) { return; }
  let ei = findEntry(i);
  let e = entries[ei];
  let row = i - e.rowPrefix;
  let bw = e.bbox.z - e.bbox.x;
  let kind = e.flags & 3u;
  let evenodd = (e.flags & FLAG_EVENODD) != 0u;
  let glyphs = (e.flags & FLAG_GLYPHS) != 0u;
  let texture = (e.flags & FLAG_TEXTURE) != 0u;
  let hasGeometry = (kind == KIND_FILL && !glyphs && !texture) || (e.flags & FLAG_CLIP) != 0u;
  let ty = e.bbox.y + row;
  let word = (ei >> 5u) & 7u;
  let chunk = ei >> 8u;
  let bit = 1u << (ei & 31u);
  var acc = 0;
  for (var c = 0u; c < bw; c++) {
    let ti = e.tileOffset + row * bw + c;
    let backdrop = acc;
    acc += tiles[ti].delta;
    tiles[ti].backdrop = backdrop;
    var mark = kind != KIND_FILL || texture;
    if (glyphs) {
      mark = glyphData[(config.glyphBase + ti) * 2u + 1u] > 0u;
    } else if (hasGeometry && tiles[ti].head != 0u) {
      let slot = atomicAdd(&counters.edgeTiles, 1u);
      if (slot < config.maskCapacity) {
        edgeTiles[slot] = vec2<u32>(ti, select(0u, 1u, evenodd));
        tiles[ti].mask = slot + 1u;
      } else {
        atomicOr(&counters.overflow, 2u);
      }
      mark = true;
    } else if (kind == KIND_FILL) {
      mark = select(backdrop != 0, (backdrop & 1) != 0, evenodd);
    }
    if (mark) {
      let screenTile = ty * config.tiles.x + e.bbox.x + c;
      atomicOr(&bitmaps[(screenTile * config.chunkCount + chunk) * 8u + word], bit);
    }
  }
}
`;

export const listsShader = /* wgsl */ `
${common}
struct PathTile {
  head: u32,
  delta: i32,
  backdrop: i32,
  mask: u32,
}

struct Counters {
  pieces: u32,
  edgeTiles: u32,
  overflow: u32,
  lists: atomic<u32>,
}

@group(0) @binding(0) var<uniform> config: Config;
@group(0) @binding(1) var<storage, read> entries: array<Entry>;
@group(0) @binding(2) var<storage, read> tiles: array<PathTile>;
@group(0) @binding(3) var<storage, read> bitmaps: array<u32>;
@group(0) @binding(4) var<storage, read_write> lists: array<u32>;
@group(0) @binding(5) var<storage, read_write> ranges: array<vec2<u32>>;
@group(0) @binding(6) var<storage, read_write> counters: Counters;

// True when entry ei is an opaque fill (flagged on the CPU, never inside a
// layer) that fully covers this tile, hiding everything painted before it.
fn occludes(ei: u32, tile: vec2<u32>) -> bool {
  let e = entries[ei];
  if ((e.flags & FLAG_OPAQUE) == 0u) { return false; }
  let t = tiles[e.tileOffset + (tile.y - e.bbox.y) * (e.bbox.z - e.bbox.x) + (tile.x - e.bbox.x)];
  return t.mask == 0u && select(t.backdrop != 0, (t.backdrop & 1) != 0, (e.flags & FLAG_EVENODD) != 0u);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let t = gid.x + gid.y * nwg.x * 64u;
  if (t >= config.tiles.x * config.tiles.y) { return; }
  let tile = vec2<u32>(t % config.tiles.x, t / config.tiles.x);
  let base = t * config.chunkCount * 8u;
  let words = config.chunkCount * 8u;
  var total = 0u;
  var count = 0u;
  for (var w = 0u; w < words; w++) {
    var bits = bitmaps[base + w];
    loop {
      if (bits == 0u) { break; }
      let ei = w * 32u + countTrailingZeros(bits);
      bits &= bits - 1u;
      if (occludes(ei, tile)) { count = 0u; }
      count++;
      total++;
    }
  }
  let offset = atomicAdd(&counters.lists, count);
  ranges[t] = vec2<u32>(offset, count);
  var seen = 0u;
  var n = 0u;
  for (var w = 0u; w < words; w++) {
    var bits = bitmaps[base + w];
    loop {
      if (bits == 0u) { break; }
      let ei = w * 32u + countTrailingZeros(bits);
      bits &= bits - 1u;
      if (seen >= total - count) {
        lists[offset + n] = ei;
        n++;
      }
      seen++;
    }
  }
}
`;

export const indirectShader = /* wgsl */ `
struct Config {
  viewport: vec2<u32>,
  tiles: vec2<u32>,
  entryCount: u32,
  chunkCount: u32,
  segmentTotal: u32,
  rowTotal: u32,
  pieceCapacity: u32,
  maskCapacity: u32,
  firstPass: u32,
  glyphBase: u32,
  background: vec4<f32>,
  time: f32,
  _c0: f32,
  _c1: f32,
  _c2: f32,
}
struct Counters {
  pieces: u32,
  edgeTiles: u32,
  overflow: u32,
  lists: u32,
}
@group(0) @binding(0) var<uniform> config: Config;
@group(0) @binding(1) var<storage, read> counters: Counters;
@group(0) @binding(2) var<storage, read_write> args: array<u32, 3>;

const MAX_X: u32 = 32768u;

@compute @workgroup_size(1)
fn main() {
  let n = min(counters.edgeTiles, config.maskCapacity);
  args[0] = min(n, MAX_X);
  args[1] = (n + MAX_X - 1u) / MAX_X;
  args[2] = 1u;
}
`;

export const coverageShader = /* wgsl */ `
${common}
struct PathTile {
  head: u32,
  delta: i32,
  backdrop: i32,
  mask: u32,
}

struct Counters {
  pieces: u32,
  edgeTiles: u32,
  overflow: u32,
  lists: u32,
}

@group(0) @binding(0) var<uniform> config: Config;
@group(0) @binding(1) var<storage, read> tiles: array<PathTile>;
@group(0) @binding(2) var<storage, read> pieces: array<Piece>;
@group(0) @binding(3) var<storage, read> edgeTiles: array<vec2<u32>>;
@group(0) @binding(4) var<storage, read> counters: Counters;
@group(0) @binding(5) var<storage, read_write> masks: array<u32>;

fn antiderivative(u: vec4<f32>) -> vec4<f32> {
  let c = clamp(u, vec4<f32>(0.0), vec4<f32>(1.0));
  // u for u <= 0; u - u^2/2 inside the pixel; 1/2 beyond it.
  return min(u, vec4<f32>(0.0)) + c - c * c * 0.5;
}

// Mean, over the edge's x span, of the fraction of each pixel right of the edge.
fn coverRight(xa: f32, xb: f32, px: vec4<f32>) -> vec4<f32> {
  if (abs(xb - xa) < 1e-3) {
    return clamp(px + 1.0 - 0.5 * (xa + xb), vec4<f32>(0.0), vec4<f32>(1.0));
  }
  return (antiderivative(xb - px) - antiderivative(xa - px)) / (xb - xa);
}

@compute @workgroup_size(64)
fn main(
  @builtin(workgroup_id) wid: vec3<u32>,
  @builtin(local_invocation_index) lid: u32,
  @builtin(num_workgroups) nwg: vec3<u32>,
) {
  let slot = wid.x + wid.y * nwg.x;
  if (slot >= min(counters.edgeTiles, config.maskCapacity)) { return; }
  let et = edgeTiles[slot];
  let tile = tiles[et.x];
  // Each invocation shades four horizontally adjacent pixels of one row.
  let py = f32(lid / 4u);
  let px0 = f32((lid % 4u) * 4u);
  let px = vec4<f32>(px0, px0 + 1.0, px0 + 2.0, px0 + 3.0);
  var area = vec4<f32>(f32(tile.backdrop));
  var cursor = tile.head;
  loop {
    if (cursor == 0u) { break; }
    let pc = pieces[cursor - 1u];
    cursor = pc.next;
    if (pc.yEdge < NO_EDGE) {
      area += pc.edgeDelta * clamp(py + 1.0 - pc.yEdge, 0.0, 1.0);
    }
    let p = pc.p;
    if (p.y == p.w) { continue; }
    let inv = 1.0 / (p.w - p.y);
    let ta = (py - p.y) * inv;
    let tb = (py + 1.0 - p.y) * inv;
    let t0 = clamp(min(ta, tb), 0.0, 1.0);
    let t1 = clamp(max(ta, tb), 0.0, 1.0);
    if (t1 <= t0) { continue; }
    let xa = p.x + t0 * (p.z - p.x);
    let xb = p.x + t1 * (p.z - p.x);
    area += (t1 - t0) * (p.w - p.y) * coverRight(xa, xb, px);
  }
  var cov: vec4<f32>;
  if (et.y == 1u) {
    let a = abs(area) - 2.0 * floor(abs(area) * 0.5);
    cov = min(a, 2.0 - a);
  } else {
    cov = min(abs(area), vec4<f32>(1.0));
  }
  let q = vec4<u32>(round(clamp(cov, vec4<f32>(0.0), vec4<f32>(1.0)) * 255.0));
  masks[slot * 64u + lid] = q.x | (q.y << 8u) | (q.z << 16u) | (q.w << 24u);
}
`;

export const compositeShader = /* wgsl */ `
${common}
struct PathTile {
  head: u32,
  delta: i32,
  backdrop: i32,
  mask: u32,
}

struct Paint {
  kind: u32,
  stopOffset: u32,
  stopCount: u32,
  _pad: u32,
  color: vec4<f32>,
  m: vec4<f32>,
  mt: vec4<f32>,
}

const MAX_DEPTH: u32 = 8u;
const PAINT_SOLID: u32 = 0u;
const PAINT_LINEAR: u32 = 1u;
const PAINT_RADIAL: u32 = 2u;
const PAINT_ANGULAR: u32 = 3u;
const PAINT_DIAMOND: u32 = 4u;
const PAINT_IMAGE: u32 = 5u;
const PAINT_SHADER: u32 = 6u;

@group(0) @binding(0) var<uniform> config: Config;
@group(0) @binding(1) var<storage, read> entries: array<Entry>;
@group(0) @binding(2) var<storage, read> tiles: array<PathTile>;
@group(0) @binding(3) var<storage, read> masks: array<u32>;
@group(0) @binding(4) var<storage, read> lists: array<u32>;
@group(0) @binding(5) var<storage, read> ranges: array<vec2<u32>>;
@group(0) @binding(6) var<storage, read> paints: array<Paint>;
@group(0) @binding(7) var<storage, read> stops: array<vec4<f32>>;
@group(0) @binding(8) var previous: texture_2d<f32>;
@group(0) @binding(9) var outTex: texture_storage_2d<rgba8unorm, write>;
// Frame data: glyph lists per entry tile (first ref word, ref count), glyph refs of four words
// (device x and y of the bitmap's corner as i32, atlas x | y << 16, width | height << 16),
// then per-entry extras of eight words (texture: atlas xy, origin xy as i16, size;
// image: atlas xy, rect origin, rect size, level size, pixels per texel as f32).
@group(0) @binding(10) var<storage, read> frameData: array<u32>;
@group(0) @binding(11) var atlas: texture_2d<f32>;
@group(0) @binding(12) var effectAtlas: texture_2d<f32>;
@group(0) @binding(13) var imageAtlas: texture_2d<f32>;

${blendWgsl}
${noiseWgsl}
${imageWgsl}
${shaderLibWgsl}

// Coverage of a glyph entry at a pixel: the sum of the atlas bitmaps covering it, clamped.
fn glyphCoverage(ti: u32, pix: vec2<u32>) -> f32 {
  let t = (config.glyphBase + ti) * 2u;
  let first = frameData[t];
  let count = frameData[t + 1u];
  var c = 0.0;
  for (var k = 0u; k < count; k++) {
    let r = first + k * 4u;
    let local = vec2<i32>(pix) - vec2<i32>(bitcast<i32>(frameData[r]), bitcast<i32>(frameData[r + 1u]));
    let packedAtlas = frameData[r + 2u];
    let packedSize = frameData[r + 3u];
    let size = vec2<i32>(i32(packedSize & 0xffffu), i32(packedSize >> 16u));
    if (all(local >= vec2<i32>(0)) && all(local < size)) {
      c += textureLoad(atlas, vec2<i32>(i32(packedAtlas & 0xffffu), i32(packedAtlas >> 16u)) + local, 0).r;
    }
  }
  return min(c, 1.0);
}

fn coverage(ti: u32, evenodd: bool, pixel: u32) -> f32 {
  let t = tiles[ti];
  if (t.mask != 0u) {
    let w = masks[(t.mask - 1u) * 64u + (pixel >> 2u)];
    return f32((w >> ((pixel & 3u) * 8u)) & 255u) / 255.0;
  }
  if (evenodd) { return select(0.0, 1.0, (t.backdrop & 1) != 0); }
  return select(0.0, 1.0, t.backdrop != 0);
}

fn gradientStops(p: Paint, t: f32) -> vec4<f32> {
  var i = 0u;
  loop {
    if (i + 1u >= p.stopCount) { break; }
    if (stops[(p.stopOffset + i + 1u) * 2u].x >= t) { break; }
    i++;
  }
  let j = min(i + 1u, p.stopCount - 1u);
  let o0 = stops[(p.stopOffset + i) * 2u].x;
  let o1 = stops[(p.stopOffset + j) * 2u].x;
  let c0 = stops[(p.stopOffset + i) * 2u + 1u];
  let c1 = stops[(p.stopOffset + j) * 2u + 1u];
  var u = select(0.0, 1.0, t >= o1);
  if (o1 > o0) { u = clamp((t - o0) / (o1 - o0), 0.0, 1.0); }
  let c = mix(c0, c1, u);
  return vec4<f32>(c.rgb * c.a, c.a);
}

fn paintColor(e: Entry, pos: vec2<f32>) -> vec4<f32> {
  let p = paints[e.paint];
  if (p.kind == PAINT_SOLID) { return p.color; }
  // Device -> local (inverse of the entry matrix) -> parameter space.
  let det = e.m.x * e.m.w - e.m.y * e.m.z;
  let q = pos - e.t;
  let lp = vec2<f32>(e.m.w * q.x - e.m.z * q.y, -e.m.y * q.x + e.m.x * q.y) / det;
  let g = vec2<f32>(p.m.x * lp.x + p.m.z * lp.y + p.mt.x, p.m.y * lp.x + p.m.w * lp.y + p.mt.y);
  if (p.kind == PAINT_IMAGE) {
    if (e.extras == NO_EXTRAS) { return vec4<f32>(0.0); }
    let b = p.stopOffset * 2u;
    let info = stops[b];
    var c = sampleImage(imagePlace(e.extras), g, info.xy, info.z > 0.5);
    let a2 = stops[b + 2u];
    if (a2.w > 0.5 && c.a > 0.0) {
      c = vec4<f32>(adjustImage(c.rgb / c.a, stops[b + 1u], a2) * c.a, c.a);
    }
    return c * info.w;
  }
  if (p.kind == PAINT_SHADER) {
    return shaderPaint(p.stopOffset * 2u, lp, sqrt(abs(det)), e.extras, pos);
  }
  var t = 0.0;
  if (p.kind == PAINT_LINEAR) {
    t = g.x;
  } else if (p.kind == PAINT_RADIAL) {
    t = length(g);
  } else if (p.kind == PAINT_ANGULAR) {
    t = atan2(g.y, g.x) / 6.283185307;
    if (t < 0.0) { t += 1.0; }
  } else {
    t = abs(g.x) + abs(g.y);
  }
  return gradientStops(p, clamp(t, 0.0, 1.0));
}

/** A texture entry's texel at pixel pix (transparent outside its texture). */
fn textureColor(e: Entry, pix: vec2<u32>) -> vec4<f32> {
  let x = e.extras;
  let atlasXY = vec2<i32>(i32(frameData[x] & 0xffffu), i32(frameData[x] >> 16u));
  let origin = vec2<i32>(entryTextureOrigin(x));
  let size = vec2<i32>(i32(frameData[x + 2u] & 0xffffu), i32(frameData[x + 2u] >> 16u));
  let local = vec2<i32>(pix) - origin;
  if (any(local < vec2<i32>(0)) || any(local >= size)) { return vec4<f32>(0.0); }
  return textureLoad(effectAtlas, atlasXY + local, 0);
}

@compute @workgroup_size(16, 16)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let pix = wid.xy * 16u + lid.xy;
  let pixel = lid.y * 16u + lid.x;
  let pos = vec2<f32>(pix) + 0.5;
  let screenTile = wid.y * config.tiles.x + wid.x;
  var color = config.background;
  if (config.firstPass == 0u) {
    color = textureLoad(previous, min(pix, config.viewport - 1u), 0);
  }
  var stack: array<vec4<f32>, MAX_DEPTH>;
  var stackScale: array<f32, MAX_DEPTH>;
  var maskValue: array<f32, MAX_DEPTH>;
  var depth = 0u;
  var skip = 0u;
  let range = ranges[screenTile];
  for (var i = 0u; i < range.y; i++) {
    let e = entries[lists[range.x + i]];
    let kind = e.flags & 3u;
    if (skip > 0u) {
      if (kind == KIND_BEGIN) { skip++; } else if (kind == KIND_END) { skip--; }
      continue;
    }
    let bw = e.bbox.z - e.bbox.x;
    let ti = e.tileOffset + (wid.y - e.bbox.y) * bw + (wid.x - e.bbox.x);
    let evenodd = (e.flags & FLAG_EVENODD) != 0u;
    if (kind == KIND_FILL) {
      if ((e.flags & FLAG_TEXTURE) != 0u) {
        let src = textureColor(e, pix) * e.opacity;
        color = src + color * (1.0 - src.a);
        continue;
      }
      var cov: f32;
      if ((e.flags & FLAG_GLYPHS) != 0u) { cov = glyphCoverage(ti, pix); } else { cov = coverage(ti, evenodd, pixel); }
      if (cov > 0.0) {
        var src: vec4<f32>;
        if ((e.flags & FLAG_SHAPE) != 0u) {
          // Shape renders: solid and gradient paints count as opaque; images and shaders by their alpha.
          var a = 1.0;
          if (e.paint != 0xffffffffu) {
            let k = paints[e.paint].kind;
            if (k == PAINT_IMAGE || k == PAINT_SHADER) { a = paintColor(e, pos).a; }
          }
          src = vec4<f32>(cov * a);
        } else {
          src = paintColor(e, pos) * (cov * e.opacity);
        }
        color = src + color * (1.0 - src.a);
      }
    } else if (kind == KIND_BEGIN) {
      var scale = e.opacity;
      if ((e.flags & FLAG_CLIP) != 0u) {
        let t = tiles[ti];
        let empty = t.mask == 0u && select(t.backdrop == 0, (t.backdrop & 1) == 0, evenodd);
        if (empty) {
          // Nothing inside this clip reaches this tile.
          skip = 1u;
          continue;
        }
        scale *= coverage(ti, evenodd, pixel);
      }
      stack[depth] = color;
      stackScale[depth] = scale;
      maskValue[depth] = select(1.0, 0.0, layerModeOf(e.flags) == MODE_MASK_GROUP);
      depth++;
      // Non-isolated layers (clips whose content blends) start from what is below them.
      if ((e.flags & FLAG_BACKDROP) == 0u) { color = vec4<f32>(0.0); }
    } else {
      depth--;
      let mode = layerModeOf(e.flags);
      if (mode == MODE_MASK_SOURCE) {
        var m = color.a;
        if (maskTypeOf(e.flags) == 1u) { m = dot(color.rgb, vec3<f32>(0.2125, 0.7154, 0.0721)); }
        color = stack[depth];
        if (depth > 0u) { maskValue[depth - 1u] = m; }
      } else if ((e.flags & FLAG_BACKDROP) != 0u) {
        color = mix(stack[depth], color, stackScale[depth]);
      } else {
        let src = color * (stackScale[depth] * maskValue[depth]);
        color = blendPremul(blendOf(e.flags), src, stack[depth]);
      }
    }
  }
  if (all(pix < config.viewport)) {
    textureStore(outTex, pix, color);
  }
}
`;
