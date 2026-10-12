/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) KALEIDOS SUBSIDIARY SL
 * Copyright (c) Fig Tree contributors (TypeScript port and changes)
 *
 * Ported from penpot/common/test/common_tests/types/path_data_test.cljc
 * @5eb33ad: the test vectors of fit-cubic, fit-curve, smooth-points,
 * remove-nodes (collinear, corner, between curves, split restore, several
 * consecutive nodes, closed paths) and bend-curve-deltas.
 *
 * The inputs and expectations are Penpot's; they are asserted against Fig
 * Tree's own implementations (written from Schneider's paper and our own
 * least-norm bend), not Penpot's code.
 */
import { describe, expect, it } from "vitest";
import {
  arcLength,
  bendSegment,
  cubic,
  deleteVertexPreservingShape,
  fitCurve,
  freehandToNetwork,
  maxDistanceToCurves,
  paramAtLength,
  pointAt,
  segmentCubic,
  splitSegment,
  validateNetwork,
  type Vec,
  type VectorNetwork,
} from "../../../src";

/** An open polyline (and curves) as a network: vertices in order, segment i from vertex i to i + 1. */
function chain(points: readonly Vec[], tangents: readonly ([Vec, Vec] | null)[] = []): VectorNetwork {
  return {
    vertices: points.map((p) => ({ x: p.x, y: p.y })),
    segments: points.slice(1).map((_, i) => {
      const t = tangents[i];
      return t ? { start: i, end: i + 1, tangentStart: t[0], tangentEnd: t[1] } : { start: i, end: i + 1 };
    }),
    regions: [],
  };
}

describe("fit-cubic and fit-curve (path_data_test.cljc)", () => {
  it("helpers-fit-cubic-recovers-curve / helpers-fit-curve-single-curve", () => {
    const curve = cubic(0, 0, 10, 10, 20, 10, 30, 0);
    const samples = Array.from({ length: 25 }, (_, i) => pointAt(curve, i / 24));
    const result = fitCurve(samples, { tolerance: 0.5 });
    expect(result).toHaveLength(1);
    const [r] = result;
    expect(r!.x0).toBe(0);
    expect(r!.x3).toBe(30);
    expect(Math.abs(r!.x1 - 10)).toBeLessThan(1.5);
    expect(Math.abs(r!.y1 - 10)).toBeLessThan(1.5);
    expect(Math.abs(r!.x2 - 20)).toBeLessThan(1.5);
    expect(Math.abs(r!.y2 - 10)).toBeLessThan(1.5);
  });

  it("helpers-fit-curve-splits-and-chains", () => {
    const pts: Vec[] = [];
    for (let i = 0; i <= 10; i++) pts.push({ x: i, y: i });
    for (let i = 1; i <= 10; i++) pts.push({ x: 10 + i, y: 10 - i });
    const result = fitCurve(pts, { tolerance: 0.1 });
    expect(result.length).toBeGreaterThan(1);
    for (let i = 0; i + 1 < result.length; i++) expect([result[i]!.x3, result[i]!.y3]).toEqual([result[i + 1]!.x0, result[i + 1]!.y0]);
    expect([result[0]!.x0, result[0]!.y0]).toEqual([0, 0]);
    expect([result[result.length - 1]!.x3, result[result.length - 1]!.y3]).toEqual([20, 0]);
  });

  it("helpers-fit-curve-respects-tolerance", () => {
    const pts = Array.from({ length: 31 }, (_, i) => ({ x: i, y: 5 * Math.sin(i / 3) }));
    const result = fitCurve(pts, { tolerance: 0.5 });
    expect(maxDistanceToCurves(pts, result)).toBeLessThanOrEqual(0.5 + 0.05);
  });

  it("helpers-fit-curve-keeps-sharp-corners", () => {
    const pts: Vec[] = [];
    for (let i = 0; i <= 10; i++) pts.push({ x: i, y: i });
    for (let i = 1; i <= 10; i++) pts.push({ x: 10 + i, y: 10 - i });
    const result = fitCurve(pts, { tolerance: 0.1 });
    const left = result.find((k) => k.x3 === 10 && k.y3 === 10)!;
    const right = result.find((k) => k.x0 === 10 && k.y0 === 10)!;
    expect(left).toBeDefined();
    expect(right).toBeDefined();
    const vin = { x: left.x2 - 10, y: left.y2 - 10 }, vout = { x: right.x1 - 10, y: right.y1 - 10 };
    const angle = (Math.acos((vin.x * vout.x + vin.y * vout.y) / (Math.hypot(vin.x, vin.y) * Math.hypot(vout.x, vout.y))) * 180) / Math.PI;
    expect(angle).toBeLessThan(135);
    expect(Math.abs(angle - 90)).toBeLessThan(15);
  });

  it("segment-smooth-points->content", () => {
    const two = freehandToNetwork([{ x: 0, y: 0 }, { x: 10, y: 0 }], { tolerance: 1 });
    expect(two.segments).toEqual([{ start: 0, end: 1 }]);
    const pts = Array.from({ length: 31 }, (_, i) => ({ x: i, y: 5 * Math.sin(i / 3) }));
    const net = freehandToNetwork(pts, { tolerance: 1 });
    expect(net.segments.length).toBeLessThan(pts.length - 1);
    expect(net.segments.every((s) => s.tangentStart || s.tangentEnd)).toBe(true);
    expect(net.vertices[0]).toEqual({ x: 0, y: 0 });
    const last = net.vertices[net.segments[net.segments.length - 1]!.end]!;
    expect(last.x).toBeCloseTo(30, 9);
    expect(last.y).toBeCloseTo(5 * Math.sin(10), 9);
  });
});

