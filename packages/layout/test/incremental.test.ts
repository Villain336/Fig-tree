import { describe, expect, it } from "vitest";
import { LayoutNode, WordsMeasurer, computeLayout, makeStyle, parseDeclarations, type Style } from "../src";
import { Gen } from "../conformance/random";

/**
 * Incremental relayout: a change marks the node and its ancestors dirty;
 * other nodes keep cached results for the constraint spaces they were laid
 * out in, so only what the change affects is laid out again. Every
 * incremental result must equal a fresh layout of the same tree.
 */

interface Spec {
  style: Style;
  words?: [number, number][];
  children: Spec[];
}

function build(spec: Spec, out: LayoutNode[] = []): LayoutNode {
  const n = new LayoutNode(spec.style);
  out.push(n);
  if (spec.words) n.setMeasure(new WordsMeasurer(spec.words));
  for (const c of spec.children) n.appendChild(build(c, out));
  return n;
}

function boxes(nodes: readonly LayoutNode[]): number[][] {
  return nodes.map((n) => [n.out.x, n.out.y, n.out.width, n.out.height]);
}

const css = (s: string): Style => makeStyle(parseDeclarations(s));

/** A document-like tree: a column of `sections` flex/grid sections with `perSection` children each. */
function documentTree(sections: number, perSection: number, g: Gen): Spec {
  const kids: Spec[] = [];
  for (let s = 0; s < sections; s++) {
    const grid = s % 3 === 2;
    const items: Spec[] = [];
    for (let i = 0; i < perSection; i++) {
      const text = i % 4 === 1;
      items.push({
        style: css(text ? "flex:1 1 0px" : `width:${20 + ((i * 7) % 40)}px;height:${10 + ((i * 13) % 30)}px`),
        ...(text ? { words: [[g.int(10, 40), 12], [g.int(10, 40), 12], [g.int(10, 40), 12]] as [number, number][] } : {}),
        children: [],
      });
    }
    kids.push({
      style: css(grid ? "display:grid;grid-template-columns:repeat(auto-fill, minmax(60px, 1fr));gap:4px;padding:8px" : "display:flex;flex-wrap:wrap;gap:6px;padding:8px;align-items:center"),
      children: items,
    });
  }
  return { style: css("display:flex;flex-direction:column;gap:10px;width:1200px"), children: kids };
}

