import { afterAll, describe, expect, it } from "vitest";
import {
  BooleanEvaluator,
  Path,
  booleanOperation,
  contoursArea,
  defaultEps,
  ellipseArcPath,
  ellipsePath,
  intersectCurves,
  parseSvgPath,
  pathShape,
  polygonPath,
  roundedRectPath,
  simplifyShape,
  starPath,
  transformCubic,
  type BooleanOperation,
  type Cubic,
  type FillRule,
  type FillShape,
} from "../src";
import { compareWithReference, samplePoints } from "./boolean-reference";
import { rng } from "./helpers";

const OPS: BooleanOperation[] = ["union", "subtract", "intersect", "exclude"];

interface Stats {
  cases: number;
  passed: number;
  maxRelXor: number;
  maxAbsXor: number;
  sampleTested: number;
  sampleMismatched: number;
  curvesIn: number;
  curvesOut: number;
  retries: number;
}
const stats: Stats = { cases: 0, passed: 0, maxRelXor: 0, maxAbsXor: 0, sampleTested: 0, sampleMismatched: 0, curvesIn: 0, curvesOut: 0, retries: 0 };

afterAll(() => {
  // Printed for docs/benchmarks: the robustness summary of this suite.
  console.log(`[boolean robustness] ${JSON.stringify(stats)}`);
});

function poly(pts: readonly (readonly [number, number])[], rule: FillRule = "nonzero"): FillShape {
  const p = new Path();
  pts.forEach(([x, y], i) => (i === 0 ? p.moveTo(x, y) : p.lineTo(x, y)));
  return pathShape(p.close(), rule);
}
const rect = (x: number, y: number, w: number, h: number): FillShape => poly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]);
const circle = (cx: number, cy: number, r: number): FillShape => pathShape(ellipsePath(cx, cy, r, r));
const svg = (d: string, rule: FillRule = "nonzero"): FillShape => pathShape(parseSvgPath(d).path, rule);

function perimeter(shapes: readonly FillShape[]): number {
  let p = 0;
  for (const s of shapes) for (const c of s.contours) for (const k of c) p += Math.hypot(k.x1 - k.x0, k.y1 - k.y0) + Math.hypot(k.x2 - k.x1, k.y2 - k.y1) + Math.hypot(k.x3 - k.x2, k.y3 - k.y2);
  return p;
}

function extent(shapes: readonly FillShape[]): number {
  let m = 0;
  for (const s of shapes) for (const c of s.contours) for (const k of c) m = Math.max(m, Math.abs(k.x0), Math.abs(k.y0), Math.abs(k.x3), Math.abs(k.y3));
  return Math.max(m, 1e-9);
}

/** Output contours must be closed, and no two output curves may cross away from their shared end points. */
function checkTopology(contours: readonly (readonly Cubic[])[], eps: number, label = ""): void {
  for (const c of contours) {
    expect(c.length).toBeGreaterThan(0);
    for (let i = 0; i < c.length; i++) {
      const a = c[i]!, b = c[(i + 1) % c.length]!;
      expect(Math.hypot(a.x3 - b.x0, a.y3 - b.y0)).toBeLessThanOrEqual(eps);
    }
  }
  // Sweep over x: only curves whose boxes overlap are intersected.
  const all = contours.flat().map((c) => ({ c, minX: Math.min(c.x0, c.x1, c.x2, c.x3), maxX: Math.max(c.x0, c.x1, c.x2, c.x3) }));
  all.sort((p, q) => p.minX - q.minX);
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length && all[j]!.minX <= all[i]!.maxX + eps; j++) {
      const a = all[i]!.c, b = all[j]!.c;
      const r = intersectCurves(a, b, eps);
      for (const h of r.hits) {
        const atEnd = (t: number): boolean => t < 1e-6 || t > 1 - 1e-6;
        // Contacts away from end points are allowed only as touches at a vertex of the result.
        if (!atEnd(h.t) || !atEnd(h.u)) {
          const ends = [[a.x0, a.y0], [a.x3, a.y3], [b.x0, b.y0], [b.x3, b.y3]];
          const nearEnd = ends.some(([x, y]) => Math.hypot(x! - h.x, y! - h.y) <= eps * 10);
          expect(nearEnd, `${label}: crossing at ${h.x},${h.y} between ${JSON.stringify(a)} and ${JSON.stringify(b)}`).toBe(true);
        }
      }
    }
  }
}

