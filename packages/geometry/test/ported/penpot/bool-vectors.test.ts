/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) KALEIDOS SUBSIDIARY SL
 * Copyright (c) Fig Tree contributors (TypeScript port and changes)
 *
 * Ported from penpot/render-wasm/src/math/bools.rs @5eb33ad (test module:
 * operands A_CW, B_CCW, C_CCW and their expected signed areas, subpath
 * counts and orientation) and from
 * penpot/common/test/common_tests/types/path_data_test.cljc @5eb33ad
 * (`contents-for-bool` union regression, `rect-a`/`rect-b`/`rect-c`
 * difference, intersection, exclusion and non-overlapping union).
 *
 * The data is Penpot's; the assertions are rewritten for Fig Tree's boolean
 * engine (which is not Penpot's algorithm) and additionally check every
 * result against the scanline reference.
 */
import { describe, expect, it } from "vitest";
import { Path, booleanOperation, contoursArea, pathShape, type BooleanOperation, type FillShape } from "../../../src";
import { compareWithReference } from "../../boolean-reference";

function polygon(points: readonly (readonly [number, number])[]): FillShape {
  const p = new Path();
  points.forEach(([x, y], i) => (i === 0 ? p.moveTo(x, y) : p.lineTo(x, y)));
  return pathShape(p.close());
}

// Operands from bools.rs: A clockwise, B and C counter-clockwise (y down), all overlapping.
const A_CW = polygon([[100, 100], [300, 100], [300, 300], [100, 300]]);
const B_CCW = polygon([[200, 200], [200, 400], [400, 400], [400, 200]]);
const C_CCW = polygon([[60, 240], [60, 360], [260, 360], [260, 240]]);

function run(op: BooleanOperation, operands: FillShape[]) {
  const r = booleanOperation(op, operands.map((s) => ({ shapes: [s] })));
  const cmp = compareWithReference(op, operands.map((s) => [s]), r.contours);
  expect(cmp.xorArea).toBeLessThan(1e-6 * Math.max(1, cmp.expectedArea));
  expect(r.inconsistencies).toBe(0);
  return r.contours;
}

describe("Penpot boolean regression vectors (bools.rs)", () => {
  it("difference with an opposite-winding operand (#11482): M100,100 L300,100 L300,200 L200,200 L200,300 L100,300 Z", () => {
    const out = run("subtract", [A_CW, B_CCW]);
    expect(out).toHaveLength(1);
    expect(contoursArea(out)).toBeCloseTo(30000, 6);
    // Penpot's expectation: clockwise in y-down axes = positive shoelace area here.
    expect(contoursArea(out)).toBeGreaterThan(0);
    expect(out[0]!.length).toBe(6);
  });

  it("union with an opposite-winding operand: M100,100 L300,100 L300,200 L400,200 L400,400 L200,400 L200,300 L100,300 Z", () => {
    const out = run("union", [A_CW, B_CCW]);
    expect(out).toHaveLength(1);
    expect(contoursArea(out)).toBeCloseTo(70000, 6);
    expect(out[0]!.length).toBe(8);
  });

  it("difference folds three opposite-winding operands: M100,100 L300,100 L300,200 L200,200 L200,240 L100,240 Z", () => {
    const out = run("subtract", [A_CW, B_CCW, C_CCW]);
    expect(out).toHaveLength(1);
    expect(contoursArea(out)).toBeCloseTo(24000, 6);
    expect(out[0]!.length).toBe(6);
  });
});

// From path_data_test.cljc.
const m = (x: number, y: number) => ({ c: "M" as const, x, y });
const l = (x: number, y: number) => ({ c: "L" as const, x, y });
const c = (c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number) => ({ c: "C" as const, c1x, c1y, c2x, c2y, x, y });
const z = { c: "Z" as const };
type Cmd = ReturnType<typeof m> | ReturnType<typeof l> | ReturnType<typeof c> | typeof z;

function content(cmds: readonly Cmd[]): FillShape {
  const p = new Path();
  for (const k of cmds) {
    if (k.c === "M") p.moveTo(k.x, k.y);
    else if (k.c === "L") p.lineTo(k.x, k.y);
    else if (k.c === "C") p.cubicTo(k.c1x, k.c1y, k.c2x, k.c2y, k.x, k.y);
    else p.close();
  }
  return pathShape(p);
}

const contentsForBool = [
  content([
    m(1682.9000244140625, 48.0), l(1682.9000244140625, 44.0),
    c(1682.9000244140625, 43.400001525878906, 1683.300048828125, 43.0, 1683.9000244140625, 43.0),
    l(1687.9000244140625, 43.0),
    c(1688.5, 43.0, 1688.9000244140625, 43.400001525878906, 1688.9000244140625, 44.0),
    l(1688.9000244140625, 48.0),
    c(1688.9000244140625, 48.599998474121094, 1688.5, 49.0, 1687.9000244140625, 49.0),
    l(1683.9000244140625, 49.0),
    c(1683.300048828125, 49.0, 1682.9000244140625, 48.599998474121094, 1682.9000244140625, 48.0),
    z, z,
    m(1684.9000244140625, 45.0), l(1684.9000244140625, 47.0), l(1686.9000244140625, 47.0), l(1686.9000244140625, 45.0), l(1684.9000244140625, 45.0),
    z, z,
  ]),
  content([
    m(1672.9000244140625, 48.0), l(1672.9000244140625, 44.0),
    c(1672.9000244140625, 43.400001525878906, 1673.300048828125, 43.0, 1673.9000244140625, 43.0),
    l(1677.9000244140625, 43.0),
    c(1678.5, 43.0, 1678.9000244140625, 43.400001525878906, 1678.9000244140625, 44.0),
    l(1678.9000244140625, 48.0),
    c(1678.9000244140625, 48.599998474121094, 1678.5, 49.0, 1677.9000244140625, 49.0),
    l(1673.9000244140625, 49.0),
    c(1673.300048828125, 49.0, 1672.9000244140625, 48.599998474121094, 1672.9000244140625, 48.0),
    z, z,
    m(1674.9000244140625, 45.0), l(1674.9000244140625, 47.0), l(1676.9000244140625, 47.0), l(1676.9000244140625, 45.0), l(1674.9000244140625, 45.0),
    z, z,
  ]),
];

const rectA = content([m(0, 0), l(10, 0), l(10, 10), l(0, 10), l(0, 0), z]);
const rectB = content([m(5, 5), l(15, 5), l(15, 15), l(5, 15), l(5, 5), z]);
const rectC = content([m(20, 20), l(30, 20), l(30, 30), l(20, 30), l(20, 20), z]);

describe("Penpot boolean regression vectors (path_data_test.cljc)", () => {
  it("calculate-bool-content: union of two rounded squares with square holes", () => {
    const out = run("union", contentsForBool);
    // Two outer contours and two holes, like Penpot's expected content (4 subpaths).
    expect(out).toHaveLength(4);
    const area = contoursArea(out);
    const one = contoursArea(contentsForBool[0]!.contours);
    expect(area).toBeCloseTo(2 * one, 9);
  });

  it("difference, intersection and exclusion of overlapping rectangles", () => {
    expect(contoursArea(run("subtract", [rectA, rectB]))).toBeCloseTo(75, 9);
    expect(contoursArea(run("intersect", [rectA, rectB]))).toBeCloseTo(25, 9);
    expect(contoursArea(run("exclude", [rectA, rectB]))).toBeCloseTo(150, 9);
  });

  it("union of non-overlapping rectangles keeps both", () => {
    const out = run("union", [rectA, rectC]);
    expect(out).toHaveLength(2);
    expect(contoursArea(out)).toBeCloseTo(200, 9);
  });
});