describe("incremental relayout", () => {
  it("relayouts only the changed node's ancestors and the siblings whose constraints changed", () => {
    const g = new Gen(1);
    const spec = documentTree(100, 99, g);
    const nodes: LayoutNode[] = [];
    const root = build(spec, nodes);
    expect(nodes.length).toBe(1 + 100 + 100 * 99);
    const full = computeLayout(root, 1200, 800);
    expect(full.layouts).toBeGreaterThan(10_000);

    // Nothing changed: nothing is laid out again.
    const idle = computeLayout(root, 1200, 800);
    expect(idle.layouts).toBe(0);

    // Change the width of one fixed-size child in a flex section.
    const section = root.children[40]!;
    const leaf = section.children[10]!;
    const runs = (): number[] => nodes.map((n) => n.layoutRuns);
    let before = runs();
    leaf.updateStyle({ width: 55 });
    const one = computeLayout(root, 1200, 800);
    const relaid = (b: number[]): Set<LayoutNode> => new Set(nodes.filter((n, i) => n.layoutRuns !== b[i]));
    let changed = relaid(before);
    // Laid out again: the leaf and its ancestors, plus siblings in the same section whose line changed.
    expect(changed.has(leaf) && changed.has(section) && changed.has(root)).toBe(true);
    for (const n of changed) expect(n === root || n === section || n.parent === section).toBe(true);
    expect(one.layouts).toBeLessThan(40);

    // A change that resizes the section's height moves later sections without laying them out.
    before = runs();
    leaf.updateStyle({ height: 120 });
    computeLayout(root, 1200, 800);
    changed = relaid(before);
    for (const n of changed) expect(n === root || n === section || n.parent === section).toBe(true);
    expect(root.children[41]!.out.y).toBeGreaterThan(root.children[40]!.out.y + 120);

    // The incremental result equals a fresh layout.
    const freshNodes: LayoutNode[] = [];
    const freshSpec = structuredClone(spec);
    freshSpec.children[40]!.children[10]!.style = leaf.style;
    computeLayout(build(freshSpec, freshNodes), 1200, 800);
    expect(boxes(nodes)).toEqual(boxes(freshNodes));
  });

  it("matches a fresh layout after random edits (property test)", () => {
    const g = new Gen(7);
    for (let round = 0; round < 25; round++) {
      const spec = documentTree(6, 12, g);
      const nodes: LayoutNode[] = [];
      const root = build(spec, nodes);
      computeLayout(root, 900, 600);
      for (let step = 0; step < 8; step++) {
        // Edit a random node's style, in the spec and in the live tree.
        const flat: Spec[] = [];
        const walk = (s: Spec): void => {
          flat.push(s);
          s.children.forEach(walk);
        };
        walk(spec);
        const k = g.int(1, flat.length - 1);
        const target = flat[k]!;
        const edits = [
          `width:${g.int(10, 200)}px`,
          `height:${g.int(5, 80)}px`,
          `padding:${g.int(0, 20)}px`,
          `gap:${g.int(0, 30)}px`,
          `flex:${g.int(0, 3)} 1 ${g.int(0, 100)}px`,
          `margin:${g.int(-5, 15)}px`,
          `justify-content:${g.pick(["center", "space-between", "flex-end"])}`,
          `align-items:${g.pick(["center", "stretch", "baseline", "flex-start"])}`,
          `display:${g.pick(["flex", "grid", "block"])}`,
          `grid-template-columns:repeat(${g.int(1, 5)}, 1fr)`,
        ];
        target.style = makeStyle({ ...target.style, ...parseDeclarations(g.pick(edits)) });
        nodes[k]!.setStyle(target.style);
        computeLayout(root, 900, 600);
        const fresh: LayoutNode[] = [];
        computeLayout(build(spec, fresh), 900, 600);
        expect(boxes(nodes), `round ${round} step ${step}`).toEqual(boxes(fresh));
      }
    }
  });

  it("re-lays out structural changes: inserted and removed children", () => {
    const g = new Gen(3);
    const spec = documentTree(5, 8, g);
    const nodes: LayoutNode[] = [];
    const root = build(spec, nodes);
    computeLayout(root, 800, 600);
    const section = root.children[2]!;
    const extra = new LayoutNode(css("width:300px;height:40px"));
    section.insertChild(extra, 3);
    computeLayout(root, 800, 600);
    const freshSpec = structuredClone(spec);
    freshSpec.children[2]!.children.splice(3, 0, { style: extra.style, children: [] });
    const fresh: LayoutNode[] = [];
    computeLayout(build(freshSpec, fresh), 800, 600);
    const live: LayoutNode[] = [];
    const collect = (n: LayoutNode): void => {
      live.push(n);
      n.children.forEach(collect);
    };
    collect(root);
    expect(boxes(live)).toEqual(boxes(fresh));
    section.removeChild(extra);
    computeLayout(root, 800, 600);
    expect(boxes(nodes)).toEqual(boxes((() => {
      const again: LayoutNode[] = [];
      computeLayout(build(spec, again), 800, 600);
      return again;
    })()));
  });

  it("lays out a 10,000-node tree and relayouts a single-property change quickly", () => {
    const g = new Gen(11);
    const spec = documentTree(100, 99, g);
    const nodes: LayoutNode[] = [];
    let t = performance.now();
    const root = build(spec, nodes);
    const buildMs = performance.now() - t;
    t = performance.now();
    const full = computeLayout(root, 1200, 800);
    const fullMs = performance.now() - t;
    const samples: number[] = [];
    const counts: number[] = [];
    for (let k = 0; k < 41; k++) {
      const leaf = root.children[(k * 7) % 100]!.children[(k * 13) % 99]!;
      const s = performance.now();
      leaf.updateStyle(leaf.measure ? { flexGrow: (k % 3) + 1 } : { width: 20 + k });
      const r = computeLayout(root, 1200, 800);
      samples.push(performance.now() - s);
      counts.push(r.layouts);
    }
    samples.sort((a, b) => a - b);
    counts.sort((a, b) => a - b);
    // A full relayout of the same tree after invalidating everything, for comparison.
    for (const n of nodes) n.markDirty();
    t = performance.now();
    computeLayout(root, 1200, 800);
    const fullAgainMs = performance.now() - t;
    console.log(
      `[layout 10k] ${nodes.length} nodes: build ${buildMs.toFixed(1)} ms, first layout ${fullMs.toFixed(1)} ms (${full.layouts} layouts, ${full.intrinsic} intrinsic), ` +
        `full relayout ${fullAgainMs.toFixed(1)} ms; single-property change median ${samples[20]!.toFixed(3)} ms, max ${samples[40]!.toFixed(3)} ms, ` +
        `layouts per change median ${counts[20]} max ${counts[40]}`,
    );
    expect(samples[20]!).toBeLessThan(8);
    // Grid sections re-size their tracks, so every item of an edited grid section can be laid out again.
    expect(counts[40]!).toBeLessThan(250);
  });
});
