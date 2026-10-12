/**
 * Caret movement units over a text node's content (UTF-16 indices):
 * grapheme clusters, words and paragraphs, with `Intl.Segmenter` (UAX #29),
 * so a caret never lands inside an emoji sequence or a combining mark.
 */

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const words = new Intl.Segmenter(undefined, { granularity: "word" });

/** The grapheme boundary after `index` (or the end). */
export function nextGrapheme(text: string, index: number): number {
  if (index >= text.length) return text.length;
  for (const s of graphemes.segment(text)) if (s.index > index) return s.index;
  return text.length;
}

/** The grapheme boundary before `index` (or 0). */
export function previousGrapheme(text: string, index: number): number {
  if (index <= 0) return 0;
  let prev = 0;
  for (const s of graphemes.segment(text)) {
    if (s.index >= index) break;
    prev = s.index;
  }
  return prev;
}

/** Word segments with their kind. */
function wordSegments(text: string): { start: number; end: number; word: boolean }[] {
  const out: { start: number; end: number; word: boolean }[] = [];
  for (const s of words.segment(text)) out.push({ start: s.index, end: s.index + s.segment.length, word: s.isWordLike === true });
  return out;
}

/** The end of the next word after `index` (skipping spaces and punctuation before it). */
export function nextWordEnd(text: string, index: number): number {
  for (const s of wordSegments(text)) if (s.word && s.end > index) return s.end;
  return text.length;
}

/** The start of the word before `index` (skipping spaces and punctuation after it). */
export function previousWordStart(text: string, index: number): number {
  let found = 0;
  for (const s of wordSegments(text)) {
    if (s.start >= index) break;
    if (s.word) found = s.start;
  }
  return found;
}

/** The word (or run of non-word characters) around `index`, for double-click selection. */
export function wordAt(text: string, index: number): { start: number; end: number } {
  const segs = wordSegments(text);
  for (const s of segs) if (index >= s.start && index < s.end) return { start: s.start, end: s.end };
  const last = segs[segs.length - 1];
  return last && index >= last.end ? { start: last.start, end: last.end } : { start: index, end: index };
}

/** The paragraph (between "\n"s) around `index`, excluding the newline. */
export function paragraphAt(text: string, index: number): { start: number; end: number } {
  const start = text.lastIndexOf("\n", index - 1) + 1;
  let end = text.indexOf("\n", index);
  if (end < 0) end = text.length;
  return { start, end };
}
