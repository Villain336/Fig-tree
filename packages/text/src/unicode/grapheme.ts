import { codePointAt, cpLength, graphemeBreakClass, indicConjunctBreak, isExtendedPictographic, type GraphemeBreakClass } from "./props";

/**
 * Extended grapheme cluster boundaries, UAX #29 (Unicode 15.1), rules GB1 to
 * GB999 including GB9c (Indic conjunct clusters) and emoji ZWJ sequences.
 * Grapheme clusters are the units of caret movement, `overflow-wrap`
 * emergency breaks, `word-break: break-all` and letter-spacing.
 */

/**
 * Boundary flags for every UTF-16 offset 0..length: `out[i] === 1` when a
 * grapheme cluster boundary falls before code unit `i`. The second half of a
 * surrogate pair is never a boundary.
 */
export function graphemeBoundaries(text: string): Uint8Array {
  const n = text.length;
  const out = new Uint8Array(n + 1);
  if (n === 0) {
    out[0] = 1;
    return out;
  }
  out[0] = 1;
  out[n] = 1;
  let prev: GraphemeBreakClass = graphemeBreakClass(codePointAt(text, 0));
  let prevCp = codePointAt(text, 0);
  // GB11: inside "ExtPict Extend*" (then possibly ZWJ).
  let pictSeq = isExtendedPictographic(prevCp);
  let pictZwj = false;
  // GB12/13: count of regional indicators in the current run.
  let riCount = prev === "Regional_Indicator" ? 1 : 0;
  // GB9c: 0 none, 1 after a consonant (Extend/Linker*), 2 after consonant ... linker.
  let conjunct = indicConjunctBreak(prevCp) === "Consonant" ? 1 : 0;
  let i = cpLength(prevCp);
  while (i < n) {
    const cp = codePointAt(text, i);
    const cls = graphemeBreakClass(cp);
    const incb = indicConjunctBreak(cp);
    let brk: boolean;
    if (prev === "CR" && cls === "LF") brk = false;
    else if (prev === "Control" || prev === "CR" || prev === "LF") brk = true;
    else if (cls === "Control" || cls === "CR" || cls === "LF") brk = true;
    else if (prev === "L" && (cls === "L" || cls === "V" || cls === "LV" || cls === "LVT")) brk = false;
    else if ((prev === "LV" || prev === "V") && (cls === "V" || cls === "T")) brk = false;
    else if ((prev === "LVT" || prev === "T") && cls === "T") brk = false;
    else if (cls === "Extend" || cls === "ZWJ") brk = false;
    else if (cls === "SpacingMark") brk = false;
    else if (prev === "Prepend") brk = false;
    else if (conjunct === 2 && incb === "Consonant") brk = false;
    else if (pictZwj && isExtendedPictographic(cp)) brk = false;
    else if (prev === "Regional_Indicator" && cls === "Regional_Indicator") brk = riCount % 2 === 0;
    else brk = true;
    if (brk) out[i] = 1;

    // State for the next position.
    if (isExtendedPictographic(cp)) {
      pictSeq = true;
      pictZwj = false;
    } else if (pictSeq && cls === "Extend") {
      pictZwj = false;
    } else if (pictSeq && cls === "ZWJ") {
      pictZwj = true;
      pictSeq = false;
    } else {
      pictSeq = false;
      pictZwj = false;
    }
    riCount = cls === "Regional_Indicator" ? (prev === "Regional_Indicator" ? riCount + 1 : 1) : 0;
    if (incb === "Consonant") conjunct = 1;
    else if (conjunct > 0 && incb === "Linker") conjunct = 2;
    else if (conjunct > 0 && incb === "Extend") {
      // keeps state
    } else conjunct = 0;
    prev = cls;
    i += cpLength(cp);
  }
  return out;
}

/** Offsets of grapheme cluster starts (excluding the end of text). */
export function graphemeStarts(text: string): number[] {
  const b = graphemeBoundaries(text);
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) if (b[i]) out.push(i);
  return out;
}
