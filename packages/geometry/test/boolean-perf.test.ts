import { describe, expect, it } from "vitest";
import { BooleanEvaluator, booleanOperation, ellipsePath, pathShape, roundedRectPath, starPath, type FillShape } from "../src";
import { compareWithReference } from "./boolean-reference";
import { rng } from "./helpers";

/**
 * Boolean performance on this machine's Node (reported in docs/benchmarks.md):
 * - the union of 100 overlapping curved shapes (one cluster);
 * - a 1,000-operand evaluation of a grid of overlapping clusters, then
 *   re-evaluation after one operand changes (only its cluster is recomputed).
 */

function timed<T>(f: () => T, runs = 5): { result: T; median: number; max: number } {
  const times: number[] = [];
  let result!: T;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    result = f();
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  return { result, median: times[Math.floor(times.length / 2)]!, max: times[times.length - 1]! };
}

function curvedShape(r: () => number, cx: number, cy: number, size: number): FillShape {
  const k = Math.floor(r() * 3);
  if (k === 0) return pathShape(ellipsePath(cx, cy, size * (0.5 + r() / 2), size * (0.5 + r() / 2)));
  if (k === 1) return pathShape(roundedRectPath(cx - size / 2, cy - size / 2, size, size * (0.5 + r()), size * 0.3, 0.6));
  return pathShape(starPath(cx - size / 2, cy - size / 2, size, size, 5, 0.5, size * 0.1));
}

describe("boolean performance", () => {
  it("unions 100 overlapping curved shapes", { timeout: 120_000 }, () => {
    const r = rng(42);
    const shapes = Array.from({ length: 100 }, () => curvedShape(r, r() * 400, r() * 400, 30 + r() * 60));
    const { result, median, max } = timed(() => booleanOperation("union", shapes.map((s) => ({ shapes: [s] }))));
    const cmp = compareWithReference("union", shapes.map((s) => [s]), result.contours, 2000);
    const curves = result.contours.reduce((s, c) => s + c.length, 0);
    console.log(`[boolean perf] union of 100 curved shapes: median ${median.toFixed(1)} ms, max ${max.toFixed(1)} ms; ${result.contours.length} contours, ${curves} curves; disagreement with reference ${(cmp.xorArea / cmp.expectedArea).toExponential(2)} of ${cmp.expectedArea.toFixed(0)}`);
    expect(result.inconsistencies).toBe(0);
    expect(cmp.xorArea / cmp.expectedArea).toBeLessThan(1e-4);
    expect(median).toBeLessThan(2000);
  });

  it("evaluates 1,000 operands and re-evaluates after editing one", { timeout: 120_000 }, () => {
    const r = rng(7);
    // A 40 × 25 grid of shapes, each overlapping its right neighbour: 25 rows, each one cluster of 40.
    const operands = Array.from({ length: 1000 }, (_, i) => {
      const col = i % 40, row = Math.floor(i / 40);
      return { key: `n${i}:0`, shapes: [curvedShape(r, col * 25, row * 100, 30 + r() * 10)] };
    });
    const ev = new BooleanEvaluator();
    const full = timed(() => new BooleanEvaluator().evaluate("union", operands), 3);
    ev.evaluate("union", operands);
    const edits: number[] = [];
    for (let k = 0; k < 9; k++) {
      const i = Math.floor(r() * 1000);
      const col = i % 40, row = Math.floor(i / 40);
      operands[i] = { key: `n${i}:${k + 1}`, shapes: [curvedShape(r, col * 25 + 3, row * 100 + 2, 30 + r() * 10)] };
      const t = performance.now();
      ev.evaluate("union", operands);
      edits.push(performance.now() - t);
      expect(ev.lastComputed).toBeLessThanOrEqual(2);
    }
    edits.sort((a, b) => a - b);
    const clusters = ev.lastClusters;
    console.log(`[boolean perf] 1,000 operands (${clusters} clusters): full evaluation median ${full.median.toFixed(0)} ms; re-evaluation after one edit median ${edits[4]!.toFixed(1)} ms, max ${edits[8]!.toFixed(1)} ms`);
    expect(full.result.inconsistencies).toBe(0);
    expect(clusters).toBeGreaterThanOrEqual(25);
    expect(edits[4]!).toBeLessThan(full.median / 5);
  });

  it("evaluates 1,000 mutually overlapping operands (one cluster: the worst case)", { timeout: 120_000 }, () => {
    const r = rng(9);
    const operands = Array.from({ length: 1000 }, (_, i) => ({ key: `m${i}`, shapes: [curvedShape(r, r() * 600, r() * 600, 30 + r() * 30)] }));
    const ev = new BooleanEvaluator();
    const t = performance.now();
    const res = ev.evaluate("union", operands);
    const ms = performance.now() - t;
    console.log(`[boolean perf] 1,000 overlapping operands in ${ev.lastClusters} cluster(s): ${ms.toFixed(0)} ms, ${res.contours.length} contours, ${res.retries} retries`);
    expect(res.inconsistencies).toBe(0);
    expect(res.retries).toBe(0);
    const cmp = compareWithReference("union", operands.map((o) => o.shapes), res.contours, 2000);
    expect(cmp.xorArea / cmp.expectedArea).toBeLessThan(1e-4);
  });
});
