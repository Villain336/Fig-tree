import fc from "fast-check";
import { Path, type Rect } from "@fig-tree/geometry";
import { describe, expect, it } from "vitest";
import { ATLAS_MAX_SIZE, GlyphAtlas, Scene, atlasCompatible, placeGlyphs, rasterizeCoverage, runBounds, sizeBucket, type GlyphRun, type GlyphSource } from "../src/index";
import { DrawList } from "../src/compile";
import { PaintCache, planFrame } from "../src/frame";

/**
 * The glyph atlas: the CPU exact-area rasterizer against exact per-pixel
 * polygon clipping, caching per glyph × size bucket × subpixel phase,
 * least-recently-used eviction that spares the current frame, placement,
 * and frame planning that picks atlas or path drawing per run.
 */

type Poly = [number, number][];

/** Exact signed area of the polygons inside pixel (px, py) (Sutherland–Hodgman clipping and the shoelace formula). */
function exactArea(polys: Poly[], px: number, py: number): number {
  let total = 0;
  for (const poly of polys) {
    let pts = poly;
    const clip = (inside: (p: [number, number]) => boolean, cut: (a: [number, number], b: [number, number]) => [number, number]): void => {
      const out: Poly = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i]!;
        const b = pts[(i + 1) % pts.length]!;
        const ia = inside(a);
        const ib = inside(b);
        if (ia) out.push(a);
        if (ia !== ib) out.push(cut(a, b));
      }
      pts = out;
    };
    const atX = (x: number) => (a: [number, number], b: [number, number]): [number, number] => [x, a[1] + ((x - a[0]) / (b[0] - a[0])) * (b[1] - a[1])];
    const atY = (y: number) => (a: [number, number], b: [number, number]): [number, number] => [a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]), y];
    clip((p) => p[0] >= px, atX(px));
    clip((p) => p[0] <= px + 1, atX(px + 1));
    clip((p) => p[1] >= py, atY(py));
    clip((p) => p[1] <= py + 1, atY(py + 1));
    let shoelace = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      shoelace += a[0] * b[1] - b[0] * a[1];
    }
    total += shoelace / 2;
  }
  return total;
}

function polylines(polys: Poly[]) {
  const points: number[] = [];
  const starts = [0];
  for (const p of polys) {
    for (const [x, y] of p) points.push(x, y);
    starts.push(points.length / 2);
  }
  return { points: Float64Array.from(points), contourStarts: Uint32Array.from(starts), closed: new Uint8Array(polys.length).fill(1) };
}

