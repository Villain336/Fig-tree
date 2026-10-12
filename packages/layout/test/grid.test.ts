import { describe, expect, it } from "vitest";
import { isDefinite, placeItems, resolveAxis, type AxisLines, type PlacementInput } from "../src/grid/placement";
import { frSize, sizeTracks, track, type Available, type SizingFn, type SizingItem } from "../src/grid/sizing";
import { expandTrackList, areaLines } from "../src/grid/tracks";
import { parseTrackList } from "../src";

/** Unit tests of the grid algorithm's steps (CSS Grid 1 §7, §8, §11). */

const px = (value: number): SizingFn => ({ kind: "fixed", value });
const fr = (value: number): SizingFn => ({ kind: "fr", value });
const auto: SizingFn = { kind: "auto" };
const minC: SizingFn = { kind: "min-content" };
const maxC: SizingFn = { kind: "max-content" };
const fit = (value: number): SizingFn => ({ kind: "fit-content", value });

function item(start: number, span: number, min: number, max: number, minimum = min): SizingItem {
  return { start, span, minContent: () => min, maxContent: () => max, minContribution: () => minimum };
}

function size(defs: [SizingFn, SizingFn][], items: SizingItem[], available: Available | number, gap = 0, extra: { minSize?: number; maxSize?: number; stretch?: boolean } = {}): number[] {
  const tracks = defs.map(([a, b]) => track(a, b));
  const avail: Available = typeof available === "number" ? { kind: "definite", size: available } : available;
  sizeTracks(tracks, items, { available: avail, gap, minSize: extra.minSize ?? 0, maxSize: extra.maxSize ?? Infinity, stretch: extra.stretch ?? true });
  return tracks.map((t) => Math.round(t.base * 1000) / 1000);
}

describe("track sizing: fixed and flexible tracks", () => {
  it("initializes fixed tracks and gives the rest to fr tracks by factor", () => {
    expect(size([[px(100), px(100)], [auto, fr(1)], [auto, fr(3)]], [], 500)).toEqual([100, 100, 300]);
  });

  it("treats a flex factor sum below 1 as 1 (leftover space stays unused)", () => {
    expect(size([[auto, fr(0.25)], [auto, fr(0.25)]], [], 400)).toEqual([100, 100]);
  });

  it("subtracts gaps before distributing", () => {
    expect(size([[auto, fr(1)], [auto, fr(1)], [auto, fr(1)]], [], 320, 10)).toEqual([100, 100, 100]);
  });

  it("does not shrink an fr track below its content minimum (find the size of an fr restarts)", () => {
    // Track 0 must hold 150 of content; the remaining 50 goes to track 1.
    expect(size([[auto, fr(1)], [auto, fr(1)]], [item(0, 1, 150, 150)], 200)).toEqual([150, 50]);
    // minmax(0, 1fr) has no content minimum.
    expect(size([[px(0), fr(1)], [px(0), fr(1)]], [item(0, 1, 150, 150)], 200)).toEqual([100, 100]);
  });

  it("finds the size of an fr directly", () => {
    const ts = [track(auto, fr(1)), track(auto, fr(2)), track(px(50), px(50))];
    ts[2]!.base = 50;
    expect(frSize(ts, 350, 0)).toBe(100);
  });

  it("uses the largest of base / factor and item max-content shares when the space is indefinite", () => {
    // max-content sizing: the item needs 300 over 1fr + 2fr → 100 per fr.
    expect(size([[auto, fr(1)], [auto, fr(2)]], [item(0, 2, 30, 300)], { kind: "max-content" })).toEqual([100, 200]);
  });

  it("clamps an indefinite grid's fr tracks to the container's min and max size", () => {
    expect(size([[auto, fr(1)], [auto, fr(1)]], [item(0, 1, 10, 10)], { kind: "indefinite" }, 0, { minSize: 200 })).toEqual([100, 100]);
    // 100 per fr would make 400 > 200: redo with 200 of space; track 0 keeps its 100 and track 1 gets the rest.
    expect(size([[auto, fr(1)], [auto, fr(3)]], [item(0, 1, 100, 100)], { kind: "indefinite" }, 0, { maxSize: 200 })).toEqual([100, 100]);
  });
});