function check(
  name: string,
  op: BooleanOperation,
  operands: readonly (readonly FillShape[])[],
  opts: { maxCurves?: number; expectedArea?: number; contours?: number; seed?: number } = {},
): Cubic[][] {
  const res = booleanOperation(op, operands.map((shapes) => ({ shapes })));
  stats.cases++;
  stats.retries += res.retries;
  if (res.retries > 0) console.log(`[boolean retry] ${name} ${op}: ${res.retries}`);
  expect(res.inconsistencies, `${name} ${op}: winding inconsistencies`).toBe(0);
  const cmp = compareWithReference(op, operands, res.contours, 1200);
  const allShapes = operands.flat();
  // The reference flattens within 5e-6 of the extent: allow that much error along every edge.
  const tolerance = Math.max(1e-6 * cmp.expectedArea, perimeter(allShapes) * extent(allShapes) * 2e-5 + 1e-12);
  expect(cmp.xorArea, `${name} ${op}: area where result and reference disagree (expected area ${cmp.expectedArea})`).toBeLessThanOrEqual(tolerance);
  if (opts.expectedArea !== undefined) expect(Math.abs(contoursArea(res.contours))).toBeCloseTo(opts.expectedArea, 3);
  if (opts.contours !== undefined) expect(res.contours.length, `${name} ${op}: contour count`).toBe(opts.contours);
  const curvesIn = allShapes.reduce((s, sh) => s + sh.contours.reduce((t, c) => t + c.length, 0), 0);
  const curvesOut = res.contours.reduce((s, c) => s + c.length, 0);
  if (opts.maxCurves !== undefined) expect(curvesOut, `${name} ${op}: curve count`).toBeLessThanOrEqual(opts.maxCurves);
  // Contacts closer than the engine's own snapping tolerance are touches, not crossings.
  checkTopology(res.contours, 4 * defaultEps(extent(allShapes)), `${name} ${op}`);
  const sample = samplePoints(op, operands, res.contours, 300, rng(opts.seed ?? 1));
  expect(sample.mismatched, `${name} ${op}: point samples classified differently`).toBe(0);
  stats.passed++;
  stats.maxRelXor = Math.max(stats.maxRelXor, cmp.xorArea / Math.max(cmp.expectedArea, 1));
  stats.maxAbsXor = Math.max(stats.maxAbsXor, cmp.xorArea);
  stats.sampleTested += sample.tested;
  stats.sampleMismatched += sample.mismatched;
  stats.curvesIn += curvesIn;
  stats.curvesOut += curvesOut;
  return res.contours;
}

function all(name: string, operands: readonly (readonly FillShape[])[], opts: { maxCurves?: number } = {}): void {
  for (const op of OPS) check(name, op, operands, opts);
}

describe("booleans: basic", () => {
  it("overlapping squares", () => {
    const a = rect(100, 100, 200, 200), b = rect(200, 200, 200, 200);
    expect(check("squares", "union", [[a], [b]], { expectedArea: 70000, contours: 1, maxCurves: 8 })).toBeDefined();
    check("squares", "subtract", [[a], [b]], { expectedArea: 30000, contours: 1, maxCurves: 6 });
    check("squares", "intersect", [[a], [b]], { expectedArea: 10000, contours: 1, maxCurves: 4 });
    check("squares", "exclude", [[a], [b]], { expectedArea: 60000, contours: 2, maxCurves: 12 });
  });

  it("overlapping circles: curves out, not polylines", () => {
    const a = circle(0, 0, 50), b = circle(40, 10, 40);
    for (const op of OPS) check("circles", op, [[a], [b]], { maxCurves: 12 });
    const u = booleanOperation("union", [{ shapes: [a] }, { shapes: [b] }]).contours;
    expect(u.flat().every((c) => !c.line)).toBe(true);
  });

  it("disjoint and nested shapes", () => {
    all("disjoint", [[rect(0, 0, 10, 10)], [rect(20, 20, 10, 10)]]);
    all("nested", [[rect(0, 0, 100, 100)], [circle(50, 50, 20)]]);
    all("nested reversed", [[circle(50, 50, 20)], [rect(0, 0, 100, 100)]]);
    all("concentric squares", [[rect(0, 0, 100, 100)], [rect(10, 10, 80, 80)], [rect(20, 20, 60, 60)], [rect(30, 30, 40, 40)]]);
  });
});