describe("exact-area glyph rasterizer", () => {
  it("matches exact pixel areas of random polygons within 8-bit rounding", () => {
    const pt = fc.tuple(fc.double({ min: 0.5, max: 15.5, noNaN: true }), fc.double({ min: 0.5, max: 11.5, noNaN: true }));
    fc.assert(
      fc.property(fc.array(pt, { minLength: 3, maxLength: 9 }), (poly) => {
        const bitmap = rasterizeCoverage(polylines([poly as Poly]), 16, 12);
        for (let y = 0; y < 12; y++) {
          for (let x = 0; x < 16; x++) {
            const exact = Math.min(1, Math.abs(exactArea([poly as Poly], x, y)));
            // Self-intersecting polygons: the rasterizer clamps the accumulated winding area, like the GPU's nonzero rule.
            const got = bitmap[y * 16 + x]! / 255;
            expect(Math.abs(got - exact)).toBeLessThanOrEqual(0.5 / 255 + 1e-6);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it("covers a pixel-aligned square exactly and a half-pixel strip by half", () => {
    const sq = rasterizeCoverage(polylines([[[1, 1], [3, 1], [3, 3], [1, 3]]]), 4, 4);
    expect([...sq]).toEqual([0, 0, 0, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 0, 0, 0]);
    const strip = rasterizeCoverage(polylines([[[0, 0], [4, 0], [4, 0.5], [0, 0.5]]]), 4, 1);
    expect([...strip]).toEqual([128, 128, 128, 128]);
  });

  it("cancels holes (opposite winding) and clamps overlaps", () => {
    const outer: Poly = [[0, 0], [6, 0], [6, 6], [0, 6]];
    const hole: Poly = [[2, 2], [2, 4], [4, 4], [4, 2]];
    const b = rasterizeCoverage(polylines([outer, hole]), 6, 6);
    expect(b[3 * 6 + 3]).toBe(0);
    expect(b[1 * 6 + 1]).toBe(255);
    const twice = rasterizeCoverage(polylines([outer, outer]), 6, 6);
    expect(twice[3 * 6 + 3]).toBe(255);
  });
});

/** A source whose glyph g is a g×g square (g ≥ 1), on the baseline. */
function squareSource(key = "squares"): GlyphSource & { built: number } {
  const src = {
    key,
    unitsPerEm: 1000,
    built: 0,
    path(gid: number): Path {
      src.built++;
      const s = gid * 100;
      return new Path().moveTo(0, -s).lineTo(s, -s).lineTo(s, 0).lineTo(0, 0).close();
    },
    bounds(gid: number): Rect {
      return { minX: 0, minY: -gid * 100, maxX: gid * 100, maxY: 0 };
    },
  };
  return src;
}

const run = (source: GlyphSource, glyphs: number[], size = 16): GlyphRun => ({ source, size, glyphs: Float64Array.from(glyphs) });

describe("glyph atlas", () => {
  it("caches per glyph, size bucket and subpixel phase", () => {
    const atlas = new GlyphAtlas(256, 256);
    const r = run(squareSource(), [5, 0, 0]);
    atlas.beginFrame();
    const a = atlas.glyph(r, 5, 16, 0)!;
    expect(atlas.rasterized).toBe(1);
    expect(atlas.glyph(r, 5, 16, 0)).toBe(a);
    expect(atlas.glyph(r, 5, 16.04, 0)).toBe(a); // same 1/8 px bucket
    expect(atlas.rasterized).toBe(1);
    expect(atlas.glyph(r, 5, 16, 2)).not.toBe(a); // another phase
    expect(atlas.glyph(r, 5, 17, 0)).not.toBe(a); // another size
    expect(atlas.rasterized).toBe(3);
    const uploads = atlas.takeUploads();
    expect(uploads.length).toBe(3);
    expect(atlas.takeUploads()).toEqual([]);
    // 5/10 em at 16 px = 8 px square, plus a 1 px margin each side.
    expect([a.width, a.height]).toEqual([10, 10]);
    expect(Math.max(...uploads[0]!.data)).toBe(255);
  });

  it("buckets sizes finer for small text", () => {
    expect(sizeBucket(12.07)).toBe(12.125);
    expect(sizeBucket(12.04)).toBe(12);
    expect(sizeBucket(30.1)).toBe(30);
    expect(sizeBucket(70.3)).toBe(70.5);
  });

  it("evicts the least recently used glyphs but never one used this frame", () => {
    // A 48 x 24 atlas holds two 24 px cells (a 20 px square plus its margins).
    const atlas = new GlyphAtlas(48, 24);
    const src = squareSource();
    const r = run(src, []);
    atlas.beginFrame();
    const a = atlas.glyph(r, 2, 100, 0)!;
    const b = atlas.glyph(r, 2, 100, 1)!;
    expect(a && b).toBeTruthy();
    // Full, and both glyphs are in use this frame: no room.
    expect(atlas.glyph(r, 2, 100, 2)).toBeNull();
    atlas.beginFrame();
    atlas.glyph(r, 2, 100, 1); // touch b
    const c = atlas.glyph(r, 2, 100, 2)!;
    expect(c).not.toBeNull();
    expect([c.x, c.y]).toEqual([a.x, a.y]); // a was the least recently used
    expect(atlas.evicted).toBe(1);
  });

  it("places glyphs on whole-pixel baselines with quarter-pixel x phases", () => {
    const atlas = new GlyphAtlas();
    const r = run(squareSource(), [5, 0.3, 10.4, 5, 10.0, 10.4, 5, 20.9, 10.4]);
    atlas.beginFrame();
    const p = placeGlyphs(atlas, r, [1, 0, 0, 1, 0, 0])!;
    expect(p.map((g) => g.y)).toEqual([10 - 8 - 1, 10 - 8 - 1, 10 - 8 - 1]);
    expect(p[0]!.glyph.key).toContain("|1|"); // 0.3 → phase 1 (¼ px)
    expect(p[1]!.glyph.key).toContain("|0|");
    expect(p[2]!.x).toBe(21 - 1); // 0.9 rounds up to the next whole pixel, phase 0
  });

  it("uses the atlas only for axis-aligned, uniformly scaled, small text", () => {
    const r = run(squareSource(), [5, 0, 0], 16);
    expect(atlasCompatible([2, 0, 0, 2, 5, 5], r)).toBe(true);
    expect(atlasCompatible([2, 0, 0, 3, 5, 5], r)).toBe(false);
    expect(atlasCompatible([0, 1, -1, 0, 0, 0], r)).toBe(false);
    expect(atlasCompatible([ATLAS_MAX_SIZE / 16 + 1, 0, 0, ATLAS_MAX_SIZE / 16 + 1, 0, 0], r)).toBe(false);
  });

  it("computes run bounds from glyph bounds without building outlines", () => {
    const src = squareSource();
    const r = run(src, [5, 10, 20, 2, 40, 20], 10);
    expect(runBounds(r)).toEqual({ minX: 10, minY: 15, maxX: 42, maxY: 20 });
    expect(src.built).toBe(0);
  });
});

describe("frame planning of glyph runs", () => {
  function scene(): { scene: Scene; src: ReturnType<typeof squareSource> } {
    const scene = new Scene();
    const src = squareSource();
    scene.root.appendChild(scene.createNode({ glyphs: run(src, [5, 0, 20, 6, 10, 20], 16), fill: { type: "solid", color: { r: 0, g: 0, b: 0, a: 1 } } }));
    return { scene, src };
  }

  it("draws small axis-aligned runs from the atlas and does not re-rasterize while panning", () => {
    const { scene: s, src } = scene();
    const list = new DrawList();
    list.sync(s);
    const atlas = new GlyphAtlas();
    const paints = new PaintCache();
    atlas.beginFrame();
    const plan = planFrame(list, paints, [1, 0, 0, 1, 10, 10], 200, 100, atlas);
    expect(plan.entries.length).toBe(1);
    expect(plan.entries[0]!.glyphs?.length).toBe(2);
    expect(plan.entries[0]!.geometry).toBeNull();
    expect(atlas.rasterizedThisFrame).toBe(2);
    // Panning by whole pixels reuses every bitmap; the run's outlines were never built as a path.
    for (let i = 1; i < 10; i++) {
      atlas.beginFrame();
      planFrame(list, paints, [1, 0, 0, 1, 10 + i * 7, 10 - i * 3], 200, 100, atlas);
      expect(atlas.rasterizedThisFrame).toBe(0);
    }
    expect(src.built).toBe(2); // once per glyph, for its bitmap
  });

  it("draws rotated or zoomed-in runs as paths", () => {
    const { scene: s } = scene();
    const list = new DrawList();
    list.sync(s);
    const atlas = new GlyphAtlas();
    atlas.beginFrame();
    const rotated = planFrame(list, new PaintCache(), [0, 1, -1, 0, 100, 10], 200, 200, atlas);
    expect(rotated.entries[0]!.glyphs).toBeNull();
    expect(rotated.entries[0]!.geometry!.segmentCount).toBe(8);
    const zoomed = planFrame(list, new PaintCache(), [10, 0, 0, 10, 0, 0], 2000, 2000, atlas);
    expect(zoomed.entries[0]!.glyphs).toBeNull();
    expect(zoomed.entries[0]!.geometry).not.toBeNull();
  });
});
