import { Scene } from "@fig-tree/renderer";
import { ShapedParagraph, loadHarfBuzz, type FontRegistry } from "@fig-tree/text";
import { beforeAll, describe, expect, it } from "vitest";
import { DrawList } from "../../renderer/src/compile";
import { SceneBridge, type Command } from "../src";
import { fixtureRegistry } from "../../text/conformance/fonts";
import { makeDoc } from "./helpers";

/**
 * A 10,001-node document with 2,000 text nodes, the same as the editor's
 * `/?doc=text10k`: 100 auto-layout cards, each a column of a heading, a
 * row of six hugging labels, thirteen wrapping paragraphs and a wrapping
 * frame of 77 swatches. Measures the bridge build and text edits, and
 * checks that an edit shapes one paragraph and lays out only the edited
 * text and its ancestors. docs/benchmarks.md records the numbers.
 */

const ink = { type: "solid" as const, color: { r: 0.1, g: 0.1, b: 0.12, a: 1 } };
const BODY = [
  "Typography follows CSS, so the code you export renders what you designed.",
  "Line breaking, kerning and ligatures come from the same rules browsers use, with fonts from the file. Long paragraphs wrap.",
  "Auto layout hugs text and wraps it in fixed columns.",
];

export function textDocumentCommands(page: string): Command[] {
  const commands: Command[] = [];
  const text = (id: string, parent: string, content: string, props: Record<string, unknown>): Command => ({
    type: "createNode",
    node: { id, type: "text", props: { fontFamily: "Inter", fills: [ink], ...props }, text: { content, runs: [] } },
    parent,
  });
  for (let f = 0; f < 100; f++) {
    const card = `c${f}`;
    commands.push({
      type: "createNode",
      node: {
        id: card,
        type: "frame",
        props: { name: `Card ${f + 1}`, x: (f % 10) * 600, y: Math.floor(f / 10) * 400, width: 580, height: 380, cornerRadius: 12, fills: [{ type: "solid", color: { r: 1, g: 1, b: 1, a: 1 } }], display: "flex", flexDirection: "column", rowGap: 4, padding: { top: 12, right: 12, bottom: 12, left: 12 } },
      },
      parent: page,
    });
    commands.push(text(`h${f}`, card, `Card ${f + 1}: text layout`, { fontSize: 20, fontWeight: 700 }));
    commands.push({ type: "createNode", node: { id: `r${f}`, type: "frame", props: { width: 10, height: 10, widthMode: "hug", heightMode: "hug", display: "flex", columnGap: 6 } }, parent: card });
    for (let i = 0; i < 6; i++) commands.push(text(`l${f}-${i}`, `r${f}`, ["Save", "Cancel", "Share", "Export code", "Duplicate", "More"][i]!, { fontSize: 12, fontWeight: 500 }));
    for (let i = 0; i < 13; i++) commands.push(text(`t${f}-${i}`, card, BODY[(f + i) % 3]!, { fontSize: 12, widthMode: "fill", lineHeight: { unit: "percent", value: 130 } }));
    commands.push({ type: "createNode", node: { id: `s${f}`, type: "frame", props: { width: 10, height: 10, widthMode: "fill", heightMode: "hug", display: "flex", flexWrap: "wrap", columnGap: 2, rowGap: 2 } }, parent: card });
    for (let i = 0; i < 77; i++) {
      commands.push({ type: "createNode", node: { id: `q${f}-${i}`, type: "rectangle", props: { width: 12, height: 8, fills: [{ type: "solid", color: { r: (i * 13) % 255 / 255, g: 0.5, b: (f * 7) % 255 / 255, a: 1 } }] } }, parent: `s${f}` });
    }
  }
  return commands;
}

let fonts: FontRegistry;
beforeAll(async () => {
  await loadHarfBuzz();
  fonts = fixtureRegistry();
});

const median = (v: number[]): number => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]!;

