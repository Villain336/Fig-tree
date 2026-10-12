/// <reference path="../types/modules.d.ts" />
import bidiFactory from "bidi-js";
import type { FontInstance } from "../font/face";
import { instanceFor, type FontRegistry, type FontRequest, type MatchedFont } from "../font/registry";
import { computedLineHeight, type ParagraphStyle, type TextStyle } from "../style";
import { graphemeBoundaries } from "../unicode/grapheme";
import { ALLOW_BREAK, MANDATORY_BREAK, NO_BREAK, lineBreaks } from "../unicode/linebreak";
import { codePointAt, cpLength, isEastAsianFWH, script as scriptOf } from "../unicode/props";
import { CHAR_FORCED_BREAK, CHAR_PRESERVED_SPACE, CHAR_SOFT_HYPHEN, CHAR_TAB, CHAR_WORD_SEPARATOR, prepareText, type PreparedText, type Span } from "./prepare";
import { featuresFor, shapeItem, type ShapedGlyphs } from "./shape";

/**
 * Shaping stage of paragraph layout (everything that does not depend on the
 * available width): text-transform and white space processing, the Unicode
 * bidirectional algorithm, itemization by style, direction, script and
 * font (with per-character fallback), HarfBuzz shaping, letter and word
 * spacing, and line break opportunities. {@link layoutLines} then breaks
 * the result into lines for a width.
 */

let bidi: ReturnType<typeof bidiFactory> | null = null;

export interface ParagraphInput {
  /** Source text of the paragraph (one block container's content). */
  readonly text: string;
  /** Style runs covering `text` contiguously; each run is an inline box. */
  readonly spans: readonly Span[];
  /** Block-level properties. */
  readonly style: ParagraphStyle;
  /** The block's own text style: the root inline box (strut). */
  readonly root: TextStyle;
  /** Space reserved on the inline-start side (a list item's `padding-inline-start`), px. */
  readonly inlineStart?: number;
  /** A list marker drawn outside the content, ending at its inline-start edge (e.g. "• " or "1. "), in the root style. */
  readonly marker?: string;
  /** An empty paragraph still has one line box (like `<p><br></p>`), as design tools show blank paragraphs. */
  readonly emptyLine?: boolean;
}

/** Vertical metrics of a font at a size, in px, rounded as Chromium rounds them (whole pixels). */
export interface FontMetricsPx {
  readonly ascent: number;
  readonly descent: number;
  readonly lineGap: number;
}

export interface Item {
  readonly start: number;
  readonly end: number;
  readonly span: number;
  /** Bidi embedding level (odd = right to left). */
  readonly level: number;
  readonly script: string;
  /** Null for characters no font has (they render as nothing, with no advance). */
  readonly font: FontInstance | null;
  readonly match: MatchedFont | null;
  /** Font size in px used for scaling outlines and advances. */
  readonly size: number;
  /** px per font unit. */
  readonly scale: number;
  readonly glyphs: ShapedGlyphs | null;
  /** Metrics of the item's font at the span's size (for `line-height: normal` line boxes). */
  readonly metrics: FontMetricsPx;
}

/** Metrics of an inline box (a span or the root): its first available font and line height. */
export interface BoxMetrics {
  readonly ascent: number;
  readonly descent: number;
  readonly lineGap: number;
  /** Computed line height in px, or null for `normal`. */
  readonly lineHeight: number | null;
  readonly font: FontInstance | null;
  readonly match: MatchedFont | null;
  readonly size: number;
}

/**
 * Chromium sizes fonts in 1/64 px steps (FreeType's 26.6 fixed point), so
 * advances and metrics scale with the font size floored to 1/64 px.
 */
export function effectiveFontSize(size: number): number {
  return Math.floor(size * 64 + 1e-6) / 64;
}

export function fontMetricsPx(font: FontInstance | null, size: number): FontMetricsPx {
  if (!font) return { ascent: 0, descent: 0, lineGap: 0 };
  const s = effectiveFontSize(size) / font.unitsPerEm;
  const m = font.metrics;
  return { ascent: Math.round(m.ascender * s), descent: Math.round(m.descender * s), lineGap: Math.round(m.lineGap * s) };
}

export function requestOf(style: TextStyle): FontRequest {
  return { weight: style.fontWeight, style: style.fontStyle, stretch: style.fontStretch };
}

