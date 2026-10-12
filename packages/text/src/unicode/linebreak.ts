import { graphemeBoundaries } from "./grapheme";
import { codePointAt, cpLength, generalCategory, isEastAsianFWH, isExtendedPictographic, lineBreakClass, type LineBreakClass } from "./props";

/**
 * Line break opportunities, UAX #14 revision 51 (Unicode 15.1), rules LB1
 * to LB31, with the CSS Text 3 tailorings that `word-break` and
 * `line-break: anywhere` call for. Implemented from the rule text; the
 * conformance tests run the Unicode LineBreakTest.txt cases against it.
 */

export const NO_BREAK = 0;
export const ALLOW_BREAK = 1;
export const MANDATORY_BREAK = 2;

/**
 * Pairs of printable ASCII characters where Chromium's line breaker decides
 * differently from UAX #14 (it uses its own table for ASCII text). Learned
 * by rendering every pair in Chromium 141 at width 0 and comparing with
 * this implementation (see docs/conformance.md); not taken from browser
 * source. Key: the first character; `b`: second characters after which a
 * break is allowed, `k`: second characters before which it is not.
 */
const ASCII_OVERRIDES: Record<string, { b?: string; k?: string }> = {
  "!": { k: "#$%&*+0123456789=>@ABCDEFGHIJKLMNOPQRSTUVWXYZ\\^_`abcdefghijklmnopqrstuvwxyz~" },
  '"': { b: "(<[{" },
  "#": { b: "(<[{" },
  $: { k: "$%(+[\\{" },
  "%": { b: "<", k: "$%+\\" },
  "&": { b: "(<[{" },
  ")": { b: "<", k: "$%+\\" },
  "*": { b: "(<[{" },
  "+": { b: "<", k: "$%+\\" },
  ",": { b: "<", k: "$%+0123456789\\" },
  "-": { b: "\"'-|", k: "$" },
  ".": { b: "<", k: "$%+0123456789\\" },
  "/": { k: "#$%&(*+0123456789<=>@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\^_`abcdefghijklmnopqrstuvwxyz{~" },
  ":": { b: "<", k: "$%+0123456789\\" },
  ";": { b: "<", k: "$%+0123456789\\" },
  "=": { b: "(<[{" },
  ">": { b: "(<[{" },
  "?": { b: "-|" },
  "\\": { b: "<", k: "$%+\\" },
  "]": { b: "<", k: "$%+\\" },
  "|": { k: "#$%&*+0123456789=>@ABCDEFGHIJKLMNOPQRSTUVWXYZ\\^_`abcdefghijklmnopqrstuvwxyz~" },
  "}": { k: "#$%&*+0123456789=>@ABCDEFGHIJKLMNOPQRSTUVWXYZ\\^_`abcdefghijklmnopqrstuvwxyz~" },
  "~": { b: "(<[{" },
};

function isAsciiAlnum(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}

/** Applies Chromium's ASCII tailoring to UAX #14 opportunities. */
function tailorAscii(text: string, out: Uint8Array): void {
  for (let i = 1; i < text.length; i++) {
    const a = text.charCodeAt(i - 1);
    const b = text.charCodeAt(i);
    if (a < 0x21 || a > 0x7e || b < 0x21 || b > 0x7e || out[i] === MANDATORY_BREAK) continue;
    const o = ASCII_OVERRIDES[text[i - 1]!];
    if (o?.b?.includes(text[i]!)) out[i] = ALLOW_BREAK;
    else if (o?.k?.includes(text[i]!)) out[i] = NO_BREAK;
    // A hyphen after a letter or digit is a hyphen, not a minus sign: it may break before a digit.
    else if (a === 0x2d && b >= 0x30 && b <= 0x39 && i >= 2 && isAsciiAlnum(text.charCodeAt(i - 2))) out[i] = ALLOW_BREAK;
  }
}

