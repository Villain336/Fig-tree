/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) KALEIDOS SUBSIDIARY SL
 * Copyright (c) Fig Tree contributors (TypeScript port and changes)
 *
 * Ported from penpot/common/test/common_tests/types/path_data_test.cljc @5eb33ad
 *
 * The path data (sample-content, sample-content-2, sample-content-large,
 * sample-content-square and the multi-line selrect regression) is Penpot's;
 * the assertions are rewritten against Fig Tree's geometry API.
 */
import { describe, expect, it } from "vitest";
import { Path, flattenPath, multiply, rotation, transformPoint, translation, windingNumber } from "../../../src";

type Command =
  | { readonly command: "move-to" | "line-to"; readonly x: number; readonly y: number }
  | { readonly command: "curve-to"; readonly c1x: number; readonly c1y: number; readonly c2x: number; readonly c2y: number; readonly x: number; readonly y: number }
  | { readonly command: "close-path" };

const m = (x: number, y: number): Command => ({ command: "move-to", x, y });
const l = (x: number, y: number): Command => ({ command: "line-to", x, y });
const c = (c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): Command => ({ command: "curve-to", c1x, c1y, c2x, c2y, x, y });
const z: Command = { command: "close-path" };

function toPath(content: readonly Command[]): Path {
  const p = new Path();
  for (const s of content) {
    if (s.command === "move-to") p.moveTo(s.x, s.y);
    else if (s.command === "line-to") p.lineTo(s.x, s.y);
    else if (s.command === "curve-to") p.cubicTo(s.c1x, s.c1y, s.c2x, s.c2y, s.x, s.y);
    else p.close();
  }
  return p;
}

const sampleContent = [m(480, 839), l(439, 802), c(368, 737, 310, 681, 264, 634), z];

const sampleContent2 = [m(480, 839), l(439, 802), c(368, 737, 310, 681, 4, 4), c(3, 7, 30, -68, 20, 20), z];

const sampleContentSquare = [m(0, 0), l(10, 0), l(10, 10), l(10, 0), l(0, 10), l(0, 0), z];

const sampleContentLarge = [
  m(480, 839), l(439, 802), c(368, 737, 310, 681, 264, 634), c(218, 587, 181, 545, 154, 508),
  c(126, 471, 107, 438, 96, 408), c(85, 378, 80, 347, 80, 317), c(80, 256, 100, 206, 140, 166),
  c(180, 126, 230, 106, 290, 106), c(328, 106, 363, 115, 395, 133), c(427, 151, 456, 177, 480, 211),
  c(508, 175, 537, 148, 569, 131), c(600, 114, 634, 106, 670, 106), c(729, 106, 779, 126, 819, 166),
  c(859, 206, 880, 256, 880, 317), c(880, 347, 874, 378, 863, 408), c(852, 438, 833, 471, 806, 508),
  c(778, 545, 741, 587, 695, 634), c(649, 681, 591, 737, 521, 802), l(480, 839), z,
  m(480, 760), c(547, 698, 603, 644, 646, 600), c(690, 556, 724, 517, 750, 484), c(776, 450, 794, 420, 804, 394),
  c(814, 368, 820, 342, 820, 317), c(820, 273, 806, 236, 778, 2085), c(750, 180, 714, 166, 670, 1660),
  c(635, 166, 604, 176, 574, 1975), c(545, 218, 522, 248, 504, 2860), l(455, 286), c(437, 248, 414, 219, 385, 198),
  c(355, 176, 324, 166, 289, 166), c(245, 166, 210, 180, 182, 208), c(154, 236, 140, 273, 140, 317),
  c(140, 343, 145, 369, 155, 395), c(165, 421, 183, 451, 209, 485), c(235, 519, 270, 558, 314, 602),
  c(358, 646, 413, 698, 480, 760), z,
  m(480, 463), z,
];

/** Bounds of the curve sampled densely, as an independent reference. */
function sampledBounds(path: Path): { minX: number; minY: number; maxX: number; maxY: number } {
  const pts = flattenPath(path, undefined, 1e-4).points;
  const r = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (let i = 0; i < pts.length; i += 2) {
    r.minX = Math.min(r.minX, pts[i]!);
    r.maxX = Math.max(r.maxX, pts[i]!);
    r.minY = Math.min(r.minY, pts[i + 1]!);
    r.maxY = Math.max(r.maxY, pts[i + 1]!);
  }
  return r;
}

function expectBoundsClose(a: ReturnType<typeof sampledBounds>, b: ReturnType<typeof sampledBounds>, eps: number): void {
  expect(Math.abs(a.minX - b.minX)).toBeLessThan(eps);
  expect(Math.abs(a.minY - b.minY)).toBeLessThan(eps);
  expect(Math.abs(a.maxX - b.maxX)).toBeLessThan(eps);
  expect(Math.abs(a.maxY - b.maxY)).toBeLessThan(eps);
}

describe("Penpot path vectors", () => {
  it("extremities-1: a monotonic curve is bounded by its endpoints", () => {
    expect(toPath(sampleContent).bounds()).toEqual({ minX: 264, minY: 634, maxX: 480, maxY: 839 });
  });

  it("extremities-2: curves with interior extrema get tight bounds", () => {
    const path = toPath(sampleContent2);
    const b = path.bounds();
    expect(b.minY).toBeLessThan(4); // the last curve dips above y = 4
    expectBoundsClose(b, sampledBounds(path), 1e-3);
  });

  it("extremities-3: a lone move-to has no area and no segments to fill", () => {
    const flat = flattenPath(toPath([m(-310.5355224609375, 452.62115478515625)]));
    expect(flat.points.length).toBe(2);
    expect(windingNumber(flat, -310.5, 452.6)).toBe(0);
  });

  it("content->selrect: the self-overlapping square spans 0..10", () => {
    expect(toPath(sampleContentSquare).bounds()).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
  });

  it("content->selrect-multi-line: every line-to vertex counts", () => {
    expect(toPath([m(5, 5), l(15, 0), l(20, 8), l(10, 12)]).bounds()).toEqual({ minX: 5, minY: 0, maxX: 20, maxY: 12 });
  });

  it("sample-content-large: tight bounds match dense sampling, including the outlier control data", () => {
    const path = toPath(sampleContentLarge);
    expectBoundsClose(path.bounds(), sampledBounds(path), 1e-3);
  });

  it("path-transform-2: translating the large path translates its bounds", () => {
    const path = toPath(sampleContentLarge);
    const b = path.bounds();
    expect(path.transform(translation(10, 10)).bounds()).toEqual({ minX: b.minX + 10, minY: b.minY + 10, maxX: b.maxX + 10, maxY: b.maxY + 10 });
  });

  it("path-transform-3: rotating by 42° maps every point", () => {
    const rot = multiply(rotation((42 * Math.PI) / 180), translation(0, 0));
    const path = toPath(sampleContentSquare);
    const moved = flattenPath(path.transform(rot)).points;
    const direct = flattenPath(path).points;
    for (let i = 0; i < direct.length; i += 2) {
      const p = transformPoint(rot, direct[i]!, direct[i + 1]!);
      expect(moved[i]).toBeCloseTo(p.x, 9);
      expect(moved[i + 1]).toBeCloseTo(p.y, 9);
    }
  });
});