export class ShapedParagraph {
  readonly prepared: PreparedText;
  /** Bidi level per prepared code unit, and the paragraph level. */
  readonly levels: Uint8Array;
  readonly baseLevel: number;
  readonly items: Item[] = [];
  /** Item index per prepared code unit. */
  readonly itemOf: Int32Array;
  /** Advance (px, with letter and word spacing) of the cluster starting at each code unit; 0 inside clusters. Tabs are NaN (resolved at layout). */
  readonly advance: Float64Array;
  /** Sum of the glyph advances (px, no spacing) of the cluster starting at each code unit. */
  readonly glyphAdvance: Float64Array;
  /** Start of the shaping cluster each code unit belongs to. */
  readonly clusterStart: Int32Array;
  /** Line break opportunities before each code unit (see `lineBreaks`). */
  readonly breaks: Uint8Array;
  readonly graphemes: Uint8Array;
  readonly spanBoxes: BoxMetrics[];
  readonly rootBox: BoxMetrics;
  /** Whether a font this paragraph needs is still loading (layout runs again when it arrives). */
  readonly pendingFonts: boolean;
  /** Width of a space in the root style, for tab stops (px, with letter and word spacing). */
  readonly spaceAdvance: number;
  /** A tab stop closer than this is skipped (half the root font's space, as Chromium does). */
  readonly tabMinimum: number;
  private minMax: { min: number; max: number } | null = null;

  constructor(
    readonly input: ParagraphInput,
    readonly fonts: FontRegistry,
  ) {
    const { style, spans, root } = input;
    const prepared = prepareText(input.text, spans, style);
    this.prepared = prepared;
    const text = prepared.text;
    const n = text.length;
    const pending = { value: false };

    // Bidi levels.
    bidi ??= bidiFactory();
    if (n > 0) {
      const emb = bidi.getEmbeddingLevels(text, style.direction === "auto" ? undefined : style.direction);
      this.levels = emb.levels;
      this.baseLevel = emb.paragraphs[0]?.level ?? (style.direction === "rtl" ? 1 : 0);
    } else {
      this.levels = new Uint8Array(0);
      this.baseLevel = style.direction === "rtl" ? 1 : 0;
    }

    // Inline box metrics.
    const boxOf = (s: TextStyle): BoxMetrics => {
      const match = this.fonts.primaryFont({ families: s.fontFamily, request: requestOf(s) }, pending);
      const font = match ? instanceFor(match, requestOf(s), s.fontSize, s.fontOpticalSizing, s.fontVariationSettings) : null;
      const m = fontMetricsPx(font, s.fontSize);
      return { ...m, lineHeight: computedLineHeight(s), font, match, size: s.fontSize };
    };
    this.rootBox = boxOf(root);
    this.spanBoxes = spans.map((sp) => boxOf(sp.style));

    this.graphemes = graphemeBoundaries(text);
    this.breaks = this.computeBreaks(text, prepared, style);

    // Itemize: span, bidi level, script and font changes split items.
    this.itemOf = new Int32Array(n);
    this.advance = new Float64Array(n);
    this.glyphAdvance = new Float64Array(n);
    this.clusterStart = new Int32Array(n);
    const scripts = resolveScripts(text);
    const fontCache = new Map<string, MatchedFont | null>();
    const fontAt = (spanIndex: number, cp: number): MatchedFont | null => {
      const key = `${spanIndex}:${cp}`;
      let m = fontCache.get(key);
      if (m === undefined) {
        const st = spans[spanIndex]!.style;
        m = this.fonts.fontFor(cp, { families: st.fontFamily, request: requestOf(st) }, pending);
        fontCache.set(key, m);
      }
      return m;
    };
    let itemStart = 0;
    let cur: { span: number; level: number; script: string; match: MatchedFont | null; special: boolean } | null = null;
    const flush = (end: number): void => {
      if (!cur || end <= itemStart) return;
      this.pushItem(itemStart, end, cur.span, cur.level, cur.script, cur.match, cur.special);
      itemStart = end;
    };
    for (let i = 0; i < n; ) {
      // Whole grapheme clusters take one font.
      let g = i + 1;
      while (g < n && !this.graphemes[g]) g++;
      const cp = codePointAt(text, i);
      const span = prepared.span[i]!;
      const special = (prepared.flags[i]! & (CHAR_FORCED_BREAK | CHAR_TAB)) !== 0;
      const match = special ? (this.spanBoxes[span]!.match ?? null) : fontAt(span, cp);
      const level = this.levels[i]!;
      const script = scripts[i]!;
      if (!cur || cur.span !== span || cur.level !== level || cur.script !== script || cur.match?.typeface !== match?.typeface || cur.special || special) {
        flush(i);
        cur = { span, level, script, match, special };
      }
      i = g;
    }
    flush(n);
    this.pendingFonts = pending.value;

    // Tab stops are measured with the root style's space.
    const rootFont = this.rootBox.font;
    this.spaceAdvance = rootFont ? (rootFont.advance(rootFont.glyph(0x20)) * effectiveFontSize(root.fontSize)) / rootFont.unitsPerEm + root.letterSpacing + root.wordSpacing : root.fontSize / 4;
    this.tabMinimum = rootFont ? (rootFont.advance(rootFont.glyph(0x20)) * effectiveFontSize(root.fontSize)) / rootFont.unitsPerEm / 2 : root.fontSize / 8;
  }

