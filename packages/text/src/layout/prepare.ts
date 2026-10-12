import { codePointAt, cpLength, isLetterOrNumber, isMark } from "../unicode/props";
import type { ParagraphStyle, TextStyle } from "../style";

/**
 * Turns a paragraph's source text into the text that is shaped and broken
 * into lines: `text-transform` per run, then white space processing (CSS
 * Text 3 §4.1.1 phase I: collapsing spaces and tabs, transforming or
 * keeping segment breaks). Every prepared character keeps the index of the
 * source character it came from, for hit-testing and selection.
 */

export interface Span {
  readonly start: number;
  readonly end: number;
  readonly style: TextStyle;
}

export interface PreparedText {
  /** The text to shape. Forced line breaks are kept as `\n`. */
  readonly text: string;
  /** Source index of each prepared code unit, plus the source length at the end. */
  readonly source: Int32Array;
  /** Span index of each prepared code unit. */
  readonly span: Uint16Array;
  /** Flags per prepared code unit (see the `CHAR_*` constants). */
  readonly flags: Uint8Array;
}

/** A space or tab that collapses: removed at the start of a line, removed at its end (white-space collapse). */
export const CHAR_COLLAPSIBLE_SPACE = 1;
/** A preserved space (pre-wrap): hangs at the end of a line. */
export const CHAR_PRESERVED_SPACE = 2;
/** A forced line break. */
export const CHAR_FORCED_BREAK = 4;
/** A preserved tab (advances to the next tab stop). */
export const CHAR_TAB = 8;
/** A soft hyphen (U+00AD). */
export const CHAR_SOFT_HYPHEN = 16;
/** A word separator that takes `word-spacing` and justification (U+0020, U+00A0, U+1361, U+10100, U+10101, U+1039F, U+1091F). */
export const CHAR_WORD_SEPARATOR = 32;

function isWordSeparator(cp: number): boolean {
  return cp === 0x20 || cp === 0xa0 || cp === 0x1361 || cp === 0x10100 || cp === 0x10101 || cp === 0x1039f || cp === 0x1091f;
}

/** Applies `text-transform` to each span; returns the text and the source index of every code unit. */
function transform(text: string, spans: readonly Span[]): { text: string; source: number[]; span: number[] } {
  let out = "";
  const source: number[] = [];
  const spanOf: number[] = [];
  let prevLetter = false;
  spans.forEach((sp, si) => {
    const tt = sp.style.textTransform;
    const lang = sp.style.language || undefined;
    for (let i = sp.start; i < sp.end; ) {
      const cp = codePointAt(text, i);
      const len = cpLength(cp);
      const ch = text.slice(i, i + len);
      let t = ch;
      const letter = isLetterOrNumber(cp);
      if (tt === "uppercase") t = lang ? ch.toLocaleUpperCase(lang) : ch.toUpperCase();
      else if (tt === "lowercase") t = lang ? ch.toLocaleLowerCase(lang) : ch.toLowerCase();
      else if (tt === "capitalize") {
        // The first letter of each word: a letter or number not preceded by one (marks continue a letter).
        if (letter && !prevLetter && !isMark(cp)) t = lang ? ch.toLocaleUpperCase(lang) : ch.toUpperCase();
      } else if (tt === "full-width") {
        if (cp === 0x20) t = "　";
        else if (cp >= 0x21 && cp <= 0x7e) t = String.fromCharCode(cp + 0xfee0);
      }
      prevLetter = letter || (prevLetter && isMark(cp)) || (prevLetter && (cp === 0x27 || cp === 0x2019));
      out += t;
      for (let k = 0; k < t.length; k++) {
        source.push(i);
        spanOf.push(si);
      }
      i += len;
    }
  });
  return { text: out, source, span: spanOf };
}

/**
 * Prepares a paragraph. `spans` must cover `text` contiguously from 0 to
 * its length.
 */
export function prepareText(text: string, spans: readonly Span[], para: ParagraphStyle): PreparedText {
  const t = transform(text, spans);
  const s = t.text;
  const mode = para.whiteSpaceCollapse;
  let out = "";
  const source: number[] = [];
  const spanOf: number[] = [];
  const flags: number[] = [];
  const push = (ch: string, i: number, f: number): void => {
    out += ch;
    source.push(t.source[i]!);
    spanOf.push(t.span[i]!);
    flags.push(f | (isWordSeparator(ch.codePointAt(0)!) ? CHAR_WORD_SEPARATOR : 0) | (ch === "­" ? CHAR_SOFT_HYPHEN : 0));
  };
  const n = s.length;
  if (mode === "preserve" || mode === "break-spaces") {
    for (let i = 0; i < n; i++) {
      const c = s[i]!;
      if (c === "\r") {
        if (s[i + 1] === "\n") continue;
        push("\n", i, CHAR_FORCED_BREAK);
      } else if (c === "\n") push("\n", i, CHAR_FORCED_BREAK);
      else if (c === "\t") push("\t", i, CHAR_TAB | CHAR_PRESERVED_SPACE);
      else if (c === " ") push(" ", i, CHAR_PRESERVED_SPACE);
      else push(c, i, 0);
    }
  } else {
    // collapse / preserve-breaks: spaces and tabs collapse; segment breaks become spaces (collapse) or stay (preserve-breaks).
    const keepBreaks = mode === "preserve-breaks";
    let i = 0;
    while (i < n) {
      const c = s[i]!;
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        // A run of white space: does it contain segment breaks?
        let j = i;
        let breaks = 0;
        let firstBreak = -1;
        while (j < n && (s[j] === " " || s[j] === "\t" || s[j] === "\n" || s[j] === "\r")) {
          if (s[j] === "\n" || (s[j] === "\r" && s[j + 1] !== "\n")) {
            breaks++;
            if (firstBreak < 0) firstBreak = j;
          }
          j++;
        }
        if (breaks > 0 && keepBreaks) {
          // Spaces around segment breaks are removed; every break is kept.
          for (let k = i; k < j; k++) if (s[k] === "\n" || (s[k] === "\r" && s[k + 1] !== "\n")) push("\n", k, CHAR_FORCED_BREAK);
        } else if (breaks > 0) {
          // A segment break becomes a space unless it sits next to a zero width space.
          const before = i > 0 ? s.charCodeAt(i - 1) : -1;
          const after = j < n ? s.charCodeAt(j) : -1;
          if (before !== 0x200b && after !== 0x200b) pushSpace(firstBreak);
        } else {
          pushSpace(i);
        }
        i = j;
      } else {
        push(c, i, 0);
        i++;
      }
    }
  }
  return { text: out, source: Int32Array.from([...source, text.length]), span: Uint16Array.from(spanOf), flags: Uint8Array.from(flags) };

  /** One collapsible space, unless the previous prepared character already is one (collapsing across spans). */
  function pushSpace(i: number): void {
    const last = flags.length - 1;
    if (last >= 0 && flags[last]! & CHAR_COLLAPSIBLE_SPACE) return;
    push(" ", i, CHAR_COLLAPSIBLE_SPACE);
  }
}