describe("track sizing: intrinsic tracks", () => {
  it("sizes auto tracks to items' contributions, then maximizes and stretches", () => {
    // Bases 30 and 50 (min-content), limits 80 and 60 (max-content); 100 px of free space.
    expect(size([[auto, auto], [auto, auto]], [item(0, 1, 30, 80), item(1, 1, 50, 60)], 200, 0, { stretch: false })).toEqual([80, 60]);
    // Stretching then shares the remaining 60 between the auto tracks.
    expect(size([[auto, auto], [auto, auto]], [item(0, 1, 30, 80), item(1, 1, 50, 60)], 200)).toEqual([110, 90]);
  });

  it("uses minimum contributions for auto minimums and min/max-content for keywords", () => {
    expect(size([[auto, px(10)], [minC, px(10)], [maxC, px(10)]], [item(0, 1, 40, 90, 5), item(1, 1, 40, 90), item(2, 1, 40, 90)], 0)).toEqual([5, 40, 90]);
  });

  it("clamps fit-content() tracks by their argument", () => {
    expect(size([[auto, fit(50)], [auto, fit(200)]], [item(0, 1, 20, 120), item(1, 1, 20, 120)], 1000, 0, { stretch: false })).toEqual([50, 120]);
  });

  it("distributes a spanning item's extra space equally over auto tracks", () => {
    // Single-span items first: 30 and 40. The spanning item needs 200: 130 more, 65 each.
    expect(size([[auto, auto], [auto, auto]], [item(0, 1, 30, 30), item(1, 1, 40, 40), item(0, 2, 200, 200)], 0)).toEqual([95, 105]);
  });

  it("grows tracks up to their growth limits first, then beyond them", () => {
    // Track 0 has a fixed 50px max: the spanning item's 200 fills it to 50, then the rest goes to the auto track.
    expect(size([[auto, px(50)], [auto, auto]], [item(0, 2, 200, 200)], 0)).toEqual([50, 150]);
  });

  it("processes spanning items in order of increasing span", () => {
    const sizes = size([[auto, auto], [auto, auto], [auto, auto]], [item(0, 3, 300, 300), item(0, 2, 120, 120), item(1, 1, 20, 20)], 0);
    // Track 1 is 20 with a growth limit of 20 (its single-span item). Span 2 first: 100 more, all to
    // track 0 (track 1 is at its limit). Then span 3: 300 - 120 = 180, all to track 2 (the only one
    // still below its limit).
    expect(sizes).toEqual([100, 20, 180]);
  });

  it("gives space from items crossing flexible tracks only to the flexible tracks", () => {
    expect(size([[auto, auto], [auto, fr(1)]], [item(0, 2, 300, 300)], { kind: "max-content" })).toEqual([0, 300]);
    // In proportion to flex factors.
    expect(size([[auto, fr(1)], [auto, fr(3)]], [item(0, 2, 400, 400, 400)], 0)).toEqual([100, 300]);
  });
});

describe("explicit grid", () => {
  it("expands repeat() with merged line names", () => {
    const x = expandTrackList(parseTrackList("[a] 10px repeat(2, [b] 20px [c]) [d]"), 500, undefined, 0, 500);
    expect(x.tracks).toEqual([10, 20, 20]);
    expect(x.lineNames).toEqual([["a"], ["b"], ["c", "b"], ["c", "d"]]);
  });

  it("counts auto-fill repetitions from the available size, gaps included", () => {
    expect(expandTrackList(parseTrackList("repeat(auto-fill, 90px)"), 400, undefined, 10, 400).tracks.length).toBe(4);
    expect(expandTrackList(parseTrackList("50px repeat(auto-fill, 60px) 70px"), 400, undefined, 0, 400).tracks.length).toBe(6);
    // An indefinite size with a definite minimum: the smallest count that reaches it.
    expect(expandTrackList(parseTrackList("repeat(auto-fill, 60px)"), undefined, 200, 0, undefined).tracks.length).toBe(4);
    expect(expandTrackList(parseTrackList("repeat(auto-fit, 60px)"), 130, undefined, 0, 130).autoFit.size).toBe(2);
  });

  it("derives implicit area lines", () => {
    const { rows, cols } = areaLines([["a", "a", "."], ["b", "c", "c"]]);
    expect(cols.get("a")).toEqual([0, 2]);
    expect(rows.get("c")).toEqual([1, 2]);
  });
});

