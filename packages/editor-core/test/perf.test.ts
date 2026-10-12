import type { Command } from "@fig-tree/document";
import { describe, expect, it } from "vitest";
import { marqueeSelect, pickPath } from "../src";
import { drag, setup } from "./helpers";

/**
 * Picking and gestures on a 10,000-node document (100 frames × 99 shapes,
 * like the editor's /?doc=grid10k): hover hit-testing walks the page, a
 * drag recompiles only the dragged node.
 */
function grid(page: string): Command[] {
  const cmds: Command[] = [];
  for (let f = 0; f < 100; f++) {
    cmds.push({ type: "createNode", node: { id: `f${f}`, type: "frame", props: { x: (f % 10) * 600, y: Math.floor(f / 10) * 400, width: 580, height: 380, fills: [{ type: "solid", color: { r: 1, g: 1, b: 1, a: 1 } }] } }, parent: page });
    for (let i = 0; i < 99; i++) {
      cmds.push({ type: "createNode", node: { id: `n${f}-${i}`, type: i % 3 === 0 ? "ellipse" : "rectangle", props: { x: (i % 10) * 55 + 15, y: Math.floor(i / 10) * 37 + 10, width: 50, height: 30, fills: [{ type: "solid", color: { r: 0.5, g: 0.5, b: 0.5, a: 1 } }] } }, parent: `f${f}` });
    }
  }
  return cmds;
}

const median = (v: number[]): number => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]!;

describe("10k-node document", () => {
  it("hit-tests, marquee-selects and drags without touching unrelated nodes", () => {
    const s = setup(grid);
    expect(s.doc.tree.size).toBe(10_001);
    const times: number[] = [];
    for (let k = 0; k < 41; k++) {
      const t0 = performance.now();
      const path = pickPath(s.editor.geometry, { x: 1270 + (k % 7), y: 447 + (k % 5) }, { tolerance: 4 });
      times.push(performance.now() - t0);
      expect(path).toEqual(["f12", "n12-11"]);
    }
    const pick = median(times);
    const t1 = performance.now();
    const hits = marqueeSelect(s.editor.geometry, { x: 1190, y: 390, width: 700, height: 300 }, { deep: false });
    const marquee = performance.now() - t1;
    expect(hits.length).toBeGreaterThan(50);
    // A drag recompiles the dragged shape and nothing else.
    s.editor.viewport.set(1, 0, 0);
    s.editor.select(["n12-11"]);
    const compiled: number[] = [];
    s.bridge.onSync = (n) => compiled.push(n);
    const t2 = performance.now();
    drag(s.editor, [1295, 462], [1395, 512], {}, 20);
    const perMove = (performance.now() - t2) / 22;
    expect(Math.max(...compiled)).toBe(1);
    expect(s.doc.get("n12-11", "x")).toBe(170);
    console.log(`[editor-core perf] pick median ${pick.toFixed(2)} ms, marquee ${marquee.toFixed(1)} ms, drag step ${perMove.toFixed(2)} ms (Node)`);
    expect(pick).toBeLessThan(16);
  });
});