export interface LineBreakOptions {
  /** CSS `word-break`. `break-all` lets letters and numbers break like ideographs; `keep-all` keeps CJK runs together. */
  readonly wordBreak?: "normal" | "break-all" | "keep-all";
  /** CSS `line-break`. `strict` keeps small kana (CJ) as non-starters; `anywhere` allows a break at every grapheme boundary. */
  readonly lineBreak?: "auto" | "loose" | "normal" | "strict" | "anywhere";
  /** Apply Chromium's tailoring of ASCII punctuation pairs (default true; false gives plain UAX #14). */
  readonly chromiumAscii?: boolean;
}

const DOTTED_CIRCLE = 0x25cc;

/** LB1: resolves the classes UAX #14 leaves to the implementation, plus the CSS tailorings. */
function resolveClass(cp: number, options: LineBreakOptions): LineBreakClass {
  let c = lineBreakClass(cp);
  switch (c) {
    case "AI":
    case "SG":
    case "XX":
      c = "AL";
      break;
    case "SA": {
      const gc = generalCategory(cp);
      c = gc === "Mn" || gc === "Mc" ? "CM" : "AL";
      break;
    }
    case "CJ":
      // CSS line-break: strict keeps small kana as non-starters; normal and loose treat them as ideographs.
      c = options.lineBreak === "strict" ? "NS" : "ID";
      break;
  }
  if (options.wordBreak === "break-all" && (c === "AL" || c === "HL" || c === "NU" || c === "AK" || c === "AS" || c === "AP" || c === "VF" || c === "VI")) c = "ID";
  if (options.wordBreak === "keep-all" && (c === "ID" || c === "H2" || c === "H3" || c === "JL" || c === "JV" || c === "JT")) c = "AL";
  return c;
}

function isAkLike(c: LineBreakClass, cp: number): boolean {
  return c === "AK" || c === "AS" || cp === DOTTED_CIRCLE;
}

/**
 * Break opportunities for every UTF-16 offset 0..length: `out[i]` is
 * {@link NO_BREAK}, {@link ALLOW_BREAK} or {@link MANDATORY_BREAK} for the
 * position before code unit `i`. Offsets inside a surrogate pair are
 * {@link NO_BREAK}; the end of the text is mandatory (LB3).
 */
