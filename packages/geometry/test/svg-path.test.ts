import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  Verb,
  formatSvgPath,
  networkToSvgPath,
  parseSvgPath,
  pathToNetwork,
  pointAt,
  svgPathToNetwork,
  validateNetwork,
  type Cubic,
  type Path,
  type VectorNetwork,
} from "../src";

function cubics(path: Path): Cubic[] {
  const out: Cubic[] = [];
  let x = 0, y = 0;
  for (const c of path.commands()) {
    if (c.verb === Verb.MoveTo || c.verb === Verb.LineTo) {
      x = c.x;
      y = c.y;
    } else if (c.verb === Verb.CubicTo) {
      out.push({ x0: x, y0: y, x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2, x3: c.x, y3: c.y, line: false });
      x = c.x;
      y = c.y;
    }
  }
  return out;
}

function expectNetworksEqual(a: VectorNetwork, b: VectorNetwork, tol = 1e-9): void {
  expect(b.vertices.length).toBe(a.vertices.length);
  expect(b.segments.length).toBe(a.segments.length);
  a.vertices.forEach((v, i) => {
    expect(Math.abs(v.x - b.vertices[i]!.x)).toBeLessThanOrEqual(tol * (1 + Math.abs(v.x)));
    expect(Math.abs(v.y - b.vertices[i]!.y)).toBeLessThanOrEqual(tol * (1 + Math.abs(v.y)));
  });
  a.segments.forEach((s, i) => {
    const t = b.segments[i]!;
    expect([t.start, t.end]).toEqual([s.start, s.end]);
    for (const k of ["tangentStart", "tangentEnd"] as const) {
      const p = s[k] ?? { x: 0, y: 0 }, q = t[k] ?? { x: 0, y: 0 };
      expect(Math.abs(p.x - q.x)).toBeLessThanOrEqual(tol * (1 + Math.abs(p.x) + Math.abs(a.vertices[s.start]!.x)));
      expect(Math.abs(p.y - q.y)).toBeLessThanOrEqual(tol * (1 + Math.abs(p.y) + Math.abs(a.vertices[s.start]!.y)));
    }
  });
}

describe("SVG path data", () => {
  it("parses every command, absolute and relative", () => {
    const abs = parseSvgPath("M10 10 L20 10 H30 V20 C30 30 20 30 20 20 S10 10 10 20 Q5 25 0 20 T-10 20 Z");
    const rel = parseSvgPath("m10 10 l10 0 h10 v10 c0 10-10 10-10 0 s-10-10-10 0 q-5 5-10 0 t-10 0 z");
    expect(abs.error).toBeNull();
    expect(rel.error).toBeNull();
    expect(formatSvgPath(rel.path)).toBe(formatSvgPath(abs.path));
    expect(formatSvgPath(abs.path)).toBe("M10 10L20 10L30 10L30 20C30 30 20 30 20 20C20 10 10 10 10 20Q5 25 0 20Q-5 15 -10 20Z");
  });

  it("handles compact number syntax and implicit repetition", () => {
    const p = parseSvgPath("M.5.5l1e1-2.5.25.75 1,1zm1 1 2 2");
    expect(p.error).toBeNull();
    expect(formatSvgPath(p.path)).toBe("M0.5 0.5L10.5 -2L10.75 -1.25L11.75 -0.25ZM1.5 1.5L3.5 3.5");
  });

  it("keeps what came before a syntax error", () => {
    const p = parseSvgPath("M0 0 L10 10 L20 x");
    expect(p.error).toMatch(/expected a number/);
    expect(formatSvgPath(p.path)).toBe("M0 0L10 10");
    expect(parseSvgPath("L10 10").error).toMatch(/moveto/);
  });

  it("converts arcs from the endpoint parameterization", () => {
    // Semicircle from (0,0) to (100,0), sweep 1: center (50,0), through (50,-50) in y-down axes.
    const p = parseSvgPath("M0 0 A50 50 0 0 1 100 0").path;
    const cs = cubics(p);
    expect(cs).toHaveLength(2);
    for (const c of cs) {
      for (let i = 0; i <= 20; i++) {
        const q = pointAt(c, i / 20);
        expect(Math.abs(Math.hypot(q.x - 50, q.y) - 50)).toBeLessThan(50 * 3e-4);
      }
    }
    expect(cs[0]!.y3).toBeCloseTo(-50, 9);
    expect(cs[1]!.x3).toBe(100);
    // Large arc flag picks the long way round.
    const big = cubics(parseSvgPath("M0 0 A50 50 0 1 0 50 50").path);
    expect(big).toHaveLength(3);
  });

  it("rotates elliptical arcs and scales radii that are too small", () => {
    const rot = 30;
    const p = parseSvgPath(`M0 0 A80 40 ${rot} 0 1 100 50`).path;
    const cs = cubics(p);
    // Every point is on one ellipse with radii 80, 40 rotated 30°: find its center from the first point's constraint.
    const phi = (rot * Math.PI) / 180;
    const local = (x: number, y: number): [number, number] => [Math.cos(phi) * x + Math.sin(phi) * y, -Math.sin(phi) * x + Math.cos(phi) * y];
    // Fit the center: use the conversion's own math via three points: check (x'/rx)² + (y'/ry)² is constant.
    const values: number[] = [];
    const center = solveCenter(cs, phi);
    for (const c of cs) {
      for (let i = 0; i <= 10; i++) {
        const q = pointAt(c, i / 10);
        const [lx, ly] = local(q.x - center[0], q.y - center[1]);
        values.push((lx / 80) ** 2 + (ly / 40) ** 2);
      }
    }
    for (const v of values) expect(Math.abs(v - 1)).toBeLessThan(2e-3);
    // Radii too small: scaled until the arc fits, so the center is the chord midpoint.
    const tiny = cubics(parseSvgPath("M0 0 A1 1 0 0 1 100 0").path);
    const mid = pointAt(tiny[0]!, 1);
    expect(Math.hypot(mid.x - 50, mid.y)).toBeCloseTo(50, 6);
    // Zero radius: a line.
    expect(formatSvgPath(parseSvgPath("M0 0 A0 10 0 0 1 10 10").path)).toBe("M0 0L10 10");
    // Arc flags without separators.
    expect(parseSvgPath("M0 0a5 5 0 1010 0").error).toBeNull();
  });

  it("round-trips: parse → network → serialize → parse gives the same network (within 1e-9)", () => {
    fc.assert(
      fc.property(pathDataArb, (d) => {
        const { error } = parseSvgPath(d);
        expect(error).toBeNull();
        const n1 = svgPathToNetwork(d);
        expect(validateNetwork(n1)).toEqual([]);
        const d2 = networkToSvgPath(n1);
        const n2 = svgPathToNetwork(d2);
        expectNetworksEqual(n1, n2);
        // And once more is a fixed point of the text.
        expect(networkToSvgPath(n2)).toBe(networkToSvgPath(svgPathToNetwork(networkToSvgPath(n2))));
      }),
      { numRuns: 400 },
    );
  });

  it("round-trips networks with branches through path data", () => {
    const d = "M0 0L100 0L100 100L0 0ZM100 0L150 50C160 60 170 60 180 50";
    const n1 = svgPathToNetwork(d);
    expect(n1.vertices).toHaveLength(5);
    const n2 = svgPathToNetwork(networkToSvgPath(n1));
    expect(n2.vertices.length).toBe(n1.vertices.length);
    expect(n2.segments.length).toBe(n1.segments.length);
  });
});

