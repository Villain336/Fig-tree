import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DrawList } from "../../renderer/src/compile";
import { GlyphAtlas, Scene, type SceneNode } from "@fig-tree/renderer";
import { FontRegistry, loadHarfBuzz } from "@fig-tree/text";
import { beforeAll, describe, expect, it } from "vitest";
import { PaintCache, planFrame } from "../../renderer/src/frame";
import { FigDocument, SceneBridge, cssDeclarations, seededRandom, type Command } from "../src";
import { fixtureRegistry } from "../../text/conformance/fonts";

/**
 * Text through the bridge: text nodes measured by the text engine take part
 * in layout, render as glyph runs with their fills, reflow when text or
 * styles change, and lay out again when fonts finish loading.
 */

const FONTS = join(process.cwd(), "fixtures", "fonts");
const ink = { type: "solid" as const, color: { r: 0, g: 0, b: 0, a: 1 } };

let fonts: FontRegistry;
beforeAll(async () => {
  await loadHarfBuzz();
  fonts = fixtureRegistry();
});

function doc(commands: (page: string) => Command[]): FigDocument {
  const d = FigDocument.create({ random: seededRandom(7), clientId: 1 });
  d.apply(commands(d.pages[0]!), d.actor("author"));
  return d;
}

const text = (id: string, parent: string, content: string, props: Record<string, unknown> = {}): Command => ({
  type: "createNode",
  node: { id, type: "text", props: { fontFamily: "Inter", fontSize: 16, fills: [ink], ...props }, text: { content, runs: [] } },
  parent,
});

function glyphNodes(bridge: SceneBridge, id: string): SceneNode[] {
  const main = bridge.sceneNodeFor(id)!;
  return main.children.filter((c) => c.glyphs !== null);
}

