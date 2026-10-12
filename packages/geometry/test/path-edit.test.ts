import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  bendSegment,
  closestParam,
  cubic,
  deleteVertexPreservingShape,
  deviation,
  fitCurve,
  freehandToNetwork,
  joinCurves,
  maxDistanceToCurves,
  pointAt,
  segmentCubic,
  simplifyNetwork,
  splitAt,
  splitSegment,
  validateNetwork,
  type Cubic,
  type Vec,
  type VectorNetwork,
} from "../src";
import { rng } from "./helpers";

const coord = fc.double({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true });
const arbCubic = fc.tuple(coord, coord, coord, coord, coord, coord, coord, coord).map(([a, b, c, d, e, f, g, h]) => cubic(a, b, c, d, e, f, g, h));

describe("curve fitting (pencil)", () => {
  it("keeps every input point within the tolerance (random strokes)", () => {
    let pieces = 0, points = 0;
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), fc.constantFrom(0.05, 0.25, 1, 4), (seed, tol) => {
        const r = rng(seed);
        // A wobbly stroke: random walk with momentum and jitter.
        const pts: Vec[] = [];
        let x = 0, y = 0, a = r() * Math.PI * 2;
        const n = 20 + Math.floor(r() * 200);
        for (let i = 0; i < n; i++) {
          a += (r() - 0.5) * 0.6;
          x += Math.cos(a) * (1 + r() * 3);
          y += Math.sin(a) * (1 + r() * 3);
          pts.push({ x: x + (r() - 0.5) * 0.2, y: y + (r() - 0.5) * 0.2 });
        }
        const curves = fitCurve(pts, { tolerance: tol });
        expect(maxDistanceToCurves(pts, curves)).toBeLessThanOrEqual(tol * (1 + 1e-9));
        // Chained end to end, starting and ending at the input's ends.
        for (let i = 0; i + 1 < curves.length; i++) {
          expect(curves[i]!.x3).toBe(curves[i + 1]!.x0);
          expect(curves[i]!.y3).toBe(curves[i + 1]!.y0);
        }
        expect(curves[0]!.x0).toBe(pts[0]!.x);
        expect(curves[curves.length - 1]!.y3).toBe(pts[pts.length - 1]!.y);
        if (tol >= 1) {
          pieces += curves.length;
          points += pts.length;
        }
      }),
      { numRuns: 150 },
    );
    // A real fit: far fewer curves than points once the tolerance exceeds the noise.
    expect(pieces).toBeLessThan(points / 4);
  });

  it("recovers a single cubic from its samples", () => {
    const c = cubic(0, 0, 10, 10, 20, 10, 30, 0);
    const pts = Array.from({ length: 25 }, (_, i) => pointAt(c, i / 24));
    const fit = fitCurve(pts, { tolerance: 0.01 });
    expect(fit).toHaveLength(1);
    expect(deviation([c], fit[0]!)).toBeLessThan(0.02);
  });

  it("keeps sharp corners", () => {
    const pts: Vec[] = [];
    for (let i = 0; i <= 10; i++) pts.push({ x: i, y: i });
    for (let i = 1; i <= 10; i++) pts.push({ x: 10 + i, y: 10 - i });
    const fit = fitCurve(pts, { tolerance: 0.1 });
    expect(fit.length).toBeGreaterThanOrEqual(2);
    const joint = fit.findIndex((c) => c.x3 === 10 && c.y3 === 10);
    expect(joint).toBeGreaterThanOrEqual(0);
  });

  it("turns a closed freehand stroke into a filled network with smooth joints", () => {
    const pts: Vec[] = [];
    for (let i = 0; i <= 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      pts.push({ x: 50 * Math.cos(a), y: 30 * Math.sin(a) });
    }
    const net = freehandToNetwork(pts, { tolerance: 0.2, closeDistance: 1 });
    expect(validateNetwork(net)).toEqual([]);
    expect(net.regions).toHaveLength(1);
    expect(net.vertices.some((v) => v.handleMirroring === "angle")).toBe(true);
  });
});

