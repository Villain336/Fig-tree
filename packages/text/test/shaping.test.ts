import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_TEXT_STYLE, featuresFor, loadHarfBuzz, parseTextStyle, shapeItem, Typeface, type FontInstance } from "../src/index";
import { harfbuzz } from "../src/hb";

/**
 * Shaping through our HarfBuzz wrapper (context windows, sub-unit scale,
 * CSS feature mapping) against HarfBuzz shaping the same text directly,
 * plus the typographic effects each feature must have.
 */

const FONTS = join(process.cwd(), "fixtures", "fonts");
const face = (file: string): Typeface => new Typeface(new Uint8Array(readFileSync(join(FONTS, file))));

let inter: Typeface;
let noto: Typeface;
let arabic: Typeface;
let deva: Typeface;

beforeAll(async () => {
  await loadHarfBuzz();
  inter = face("inter/Inter[opsz,wght].ttf");
  noto = face("noto-sans/NotoSans[wdth,wght].ttf");
  arabic = face("noto-sans-arabic/NotoSansArabic[wdth,wght].ttf");
  deva = face("noto-sans-devanagari/NotoSansDevanagari[wdth,wght].ttf");
});

/** HarfBuzz's own result: glyph ids, clusters and advances in font units, via hb_shape on the whole string. */
function reference(font: FontInstance, text: string, rtl: boolean, script: string, features: [string, number][] = []): { gids: number[]; clusters: number[]; advances: number[] } {
  const hb = harfbuzz();
  const f = new hb.Font(font.typeface.hbFace);
  const vars = Object.entries(font.coords).map(([t, v]) => new hb.Variation(t, v));
  if (vars.length) f.setVariations(vars);
  const buf = new hb.Buffer();
  buf.addText(text);
  buf.setDirection(rtl ? hb.Direction.RTL : hb.Direction.LTR);
  buf.setScript(script);
  buf.setFlags(hb.BufferFlag.BOT | hb.BufferFlag.EOT);
  hb.shape(f, buf, features.map(([t, v]) => new hb.Feature(t, v)));
  return {
    gids: buf.getGlyphInfos().map((g) => g.codepoint),
    clusters: buf.getGlyphInfos().map((g) => g.cluster),
    advances: buf.getGlyphPositions().map((p) => p.xAdvance),
  };
}

function ours(font: FontInstance, text: string, rtl: boolean, script: string, features: [string, number][] = []) {
  const g = shapeItem(text, 0, text.length, font, rtl, script, "", features);
  return { gids: [...g.gids], clusters: [...g.clusters], advances: [...g.advances] };
}

const SAMPLES: [string, () => FontInstance, string, boolean, string][] = [
  ["Latin with kerning", () => inter.instance(), "AVATAR To Ty Wave office", false, "Latn"],
  ["Latin, variable instance", () => inter.instance({ wght: 730, opsz: 24 }), "Handgloves 0123456789", false, "Latn"],
  ["Noto Sans ligatures", () => noto.instance({ wdth: 87.5 }), "office fluffy fjord", false, "Latn"],
  ["Arabic joining", () => arabic.instance(), "مرحبا بالعالم", true, "Arab"],
  ["Arabic, bold", () => arabic.instance({ wght: 700 }), "السلام عليكم", true, "Arab"],
  ["Devanagari conjuncts", () => deva.instance(), "क्षत्रिय श्री हिन्दी", false, "Deva"],
];

describe("shaping against HarfBuzz", () => {
  for (const [label, font, text, rtl, script] of SAMPLES) {
    it(label, () => {
      const f = font();
      const ref = reference(f, text, rtl, script);
      const got = ours(f, text, rtl, script);
      expect(got.gids).toEqual(ref.gids);
      expect(got.clusters).toEqual(ref.clusters);
      // Our advances are font units with sub-unit precision; HarfBuzz's default scale rounds to units.
      got.advances.forEach((a, i) => expect(Math.abs(a - ref.advances[i]!), `glyph ${i}`).toBeLessThanOrEqual(0.5));
    });
  }

  it("shapes an item inside a paragraph with its context (Arabic joining across a style change)", () => {
    const f = arabic.instance();
    const text = "مرحبا";
    const whole = ours(f, text, true, "Arab");
    // Shaping "رح" alone gives isolated/final forms; with context it keeps the medial forms of the whole word.
    const middle = shapeItem(text, 1, 3, f, true, "Arab", "", []);
    const alone = shapeItem(text.slice(1, 3), 0, 2, f, true, "Arab", "", []);
    const inWhole = whole.gids.filter((_, i) => whole.clusters[i]! >= 1 && whole.clusters[i]! < 3);
    expect([...middle.gids]).toEqual(inWhole);
    expect([...alone.gids]).not.toEqual(inWhole);
  });
});

describe("CSS font features", () => {
  const style = (css: string) => parseTextStyle(css, DEFAULT_TEXT_STYLE);
  const width = (font: FontInstance, text: string, css: string): number => {
    const g = shapeItem(text, 0, text.length, font, false, "Latn", "", featuresFor(style(css)));
    return g.advances.reduce((a, b) => a + b, 0);
  };
  const glyphs = (font: FontInstance, text: string, css: string): number[] => [...shapeItem(text, 0, text.length, font, false, "Latn", "", featuresFor(style(css))).gids];

  it("kerning is on by default and off with font-kerning: none", () => {
    const f = inter.instance();
    expect(width(f, "AV", "")).toBeLessThan(width(f, "AV", "font-kerning: none"));
  });

  it("standard ligatures apply by default and font-variant-ligatures: none or letter-spacing turn them off", () => {
    const f = noto.instance();
    expect(glyphs(f, "fi", "").length).toBe(1);
    expect(glyphs(f, "fi", "font-variant-ligatures: none").length).toBe(2);
    expect(glyphs(f, "fi", "letter-spacing: 1px").length).toBe(2);
  });

  it("font-variant-numeric and font-feature-settings select alternates", () => {
    const f = inter.instance();
    const one = width(f, "1", "font-variant-numeric: tabular-nums");
    const eight = width(f, "8", "font-variant-numeric: tabular-nums");
    expect(one).toBe(eight);
    expect(width(f, "1", "")).not.toBe(width(f, "8", ""));
    expect(glyphs(f, "0", "font-feature-settings: 'zero'")).not.toEqual(glyphs(f, "0", ""));
    expect(glyphs(f, "a", "font-feature-settings: 'ss01' 1")[0]).toBeDefined();
    expect(featuresFor(style("font-feature-settings: 'liga' 0, 'ss02'"))).toEqual(expect.arrayContaining([["liga", 0], ["ss02", 1]]));
  });

  it("variable axes change advances (wght) and widths (wdth)", () => {
    expect(width(inter.instance({ wght: 800 }), "mmm", "")).toBeGreaterThan(width(inter.instance({ wght: 200 }), "mmm", ""));
    expect(width(noto.instance({ wdth: 62.5 }), "mmm", "")).toBeLessThan(width(noto.instance({ wdth: 100 }), "mmm", ""));
  });
});
