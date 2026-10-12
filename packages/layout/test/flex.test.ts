import { describe, expect, it } from "vitest";
import { resolveFlexibleLengths } from "../src/flex";
import { LayoutNode, computeLayout, makeStyle, parseStyle, WordsMeasurer, type Style } from "../src";

/** Unit tests of the flex algorithm's steps (CSS Flexbox 1 §9). */

interface TestItem {
  base: number;
  hypo: number;
  minMain: number;
  maxMain: number;
  pbMain: number;
  target: number;
  frozen: boolean;
  violation: number;
  main: number;
  readonly style: Style;
}

function item(base: number, opts: { grow?: number; shrink?: number; min?: number; max?: number; pb?: number; margin?: number } = {}): TestItem & { margin: number } {
  const min = opts.min ?? 0;
  const max = opts.max ?? Infinity;
  return {
    base,
    hypo: Math.max(opts.pb ?? 0, Math.min(Math.max(base, min), Math.max(min, max))),
    minMain: min,
    maxMain: max,
    pbMain: opts.pb ?? 0,
    target: 0,
    frozen: false,
    violation: 0,
    main: 0,
    margin: opts.margin ?? 0,
    style: makeStyle({ flexGrow: opts.grow ?? 0, flexShrink: opts.shrink ?? 1 }),
  };
}

function flex(items: (TestItem & { margin: number })[], inner: number, gap = 0): number[] {
  resolveFlexibleLengths(items, inner, gap, ((it: TestItem & { margin: number }, size: number) => size + it.margin) as never);
  return items.map((i) => Math.round(i.main * 1000) / 1000);
}

describe("resolving flexible lengths (§9.7)", () => {
  it("distributes positive free space in proportion to flex-grow", () => {
    expect(flex([item(0, { grow: 1 }), item(0, { grow: 2 }), item(0, { grow: 3 })], 600)).toEqual([100, 200, 300]);
    expect(flex([item(100, { grow: 1 }), item(50, { grow: 1 })], 400)).toEqual([225, 175]);
  });

  it("subtracts margins and gaps from the free space", () => {
    expect(flex([item(0, { grow: 1, margin: 20 }), item(0, { grow: 1 })], 220, 20)).toEqual([90, 90]);
  });

  it("shrinks in proportion to flex-shrink times the inner (content-box) base size", () => {
    // 100 and 300 over 300: overflow 100, scaled factors 100 and 300.
    expect(flex([item(100, { shrink: 1 }), item(300, { shrink: 1 })], 300)).toEqual([75, 225]);
    // Padding does not count toward the scaled shrink factor: 120 and 200 share the 100 px overflow.
    expect(flex([item(200, { pb: 80 }), item(200)], 300)).toEqual([162.5, 137.5]);
  });

  it("freezes an item at its max and gives the rest to the others (freeze loop)", () => {
    expect(flex([item(0, { grow: 1, max: 50 }), item(0, { grow: 1 }), item(0, { grow: 1 })], 400)).toEqual([50, 175, 175]);
  });

  it("freezes min violations when the total violation is positive", () => {
    expect(flex([item(0, { grow: 1, min: 200 }), item(0, { grow: 1 }), item(0, { grow: 1 })], 300)).toEqual([200, 50, 50]);
  });

  it("handles several rounds of violations", () => {
    // Round 1: 100/100/200/100; the min violation (+100) outweighs the max ones (-60): freeze the third at 300.
    // Round 2: 66.7 each; the first violates its max: freeze at 60. Round 3: 70 each.
    const sizes = flex([item(0, { grow: 1, max: 60 }), item(0, { grow: 1, max: 80 }), item(0, { grow: 2, min: 300 }), item(0, { grow: 1 })], 500);
    expect(sizes).toEqual([60, 70, 300, 70]);
    expect(sizes.reduce((a, b) => a + b)).toBe(500);
  });

  it("distributes only a fraction of the free space when flex factors sum below 1", () => {
    expect(flex([item(50, { grow: 0.2 }), item(50, { grow: 0.3 })], 400)).toEqual([110, 140]);
    expect(flex([item(0, { grow: 0.5 })], 400)).toEqual([200]);
    expect(flex([item(200, { shrink: 0.25 }), item(200, { shrink: 0.25 })], 300)).toEqual([175, 175]);
  });

  it("leaves inflexible items at their hypothetical size", () => {
    expect(flex([item(200, { shrink: 0 }), item(200)], 300)).toEqual([200, 100]);
    expect(flex([item(100, { grow: 0 }), item(0, { grow: 1 })], 300)).toEqual([100, 200]);
  });

  it("never shrinks an item's content box below zero", () => {
    expect(flex([item(200, { pb: 40 }), item(200, { pb: 20 })], 50)).toEqual([40, 20]);
  });
});

describe("flex layout through the public API", () => {
  const layoutOf = (container: string, children: string[], measure?: (i: number) => WordsMeasurer | undefined) => {
    const root = new LayoutNode(parseStyle(container));
    const kids = children.map((css, i) => {
      const n = new LayoutNode(parseStyle(css));
      const m = measure?.(i);
      if (m) n.setMeasure(m);
      root.appendChild(n);
      return n;
    });
    computeLayout(root, 800, 600);
    return { root: root.box, kids: kids.map((k) => k.box) };
  };

  it("positions items along the main axis with justify-content and gaps", () => {
    const { kids } = layoutOf("display:flex;width:300px;height:50px;justify-content:space-between;gap:10px", ["width:50px", "width:50px", "width:50px"]);
    expect(kids.map((k) => k.x)).toEqual([0, 125, 250]);
  });

  it("reverses the main axis for row-reverse", () => {
    const { kids } = layoutOf("display:flex;flex-direction:row-reverse;width:300px;height:50px", ["width:50px", "width:70px"]);
    expect(kids.map((k) => [k.x, k.width])).toEqual([[250, 50], [180, 70]]);
  });

  it("stretches items to the line's cross size", () => {
    const { kids } = layoutOf("display:flex;width:300px;height:80px", ["width:50px", "width:50px;height:20px", "width:50px;max-height:40px"]);
    expect(kids.map((k) => k.height)).toEqual([80, 20, 40]);
  });

  it("wraps items into lines and stacks the lines", () => {
    const { root, kids } = layoutOf("display:flex;flex-wrap:wrap;width:200px;row-gap:5px", ["width:80px;height:30px", "width:80px;height:40px", "width:80px;height:20px"]);
    expect(kids.map((k) => [k.x, k.y])).toEqual([[0, 0], [80, 0], [0, 45]]);
    expect(root.height).toBe(65);
  });

  it("aligns first baselines of measured text", () => {
    const { kids } = layoutOf("display:flex;align-items:baseline;width:400px", ["", ""], (i) => new WordsMeasurer(i === 0 ? [[30, 10]] : [[30, 24]]));
    expect(kids.map((k) => k.y)).toEqual([14, 0]);
  });

  it("does not shrink a text item below its min-content width (automatic minimum size)", () => {
    const { kids } = layoutOf("display:flex;width:100px", ["", "width:80px"], (i) => (i === 0 ? new WordsMeasurer([[60, 10], [60, 10]]) : undefined));
    expect(kids[0]!.width).toBe(60);
  });
});
