import { harfbuzz } from "../hb";
import { HB_SUBUNITS, type FontInstance } from "../font/face";
import type { TextStyle } from "../style";

/**
 * Shaping of one item (a run of text with one font, direction and script)
 * with HarfBuzz. The whole paragraph text goes into the buffer with the
 * item marked as the range to shape, so contextual shaping (Arabic joining,
 * Indic reordering) sees the neighbouring characters.
 */

export interface ShapedGlyphs {
  /** Glyph ids, in visual order (left to right) as HarfBuzz returns them. */
  readonly gids: Uint32Array;
  /** Cluster of each glyph: the UTF-16 index (in the paragraph) of its first character. */
  readonly clusters: Int32Array;
  /** Advances and offsets in font units (y up, as in the font). */
  readonly advances: Float64Array;
  readonly offsetsX: Float64Array;
  readonly offsetsY: Float64Array;
  /** HarfBuzz glyph flags (unsafe-to-break). */
  readonly flags: Uint8Array;
}

/** OpenType features for a style (CSS Fonts 4 §7.2, in the order of operations of §7.1). */
export function featuresFor(style: TextStyle): [string, number][] {
  const f = new Map<string, number>();
  if (style.fontKerning === "none") f.set("kern", 0);
  const lig = style.fontVariantLigatures;
  if (lig.includes("none")) for (const t of ["liga", "clig", "dlig", "hlig", "calt"]) f.set(t, 0);
  for (const w of lig) {
    if (w === "no-common-ligatures") (f.set("liga", 0), f.set("clig", 0));
    else if (w === "common-ligatures") (f.set("liga", 1), f.set("clig", 1));
    else if (w === "discretionary-ligatures") f.set("dlig", 1);
    else if (w === "no-discretionary-ligatures") f.set("dlig", 0);
    else if (w === "historical-ligatures") f.set("hlig", 1);
    else if (w === "no-historical-ligatures") f.set("hlig", 0);
    else if (w === "contextual") f.set("calt", 1);
    else if (w === "no-contextual") f.set("calt", 0);
  }
  switch (style.fontVariantCaps) {
    case "small-caps":
      f.set("smcp", 1);
      break;
    case "all-small-caps":
      f.set("smcp", 1);
      f.set("c2sc", 1);
      break;
    case "petite-caps":
      f.set("pcap", 1);
      break;
    case "all-petite-caps":
      f.set("pcap", 1);
      f.set("c2pc", 1);
      break;
    case "unicase":
      f.set("unic", 1);
      break;
    case "titling-caps":
      f.set("titl", 1);
      break;
  }
  for (const w of style.fontVariantNumeric) {
    const tag = { "lining-nums": "lnum", "oldstyle-nums": "onum", "proportional-nums": "pnum", "tabular-nums": "tnum", "diagonal-fractions": "frac", "stacked-fractions": "afrc", ordinal: "ordn", "slashed-zero": "zero" }[w];
    if (tag) f.set(tag, 1);
  }
  if (style.fontVariantPosition === "sub") f.set("subs", 1);
  else if (style.fontVariantPosition === "super") f.set("sups", 1);
  // CSS Text 3 §8.2: no optional ligatures when letter-spacing is not zero.
  if (style.letterSpacing !== 0) for (const t of ["liga", "clig", "dlig", "hlig", "calt"]) f.set(t, 0);
  for (const [tag, v] of Object.entries(style.fontFeatureSettings)) f.set(tag, v);
  return [...f];
}

/** Characters of shaping context kept on each side of an item. */
const CONTEXT = 16;

function isLowSurrogate(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff;
}

let buffer: InstanceType<ReturnType<typeof harfbuzz>["Buffer"]> | null = null;

/**
 * Shapes `text[start, end)` with the given font and direction. The rest of
 * the paragraph is context only.
 */
export function shapeItem(
  text: string,
  start: number,
  end: number,
  font: FontInstance,
  rtl: boolean,
  script: string,
  language: string,
  features: readonly [string, number][],
): ShapedGlyphs {
  const hb = harfbuzz();
  buffer ??= new hb.Buffer();
  const buf = buffer;
  buf.reset();
  // A few characters of context on each side are all HarfBuzz looks at; copying the
  // whole paragraph for every item would make long paragraphs quadratic.
  let ctxStart = Math.max(0, start - CONTEXT);
  let ctxEnd = Math.min(text.length, end + CONTEXT);
  if (ctxStart > 0 && isLowSurrogate(text.charCodeAt(ctxStart))) ctxStart--;
  if (ctxEnd < text.length && isLowSurrogate(text.charCodeAt(ctxEnd))) ctxEnd++;
  buf.addText(ctxStart === 0 && ctxEnd === text.length ? text : text.slice(ctxStart, ctxEnd), start - ctxStart, end - start);
  buf.setDirection(rtl ? hb.Direction.RTL : hb.Direction.LTR);
  if (script && script !== "Zyyy" && script !== "Zinh" && script !== "Zzzz") buf.setScript(script);
  if (language) buf.setLanguage(language);
  buf.setFlags((start === 0 ? hb.BufferFlag.BOT : 0) | (end === text.length ? hb.BufferFlag.EOT : 0));
  hb.shape(font.hbFont, buf, features.map(([t, v]) => new hb.Feature(t, v)));
  const infos = buf.getGlyphInfos();
  const positions = buf.getGlyphPositions();
  const n = infos.length;
  const out: ShapedGlyphs = {
    gids: new Uint32Array(n),
    clusters: new Int32Array(n),
    advances: new Float64Array(n),
    offsetsX: new Float64Array(n),
    offsetsY: new Float64Array(n),
    flags: new Uint8Array(n),
  };
  const k = 1 / HB_SUBUNITS;
  for (let i = 0; i < n; i++) {
    const info = infos[i]!;
    const pos = positions[i]!;
    (out.gids as Uint32Array)[i] = info.codepoint;
    (out.clusters as Int32Array)[i] = info.cluster + ctxStart;
    (out.flags as Uint8Array)[i] = info.flags;
    (out.advances as Float64Array)[i] = pos.xAdvance * k;
    (out.offsetsX as Float64Array)[i] = pos.xOffset * k;
    (out.offsetsY as Float64Array)[i] = pos.yOffset * k;
  }
  return out;
}