describe("deleting a vertex while keeping the shape", () => {
  const chain = (c1: Cubic, c2: Cubic): VectorNetwork => ({
    vertices: [{ x: c1.x0, y: c1.y0 }, { x: c1.x3, y: c1.y3 }, { x: c2.x3, y: c2.y3 }],
    segments: [
      { start: 0, end: 1, tangentStart: { x: c1.x1 - c1.x0, y: c1.y1 - c1.y0 }, tangentEnd: { x: c1.x2 - c1.x3, y: c1.y2 - c1.y3 } },
      { start: 1, end: 2, tangentStart: { x: c2.x1 - c2.x0, y: c2.y1 - c2.y0 }, tangentEnd: { x: c2.x2 - c2.x3, y: c2.y2 - c2.y3 } },
    ],
    regions: [],
  });

  it("restores a split cubic exactly", () => {
    fc.assert(
      fc.property(arbCubic, fc.double({ min: 0.05, max: 0.95, noNaN: true }), (c, t) => {
        const [l, r] = splitAt(c, t);
        const joined = joinCurves(l, r);
        const scale = 1 + Math.abs(c.x0) + Math.abs(c.x1) + Math.abs(c.x2) + Math.abs(c.x3) + Math.abs(c.y0) + Math.abs(c.y1) + Math.abs(c.y2) + Math.abs(c.y3);
        for (const k of ["x1", "y1", "x2", "y2"] as const) expect(Math.abs(joined[k] - c[k])).toBeLessThan(1e-6 * scale);
      }),
      { numRuns: 300 },
    );
  });

  it("restores a curve after split-then-delete through the network API", () => {
    const net: VectorNetwork = { vertices: [{ x: 0, y: 0 }, { x: 100, y: 100 }], segments: [{ start: 0, end: 1, tangentStart: { x: 0, y: 0 }, tangentEnd: { x: -100, y: 0 } }], regions: [] };
    const bent = bendSegment(net, 0, 0.4, { x: 20, y: 70 });
    const original = segmentCubic(bent, 0);
    const split = splitSegment(bent, 0, 0.37);
    const healed = deleteVertexPreservingShape(split.network, split.vertex);
    expect(validateNetwork(healed)).toEqual([]);
    expect(healed.segments).toHaveLength(1);
    expect(deviation([original], segmentCubic(healed, 0))).toBeLessThan(1e-9);
  });

  it("collinear straight segments become one straight segment", () => {
    const net: VectorNetwork = {
      vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }],
      segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }],
      regions: [],
    };
    const out = deleteVertexPreservingShape(net, 1);
    expect(out.segments).toEqual([{ start: 0, end: 1 }]);
    expect(out.vertices).toEqual([{ x: 0, y: 0 }, { x: 20, y: 0 }]);
  });

  it("a slanted corner becomes a curve with the same end tangents", () => {
    const net: VectorNetwork = {
      vertices: [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }],
      segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }],
      regions: [],
    };
    const out = deleteVertexPreservingShape(net, 1);
    const c = segmentCubic(out, 0);
    expect(c.x1 - c.x0).toBeCloseTo(c.y1 - c.y0, 9);
    expect(c.x3 - c.x2).toBeCloseTo(c.y2 - c.y3, 9);
    const mid = pointAt(c, 0.5);
    expect(mid.y).toBeGreaterThan(2);
    expect(mid.y).toBeLessThan(10);
  });

  it("fits two quarter arcs with a semicircle within a bounded error", () => {
    const k = 0.5522847498307936 * 10;
    const net = chain(cubic(0, 0, 0, k, 10 - k, 10, 10, 10), cubic(10, 10, 10 + k, 10, 20, k, 20, 0));
    const before = [segmentCubic(net, 0), segmentCubic(net, 1)];
    const out = deleteVertexPreservingShape(net, 1);
    const err = deviation(before, segmentCubic(out, 0));
    // A single cubic cannot be a semicircle; the least-squares fit stays within 2% of the radius.
    expect(err).toBeLessThan(0.2);
  });

  it("bounds the refit error on random smooth joints (error report)", () => {
    const errors: number[] = [];
    fc.assert(
      fc.property(arbCubic, fc.double({ min: 0.1, max: 0.9, noNaN: true }), fc.double({ min: -0.3, max: 0.3, noNaN: true }), (c, t, wobble) => {
        // Split, then disturb the joint a little: the healed curve should stay close to both pieces.
        const [l, r] = splitAt(c, t);
        const size = Math.hypot(c.x3 - c.x0, c.y3 - c.y0) + 1;
        const dx = wobble * size * 0.05;
        const l2 = { ...l, x3: l.x3 + dx, x2: l.x2 + dx };
        const r2 = { ...r, x0: r.x0 + dx, x1: r.x1 + dx };
        const joined = joinCurves(l2, r2);
        const err = deviation([l2, r2], joined) / size;
        errors.push(err);
      }),
      { numRuns: 300 },
    );
    errors.sort((a, b) => a - b);
    // Median and 95th percentile relative errors (to the chord length).
    expect(errors[Math.floor(errors.length / 2)]!).toBeLessThan(0.02);
    expect(errors[Math.floor(errors.length * 0.95)]!).toBeLessThan(0.25);
  });

  it("keeps regions through a healed vertex", () => {
    const net: VectorNetwork = {
      vertices: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 80 }],
      segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 0 }],
      regions: [{ loops: [[0, 1, 2, 3]], fillRule: "nonzero" }],
    };
    const out = deleteVertexPreservingShape(net, 1);
    expect(validateNetwork(out)).toEqual([]);
    expect(out.regions[0]!.loops[0]).toHaveLength(3);
  });
});

describe("simplify", () => {
  it("removes vertices while staying within the tolerance of the original", () => {
    // A circle sampled as 64 short curves (from a fit with a tight tolerance).
    const pts: Vec[] = [];
    for (let i = 0; i <= 256; i++) {
      const a = (i / 256) * Math.PI * 1.5;
      pts.push({ x: 100 * Math.cos(a), y: 100 * Math.sin(a) });
    }
    const dense = freehandToNetwork(pts, { tolerance: 0.001 });
    const original = dense.segments.map((_, i) => segmentCubic(dense, i));
    for (const tol of [0.01, 0.1, 1]) {
      const simple = simplifyNetwork(dense, tol);
      expect(validateNetwork(simple)).toEqual([]);
      expect(simple.segments.length).toBeLessThanOrEqual(dense.segments.length);
      const curves = simple.segments.map((_, i) => segmentCubic(simple, i));
      // Every point of the original is within tol of the simplified network.
      for (const c of original) {
        for (let i = 0; i <= 8; i++) {
          const p = pointAt(c, i / 8);
          const d = Math.min(...curves.map((k) => Math.sqrt(closestParam(k, p.x, p.y).dist2)));
          expect(d).toBeLessThanOrEqual(tol * 1.05);
        }
      }
    }
    expect(simplifyNetwork(dense, 1).segments.length).toBeLessThan(dense.segments.length);
  });
});
