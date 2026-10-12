import type { FaceStyle } from "./font/face";

/**
 * Computed CSS for text. {@link TextStyle} holds the properties of an inline
 * box (a style run); {@link ParagraphStyle} the block container's. Every
 * property here inherits in CSS, so runs start from their parent's values.
 */

export type LineHeight =
  | { readonly kind: "normal" }
  /** A unitless multiple of the font size. */
  | { readonly kind: "number"; readonly value: number }
  /** A computed length in px (percentages compute to lengths). */
  | { readonly kind: "px"; readonly value: number };

export interface TextDecorationLine {
  readonly underline: boolean;
  readonly overline: boolean;
  readonly lineThrough: boolean;
}

export interface TextStyle {
  readonly fontFamily: readonly string[];
  readonly fontSize: number;
  readonly fontWeight: number;
  readonly fontStyle: FaceStyle;
  /** Percentage (100 = normal). */
  readonly fontStretch: number;
  readonly fontFeatureSettings: Readonly<Record<string, number>>;
  readonly fontVariationSettings: Readonly<Record<string, number>>;
  readonly fontKerning: "auto" | "normal" | "none";
  /** `font-variant-ligatures` keywords (`normal`, `none`, or a list such as `no-common-ligatures discretionary-ligatures`). */
  readonly fontVariantLigatures: readonly string[];
  readonly fontVariantCaps: "normal" | "small-caps" | "all-small-caps" | "petite-caps" | "all-petite-caps" | "unicase" | "titling-caps";
  readonly fontVariantNumeric: readonly string[];
  readonly fontVariantPosition: "normal" | "sub" | "super";
  readonly fontOpticalSizing: "auto" | "none";
  readonly lineHeight: LineHeight;
  /** px */
  readonly letterSpacing: number;
  /** px */
  readonly wordSpacing: number;
  readonly textTransform: "none" | "uppercase" | "lowercase" | "capitalize" | "full-width";
  readonly textDecorationLine: TextDecorationLine;
  /** `auto`, `from-font`, or px. */
  readonly textDecorationThickness: "auto" | "from-font" | number;
  /** `auto` or px. */
  readonly textUnderlineOffset: "auto" | number;
  /** BCP 47 language tag (HTML `lang`), for shaping. */
  readonly language: string;
  /** Opaque paint reference carried through to glyph runs (fills, colors). */
  readonly paint: unknown;
}

export interface ParagraphStyle {
  /** `auto` takes the direction of the first strong character (HTML `dir="auto"`). */
  readonly direction: "ltr" | "rtl" | "auto";
  readonly textAlign: "start" | "end" | "left" | "right" | "center" | "justify";
  readonly textAlignLast: "auto" | "start" | "end" | "left" | "right" | "center" | "justify";
  /** px, or a percentage of the containing block width. */
  readonly textIndent: number | { readonly percent: number };
  readonly whiteSpaceCollapse: "collapse" | "preserve" | "preserve-breaks" | "break-spaces";
  readonly textWrapMode: "wrap" | "nowrap";
  readonly textWrapStyle: "auto" | "balance" | "pretty" | "stable";
  readonly overflowWrap: "normal" | "break-word" | "anywhere";
  readonly wordBreak: "normal" | "break-all" | "keep-all" | "break-word";
  readonly lineBreak: "auto" | "loose" | "normal" | "strict" | "anywhere";
  readonly hyphens: "none" | "manual" | "auto";
  /** In spaces. */
  readonly tabSize: number;
  readonly textOverflow: "clip" | "ellipsis";
  /** `-webkit-line-clamp` (null = none). */
  readonly lineClamp: number | null;
  /** Whether the block clips overflow (text-overflow only applies then). */
  readonly overflowHidden: boolean;
}

export const DEFAULT_TEXT_STYLE: TextStyle = {
  fontFamily: ["sans-serif"],
  fontSize: 16,
  fontWeight: 400,
  fontStyle: "normal",
  fontStretch: 100,
  fontFeatureSettings: {},
  fontVariationSettings: {},
  fontKerning: "auto",
  fontVariantLigatures: ["normal"],
  fontVariantCaps: "normal",
  fontVariantNumeric: ["normal"],
  fontVariantPosition: "normal",
  fontOpticalSizing: "auto",
  lineHeight: { kind: "normal" },
  letterSpacing: 0,
  wordSpacing: 0,
  textTransform: "none",
  textDecorationLine: { underline: false, overline: false, lineThrough: false },
  textDecorationThickness: "auto",
  textUnderlineOffset: "auto",
  language: "",
  paint: null,
};

export const DEFAULT_PARAGRAPH_STYLE: ParagraphStyle = {
  direction: "ltr",
  textAlign: "start",
  textAlignLast: "auto",
  textIndent: 0,
  whiteSpaceCollapse: "collapse",
  textWrapMode: "wrap",
  textWrapStyle: "auto",
  overflowWrap: "normal",
  wordBreak: "normal",
  lineBreak: "auto",
  hyphens: "manual",
  tabSize: 8,
  textOverflow: "clip",
  lineClamp: null,
  overflowHidden: false,
};

/** Line height in px of a style whose line-height is not `normal`. */
export function computedLineHeight(style: TextStyle): number | null {
  const lh = style.lineHeight;
  if (lh.kind === "normal") return null;
  return lh.kind === "number" ? lh.value * style.fontSize : lh.value;
}

/** Whether two styles shape and measure identically (paint and decorations aside). */
export function sameShaping(a: TextStyle, b: TextStyle): boolean {
  return (
    a.fontSize === b.fontSize &&
    a.fontWeight === b.fontWeight &&
    a.fontStyle === b.fontStyle &&
    a.fontStretch === b.fontStretch &&
    a.letterSpacing === b.letterSpacing &&
    a.wordSpacing === b.wordSpacing &&
    a.fontKerning === b.fontKerning &&
    a.fontVariantCaps === b.fontVariantCaps &&
    a.fontVariantPosition === b.fontVariantPosition &&
    a.fontOpticalSizing === b.fontOpticalSizing &&
    a.language === b.language &&
    sameList(a.fontFamily, b.fontFamily) &&
    sameList(a.fontVariantLigatures, b.fontVariantLigatures) &&
    sameList(a.fontVariantNumeric, b.fontVariantNumeric) &&
    sameRecord(a.fontFeatureSettings, b.fontFeatureSettings) &&
    sameRecord(a.fontVariationSettings, b.fontVariationSettings)
  );
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function sameRecord(a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
}