describe("booleans: adversarial", () => {
  it("coincident edges (shared sides, identical shapes, same circle split differently)", () => {
    all("shared edge", [[rect(0, 0, 100, 100)], [rect(100, 0, 100, 100)]], { maxCurves: 8 });
    check("shared edge", "union", [[rect(0, 0, 100, 100)], [rect(100, 0, 100, 100)]], { contours: 1, maxCurves: 4, expectedArea: 20000 });
    all("partial shared edge", [[rect(0, 0, 100, 100)], [rect(100, 30, 50, 40)]]);
    all("identical squares", [[rect(0, 0, 100, 100)], [rect(0, 0, 100, 100)]]);
    all("identical circles", [[circle(0, 0, 50)], [circle(0, 0, 50)]]);
    // The same circle as an ellipse and as a fully rounded rectangle: different cubic decompositions.
    all("circle as rounded rect", [[circle(0, 0, 50)], [pathShape(roundedRectPath(-50, -50, 100, 100, 50))]]);
    // Half of a circle drawn separately (sub-arcs of the same circle).
    all("half circle", [[circle(0, 0, 50)], [pathShape(ellipseArcPath(-50, -50, 100, 100, 0, Math.PI, 0))]]);
    all("reversed duplicate", [[rect(0, 0, 100, 100)], [poly([[0, 0], [0, 100], [100, 100], [100, 0]])]]);
    all("overlapping collinear edges", [[rect(0, 0, 100, 50)], [rect(50, 0, 100, 50)], [rect(25, 0, 100, 50)]]);
  });

  it("tangential touches", () => {
    all("circle touching square outside", [[rect(0, 0, 100, 100)], [circle(150, 50, 50)]]);
    all("circle touching square inside", [[rect(0, 0, 100, 100)], [circle(50, 50, 50)]]);
    all("circle inscribed in corner", [[rect(0, 0, 100, 100)], [circle(30, 30, 30)]]);
    all("circles externally tangent", [[circle(0, 0, 50)], [circle(100, 0, 50)]]);
    all("circles internally tangent", [[circle(0, 0, 50)], [circle(20, 0, 30)]]);
    all("squares touching at a corner", [[rect(0, 0, 10, 10)], [rect(10, 10, 10, 10)]]);
    all("T-junction", [[rect(0, 0, 100, 100)], [rect(50, 100, 100, 50)]]);
  });

  it("self-intersections and fill rules", () => {
    const star = (rule: FillRule): FillShape => poly([[50, 0], [79, 90], [2, 35], [98, 35], [21, 90]], rule);
    all("pentagram nonzero", [[star("nonzero")], [rect(30, 30, 40, 40)]]);
    all("pentagram evenodd", [[star("evenodd")], [rect(30, 30, 40, 40)]]);
    all("figure eight", [[poly([[0, 0], [100, 100], [100, 0], [0, 100]])], [circle(50, 50, 30)]]);
    // A cubic that loops over itself.
    all("cubic loop", [[svg("M0 0 C 150 100 -50 100 100 0 Z")], [rect(20, 20, 60, 60)]]);
    all("cubic loop evenodd", [[svg("M0 0 C 150 100 -50 100 100 0 Z", "evenodd")], [circle(50, 40, 25)]]);
    // Self-overlapping contour winding twice.
    all("double wound", [[svg("M0 0 L100 0 L100 100 L0 100 Z M0 0 L100 0 L100 100 L0 100 Z")], [rect(50, 50, 100, 100)]]);
    const s = simplifyShape(svg("M0 0 L100 100 L100 0 L0 100 Z"));
    expect(s.contours).toHaveLength(2);
  });

  it("holes", () => {
    const donut = pathShape(ellipseArcPath(0, 0, 100, 100, 0, Math.PI * 2, 0.5));
    all("donut and circle", [[donut], [circle(50, 50, 30)]]);
    all("donut and bar", [[donut], [rect(40, -10, 20, 120)]]);
    all("two donuts", [[donut], [pathShape(ellipseArcPath(50, 0, 100, 100, 0, Math.PI * 2, 0.4))]]);
    all("frame with hole (evenodd)", [[svg("M0 0H100V100H0Z M25 25H75V75H25Z", "evenodd")], [rect(50, 50, 100, 100)]]);
  });

  it("degenerate input: zero-length segments, spikes, repeated points, zero-area operands", () => {
    all("zero-length segments", [[svg("M0 0 L0 0 L100 0 L100 0 L100 100 L0 100 Z")], [rect(50, 50, 100, 100)]]);
    all("spike", [[svg("M0 0 L100 0 L100 100 L50 100 L50 200 L50 100 L0 100 Z")], [rect(25, 50, 50, 100)]]);
    all("collinear points", [[svg("M0 0 L50 0 L100 0 L100 50 L100 100 L0 100 Z")], [rect(50, -50, 100, 100)]]);
    all("zero-area operand", [[rect(0, 0, 100, 100)], [svg("M20 20 L80 80 Z")]]);
    all("empty operand", [[rect(0, 0, 100, 100)], []]);
    all("degenerate cubic", [[svg("M0 0 C0 0 0 0 100 0 L100 100 L0 100 Z")], [circle(100, 50, 30)]]);
  });

  it("near-coincident edges and extreme scales", () => {
    all("offset by 1e-10", [[rect(0, 0, 100, 100)], [rect(100 + 1e-10, 0, 100, 100)]]);
    all("offset by 1e-7", [[rect(0, 0, 100, 100)], [rect(100 - 1e-7, 0, 100, 100)]]);
    const big = (s: FillShape, k: number, dx: number): FillShape => ({ fillRule: s.fillRule, contours: s.contours.map((c) => c.map((q) => transformCubic(q, [k, 0, 0, k, dx, dx]))) });
    all("large coordinates", [[big(circle(0, 0, 50), 100, 1e5)], [big(circle(40, 10, 40), 100, 1e5)]]);
    all("tiny coordinates", [[big(circle(0, 0, 50), 1e-4, 0)], [big(circle(40, 10, 40), 1e-4, 0)]]);
  });

  it("many operands", () => {
    const ring = Array.from({ length: 20 }, (_, i) => [circle(100 * Math.cos((i / 20) * Math.PI * 2), 100 * Math.sin((i / 20) * Math.PI * 2), 30)]);
    check("ring of 20 circles", "union", ring);
    check("ring of 20 circles", "exclude", ring);
    check("ring of 20 circles", "intersect", ring);
    check("ring of 20 circles", "subtract", ring);
    const stack = Array.from({ length: 12 }, (_, i) => [rect(i * 10, i * 7, 80, 60)]);
    for (const op of OPS) check("staircase of 12 rects", op, stack);
    const stars = Array.from({ length: 8 }, (_, i) => [pathShape(starPath(i * 15, (i % 3) * 20, 100, 100, 5 + i, 0.4, i))]);
    for (const op of OPS) check("8 stars", op, stars);
  });

  it("dense clusters: 200 mutually overlapping curved shapes", { timeout: 120_000 }, () => {
    const r = rng(9);
    const shapes = Array.from({ length: 200 }, () => {
      const s = randomShape(r);
      const m = [3, 0, 0, 3, r() * 300, r() * 300] as const;
      return [{ ...s, contours: s.contours.map((c) => c.map((q) => transformCubic(q, m))) }];
    });
    for (const op of ["union", "exclude"] as const) check("200 overlapping shapes", op, shapes);
  });

  it("vector-network-like operands (union of regions with their own rules)", () => {
    const a: FillShape[] = [rect(0, 0, 100, 100), { ...circle(50, 50, 30), fillRule: "evenodd" }];
    const b: FillShape[] = [circle(100, 50, 40)];
    all("multi-shape operands", [a, b]);
  });
});