  private computeBreaks(text: string, prepared: PreparedText, style: ParagraphStyle): Uint8Array {
    const wordBreak = style.wordBreak === "break-word" ? "normal" : style.wordBreak;
    // CSS Text 3 §5.3: strict, normal and loose only differ for Chinese, Japanese and Korean content.
    const cjk = /^(zh|ja|ko)\b/i.test(this.input.root.language);
    const lineBreak = style.lineBreak === "anywhere" ? "anywhere" : cjk ? style.lineBreak : "normal";
    const b = lineBreaks(text, { wordBreak, lineBreak });
    const n = text.length;
    const wrap = style.textWrapMode === "wrap";
    for (let i = 1; i < n; i++) {
      const f = prepared.flags[i - 1]!;
      if (f & CHAR_FORCED_BREAK) {
        b[i] = MANDATORY_BREAK;
        continue;
      }
      if (b[i] === MANDATORY_BREAK) b[i] = ALLOW_BREAK; // only prepared forced breaks are forced
      if (!wrap) {
        b[i] = NO_BREAK;
        continue;
      }
      if (f & CHAR_SOFT_HYPHEN && style.hyphens === "none") b[i] = NO_BREAK;
      // break-spaces: an opportunity after every preserved space.
      if (style.whiteSpaceCollapse === "break-spaces" && f & CHAR_PRESERVED_SPACE && !(f & CHAR_TAB)) b[i] = ALLOW_BREAK;
    }
    if (n > 0) b[0] = NO_BREAK;
    return b;
  }

  private pushItem(start: number, end: number, spanIndex: number, level: number, script: string, match: MatchedFont | null, special: boolean): void {
    const index = this.items.length;
    const st = this.input.spans[spanIndex]!.style;
    const text = this.prepared.text;
    const font = match ? instanceFor(match, requestOf(st), st.fontSize, st.fontOpticalSizing, st.fontVariationSettings) : null;
    const size = effectiveFontSize(st.fontSize);
    const scale = font ? size / font.unitsPerEm : 0;
    let glyphs: ShapedGlyphs | null = null;
    if (font && !special) glyphs = shapeItem(text, start, end, font, (level & 1) === 1, script, st.language, featuresFor(st));
    this.items.push({ start, end, span: spanIndex, level, script, font, match, size, scale, glyphs, metrics: fontMetricsPx(font, st.fontSize) });
    for (let i = start; i < end; i++) {
      this.itemOf[i] = index;
      this.clusterStart[i] = i;
    }
    const flags = this.prepared.flags;
    if (special) {
      for (let i = start; i < end; i++) this.advance[i] = flags[i]! & CHAR_TAB ? NaN : 0;
      return;
    }
    if (glyphs) {
      // Cluster starts: every code unit belongs to the largest glyph cluster value at or before it.
      const isStart = new Uint8Array(end - start);
      for (let g = 0; g < glyphs.clusters.length; g++) {
        const c = glyphs.clusters[g]!;
        if (c >= start && c < end) isStart[c - start] = 1;
      }
      isStart[0] = 1;
      let cs = start;
      for (let i = start; i < end; i++) {
        if (isStart[i - start]) cs = i;
        this.clusterStart[i] = cs;
      }
      for (let g = 0; g < glyphs.clusters.length; g++) {
        const c = glyphs.clusters[g]!;
        if (c >= start && c < end) this.advance[this.clusterStart[c]!] = this.advance[this.clusterStart[c]!]! + glyphs.advances[g]! * scale;
      }
      for (let i = start; i < end; i++) this.glyphAdvance[i] = this.advance[i]!;
    }
    // Letter spacing after every grapheme, word spacing on word separators (CSS Text 3 §8).
    const ls = st.letterSpacing;
    const ws = st.wordSpacing;
    for (let i = start; i < end; i++) {
      if (ls !== 0 && this.graphemes[i] && !(flags[i]! & CHAR_SOFT_HYPHEN)) this.advance[this.clusterStart[i]!] = this.advance[this.clusterStart[i]!]! + ls;
      if (ws !== 0 && flags[i]! & CHAR_WORD_SEPARATOR) this.advance[this.clusterStart[i]!] = this.advance[this.clusterStart[i]!]! + ws;
    }
  }

