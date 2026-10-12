import { contoursToPath, flattenPath, type BooleanOperation, type Cubic, type FillRule, type FillShape } from "../src";

/**
 * An independent reference for boolean operations: shapes are flattened
 * finely (0.0005 units) and integrated scanline by scanline. On each
 * scanline the crossings of every flattened edge are sorted by x and swept,
 * which gives the exact inside intervals of that line for every operand
 * (exact in x, midpoint rule in y). Comparing the result's own intervals
 * with the expected ones row by row measures the symmetric difference (the
 * area where the two disagree), not just the difference of the areas.
 */

interface Edge {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  dim: number;
}

function edgesOf(shape: FillShape, dim: number, tol: number, out: Edge[]): void {
  const poly = flattenPath(contoursToPath(shape.contours), undefined, tol);
  for (let c = 0; c + 1 < poly.contourStarts.length; c++) {
    const s = poly.contourStarts[c]!, e = poly.contourStarts[c + 1]!;
    for (let i = s; i < e; i++) {
      const j = i + 1 < e ? i + 1 : s;
      out.push({ x0: poly.points[i * 2]!, y0: poly.points[i * 2 + 1]!, x1: poly.points[j * 2]!, y1: poly.points[j * 2 + 1]!, dim });
    }
  }
}

function inside(w: number, rule: FillRule): boolean {
  return rule === "nonzero" ? w !== 0 : (w & 1) === 1;
}

/** Inside intervals of the row at y, given a predicate over per-dimension windings. */
function rowIntervals(edges: readonly Edge[], dims: number, y: number, pred: (w: Int32Array) => boolean): [number, number][] {
  const xs: { x: number; dim: number; d: number }[] = [];
  for (const e of edges) {
    if (e.y0 <= y && y < e.y1) xs.push({ x: e.x0 + ((y - e.y0) / (e.y1 - e.y0)) * (e.x1 - e.x0), dim: e.dim, d: 1 });
    else if (e.y1 <= y && y < e.y0) xs.push({ x: e.x0 + ((y - e.y0) / (e.y1 - e.y0)) * (e.x1 - e.x0), dim: e.dim, d: -1 });
  }
  xs.sort((a, b) => a.x - b.x);
  const w = new Int32Array(dims);
  const out: [number, number][] = [];
  let start: number | null = null;
  for (let i = 0; i < xs.length; i++) {
    const c = xs[i]!;
    w[c.dim]! += c.d;
    // Apply every crossing at the same x before deciding.
    if (i + 1 < xs.length && xs[i + 1]!.x === c.x) continue;
    const ins = pred(w);
    if (ins && start === null) start = c.x;
    else if (!ins && start !== null) {
      out.push([start, c.x]);
      start = null;
    }
  }
  return out;
}

function intervalXor(a: [number, number][], b: [number, number][]): number {
  const ev: [number, number][] = [];
  for (const [s, e] of a) ev.push([s, 1], [e, -1]);
  for (const [s, e] of b) ev.push([s, 2], [e, -2]);
  ev.sort((p, q) => p[0] - q[0]);
  let ina = 0, inb = 0, last = 0, total = 0;
  for (const [x, k] of ev) {
    if ((ina > 0) !== (inb > 0)) total += x - last;
    if (k === 1) ina++;
    else if (k === -1) ina--;
    else if (k === 2) inb++;
    else inb--;
    last = x;
  }
  return total;
}

/** Size of the bounding box of all operands and the result (for relative tolerances). */
function extentOf(operands: readonly (readonly FillShape[])[], result: readonly (readonly Cubic[])[]): number {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (c: Cubic): void => {
    for (const [x, y] of [[c.x0, c.y0], [c.x1, c.y1], [c.x2, c.y2], [c.x3, c.y3]] as const) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  };
  for (const shapes of operands) for (const s of shapes) for (const c of s.contours) c.forEach(add);
  for (const c of result) c.forEach(add);
  const e = Math.max(maxX - minX, maxY - minY);
  return Number.isFinite(e) && e > 0 ? e : 1;
}

const intervalLength = (a: [number, number][]): number => a.reduce((s, [p, q]) => s + q - p, 0);

export interface ReferenceComparison {
  /** Area of the expected result. */
  readonly expectedArea: number;
  /** Area of the computed result (scanline integrated). */
  readonly resultArea: number;
  /** Area where the computed and expected results disagree. */
  readonly xorArea: number;
}