describe("booleans: near-tangent fuzz", () => {
  it("circles and rotated rectangles tangent or within 1e-9 to 1e-4 of tangency (100 seeds)", { timeout: 300_000 }, () => {
    for (let seed = 1; seed <= 100; seed++) {
      const r = rng(seed * 31337);
      const radius = 5 + r() * 50;
      const cx = r() * 100, cy = r() * 100;
      const angle = r() * Math.PI * 2;
      const gap = [0, 1e-9, -1e-9, 1e-6, -1e-6, 1e-4][Math.floor(r() * 6)]! * radius;
      // A rectangle whose near side is tangent to the circle (outside), offset by gap.
      const d = radius + gap;
      const ux = Math.cos(angle), uy = Math.sin(angle), vx = -uy, vy = ux;
      const w = 10 + r() * 80, h = 10 + r() * 40, along = (r() - 0.5) * w;
      const p0 = [cx + ux * d + vx * (along - w / 2), cy + uy * d + vy * (along - w / 2)] as const;
      const pts: [number, number][] = [
        [p0[0], p0[1]],
        [p0[0] + vx * w, p0[1] + vy * w],
        [p0[0] + vx * w + ux * h, p0[1] + vy * w + uy * h],
        [p0[0] + ux * h, p0[1] + uy * h],
      ];
      // A circle "cap" tangent to a band, as stroke outlines produce, plus a second circle tangent to the first.
      const c2r = radius * (0.2 + r() * 0.5);
      const c2 = circle(cx + ux * (radius + c2r + gap) + vx * w, cy + uy * (radius + c2r + gap) + vy * w, c2r);
      const shapes = [[circle(cx, cy, radius)], [poly(pts)], [c2]];
      for (const op of OPS) check(`near-tangent seed ${seed}`, op, shapes, { seed });
    }
  });
});

