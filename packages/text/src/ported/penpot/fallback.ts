// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) KALEIDOS SUBSIDIARY SL
//
// Ported from penpot/common/src/app/common/fonts.cljs @5eb33ad
// (the `unicode-ranges` and `noto-fonts` tables and `emoji-pattern`, lines
// 161-303), translated from ClojureScript regular expressions to code point
// ranges. Changes from the original: families are Google Fonts family names
// instead of Penpot font ids; Devanagari maps to "Noto Sans Devanagari"
// (the original mapped it to "Noto Sans", which has no Devanagari glyphs);
// the overlapping `symbols` / `symbols-2` entries are kept in their original
// order, so the first match wins as with the original's ordered map walk.

/** Script (or symbol block) → code point ranges and the Noto family that covers them. */
export const SCRIPT_FALLBACKS: readonly { readonly script: string; readonly ranges: readonly (readonly [number, number])[]; readonly family: string }[] = [
  { script: "japanese", ranges: [[0x3040, 0x30ff], [0x31f0, 0x31ff], [0xff66, 0xff9f]], family: "Noto Sans JP" },
  { script: "chinese", ranges: [[0x4e00, 0x9fff], [0x3400, 0x4dbf]], family: "Noto Sans SC" },
  { script: "korean", ranges: [[0xac00, 0xd7af]], family: "Noto Sans KR" },
  { script: "arabic", ranges: [[0x0600, 0x06ff], [0x0750, 0x077f], [0x0870, 0x089f], [0x08a0, 0x08ff]], family: "Noto Sans Arabic" },
  { script: "cyrillic", ranges: [[0x0400, 0x04ff], [0x0500, 0x052f], [0x2de0, 0x2dff], [0xa640, 0xa69f]], family: "Noto Sans" },
  { script: "greek", ranges: [[0x0370, 0x03ff], [0x1f00, 0x1fff]], family: "Noto Sans" },
  { script: "hebrew", ranges: [[0x0590, 0x05ff], [0xfb1d, 0xfb4f]], family: "Noto Sans Hebrew" },
  { script: "thai", ranges: [[0x0e00, 0x0e7f]], family: "Noto Sans Thai" },
  { script: "devanagari", ranges: [[0x0900, 0x097f], [0xa8e0, 0xa8ff]], family: "Noto Sans Devanagari" },
  { script: "tamil", ranges: [[0x0b80, 0x0bff]], family: "Noto Sans Tamil" },
  { script: "latin-ext", ranges: [[0x0100, 0x017f], [0x0180, 0x024f]], family: "Noto Sans" },
  { script: "vietnamese", ranges: [[0x1ea0, 0x1ef9]], family: "Noto Sans" },
  { script: "armenian", ranges: [[0x0530, 0x058f], [0xfb13, 0xfb17]], family: "Noto Sans Armenian" },
  { script: "bengali", ranges: [[0x0980, 0x09ff]], family: "Noto Sans Bengali" },
  { script: "cherokee", ranges: [[0x13a0, 0x13ff]], family: "Noto Sans Cherokee" },
  { script: "ethiopic", ranges: [[0x1200, 0x137f]], family: "Noto Sans Ethiopic" },
  { script: "georgian", ranges: [[0x10a0, 0x10ff]], family: "Noto Sans Georgian" },
  { script: "gujarati", ranges: [[0x0a80, 0x0aff]], family: "Noto Sans Gujarati" },
  { script: "gurmukhi", ranges: [[0x0a00, 0x0a7f]], family: "Noto Sans Gurmukhi" },
  { script: "khmer", ranges: [[0x1780, 0x17ff], [0x19e0, 0x19ff]], family: "Noto Sans Khmer" },
  { script: "lao", ranges: [[0x0e80, 0x0eff]], family: "Noto Sans Lao" },
  { script: "malayalam", ranges: [[0x0d00, 0x0d7f]], family: "Noto Sans Malayalam" },
  { script: "myanmar", ranges: [[0x1000, 0x109f], [0xaa60, 0xaa7f]], family: "Noto Sans Myanmar" },
  { script: "sinhala", ranges: [[0x0d80, 0x0dff]], family: "Noto Sans Sinhala" },
  { script: "telugu", ranges: [[0x0c00, 0x0c7f]], family: "Noto Sans Telugu" },
  { script: "tibetan", ranges: [[0x0f00, 0x0fff]], family: "Noto Serif Tibetan" },
  { script: "javanese", ranges: [[0xa980, 0xa9df]], family: "Noto Sans Javanese" },
  { script: "kannada", ranges: [[0x0c80, 0x0cff]], family: "Noto Sans Kannada" },
  { script: "oriya", ranges: [[0x0b00, 0x0b7f]], family: "Noto Sans Oriya" },
  { script: "mongolian", ranges: [[0x1800, 0x18af]], family: "Noto Sans Mongolian" },
  { script: "syriac", ranges: [[0x0700, 0x074f]], family: "Noto Sans Syriac" },
  { script: "tifinagh", ranges: [[0x2d30, 0x2d7f]], family: "Noto Sans Tifinagh" },
  { script: "coptic", ranges: [[0x2c80, 0x2cff]], family: "Noto Sans Coptic" },
  { script: "ol-chiki", ranges: [[0x1c50, 0x1c7f]], family: "Noto Sans Ol Chiki" },
  { script: "vai", ranges: [[0xa500, 0xa63f]], family: "Noto Sans Vai" },
  { script: "shavian", ranges: [[0x10450, 0x1047f]], family: "Noto Sans Shavian" },
  { script: "osmanya", ranges: [[0x10480, 0x104af]], family: "Noto Sans Osmanya" },
  { script: "runic", ranges: [[0x16a0, 0x16ff]], family: "Noto Sans Runic" },
  { script: "old-italic", ranges: [[0x10300, 0x1032f]], family: "Noto Sans Old Italic" },
  { script: "brahmi", ranges: [[0x11000, 0x1107f]], family: "Noto Sans Brahmi" },
  { script: "modi", ranges: [[0x11600, 0x1165f]], family: "Noto Sans Modi" },
  { script: "sora-sompeng", ranges: [[0x110d0, 0x110ff]], family: "Noto Sans Sora Sompeng" },
  { script: "bamum", ranges: [[0xa6a0, 0xa6ff]], family: "Noto Sans Bamum" },
  { script: "meroitic", ranges: [[0x10980, 0x1099f]], family: "Noto Sans Meroitic" },
  {
    script: "symbols",
    ranges: [[0x2190, 0x21ff], [0x2200, 0x22ff], [0x2300, 0x23ff], [0x25a0, 0x25ff], [0x2600, 0x26ff], [0x2700, 0x27bf], [0x2b00, 0x2bff]],
    family: "Noto Sans Symbols",
  },
  {
    script: "symbols-2",
    ranges: [[0x2190, 0x21ff], [0x2200, 0x22ff], [0x2300, 0x23ff], [0x25a0, 0x25ff], [0x2600, 0x26ff], [0x2700, 0x27bf], [0x2b00, 0x2bff], [0x1f000, 0x1f0ff], [0x1f800, 0x1f8ff], [0x1fb00, 0x1fbff]],
    family: "Noto Sans Symbols 2",
  },
  { script: "music", ranges: [[0x2669, 0x267b], [0x1d100, 0x1d11f]], family: "Noto Music" },
];

