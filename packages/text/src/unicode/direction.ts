/// <reference path="../types/modules.d.ts" />
import bidiFactory, { type Bidi } from "bidi-js";

let bidi: Bidi | null = null;

/**
 * The direction of the first strong character of `text` (UAX #9 rules P2
 * and P3, as HTML `dir="auto"` resolves an element's direction): "rtl" for
 * bidi classes R and AL, "ltr" for L, null when there is no strong
 * character. Isolates are skipped, like P2 skips the characters between an
 * isolate initiator and its matching PDI.
 */
export function firstStrongDirection(text: string): "ltr" | "rtl" | null {
  bidi ??= bidiFactory();
  let isolates = 0;
  for (const ch of text) {
    const t = bidi.getBidiCharTypeName(ch);
    if (t === "LRI" || t === "RLI" || t === "FSI") isolates++;
    else if (t === "PDI") isolates = Math.max(0, isolates - 1);
    else if (isolates === 0) {
      if (t === "L") return "ltr";
      if (t === "R" || t === "AL") return "rtl";
    }
  }
  return null;
}