describe("remove-nodes (path_data_test.cljc)", () => {
  it("segment-remove-nodes-collinear-keeps-line", () => {
    const out = deleteVertexPreservingShape(chain([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }]), 1);
    expect(out.segments).toEqual([{ start: 0, end: 1 }]);
    expect(out.vertices[1]).toEqual({ x: 20, y: 0 });
  });

  it("segment-remove-nodes-corner-fits-curve", () => {
    const out = deleteVertexPreservingShape(chain([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }]), 1);
    const k = segmentCubic(out, 0);
    expect(k.x3).toBeCloseTo(20, 9);
    expect(k.y3).toBeCloseTo(0, 9);
    // Handles stay on the removed segments' directions (45 degrees).
    expect(k.x1).toBeCloseTo(k.y1, 2);
    expect(20 - k.x2).toBeCloseTo(k.y2, 2);
    const mid = pointAt(k, 0.5);
    expect(mid.y).toBeGreaterThan(2);
    expect(mid.y).toBeLessThan(10);
    expect(Math.abs(mid.x - 10)).toBeLessThan(0.5);
  });

  it("segment-remove-nodes-between-curves-approximates", () => {
    const out = deleteVertexPreservingShape(
      chain([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }], [
        [{ x: 0, y: 5.52 }, { x: 4.48 - 10, y: 0 }],
        [{ x: 5.52, y: 0 }, { x: 0, y: 5.52 }],
      ]),
      1,
    );
    const mid = pointAt(segmentCubic(out, 0), 0.5);
    expect(Math.abs(mid.x - 10)).toBeLessThan(0.5);
    expect(Math.abs(mid.y - 10)).toBeLessThan(0.5);
  });

  it("segment-remove-node-restores-a-split-curve (split at the arc-length midpoint)", () => {
    const net = chain([{ x: 0, y: 0 }, { x: 100, y: 100 }], [[{ x: 0, y: 0 }, { x: -100, y: 0 }]]);
    const original = segmentCubic(net, 0);
    const t = paramAtLength(original, arcLength(original) / 2);
    expect(Math.abs(t - 0.5)).toBeGreaterThan(0.01);
    const split = splitSegment(net, 0, t);
    const healed = segmentCubic(deleteVertexPreservingShape(split.network, split.vertex), 0);
    for (const k of ["x1", "y1", "x2", "y2", "x3", "y3"] as const) expect(healed[k]).toBeCloseTo(original[k], 6);
  });

  it("segment-remove-nodes-multiple-consecutive", () => {
    let net = chain([{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 7 }, { x: 15, y: 5 }, { x: 20, y: 0 }]);
    // Remove vertices 1..3 (indices shift down after each removal).
    for (let i = 0; i < 3; i++) net = deleteVertexPreservingShape(net, 1);
    expect(net.segments).toHaveLength(1);
    const mid = pointAt(segmentCubic(net, 0), 0.5);
    expect(Math.abs(mid.x - 10)).toBeLessThan(1);
  });

  it("segment-remove-nodes-closed-path-keeps-closure", () => {
    const net: VectorNetwork = {
      vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
      segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 0 }],
      regions: [{ loops: [[0, 1, 2, 3]], fillRule: "nonzero" }],
    };
    const out = deleteVertexPreservingShape(net, 0);
    expect(validateNetwork(out)).toEqual([]);
    expect(out.segments).toHaveLength(3);
    expect(out.regions).toHaveLength(1);
  });
});

describe("bend-curve-deltas (path_data_test.cljc)", () => {
  it("helpers-bend-curve-deltas-passes-through-target", () => {
    for (const t of [0.3, 0.5, 0.7]) {
      const net = chain([{ x: 0, y: 0 }, { x: 10, y: 0 }], [[{ x: 0, y: 0 }, { x: 0, y: 0 }]]);
      const out = bendSegment(net, 0, t, { x: 5, y: 4 });
      const p = pointAt(segmentCubic(out, 0), t);
      expect(p.x).toBeCloseTo(5, 9);
      expect(p.y).toBeCloseTo(4, 9);
    }
  });

  it("helpers-bend-straight-segment-turns-a-line-into-a-soft-curve", () => {
    const out = bendSegment(chain([{ x: 0, y: 0 }, { x: 30, y: 0 }]), 0, 0.5, { x: 15, y: 6 });
    const k = segmentCubic(out, 0);
    expect(k.line).toBe(false);
    // Both handles move by the same amount towards the target.
    expect(k.y1).toBeCloseTo(k.y2, 9);
    expect(k.y1).toBeGreaterThan(0);
  });
});
