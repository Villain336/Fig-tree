import { describe, expect, it } from "vitest";
import {
  Path,
  contoursArea,
  ellipsePath,
  lineCubic,
  outlineStroke,
  parseSvgPath,
  pathContours,
  strokePath,
  type Cubic,
  type FillShape,
  type LineCap,
  type LineJoin,
  type OutlineStrokeStyle,
  type Polylines,
} from "../src";
import { compareWithReference } from "./boolean-reference";

/** The polygon stroker's output as a fill shape (nonzero). */
function polygonShape(p: Polylines): FillShape {
  const contours: Cubic[][] = [];
  for (let c = 0; c + 1 < p.contourStarts.length; c++) {
    const s = p.contourStarts[c]!, e = p.contourStarts[c + 1]!;
    const contour: Cubic[] = [];
    for (let i = s; i < e; i++) {
      const j = i + 1 < e ? i + 1 : s;
      contour.push(lineCubic(p.points[i * 2]!, p.points[i * 2 + 1]!, p.points[j * 2]!, p.points[j * 2 + 1]!));
    }
    contours.push(contour);
  }
  return { contours, fillRule: "nonzero" };
}

function compare(path: Path, style: OutlineStrokeStyle): { area: number; xor: number; curves: number; polygonPoints: number } {
  const outline = outlineStroke(path, style);
  const reference = strokePath(path, style, undefined, 0.001);
  const cmp = compareWithReference("union", [[polygonShape(reference)]], outline, 1500);
  return { area: cmp.expectedArea, xor: cmp.xorArea, curves: outline.reduce((s, c) => s + c.length, 0), polygonPoints: reference.points.length / 2 };
}

const report: string[] = [];

function pathContoursOf(p: Path): Cubic[][] {
  return pathContours(p);
}

describe("outline stroke", () => {
  const wave = parseSvgPath("M10 50 C 40 0, 70 100, 100 50 S 160 0, 190 50").path;
  const zigzag = parseSvgPath("M10 10 L60 90 L110 10 L160 90").path;
  const closed = parseSvgPath("M20 20 L180 20 L100 160 Z").path;
  const tight = parseSvgPath("M0 0 C 100 0, 100 20, 0 20").path; // turns back on itself: radius smaller than the pen
  const cases: [string, Path][] = [["wave", wave], ["zigzag", zigzag], ["triangle", closed], ["hairpin", tight], ["circle", ellipsePath(100, 100, 60, 40)]];

  for (const [name, path] of cases) {
    for (const join of ["miter", "round", "bevel"] as LineJoin[]) {
      for (const cap of ["butt", "round", "square"] as LineCap[]) {
        it(`${name}, ${join} joins, ${cap} caps`, () => {
          const r = compare(path, { width: 12, join, cap });
          report.push(`${name}/${join}/${cap}: area ${r.area.toFixed(1)}, disagreement ${r.xor.toFixed(4)}, ${r.curves} curves vs ${r.polygonPoints} polygon points`);
          // The two constructions agree to within the reference's own flattening.
          expect(r.xor / r.area).toBeLessThan(2e-3);
          expect(r.curves).toBeLessThanOrEqual(r.polygonPoints);
        });
      }
    }
  }

  it("follows dash patterns", () => {
    const r = compare(wave, { width: 6, dash: [20, 10], dashOffset: 5, cap: "round", join: "round" });
    expect(r.xor / r.area).toBeLessThan(3e-3);
    const r2 = compare(closed, { width: 6, dash: [30, 15, 5, 15], cap: "butt" });
    expect(r2.xor / r2.area).toBeLessThan(3e-3);
  });

  it("outlines thin and thick strokes on curves with curves, not polylines", () => {
    const outline = outlineStroke(ellipsePath(0, 0, 50, 50), { width: 4 });
    expect(outline).toHaveLength(2);
    expect(outline.flat().some((c) => !c.line)).toBe(true);
    // Area of a ring between radii 48 and 52.
    expect(Math.abs(contoursArea(outline))).toBeCloseTo(Math.PI * (52 * 52 - 48 * 48), 0);
  });

  it("handles a width larger than the curvature radius (the inner side vanishes)", () => {
    // A circle of radius 5 stroked 20 wide covers the disk of radius 15 entirely.
    // (The polygon stroker leaves winding-0 holes here, so compare with the exact answer.)
    const outline = outlineStroke(ellipsePath(0, 0, 5, 5), { width: 20 });
    expect(outline).toHaveLength(1);
    expect(Math.abs(contoursArea(outline)) / (Math.PI * 225)).toBeCloseTo(1, 3);
    const disk = ellipsePath(0, 0, 15, 15);
    const cmp = compareWithReference("union", [[{ contours: [disk].flatMap((p) => pathContoursOf(p)), fillRule: "nonzero" }]], outline, 1500);
    expect(cmp.xorArea / cmp.expectedArea).toBeLessThan(2e-3);
  });

  it("prints the comparison", () => {
    console.log(`[outline stroke]\n${report.join("\n")}`);
  });
});