/** Compares `result` (nonzero contours) with the reference evaluation of `op` on operands. */
export function compareWithReference(
  op: BooleanOperation,
  operands: readonly (readonly FillShape[])[],
  result: readonly (readonly Cubic[])[],
  rows = 1500,
  relTol = 5e-6,
): ReferenceComparison {
  const tol = relTol * extentOf(operands, result);
  const opEdges: Edge[] = [];
  const rules: FillRule[] = [];
  const dimOperand: number[] = [];
  operands.forEach((shapes, k) => {
    for (const s of shapes) {
      edgesOf(s, rules.length, tol, opEdges);
      rules.push(s.fillRule);
      dimOperand.push(k);
    }
  });
  const resEdges: Edge[] = [];
  edgesOf({ contours: result, fillRule: "nonzero" }, 0, tol, resEdges);
  let minY = Infinity, maxY = -Infinity;
  for (const e of [...opEdges, ...resEdges]) {
    minY = Math.min(minY, e.y0, e.y1);
    maxY = Math.max(maxY, e.y0, e.y1);
  }
  if (!(maxY > minY)) return { expectedArea: 0, resultArea: 0, xorArea: 0 };
  const k = operands.length;
  const ins = new Array<boolean>(k);
  const expectedPred = (w: Int32Array): boolean => {
    ins.fill(false);
    for (let d = 0; d < rules.length; d++) if (inside(w[d]!, rules[d]!)) ins[dimOperand[d]!] = true;
    switch (op) {
      case "union": return ins.some(Boolean);
      case "intersect": return ins.every(Boolean);
      case "subtract": return ins[0] === true && !ins.slice(1).some(Boolean);
      case "exclude": return ins.filter(Boolean).length % 2 === 1;
    }
  };
  const h = (maxY - minY) / rows;
  let expectedArea = 0, resultArea = 0, xorArea = 0;
  for (let r = 0; r < rows; r++) {
    const y = minY + (r + 0.5) * h;
    const want = rowIntervals(opEdges, rules.length, y, expectedPred);
    const got = rowIntervals(resEdges, 1, y, (w) => w[0] !== 0);
    expectedArea += intervalLength(want) * h;
    resultArea += intervalLength(got) * h;
    xorArea += intervalXor(want, got) * h;
  }
  return { expectedArea, resultArea, xorArea };
}

/** Point-in-shape agreement: the fraction of sample points (away from boundaries) classified differently. */
export function samplePoints(
  op: BooleanOperation,
  operands: readonly (readonly FillShape[])[],
  result: readonly (readonly Cubic[])[],
  count: number,
  rand: () => number,
): { tested: number; mismatched: number } {
  const tol = 1e-5 * extentOf(operands, result);
  const opEdges: Edge[] = [];
  const rules: FillRule[] = [];
  const dimOperand: number[] = [];
  operands.forEach((shapes, k) => {
    for (const s of shapes) {
      edgesOf(s, rules.length, tol, opEdges);
      rules.push(s.fillRule);
      dimOperand.push(k);
    }
  });
  const resEdges: Edge[] = [];
  edgesOf({ contours: result, fillRule: "nonzero" }, 0, tol, resEdges);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const e of opEdges) {
    minX = Math.min(minX, e.x0);
    maxX = Math.max(maxX, e.x0);
    minY = Math.min(minY, e.y0);
    maxY = Math.max(maxY, e.y0);
  }
  const winding = (edges: readonly Edge[], dims: number, x: number, y: number): Int32Array => {
    const w = new Int32Array(dims);
    for (const e of edges) {
      if (e.y0 <= y && y < e.y1) {
        if (e.x0 + ((y - e.y0) / (e.y1 - e.y0)) * (e.x1 - e.x0) > x) w[e.dim]!++;
      } else if (e.y1 <= y && y < e.y0) {
        if (e.x0 + ((y - e.y0) / (e.y1 - e.y0)) * (e.x1 - e.x0) > x) w[e.dim]!--;
      }
    }
    return w;
  };
  const allEdges = [...opEdges, ...resEdges];
  const near = (x: number, y: number, d: number): boolean => {
    for (const e of allEdges) {
      if (Math.min(e.x0, e.x1) - d > x || Math.max(e.x0, e.x1) + d < x || Math.min(e.y0, e.y1) - d > y || Math.max(e.y0, e.y1) + d < y) continue;
      const vx = e.x1 - e.x0, vy = e.y1 - e.y0;
      const l2 = vx * vx + vy * vy;
      const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - e.x0) * vx + (y - e.y0) * vy) / l2));
      if (Math.hypot(x - e.x0 - vx * t, y - e.y0 - vy * t) < d) return true;
    }
    return false;
  };
  const k = operands.length;
  let tested = 0, mismatched = 0;
  const margin = 1e-3 * Math.max(maxX - minX, maxY - minY);
  for (let i = 0; i < count; i++) {
    const x = minX + (maxX - minX) * rand();
    const y = minY + (maxY - minY) * rand();
    if (near(x, y, margin)) continue;
    tested++;
    const w = winding(opEdges, rules.length, x, y);
    const ins = new Array<boolean>(k).fill(false);
    for (let d = 0; d < rules.length; d++) if (inside(w[d]!, rules[d]!)) ins[dimOperand[d]!] = true;
    let want: boolean;
    switch (op) {
      case "union": want = ins.some(Boolean); break;
      case "intersect": want = ins.every(Boolean); break;
      case "subtract": want = ins[0] === true && !ins.slice(1).some(Boolean); break;
      case "exclude": want = ins.filter(Boolean).length % 2 === 1; break;
    }
    const got = winding(resEdges, 1, x, y)[0] !== 0;
    if (got !== want) mismatched++;
  }
  return { tested, mismatched };
}