describe("booleans: random fuzz against the reference", () => {
  it("200 seeds × 4 operations on random curved, polygonal and self-intersecting shapes", { timeout: 600_000 }, () => {
    let failures = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed * 104729);
      const n = 2 + Math.floor(r() * 3);
      const shapes = Array.from({ length: n }, () => randomShape(r));
      for (const op of OPS) {
        try {
          check(`seed ${seed}`, op, shapes.map((s) => [s]), { seed });
        } catch (e) {
          failures++;
          throw e;
        }
      }
    }
    expect(failures).toBe(0);
  });
});

describe("booleans: incremental evaluation", () => {
  it("recomputes only the clusters an edit touches", () => {
    const ev = new BooleanEvaluator();
    const operands = Array.from({ length: 50 }, (_, i) => ({ key: `c${i}:0`, shapes: [circle((i % 10) * 100, Math.floor(i / 10) * 100, 30 + (i % 3) * 15)] }));
    const first = ev.evaluate("union", operands);
    expect(ev.lastComputed).toBe(ev.lastClusters);
    const again = ev.evaluate("union", operands);
    expect(ev.lastComputed).toBe(0);
    expect(again.contours.length).toBe(first.contours.length);
    operands[7] = { key: "c7:1", shapes: [circle(700, 0, 80)] };
    ev.evaluate("union", operands);
    expect(ev.lastComputed).toBeLessThanOrEqual(2);
  });
});

export function randomShapeForDebug(r: () => number): FillShape {
  return randomShape(r);
}

function randomShape(r: () => number): FillShape {
  const kind = Math.floor(r() * 6);
  const x = r() * 100, y = r() * 100, w = 10 + r() * 80, h = 10 + r() * 80;
  switch (kind) {
    case 0: return pathShape(ellipsePath(x, y, w / 2, h / 2));
    case 1: return pathShape(starPath(x, y, w, h, 3 + Math.floor(r() * 6), r(), r() * 5));
    case 2: return pathShape(roundedRectPath(x, y, w, h, r() * 30, r()));
    case 3: {
      // Grid-snapped polygons: many shared vertices, collinear and coincident edges.
      const pts: [number, number][] = [];
      const n = 3 + Math.floor(r() * 8);
      for (let i = 0; i < n; i++) pts.push([Math.round(r() * 20) * 5, Math.round(r() * 20) * 5]);
      return poly(pts, r() < 0.5 ? "nonzero" : "evenodd");
    }
    case 4: return pathShape(polygonPath(x, y, w, h, 3 + Math.floor(r() * 5), r() * 10));
    default: {
      const p = new Path();
      const n = 2 + Math.floor(r() * 4);
      p.moveTo(r() * 100, r() * 100);
      for (let i = 0; i < n; i++) p.cubicTo(r() * 100, r() * 100, r() * 100, r() * 100, r() * 100, r() * 100);
      return pathShape(p.close(), r() < 0.5 ? "nonzero" : "evenodd");
    }
  }
}