describe("text in a 10,000-node document", () => {
  it("builds, and edits one text node by shaping it alone and laying out only it and its ancestors", () => {
    const { doc, page, user } = makeDoc(21);
    doc.apply(textDocumentCommands(page), user);
    expect(doc.tree.size).toBe(10_001);
    const texts = [...doc.tree.ids()].filter((id) => doc.typeOf(id) === "text");
    expect(texts.length).toBe(2_000);

    const scene = new Scene();
    const shaped0 = ShapedParagraph.shapedCount;
    let t = performance.now();
    const bridge = new SceneBridge(doc, scene, { fonts });
    const buildMs = performance.now() - t;
    const shapedOnBuild = ShapedParagraph.shapedCount - shaped0;
    const list = new DrawList();
    t = performance.now();
    list.sync(scene);
    const syncMs = performance.now() - t;
    expect(bridge.unsupported.size).toBe(0);
    // Hugging labels and wrapped paragraphs got their sizes from the text engine.
    expect(bridge.box("l3-3")!.width).toBeGreaterThan(50);
    expect(bridge.box("t3-1")!.height).toBeGreaterThan(bridge.box("t3-0")!.height);

    const ancestorsOf = (id: string): Set<string> => {
      const out = new Set<string>([id]);
      for (let p = doc.tree.parentOf(id); p; p = doc.tree.parentOf(p)) out.add(p);
      return out;
    };
    const runs = (): Map<string, number> => {
      const m = new Map<string, number>();
      for (const id of doc.tree.ids()) {
        const n = bridge.layout.layoutNode(id);
        if (n) m.set(id, n.layoutRuns);
      }
      return m;
    };

    const measure = (target: (k: number) => string) => {
      const samples: number[] = [];
      const compiled: number[] = [];
      const shaped: number[] = [];
      const laidOut: number[] = [];
      for (let k = 0; k < 41; k++) {
        const id = target(k);
        const before = runs();
        const s0 = ShapedParagraph.shapedCount;
        const s = performance.now();
        doc.apply([{ type: "insertText", id, index: doc.text(id).content.length, text: k % 2 ? " more words" : "!" }], user);
        list.sync(scene);
        samples.push(performance.now() - s);
        compiled.push(bridge.lastCompiled);
        shaped.push(ShapedParagraph.shapedCount - s0);
        // Nodes laid out again (not served from their layout cache): the text and its ancestors only.
        const after = runs();
        const relaid = [...after].filter(([n, r]) => r !== before.get(n)).map(([n]) => n);
        const allowed = ancestorsOf(id);
        expect(relaid.filter((n) => !allowed.has(n)), `laid out besides ${id} and its ancestors`).toEqual([]);
        laidOut.push(relaid.length);
      }
      return { median: median(samples), max: Math.max(...samples), compiled: median(compiled), maxCompiled: Math.max(...compiled), shaped: Math.max(...shaped), laidOut: Math.max(...laidOut) };
    };
    const paragraph = measure((k) => `t${(k * 7) % 100}-${k % 13}`);
    const label = measure((k) => `l${(k * 3) % 100}-${k % 6}`);
    console.log(
      `[text doc 10k] ${texts.length} text nodes; bridge build ${buildMs.toFixed(0)} ms (${shapedOnBuild} paragraphs shaped), first draw-list sync ${syncMs.toFixed(0)} ms\n` +
        `  paragraph edit: median ${paragraph.median.toFixed(2)} ms, max ${paragraph.max.toFixed(2)} ms; paragraphs shaped per edit ${paragraph.shaped}; nodes laid out per edit max ${paragraph.laidOut}; nodes recompiled median ${paragraph.compiled} max ${paragraph.maxCompiled}\n` +
        `  label edit (hugging, in a row): median ${label.median.toFixed(2)} ms, max ${label.max.toFixed(2)} ms; paragraphs shaped per edit ${label.shaped}; nodes laid out per edit max ${label.laidOut}; nodes recompiled median ${label.compiled} max ${label.maxCompiled}`,
    );
    expect(paragraph.shaped).toBe(1);
    expect(label.shaped).toBe(1);
    expect(paragraph.median).toBeLessThan(16);
    expect(label.median).toBeLessThan(16);
  }, 300_000);
});
