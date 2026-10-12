import {
  GENERAL_CATEGORY_VALUES,
  GRAPHEME_BREAK_VALUES,
  INDIC_CONJUNCT_BREAK_VALUES,
  LINE_BREAK_VALUES,
  SCRIPT_VALUES,
  TABLES,
} from "./data.generated";

/**
 * Unicode character properties from run tables generated out of the UCD
 * (see scripts/unicode/generate.mjs). Each table is decoded on first use;
 * the Basic Multilingual Plane is expanded into a direct lookup array and
 * supplementary planes use a binary search over the runs.
 */

export type LineBreakClass = (typeof LINE_BREAK_VALUES)[number];
export type GraphemeBreakClass = (typeof GRAPHEME_BREAK_VALUES)[number];
export type IndicConjunctBreak = (typeof INDIC_CONJUNCT_BREAK_VALUES)[number];
export type GeneralCategory = (typeof GENERAL_CATEGORY_VALUES)[number];
/** ISO 15924 script code (`Zyyy` common, `Zinh` inherited, `Zzzz` unknown). */
export type ScriptCode = (typeof SCRIPT_VALUES)[number];

class RunTable {
  private bmp: Uint8Array | null = null;
  private starts: Uint32Array | null = null;
  private values: Uint8Array | null = null;

  constructor(private readonly base64: string) {}

  private decode(): void {
    const bin = atob(this.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const runs = new Uint32Array(bytes.buffer, 0, bytes.length / 4);
    this.starts = new Uint32Array(runs.length);
    this.values = new Uint8Array(runs.length);
    for (let i = 0; i < runs.length; i++) {
      this.starts[i] = runs[i]! >>> 8;
      this.values[i] = runs[i]! & 0xff;
    }
    const bmp = new Uint8Array(0x10000);
    for (let i = 0; i < runs.length; i++) {
      const a = this.starts[i]!;
      if (a >= 0x10000) break;
      const b = i + 1 < runs.length ? Math.min(this.starts[i + 1]!, 0x10000) : 0x10000;
      bmp.fill(this.values[i]!, a, b);
    }
    this.bmp = bmp;
  }

  get(cp: number): number {
    if (!this.bmp) this.decode();
    if (cp < 0x10000) return this.bmp![cp]!;
    const starts = this.starts!;
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= cp) lo = mid;
      else hi = mid - 1;
    }
    return this.values![lo]!;
  }
}

const lineBreakTable = new RunTable(TABLES.lineBreak);
const graphemeTable = new RunTable(TABLES.graphemeBreak);
const incbTable = new RunTable(TABLES.indicConjunctBreak);
const gcTable = new RunTable(TABLES.generalCategory);
const scriptTable = new RunTable(TABLES.script);
const flagTable = new RunTable(TABLES.flags);

/** Line_Break property value index (see {@link LINE_BREAK_VALUES}). */
export function lineBreakIndex(cp: number): number {
  return lineBreakTable.get(cp);
}

export function lineBreakClass(cp: number): LineBreakClass {
  return LINE_BREAK_VALUES[lineBreakTable.get(cp)]!;
}

export function graphemeBreakIndex(cp: number): number {
  return graphemeTable.get(cp);
}

export function graphemeBreakClass(cp: number): GraphemeBreakClass {
  return GRAPHEME_BREAK_VALUES[graphemeTable.get(cp)]!;
}

export function indicConjunctBreak(cp: number): IndicConjunctBreak {
  return INDIC_CONJUNCT_BREAK_VALUES[incbTable.get(cp)]!;
}

export function generalCategory(cp: number): GeneralCategory {
  return GENERAL_CATEGORY_VALUES[gcTable.get(cp)]!;
}

export function script(cp: number): ScriptCode {
  return SCRIPT_VALUES[scriptTable.get(cp)]!;
}

/** East_Asian_Width is Fullwidth, Wide or Halfwidth. */
export function isEastAsianFWH(cp: number): boolean {
  return (flagTable.get(cp) & 1) !== 0;
}

export function isExtendedPictographic(cp: number): boolean {
  return (flagTable.get(cp) & 2) !== 0;
}

export function isEmojiPresentation(cp: number): boolean {
  return (flagTable.get(cp) & 4) !== 0;
}

export function isEmoji(cp: number): boolean {
  return (flagTable.get(cp) & 8) !== 0;
}

/** Letters, marks and numbers (general categories L*, M*, N*). */
export function isLetterOrNumber(cp: number): boolean {
  const gc = generalCategory(cp);
  const c = gc.charCodeAt(0);
  return c === 76 /* L */ || c === 77 /* M */ || c === 78 /* N */;
}

export function isMark(cp: number): boolean {
  return generalCategory(cp).charCodeAt(0) === 77;
}

/** Code point at UTF-16 index `i` (a lone surrogate is returned as is). */
export function codePointAt(s: string, i: number): number {
  const c = s.charCodeAt(i);
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
    const d = s.charCodeAt(i + 1);
    if (d >= 0xdc00 && d <= 0xdfff) return ((c - 0xd800) << 10) + (d - 0xdc00) + 0x10000;
  }
  return c;
}

/** UTF-16 length of a code point. */
export function cpLength(cp: number): number {
  return cp >= 0x10000 ? 2 : 1;
}