describe("placement", () => {
  const lines = (count: number, names: Record<number, string[]> = {}): AxisLines => ({ count, names: Array.from({ length: count + 1 }, (_, i) => names[i] ?? []) });

  it("resolves numbers, negative numbers, spans and named lines", () => {
    const ax = lines(3, { 1: ["x"], 2: ["x"] });
    expect(resolveAxis(ax, { line: 2 }, "auto")).toEqual({ start: 1, end: 2 });
    expect(resolveAxis(ax, { line: -1 }, "auto")).toEqual({ start: 3, end: 4 });
    expect(resolveAxis(ax, { line: 1 }, { span: 2 })).toEqual({ start: 0, end: 2 });
    expect(resolveAxis(ax, { span: 2 }, { line: 4 })).toEqual({ start: 1, end: 3 });
    expect(resolveAxis(ax, { name: "x" }, { line: 2, name: "x" })).toEqual({ start: 1, end: 2 });
    expect(resolveAxis(ax, { line: 1 }, { span: 2, name: "x" })).toEqual({ start: 0, end: 2 });
    // Missing names: implicit lines past the explicit grid carry every name.
    expect(resolveAxis(ax, { name: "nope" }, "auto")).toEqual({ start: 4, end: 5 });
    expect(resolveAxis(ax, "auto", "auto")).toEqual({ span: 1 });
    expect(resolveAxis(ax, { span: 3 }, "auto")).toEqual({ span: 3 });
  });

  it("handles placement conflicts", () => {
    const ax = lines(3);
    expect(resolveAxis(ax, { line: 3 }, { line: 1 })).toEqual({ start: 0, end: 2 });
    expect(resolveAxis(ax, { line: 2 }, { line: 2 })).toEqual({ start: 1, end: 2 });
    expect(resolveAxis(ax, { span: 2 }, { span: 3 })).toEqual({ span: 2 });
    expect(resolveAxis(ax, { span: 2, name: "a" }, "auto")).toEqual({ span: 1 });
  });

  const auto1 = (span = 1, rowSpan = 1): PlacementInput => ({ row: { span: rowSpan }, col: { span } });
  const cells = (areas: ReturnType<typeof placeItems>): string[] => areas.map((a) => `${a.rowStart},${a.colStart}+${a.colEnd - a.colStart}`);

  it("auto-places items in row order, leaving holes when sparse", () => {
    const items = [auto1(), auto1(3), auto1(), auto1(2), auto1(2), auto1()];
    expect(cells(placeItems(items, 0, 3, "row", false))).toEqual(["0,0+1", "1,0+3", "2,0+1", "2,1+2", "3,0+2", "3,2+1"]);
  });

  it("backfills holes when dense", () => {
    // A full-width item leaves a hole after the first one; sparse packing never goes back, dense fills it.
    const items = [auto1(), auto1(3), auto1()];
    expect(cells(placeItems(items, 0, 3, "row", false))).toEqual(["0,0+1", "1,0+3", "2,0+1"]);
    expect(cells(placeItems(items, 0, 3, "row", true))).toEqual(["0,0+1", "1,0+3", "0,1+1"]);
  });

  it("places definite items first, then items locked to a row, then the rest", () => {
    const items: PlacementInput[] = [
      auto1(),
      { row: { start: 1, end: 2 }, col: { span: 1 } },
      { row: { start: 0, end: 1 }, col: { start: 0, end: 1 } },
      auto1(),
    ];
    expect(cells(placeItems(items, 0, 2, "row", false))).toEqual(["0,1+1", "1,0+1", "0,0+1", "1,1+1"]);
  });

  it("moves to the next row when a definite column is behind the cursor (sparse)", () => {
    const items: PlacementInput[] = [auto1(), auto1(), { row: { span: 1 }, col: { start: 0, end: 1 } }];
    expect(cells(placeItems(items, 0, 3, "row", false))).toEqual(["0,0+1", "0,1+1", "1,0+1"]);
    expect(cells(placeItems(items, 0, 3, "row", true))).toEqual(["0,0+1", "0,1+1", "1,0+1"]);
  });

  it("flows by columns with grid-auto-flow: column", () => {
    const areas = placeItems([auto1(), auto1(), auto1()], 2, 0, "column", false);
    expect(areas.map((a) => [a.rowStart, a.colStart])).toEqual([[0, 0], [1, 0], [0, 1]]);
  });

  it("creates implicit columns for spans wider than the grid", () => {
    const areas = placeItems([auto1(4), auto1()], 0, 2, "row", false);
    expect(areas[0]).toEqual({ rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 4 });
    expect(isDefinite({ start: 0, end: 1 })).toBe(true);
  });
});
