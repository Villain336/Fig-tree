import type { FaceStyle } from "./font/face";
import { DEFAULT_PARAGRAPH_STYLE, DEFAULT_TEXT_STYLE, type LineHeight, type ParagraphStyle, type TextStyle } from "./style";

/**
 * Parses CSS declarations of text properties into computed styles, with
 * inheritance from a parent style. The same declarations render the
 * conformance cases in Chromium, and documents state their typography as
 * CSS through the same parser, so what is laid out is what code export
 * emits.
 */

export class TextCssError extends Error {
  override readonly name = "TextCssError";
  constructor(
    readonly property: string,
    readonly value: string,
  ) {
    super(`invalid value for ${property}: ${value}`);
  }
}

export type Declarations = string | Readonly<Record<string, string>>;

/** Splits a declaration block into lowercase property names and values. */
export function declarations(input: Declarations): [string, string][] {
  if (typeof input !== "string") return Object.entries(input).map(([k, v]) => [k.trim().toLowerCase(), String(v).trim()]);
  const out: [string, string][] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  const flush = (end: number): void => {
    const decl = input.slice(start, end);
    const i = decl.indexOf(":");
    if (i > 0) out.push([decl.slice(0, i).trim().toLowerCase(), decl.slice(i + 1).trim()]);
  };
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === ";" && depth === 0) {
      flush(i);
      start = i + 1;
    }
  }
  flush(input.length);
  return out.filter(([k, v]) => k && v);
}

const ABSOLUTE_SIZES: Record<string, number> = { "xx-small": 9, "x-small": 10, small: 13, medium: 16, large: 18, "x-large": 24, "xx-large": 32, "xxx-large": 48 };
const STRETCH_KEYWORDS: Record<string, number> = {
  "ultra-condensed": 50,
  "extra-condensed": 62.5,
  condensed: 75,
  "semi-condensed": 87.5,
  normal: 100,
  "semi-expanded": 112.5,
  expanded: 125,
  "extra-expanded": 150,
  "ultra-expanded": 200,
};

/** A length in px (`px`, `em` relative to `em`, `rem` relative to 16px), or null. */
function length(v: string, em: number): number | null {
  const m = /^(-?\d*\.?\d+(?:e[+-]?\d+)?)(px|em|rem)?$/i.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? "").toLowerCase();
  if (unit === "px") return n;
  if (unit === "em") return n * em;
  if (unit === "rem") return n * 16;
  return n === 0 ? 0 : null;
}

function percent(v: string): number | null {
  const m = /^(-?\d*\.?\d+)%$/.exec(v.trim());
  return m ? Number(m[1]) : null;
}

function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t.replace(/\s+/g, " ");
}