/** Solves the ellipse center from the arc's start point (0,0) and end (100,50) using the F.6.5 formulas. */
function solveCenter(cs: Cubic[], phi: number): [number, number] {
  void cs;
  const rx = 80, ry = 40, x1 = 0, y1 = 0, x2 = 100, y2 = 50;
  const cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy;
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coef = -Math.sqrt(Math.max(0, num / den)); // largeArc 0 == sweep 1? no: 0 !== 1 → positive
  const c = -coef;
  const cxp = (c * rx * y1p) / ry, cyp = (-c * ry * x1p) / rx;
  return [cos * cxp - sin * cyp + (x1 + x2) / 2, sin * cxp + cos * cyp + (y1 + y2) / 2];
}

const num = fc.integer({ min: -400, max: 400 }).map((n) => n / 4);
const posNum = fc.integer({ min: 1, max: 400 }).map((n) => n / 4);
const segmentArb = fc.oneof(
  fc.tuple(fc.constantFrom("L", "l"), num, num).map(([c, x, y]) => `${c}${x} ${y}`),
  fc.tuple(fc.constantFrom("H", "h", "V", "v"), num).map(([c, x]) => `${c}${x}`),
  fc.tuple(fc.constantFrom("C", "c"), num, num, num, num, num, num).map(([c, ...a]) => `${c}${a.join(" ")}`),
  fc.tuple(fc.constantFrom("S", "s", "Q", "q"), num, num, num, num).map(([c, ...a]) => `${c}${a.join(" ")}`),
  fc.tuple(fc.constantFrom("T", "t"), num, num).map(([c, x, y]) => `${c}${x} ${y}`),
  fc.tuple(fc.constantFrom("A", "a"), posNum, posNum, fc.integer({ min: 0, max: 359 }), fc.boolean(), fc.boolean(), num, num).map(
    ([c, rx, ry, rot, l, s, x, y]) => `${c}${rx} ${ry} ${rot} ${l ? 1 : 0} ${s ? 1 : 0} ${x} ${y}`,
  ),
);
const subpathArb = fc.tuple(fc.constantFrom("M", "m"), num, num, fc.array(segmentArb, { minLength: 1, maxLength: 6 }), fc.boolean()).map(
  ([m, x, y, segs, z]) => `${m}${x} ${y} ${segs.join(" ")}${z ? " Z" : ""}`,
);
const pathDataArb = fc.array(subpathArb, { minLength: 1, maxLength: 4 }).map((s) => s.join(" "));

void pathToNetwork;
