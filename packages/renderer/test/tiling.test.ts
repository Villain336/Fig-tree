import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { TILE, backdrops, binSegment, makeGrid, pixelArea, type TileGrid } from "./tile-reference";

type Poly = [number, number][];

/** Exact integral of the winding number over a pixel (sign: +1 for edges heading down). */
function exactArea(polys: Poly[], px: number, py: number): number {
  let total = 0;
  for (const poly of polys) {
    let pts = poly;
    const clip = (inside: (p: [number, number]) => boolean, cut: (a: [number, number], b: [number, number]) => [number, number]): void => {
      const out: Poly = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i]!;
        const b = pts[(i + 1) % pts.length]!;
        const ia = inside(a), ib = inside(b);
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
    total -= shoelace / 2;
  }
  return total;
}

function rasterize(polys: Poly[], g: TileGrid): void {
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      if (a[0] === b[0] && a[1] === b[1]) continue;
      binSegment(g, a[0], a[1], b[0], b[1]);
    }
  }
}

function maxError(polys: Poly[], g: TileGrid): number {
  rasterize(polys, g);
  const bd = backdrops(g);
  const bw = g.tx1 - g.tx0;
  let worst = 0;
  for (let r = 0; r < g.ty1 - g.ty0; r++) {
    for (let c = 0; c < bw; c++) {
      const tile = r * bw + c;
      for (let py = 0; py < TILE; py++) {
        for (let px = 0; px < TILE; px++) {
          const got = pixelArea(g.pieces[tile]!, bd[tile]!, px, py);
          const want = exactArea(polys, (g.tx0 + c) * TILE + px, (g.ty0 + r) * TILE + py);
          worst = Math.max(worst, Math.abs(got - want));
        }
      }
    }
  }
  return worst;
}

const coordArb = fc.double({ min: -20, max: 84, noNaN: true }).map((v) => Math.fround(v));
const snappedArb = fc.integer({ min: -2, max: 10 }).map((v) => v * 8);
const pointArb = fc.oneof(fc.tuple(coordArb, coordArb), fc.tuple(snappedArb, snappedArb), fc.tuple(snappedArb, coordArb));
const polyArb = fc.array(pointArb, { minLength: 3, maxLength: 9 });
const gridArb = fc.tuple(fc.integer({ min: 0, max: 2 }), fc.integer({ min: 0, max: 2 }), fc.integer({ min: 1, max: 4 }), fc.integer({ min: 1, max: 4 }));

describe("tiled analytic coverage (reference for the WGSL passes)", () => {
  it("matches exact per-pixel winding area for arbitrary polygons and clipped bounding boxes", () => {
    fc.assert(
      fc.property(fc.array(polyArb, { minLength: 1, maxLength: 3 }), gridArb, (polys, [tx, ty, w, h]) => {
        return maxError(polys, makeGrid(tx, ty, tx + w, ty + h)) < 2e-3;
      }),
      { numRuns: 400 },
    );
  });

  it("handles paths passing exactly through tile corners", () => {
    const polys: Poly[] = [[[0, 0], [32, 32], [48, 0]], [[16, 8], [32, 16], [16, 24], [0, 16]]];
    expect(maxError(polys, makeGrid(0, 0, 4, 3))).toBeLessThan(1e-4);
    // A "V" touching a column boundary at a band corner from the right.
    const v: Poly[] = [[[21, 11], [16, 16], [21, 21], [40, 21], [40, 11]]];
    expect(maxError(v, makeGrid(0, 0, 3, 2))).toBeLessThan(1e-4);
  });

  it("projects geometry left of the box onto its left edge", () => {
    // A wide rectangle starting far left of the grid.
    const rect: Poly[] = [[[-500, 3.5], [40.25, 3.5], [40.25, 27.75], [-500, 27.75]]];
    expect(maxError(rect, makeGrid(1, 0, 3, 2))).toBeLessThan(1e-4);
  });

  it("keeps abutting edges inside one path crack-free", () => {
    // Two triangles sharing a diagonal: every interior pixel must be exactly 1.
    const g = makeGrid(0, 0, 2, 2);
    rasterize([[[2.3, 2.7], [29.1, 3.3], [27.6, 30.2]], [[2.3, 2.7], [27.6, 30.2], [3.1, 28.9]]], g);
    const bd = backdrops(g);
    const area = pixelArea(g.pieces[0]!, bd[0]!, 10, 10);
    expect(Math.abs(area)).toBeCloseTo(1, 6);
  });
});
