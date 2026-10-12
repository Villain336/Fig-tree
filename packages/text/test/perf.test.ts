import { beforeAll, describe, expect, it } from "vitest";
import { ShapedParagraph, TextBlock, layoutLines, loadHarfBuzz, parseParagraphStyle, parseTextStyle, type FontRegistry } from "../src/index";
import { fixtureRegistry } from "../conformance/fonts";

/**
 * Text engine performance on long paragraphs: shaping (itemization, font
 * matching, HarfBuzz, break opportunities) and line layout of a
 * 10,000-character paragraph. Numbers go to the console; docs/benchmarks.md
 * records them. The bounds only catch pathological regressions.
 */

let fonts: FontRegistry;
beforeAll(async () => {
  await loadHarfBuzz();
  fonts = fixtureRegistry();
});

const WORDS = "the quick brown fox jumps over a lazy dog while typography engines shape kerning ligatures and line breaks across ten thousand characters".split(" ");

function paragraph(chars: number): string {
  let s = "";
  for (let i = 0; s.length < chars; i++) s += (i ? " " : "") + WORDS[(i * 7) % WORDS.length];
  return s.slice(0, chars);
}

const median = (v: number[]): number => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]!;

describe("text performance", () => {
  it("shapes and lays out a 10,000-character paragraph", () => {
    const text = paragraph(10_000);
    const style = parseTextStyle("font: 16px Inter");
    const mixed = parseTextStyle("font: 700 16px Inter");
    const para = parseParagraphStyle("");
    const shapeMs: number[] = [];
    const layoutMs: number[] = [];
    const relayoutMs: number[] = [];
    let lines = 0;
    for (let run = 0; run < 7; run++) {
      // Style runs of 250 characters, alternately regular and bold (40 runs).
      const spans: { start: number; end: number; style: typeof style }[] = [];
      let at = 0;
      for (let k = 0; at < text.length; k++) {
        const end = Math.min(text.length, at + 250);
        spans.push({ start: at, end, style: k % 2 ? mixed : style });
        at = end;
      }
      let t = performance.now();
      const sp = new ShapedParagraph({ text, spans, style: para, root: style }, fonts);
      shapeMs.push(performance.now() - t);
      t = performance.now();
      const layout = layoutLines(sp, 600);
      layoutMs.push(performance.now() - t);
      lines = layout.lines.length;
      t = performance.now();
      layoutLines(sp, 480);
      relayoutMs.push(performance.now() - t);
    }
    const balanced = parseParagraphStyle("text-wrap: pretty");
    const sp = new ShapedParagraph({ text, spans: [{ start: 0, end: text.length, style }], style: balanced, root: style }, fonts);
    let t = performance.now();
    layoutLines(sp, 600);
    const prettyMs = performance.now() - t;
    const block = new TextBlock(fonts, { paragraphs: [{ text, spans: [{ start: 0, end: text.length, style }], style: para, root: style }] });
    t = performance.now();
    const min = block.minContentWidth();
    const max = block.maxContentWidth();
    const intrinsicMs = performance.now() - t;
    console.log(
      `[text 10k chars] shape median ${median(shapeMs).toFixed(1)} ms (first ${shapeMs[0]!.toFixed(1)}), ` +
        `line layout at 600 px median ${median(layoutMs).toFixed(1)} ms (${lines} lines), relayout at 480 px ${median(relayoutMs).toFixed(1)} ms, ` +
        `text-wrap: pretty ${prettyMs.toFixed(1)} ms, min/max-content ${intrinsicMs.toFixed(1)} ms`,
    );
    expect(lines).toBeGreaterThan(100);
    expect(min).toBeLessThan(max);
    expect(median(shapeMs)).toBeLessThan(1_000);
    expect(median(layoutMs)).toBeLessThan(1_000);
  }, 120_000);
});