  get length(): number {
    return this.prepared.text.length;
  }

  /** Intrinsic inline sizes of the paragraph (CSS Sizing 3 §5.1), in px. */
  intrinsic(textIndent: number): { min: number; max: number } {
    if (this.minMax) return this.minMax;
    const n = this.length;
    const flags = this.prepared.flags;
    const style = this.input.style;
    const anywhere = style.overflowWrap === "anywhere" || style.wordBreak === "break-word";
    let max = 0;
    let min = 0;
    let lineWidth = textIndent;
    let lineVisible = textIndent;
    let segWidth = textIndent;
    let segVisible = textIndent;
    let x = 0;
    for (let i = 0; i < n; i++) {
      if (i > 0 && this.breaks[i] !== NO_BREAK) {
        min = Math.max(min, segVisible);
        segWidth = 0;
        segVisible = 0;
      }
      if (i > 0 && this.breaks[i] === MANDATORY_BREAK) {
        max = Math.max(max, lineVisible);
        lineWidth = 0;
        lineVisible = 0;
        x = 0;
      }
      if (anywhere && i > 0 && this.graphemes[i]) {
        min = Math.max(min, segVisible);
        segWidth = 0;
        segVisible = 0;
      }
      const f = flags[i]!;
      let w = this.advance[i]!;
      if (Number.isNaN(w)) w = tabAdvance(x, this.spaceAdvance * style.tabSize, this.tabMinimum);
      x += w;
      lineWidth += w;
      segWidth += w;
      const hangs = f & (CHAR_FORCED_BREAK) || ((f & (CHAR_PRESERVED_SPACE | 1)) !== 0 && style.whiteSpaceCollapse !== "break-spaces");
      if (!hangs) {
        lineVisible = lineWidth;
        segVisible = segWidth;
      }
    }
    max = Math.max(max, lineVisible);
    min = Math.max(min, segVisible);
    if (style.textWrapMode === "nowrap") min = max;
    this.minMax = { min, max };
    return this.minMax;
  }
}

/**
 * Advance of a tab at `x` (from the line start) to the next tab stop
 * (CSS Text 3 §4.2): a stop closer than `minimum` is skipped.
 */
export function tabAdvance(x: number, interval: number, minimum: number): number {
  if (!(interval > 0)) return 0;
  let next = (Math.floor(x / interval + 1e-9) + 1) * interval;
  if (next - x < minimum) next += interval;
  return next - x;
}

/** Script of every code unit, with Common and Inherited resolved to the surrounding script (UAX #24 §5.2, simplified). */
function resolveScripts(text: string): string[] {
  const n = text.length;
  const out: string[] = new Array(n);
  let last = "";
  for (let i = 0; i < n; ) {
    const cp = codePointAt(text, i);
    const len = cpLength(cp);
    let sc: string = scriptOf(cp);
    if (sc === "Zyyy" || sc === "Zinh" || sc === "Zzzz") sc = last;
    // Han, Hiragana and Katakana share East Asian width; keep them in one run for shaping.
    else if ((sc === "Hira" || sc === "Kana") && isEastAsianFWH(cp)) sc = "Hani";
    for (let k = 0; k < len; k++) out[i + k] = sc;
    if (sc) last = sc;
    i += len;
  }
  // Leading common characters take the first real script.
  let first = out.find((s) => s) ?? "Zyyy";
  for (let i = 0; i < n && !out[i]; i++) out[i] = first;
  first = "";
  return out;
}