describe("text in the bridge", () => {
  it("measures hugging text with the text engine and draws glyph runs", () => {
    const d = doc((p) => [text("t", p, "Hello world", { x: 10, y: 20 })]);
    const bridge = new SceneBridge(d, new Scene(), { fonts });
    const box = bridge.box("t")!;
    // Inter 16px: line height 20; the width is the shaped advance of "Hello world", rounded up to 1/64 px.
    expect(box.height).toBe(20);
    expect(box.width).toBeGreaterThan(70);
    expect(box.width).toBeLessThan(100);
    const runs = glyphNodes(bridge, "t");
    expect(runs.length).toBe(1);
    expect(runs[0]!.glyphs!.glyphs.length / 3).toBe(11);
    expect(runs[0]!.fill).toEqual({ type: "solid", color: ink.color });
    expect(bridge.unsupported.get("t")).toBeUndefined();
  });

  it("paints each fill of a text node as its own glyph run, bottom to top", () => {
    const red = { type: "solid" as const, color: { r: 1, g: 0, b: 0, a: 1 } };
    const d = doc((p) => [text("t", p, "Two fills", { fills: [ink, red] })]);
    const bridge = new SceneBridge(d, new Scene(), { fonts });
    expect(glyphNodes(bridge, "t").map((n) => n.fill)).toEqual([{ type: "solid", color: ink.color }, { type: "solid", color: red.color }]);
  });

  it("reflows a flex row of text buttons when a label changes", () => {
    const d = doc((p) => [
      { type: "createNode", node: { id: "row", type: "frame", props: { x: 0, y: 0, width: 10, height: 10, widthMode: "hug", heightMode: "hug", display: "flex", columnGap: 8, padding: { top: 6, right: 6, bottom: 6, left: 6 } } }, parent: p },
      text("a", "row", "OK"),
      text("b", "row", "Cancel"),
    ]);
    const bridge = new SceneBridge(d, new Scene(), { fonts });
    const before = { row: bridge.box("row")!, a: bridge.box("a")!, b: bridge.box("b")! };
    expect(before.b.x).toBeCloseTo(6 + before.a.width + 8, 5);
    expect(before.row.width).toBeCloseTo(6 + before.a.width + 8 + before.b.width + 6, 5);
    // Typing into the first label widens it, moves the second and grows the row.
    d.apply([{ type: "insertText", id: "a", index: 2, text: " then" }], d.actor("author"));
    const after = { row: bridge.box("row")!, a: bridge.box("a")!, b: bridge.box("b")! };
    expect(after.a.width).toBeGreaterThan(before.a.width + 20);
    expect(after.b.x).toBeCloseTo(6 + after.a.width + 8, 5);
    expect(after.row.width).toBeCloseTo(before.row.width + (after.a.width - before.a.width), 5);
    expect(glyphNodes(bridge, "a")[0]!.glyphs!.glyphs.length / 3).toBe("OK then".length);
    // Only the edited text, the node it moved and the row recompiled.
    expect(bridge.lastCompiled).toBe(3);
  });

  it("wraps fixed-width text and grows its auto height", () => {
    const d = doc((p) => [text("t", p, "A paragraph long enough to wrap onto several lines in a narrow box.", { width: 120, widthMode: "fixed" })]);
    const bridge = new SceneBridge(d, new Scene(), { fonts });
    const h = bridge.box("t")!.height;
    expect(h).toBeGreaterThanOrEqual(80);
    expect(h % 20).toBe(0);
    d.apply([{ type: "updateProps", id: "t", props: { width: 400 } }], d.actor("author"));
    expect(bridge.box("t")!.height).toBe(40);
    d.apply([{ type: "updateProps", id: "t", props: { fontSize: 32 } }], d.actor("author"));
    expect(bridge.box("t")!.height).toBeGreaterThan(80);
  });

  it("places text by vertical alignment in a fixed box", () => {
    const d = doc((p) => [text("t", p, "Mid", { width: 100, height: 100, widthMode: "fixed", heightMode: "fixed", verticalAlign: "center" })]);
    const bridge = new SceneBridge(d, new Scene(), { fonts });
    const y = glyphNodes(bridge, "t")[0]!.glyphs!.glyphs[2]!;
    // A 20 px line centered in 100 px: its top at 40, baseline 16 below.
    expect(y).toBe(56);
  });

  it("states its typography as CSS", () => {
    const d = doc((p) => [text("t", p, "x", { fontWeight: 650, lineHeight: { unit: "percent", value: 140 }, letterSpacing: { unit: "em", value: 0.02 }, textAlign: "center", maxLines: 2, textTransform: "uppercase" })]);
    expect(cssDeclarations(d, "t")).toMatchObject({
      "font-family": '"Inter"',
      "font-size": "16px",
      "font-weight": "650",
      "line-height": "140%",
      "letter-spacing": "0.02em",
      "text-transform": "uppercase",
      "text-align": "center",
      display: "-webkit-box",
      "-webkit-line-clamp": "2",
      color: "rgb(0, 0, 0)",
      "white-space": "pre-wrap",
    });
  });

  it("lays text out again when its font arrives (no metrics are faked meanwhile)", async () => {
    const reg = new FontRegistry();
    reg.scriptFallback = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    reg.add({ family: "Late", weight: [100, 900] }, async () => {
      await gate;
      return new Uint8Array(readFileSync(join(FONTS, "inter/Inter[opsz,wght].ttf")));
    });
    const d = doc((p) => [text("t", p, "Arrives later", { fontFamily: "Late" })]);
    let syncs = 0;
    const bridge = new SceneBridge(d, new Scene(), { fonts: reg });
    bridge.onSync = () => syncs++;
    // Nothing is drawn and the text has no width until the font is there.
    expect(glyphNodes(bridge, "t")).toEqual([]);
    expect(bridge.unsupported.get("t")).toContain("text-fonts-loading");
    release();
    await reg.whenIdle();
    await Promise.resolve();
    expect(syncs).toBe(1);
    expect(glyphNodes(bridge, "t").length).toBe(1);
    expect(bridge.box("t")!.width).toBeGreaterThan(80);
    expect(bridge.unsupported.get("t")).toBeUndefined();
  });

  it("renders text from the glyph atlas in a frame plan", () => {
    const d = doc((p) => [text("t", p, "Atlas", { x: 10, y: 10 })]);
    const scene = new Scene();
    new SceneBridge(d, scene, { fonts });
    const list = new DrawList();
    list.sync(scene);
    const atlas = new GlyphAtlas();
    atlas.beginFrame();
    const plan = planFrame(list, new PaintCache(), [1, 0, 0, 1, 0, 0], 200, 100, atlas);
    const glyphEntries = plan.entries.filter((e) => e.glyphs);
    expect(glyphEntries.length).toBe(1);
    expect(glyphEntries[0]!.glyphs!.length).toBe(5);
  });
});