export function lineBreaks(text: string, options: LineBreakOptions = {}): Uint8Array {
  const n = text.length;
  const out = new Uint8Array(n + 1);
  if (n === 0) return out;
  out[n] = MANDATORY_BREAK;
  if (options.lineBreak === "anywhere") return anywhereBreaks(text, out);

  // Code points with resolved classes.
  const cps: number[] = [];
  const offs: number[] = [];
  const cls: LineBreakClass[] = [];
  for (let i = 0; i < n; ) {
    const cp = codePointAt(text, i);
    cps.push(cp);
    offs.push(i);
    cls.push(resolveClass(cp, options));
    i += cpLength(cp);
  }
  const m = cps.length;

  // Effective class of the character before the current position (after LB9/LB10).
  let L: LineBreakClass = cls[0]!;
  let Lcp = cps[0]!;
  if (L === "CM" || L === "ZWJ") L = "AL"; // LB10 at the start of text
  let L2: LineBreakClass | null = null; // effective class before L (LB28a)
  let L2cp = -1;
  let rawPrev: LineBreakClass = cls[0]!; // raw class of the previous code point (LB8a)
  // States of the "X SP*" rules, true while only spaces followed X.
  let s8 = L === "ZW";
  let s14 = L === "OP";
  let s15a = L === "QU" && generalCategory(Lcp) === "Pi"; // preceded by sot
  let s16 = L === "CL" || L === "CP";
  let s17 = L === "B2";
  let s21a = false;
  let riRun = L === "RI" ? 1 : 0;
  // LB25: L ends "NU (NU | SY | IS)*" (numSeq) or that followed by CL or CP (numClose).
  let numSeq = L === "NU";
  let numClose = false;

  for (let k = 1; k < m; k++) {
    const pos = offs[k]!;
    const rcp = cps[k]!;
    let R = cls[k]!;
    let decision: number;
    let attached = false;

    if (L === "BK" || L === "LF" || L === "NL") decision = MANDATORY_BREAK; // LB4, LB5
    else if (L === "CR") decision = R === "LF" ? NO_BREAK : MANDATORY_BREAK; // LB5
    else if (R === "BK" || R === "CR" || R === "LF" || R === "NL") decision = NO_BREAK; // LB6
    else if (R === "SP" || R === "ZW") decision = NO_BREAK; // LB7
    else if (s8) decision = ALLOW_BREAK; // LB8
    else if (rawPrev === "ZWJ") {
      decision = NO_BREAK; // LB8a
      if (R === "CM" || R === "ZWJ") attached = L !== "SP" && L !== "ZW";
    } else if ((R === "CM" || R === "ZWJ") && L !== "SP" && L !== "ZW") {
      decision = NO_BREAK; // LB9
      attached = true;
    } else {
      if (R === "CM" || R === "ZWJ") R = "AL"; // LB10
      decision = pairRule(L, Lcp, L2, L2cp, R, rcp, k);
    }

    out[pos] = decision;
    const rawR = cls[k]!;
    if (attached) {
      // LB9: X CM* behaves as X; states continue unchanged.
      rawPrev = rawR;
      continue;
    }
    if ((rawR === "CM" || rawR === "ZWJ") && R !== "AL") R = "AL";
    // Update the "X SP*" states.
    if (R !== "SP") {
      s15a = R === "QU" && generalCategory(rcp) === "Pi" && (L === "BK" || L === "CR" || L === "LF" || L === "NL" || L === "OP" || L === "QU" || L === "GL" || L === "SP" || L === "ZW");
      s8 = R === "ZW";
      s14 = R === "OP";
      s16 = R === "CL" || R === "CP";
      s17 = R === "B2";
    }
    s21a = (R === "HY" || R === "BA") && L === "HL";
    riRun = R === "RI" ? (L === "RI" ? riRun + 1 : 1) : 0;
    numClose = numSeq && (R === "CL" || R === "CP");
    numSeq = R === "NU" || (numSeq && (R === "SY" || R === "IS"));
    L2 = L;
    L2cp = Lcp;
    L = R;
    Lcp = rcp;
    rawPrev = rawR;
  }
  if (options.chromiumAscii !== false) tailorAscii(text, out);
  return out;

  function pairRule(L: LineBreakClass, Lcp: number, L2: LineBreakClass | null, L2cp: number, R: LineBreakClass, rcp: number, k: number): number {
    if (R === "WJ" || L === "WJ") return NO_BREAK; // LB11
    if (L === "GL") return NO_BREAK; // LB12
    if (R === "GL" && L !== "SP" && L !== "BA" && L !== "HY") return NO_BREAK; // LB12a
    if (R === "CL" || R === "CP" || R === "EX" || R === "IS" || R === "SY") return NO_BREAK; // LB13
    if (s14) return NO_BREAK; // LB14
    if (s15a) return NO_BREAK; // LB15a
    if (R === "QU" && generalCategory(rcp) === "Pf") {
      // LB15b: look at what follows the quote.
      const next = k + 1 < m ? effectiveNext(k + 1) : null;
      if (next === null || ["SP", "GL", "WJ", "CL", "QU", "CP", "EX", "IS", "SY", "BK", "CR", "LF", "NL", "ZW"].includes(next)) return NO_BREAK;
    }
    if (s16 && R === "NS") return NO_BREAK; // LB16
    if (s17 && R === "B2") return NO_BREAK; // LB17
    if (L === "SP") return ALLOW_BREAK; // LB18
    if (R === "QU" || L === "QU") return NO_BREAK; // LB19
    if (R === "CB" || L === "CB") return ALLOW_BREAK; // LB20
    if (R === "BA" || R === "HY" || R === "NS" || L === "BB") return NO_BREAK; // LB21
    if (s21a) return NO_BREAK; // LB21a
    if (L === "SY" && R === "HL") return NO_BREAK; // LB21b
    if (R === "IN") return NO_BREAK; // LB22
    const alpha = (c: LineBreakClass): boolean => c === "AL" || c === "HL";
    if ((alpha(L) && R === "NU") || (L === "NU" && alpha(R))) return NO_BREAK; // LB23
    if (L === "PR" && (R === "ID" || R === "EB" || R === "EM")) return NO_BREAK; // LB23a
    if ((L === "ID" || L === "EB" || L === "EM") && R === "PO") return NO_BREAK;
    if ((L === "PR" || L === "PO") && alpha(R)) return NO_BREAK; // LB24
    if (alpha(L) && (R === "PR" || R === "PO")) return NO_BREAK;
    // LB25, in the regular-expression form UAX #14 §8.2 gives (and the test data uses):
    // (PR | PO)? (OP | HY)? NU (NU | SY | IS)* (CL | CP)? (PR | PO)?
    if ((L === "PR" || L === "PO") && R === "NU") return NO_BREAK;
    // (HY before a number is already kept by LB21; CL, CP, IS and SY by LB13.)
    if ((L === "PR" || L === "PO") && R === "OP" && k + 1 < m && effectiveNext(k + 1) === "NU") return NO_BREAK;
    if ((L === "OP" || L === "HY") && R === "NU") return NO_BREAK;
    if (numSeq && R === "NU") return NO_BREAK;
    if ((numSeq || numClose) && (R === "PO" || R === "PR")) return NO_BREAK;
    // LB26
    if (L === "JL" && (R === "JL" || R === "JV" || R === "H2" || R === "H3")) return NO_BREAK;
    if ((L === "JV" || L === "H2") && (R === "JV" || R === "JT")) return NO_BREAK;
    if ((L === "JT" || L === "H3") && R === "JT") return NO_BREAK;
    // LB27
    const korean = (c: LineBreakClass): boolean => c === "JL" || c === "JV" || c === "JT" || c === "H2" || c === "H3";
    if (korean(L) && R === "PO") return NO_BREAK;
    if (L === "PR" && korean(R)) return NO_BREAK;
    if (alpha(L) && alpha(R)) return NO_BREAK; // LB28
    // LB28a
    if (L === "AP" && isAkLike(R, rcp)) return NO_BREAK;
    if (isAkLike(L, Lcp) && (R === "VF" || R === "VI")) return NO_BREAK;
    if (L === "VI" && L2 !== null && isAkLike(L2, L2cp) && (R === "AK" || rcp === DOTTED_CIRCLE)) return NO_BREAK;
    if (isAkLike(L, Lcp) && isAkLike(R, rcp) && k + 1 < m && effectiveNext(k + 1) === "VF") return NO_BREAK;
    if (L === "IS" && alpha(R)) return NO_BREAK; // LB29
    // LB30
    if ((alpha(L) || L === "NU") && R === "OP" && !isEastAsianFWH(rcp)) return NO_BREAK;
    if (L === "CP" && !isEastAsianFWH(Lcp) && (alpha(R) || R === "NU")) return NO_BREAK;
    if (L === "RI" && R === "RI" && riRun % 2 === 1) return NO_BREAK; // LB30a
    if (R === "EM" && (L === "EB" || (isExtendedPictographic(Lcp) && generalCategory(Lcp) === "Cn"))) return NO_BREAK; // LB30b
    return ALLOW_BREAK; // LB31
  }

  /** The class of code point `k` for lookahead (combining marks resolve to AL). */
  function effectiveNext(k: number): LineBreakClass {
    const c = cls[k]!;
    return c === "CM" || c === "ZWJ" ? "AL" : c;
  }
}

/** `line-break: anywhere`: a soft wrap opportunity at every grapheme boundary, forced breaks kept. */
function anywhereBreaks(text: string, out: Uint8Array): Uint8Array {
  const plain = lineBreaks(text, { chromiumAscii: false });
  const graphemes = graphemeBoundaries(text);
  for (let i = 1; i < text.length; i++) out[i] = plain[i] === MANDATORY_BREAK ? MANDATORY_BREAK : graphemes[i] ? ALLOW_BREAK : NO_BREAK;
  return out;
}