/** Code point ranges the original `emoji-pattern` matches (regional indicator pairs are matched per code point here). */
export const EMOJI_RANGES: readonly (readonly [number, number])[] = [
  [0x1f1e6, 0x1f1ff],
  [0x1f000, 0x1f3ff],
  [0x1f400, 0x1f6ff],
  [0x1f900, 0x1f9ff],
  [0x1f680, 0x1f6ff],
  [0x1f800, 0x1f8ff],
  [0x1fa70, 0x1fbff],
  [0x2600, 0x26ff],
  [0x2700, 0x27bf],
  [0x2300, 0x23ff],
  [0x2b00, 0x2bff],
];

/** The emoji family the original adds when a text contains emoji. */
export const EMOJI_FAMILY = "Noto Color Emoji";

/** The fallback family for a code point, or undefined when the table has none. */
export function fallbackFamilyFor(cp: number): string | undefined {
  for (const entry of SCRIPT_FALLBACKS) for (const [a, b] of entry.ranges) if (cp >= a && cp <= b) return entry.family;
  return undefined;
}

/** Whether a code point falls in the original's emoji pattern. */
export function isEmojiCodePoint(cp: number): boolean {
  for (const [a, b] of EMOJI_RANGES) if (cp >= a && cp <= b) return true;
  return false;
}