/** Splits on top-level commas (outside quotes). */
function commaList(v: string): string[] {
  const out: string[] = [];
  let quote = "";
  let start = 0;
  for (let i = 0; i < v.length; i++) {
    const c = v[i]!;
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ",") {
      out.push(v.slice(start, i));
      start = i + 1;
    }
  }
  out.push(v.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

function tagSettings(property: string, v: string, defaultValue: number | null): Record<string, number> {
  if (v.trim() === "normal") return {};
  const out: Record<string, number> = {};
  for (const item of commaList(v)) {
    const m = /^(["'])([\x20-\x7e]{4})\1(?:\s+(on|off|-?\d*\.?\d+))?$/.exec(item);
    if (!m) throw new TextCssError(property, v);
    const raw = m[3];
    const value = raw === undefined ? defaultValue : raw === "on" ? 1 : raw === "off" ? 0 : Number(raw);
    if (value === null) throw new TextCssError(property, v);
    out[m[2]!] = value;
  }
  return out;
}

function relativeWeight(parent: number, keyword: "bolder" | "lighter"): number {
  // CSS Fonts 4 §2.2 table.
  if (keyword === "bolder") return parent < 350 ? 400 : parent < 550 ? 700 : parent < 900 ? 900 : parent;
  return parent < 100 ? parent : parent < 550 ? 100 : parent < 750 ? 400 : 700;
}

/** Parses the text properties of a declaration block, inheriting from `parent`. Unknown properties are ignored. */
export function parseTextStyle(input: Declarations, parent: TextStyle = DEFAULT_TEXT_STYLE): TextStyle {
  const decls = declarations(input);
  const s: { -readonly [K in keyof TextStyle]: TextStyle[K] } = { ...parent };
  // font-size first: em values of other properties depend on it.
  for (const [k, v] of decls) {
    if (k === "font-size") s.fontSize = fontSize(v, parent.fontSize);
    if (k === "font") applyFontShorthand(s, v, parent);
  }
  for (const [k, v] of decls) {
    switch (k) {
      case "font-family":
        s.fontFamily = commaList(v).map(unquote);
        break;
      case "font-weight": {
        const w = v === "normal" ? 400 : v === "bold" ? 700 : v === "bolder" || v === "lighter" ? relativeWeight(parent.fontWeight, v) : Number(v);
        if (!Number.isFinite(w) || w < 1 || w > 1000) throw new TextCssError(k, v);
        s.fontWeight = w;
        break;
      }
      case "font-style": {
        const m = /^(normal|italic|oblique)(\s+-?\d*\.?\d+deg)?$/.exec(v);
        if (!m) throw new TextCssError(k, v);
        s.fontStyle = m[1] as FaceStyle;
        break;
      }
      case "font-stretch": {
        const p = percent(v) ?? STRETCH_KEYWORDS[v];
        if (p === undefined || p < 0) throw new TextCssError(k, v);
        s.fontStretch = p;
        break;
      }
      case "font-feature-settings":
        s.fontFeatureSettings = tagSettings(k, v, 1);
        break;
      case "font-variation-settings":
        s.fontVariationSettings = tagSettings(k, v, null);
        break;
      case "font-kerning":
        if (v !== "auto" && v !== "normal" && v !== "none") throw new TextCssError(k, v);
        s.fontKerning = v;
        break;
      case "font-variant-ligatures":
        s.fontVariantLigatures = v.split(/\s+/);
        break;
      case "font-variant-caps":
        s.fontVariantCaps = v as TextStyle["fontVariantCaps"];
        break;
      case "font-variant-numeric":
        s.fontVariantNumeric = v.split(/\s+/);
        break;
      case "font-variant-position":
        if (v !== "normal" && v !== "sub" && v !== "super") throw new TextCssError(k, v);
        s.fontVariantPosition = v;
        break;
      case "font-variant":
        if (v === "normal") {
          s.fontVariantLigatures = ["normal"];
          s.fontVariantCaps = "normal";
          s.fontVariantNumeric = ["normal"];
        } else if (v === "none") s.fontVariantLigatures = ["none"];
        else if (v === "small-caps") s.fontVariantCaps = "small-caps";
        break;
      case "font-optical-sizing":
        if (v !== "auto" && v !== "none") throw new TextCssError(k, v);
        s.fontOpticalSizing = v;
        break;
      case "line-height":
        s.lineHeight = lineHeight(v, s.fontSize);
        break;
      case "letter-spacing": {
        const px = v === "normal" ? 0 : length(v, s.fontSize);
        if (px === null) throw new TextCssError(k, v);
        s.letterSpacing = px;
        break;
      }
      case "word-spacing": {
        const px = v === "normal" ? 0 : length(v, s.fontSize);
        if (px === null) throw new TextCssError(k, v);
        s.wordSpacing = px;
        break;
      }
      case "text-transform":
        if (!["none", "uppercase", "lowercase", "capitalize", "full-width"].includes(v)) throw new TextCssError(k, v);
        s.textTransform = v as TextStyle["textTransform"];
        break;
      case "text-decoration":
      case "text-decoration-line": {
        const words = v.split(/\s+/);
        if (k === "text-decoration-line" || words.some((w) => ["none", "underline", "overline", "line-through"].includes(w))) {
          s.textDecorationLine = { underline: words.includes("underline"), overline: words.includes("overline"), lineThrough: words.includes("line-through") };
        }
        for (const w of words) {
          const px = length(w, s.fontSize);
          if (px !== null) s.textDecorationThickness = px;
        }
        break;
      }
      case "text-decoration-thickness": {
        const px = v === "auto" || v === "from-font" ? v : length(v, s.fontSize);
        if (px === null) throw new TextCssError(k, v);
        s.textDecorationThickness = px;
        break;
      }
      case "text-underline-offset": {
        const px = v === "auto" ? v : length(v, s.fontSize);
        if (px === null) throw new TextCssError(k, v);
        s.textUnderlineOffset = px;
        break;
      }
    }
  }
  return s;
}

function fontSize(v: string, parentSize: number): number {
  const abs = ABSOLUTE_SIZES[v];
  if (abs !== undefined) return abs;
  if (v === "larger") return parentSize * 1.2;
  if (v === "smaller") return parentSize / 1.2;
  const p = percent(v);
  if (p !== null) return (parentSize * p) / 100;
  const px = length(v, parentSize);
  if (px === null || px < 0) throw new TextCssError("font-size", v);
  return px;
}

function lineHeight(v: string, size: number): LineHeight {
  if (v === "normal") return { kind: "normal" };
  if (/^\d*\.?\d+$/.test(v)) return { kind: "number", value: Number(v) };
  const p = percent(v);
  if (p !== null) return { kind: "px", value: (size * p) / 100 };
  const px = length(v, size);
  if (px === null || px < 0) throw new TextCssError("line-height", v);
  return { kind: "px", value: px };
}

/** `font: [style] [variant] [weight] [stretch] size[/line-height] family`. */
function applyFontShorthand(s: { -readonly [K in keyof TextStyle]: TextStyle[K] }, v: string, parent: TextStyle): void {
  const m = /^((?:(?:italic|oblique|normal|small-caps|bold|bolder|lighter|\d{3}|[a-z-]*condensed|[a-z-]*expanded)\s+)*)(\S+?)(?:\/(\S+))?\s+(.+)$/.exec(v.trim());
  if (!m) throw new TextCssError("font", v);
  s.fontStyle = "normal";
  s.fontWeight = 400;
  s.fontStretch = 100;
  s.fontVariantCaps = "normal";
  s.lineHeight = { kind: "normal" };
  for (const w of m[1]!.trim().split(/\s+/).filter(Boolean)) {
    if (w === "italic" || w === "oblique") s.fontStyle = w;
    else if (w === "small-caps") s.fontVariantCaps = "small-caps";
    else if (w === "bold") s.fontWeight = 700;
    else if (w === "bolder" || w === "lighter") s.fontWeight = relativeWeight(parent.fontWeight, w);
    else if (/^\d{3}$/.test(w)) s.fontWeight = Number(w);
    else if (STRETCH_KEYWORDS[w] !== undefined) s.fontStretch = STRETCH_KEYWORDS[w]!;
  }
  s.fontSize = fontSize(m[2]!, parent.fontSize);
  if (m[3]) s.lineHeight = lineHeight(m[3], s.fontSize);
  s.fontFamily = commaList(m[4]!).map(unquote);
}

/** Parses the block-level text properties (inheriting from `parent`). */
export function parseParagraphStyle(input: Declarations, parent: ParagraphStyle = DEFAULT_PARAGRAPH_STYLE): ParagraphStyle {
  const s: { -readonly [K in keyof ParagraphStyle]: ParagraphStyle[K] } = { ...parent, overflowHidden: false, lineClamp: null, textOverflow: "clip" };
  for (const [k, v] of declarations(input)) {
    switch (k) {
      case "direction":
        if (v !== "ltr" && v !== "rtl" && v !== "auto") throw new TextCssError(k, v);
        s.direction = v;
        break;
      case "text-align":
        if (!["start", "end", "left", "right", "center", "justify"].includes(v)) throw new TextCssError(k, v);
        s.textAlign = v as ParagraphStyle["textAlign"];
        break;
      case "text-align-last":
        s.textAlignLast = v as ParagraphStyle["textAlignLast"];
        break;
      case "text-indent": {
        const p = percent(v);
        if (p !== null) s.textIndent = { percent: p };
        else {
          const px = length(v, 16);
          if (px === null) throw new TextCssError(k, v);
          s.textIndent = px;
        }
        break;
      }
      case "white-space": {
        const map: Record<string, [ParagraphStyle["whiteSpaceCollapse"], ParagraphStyle["textWrapMode"]]> = {
          normal: ["collapse", "wrap"],
          pre: ["preserve", "nowrap"],
          nowrap: ["collapse", "nowrap"],
          "pre-wrap": ["preserve", "wrap"],
          "pre-line": ["preserve-breaks", "wrap"],
          "break-spaces": ["break-spaces", "wrap"],
        };
        const e = map[v];
        if (!e) throw new TextCssError(k, v);
        [s.whiteSpaceCollapse, s.textWrapMode] = e;
        break;
      }
      case "white-space-collapse":
        s.whiteSpaceCollapse = v as ParagraphStyle["whiteSpaceCollapse"];
        break;
      case "text-wrap-mode":
        s.textWrapMode = v as ParagraphStyle["textWrapMode"];
        break;
      case "text-wrap":
        if (v === "wrap" || v === "nowrap") s.textWrapMode = v;
        else if (v === "balance" || v === "pretty" || v === "stable") {
          s.textWrapMode = "wrap";
          s.textWrapStyle = v;
        } else throw new TextCssError(k, v);
        break;
      case "text-wrap-style":
        s.textWrapStyle = v as ParagraphStyle["textWrapStyle"];
        break;
      case "overflow-wrap":
      case "word-wrap":
        if (v !== "normal" && v !== "break-word" && v !== "anywhere") throw new TextCssError(k, v);
        s.overflowWrap = v;
        break;
      case "word-break":
        if (!["normal", "break-all", "keep-all", "break-word"].includes(v)) throw new TextCssError(k, v);
        s.wordBreak = v as ParagraphStyle["wordBreak"];
        break;
      case "line-break":
        s.lineBreak = v as ParagraphStyle["lineBreak"];
        break;
      case "hyphens":
        if (v !== "none" && v !== "manual" && v !== "auto") throw new TextCssError(k, v);
        s.hyphens = v;
        break;
      case "tab-size":
        s.tabSize = Number(v);
        break;
      case "text-overflow":
        if (v !== "clip" && v !== "ellipsis") throw new TextCssError(k, v);
        s.textOverflow = v;
        break;
      case "-webkit-line-clamp":
      case "line-clamp":
        s.lineClamp = v === "none" ? null : Math.max(1, Math.floor(Number(v)));
        break;
      case "overflow":
      case "overflow-x":
        s.overflowHidden = v !== "visible";
        break;
    }
  }
  return s;
}
