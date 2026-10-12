import type { FontInstance } from "../font/face";
import { instanceFor } from "../font/registry";
import { MANDATORY_BREAK, NO_BREAK } from "../unicode/linebreak";
import { CHAR_COLLAPSIBLE_SPACE, CHAR_FORCED_BREAK, CHAR_PRESERVED_SPACE, CHAR_SOFT_HYPHEN, CHAR_TAB, CHAR_WORD_SEPARATOR } from "./prepare";
import { effectiveFontSize, fontMetricsPx, requestOf, tabAdvance, type BoxMetrics, type FontMetricsPx, type Item, type ShapedParagraph } from "./paragraph";
import { featuresFor, shapeItem } from "./shape";
import { isEastAsianFWH, codePointAt } from "../unicode/props";

/**
 * Line layout of a shaped paragraph at an available width: line breaking
 * (greedy, with `text-wrap: balance` and `pretty`), soft hyphens,
 * `overflow-wrap` emergency breaks, line boxes from inline box metrics
 * (CSS Inline 3 half-leading), `text-align` and justification, bidi
 * reordering (UAX #9 L1–L2), glyph positions, ellipsis and line clamping.
 */

/** A glyph placed in paragraph coordinates (x from the paragraph's left edge, y on the baseline). */
export interface PlacedGlyph {
  readonly gid: number;
  readonly x: number;
  readonly y: number;
}

/** Consecutive glyphs of one font, size and style run on one line. */
export interface GlyphRun {
  readonly font: FontInstance;
  /** Font size in px (outlines scale by size / unitsPerEm). */
  readonly size: number;
  /** Index of the style run (span) the glyphs belong to. */
  readonly span: number;
  readonly syntheticBold: boolean;
  readonly syntheticOblique: boolean;
  /** Packed glyph id, x, y triples. */
  readonly glyphs: Float64Array;
  /** Left and right edge of the run's advance box, and its line's baseline. */
  readonly left: number;
  readonly right: number;
  readonly baseline: number;
}

/** A text decoration line segment (underline, overline, line-through). */
export interface DecorationRect {
  readonly kind: "underline" | "overline" | "line-through";
  readonly span: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly thickness: number;
}

/** A grapheme cluster's caret edges on its line (x left/right in visual terms). */
export interface CharBox {
  /** Prepared text index of the grapheme. */
  readonly index: number;
  readonly left: number;
  readonly right: number;
  readonly span: number;
  readonly rtl: boolean;
}

export interface Line {
  /** Prepared text range of the line (including trailing spaces and the forced break). */
  readonly start: number;
  readonly end: number;
  /** Top of the line box and its height, from the paragraph's top. */
  readonly top: number;
  readonly height: number;
  /** Baseline position from the paragraph's top. */
  readonly baseline: number;
  /** Left edge of the line's content (after alignment) and its width without hanging or removed spaces. */
  readonly left: number;
  readonly width: number;
  readonly runs: readonly GlyphRun[];
  /** Grapheme boxes in logical order. */
  readonly chars: readonly CharBox[];
  readonly ellipsis: boolean;
  readonly hyphenated: boolean;
  /** Laid out but not shown (after a line clamp). */
  readonly hidden: boolean;
}

export interface ParagraphLayout {
  /** The available width the paragraph was laid out at. */
  readonly width: number;
  readonly height: number;
  readonly lines: readonly Line[];
  readonly decorations: readonly DecorationRect[];
  /** Widest line content (for shrink-to-fit). */
  readonly contentWidth: number;
  readonly firstBaseline: number | undefined;
  readonly lastBaseline: number | undefined;
  /** Lines removed by line-clamp (the text continued past the last line). */
  readonly clamped: boolean;
}

interface Break {
  start: number;
  end: number;
  hyphen: boolean;
}

const EPSILON = 1 / 128;

function isSpaceFlag(f: number, breakSpaces: boolean): boolean {
  if (f & CHAR_FORCED_BREAK) return true;
  if (f & CHAR_COLLAPSIBLE_SPACE) return true;
  return (f & CHAR_PRESERVED_SPACE) !== 0 && !breakSpaces;
}

/** The first-line indent in px. */
export function indentOf(sp: ShapedParagraph, width: number): number {
  const ti = sp.input.style.textIndent;
  return typeof ti === "number" ? ti : (ti.percent / 100) * width;
}

/**
 * Greedy line breaking: each line takes as much as fits, breaking at the
 * last opportunity; a line always holds at least one grapheme.
 */
export function breakLines(sp: ShapedParagraph, available: number, indent: number): Break[] {
  const n = sp.length;
  const flags = sp.prepared.flags;
  const style = sp.input.style;
  const breakSpaces = style.whiteSpaceCollapse === "break-spaces";
  const emergency = style.overflowWrap !== "normal" || style.wordBreak === "break-word";
  const tabInterval = sp.spaceAdvance * style.tabSize;
  const out: Break[] = [];
  let i = 0;
  let first = true;
  while (i < n) {
    const lineStart = i;
    let x = first ? indent : 0;
    let lineX = 0; // x from the line's start edge for tab stops
    let visible = x;
    let candidate = -1;
    let candidateHyphen = false;
    let hasContent = false;
    let j = i;
    let end = -1;
    let hyphen = false;
    for (; j < n; j++) {
      if (j > lineStart && sp.breaks[j] === MANDATORY_BREAK) {
        end = j;
        break;
      }
      const f = flags[j]!;
      if (j > lineStart && sp.breaks[j] !== NO_BREAK && hasContent) {
        const shy = (flags[j - 1]! & CHAR_SOFT_HYPHEN) !== 0;
        if (!shy || visible + hyphenWidth(sp, j - 1) <= available + EPSILON) {
          candidate = j;
          candidateHyphen = shy;
        }
      }
      let w = sp.advance[j]!;
      if (Number.isNaN(w)) w = tabAdvance(lineX + (first ? indent : 0), tabInterval, sp.tabMinimum);
      const space = isSpaceFlag(f, breakSpaces);
      // Collapsible spaces at the start of a line are removed.
      if (!hasContent && f & CHAR_COLLAPSIBLE_SPACE) continue;
      if (!space && w > 0 && x + w > available + EPSILON && hasContent) {
        // Overflow: break at the last opportunity, or emergency-break the word.
        if (candidate > lineStart) {
          end = candidate;
          hyphen = candidateHyphen;
        } else if (emergency) {
          let g = j;
          while (g > lineStart && !sp.graphemes[g]) g--;
          end = g > lineStart ? g : -1;
        }
        if (end > 0) break;
      }
      x += w;
      lineX += w;
      if (!space) {
        visible = x;
        hasContent = true;
      } else if (f & (CHAR_PRESERVED_SPACE | CHAR_TAB) && breakSpaces) hasContent = true;
    }
    if (end < 0) end = j >= n ? n : j;
    // Never return an empty line (a forced break right at the start is a line of its own).
    if (end <= lineStart) end = lineStart + 1;
    out.push({ start: lineStart, end, hyphen });
    i = end;
    first = false;
  }
  return out;
}

function hyphenWidth(sp: ShapedParagraph, shyIndex: number): number {
  const h = hyphenGlyph(sp, shyIndex);
  return h ? h.advance : 0;
}

/** The hyphen shown at a soft hyphen break: U+2010 if the font has it, else U+002D. */
function hyphenGlyph(sp: ShapedParagraph, shyIndex: number): { font: FontInstance; gid: number; advance: number; item: Item } | null {
  const item = sp.items[sp.itemOf[shyIndex]!];
  if (!item?.font) return null;
  for (const cp of [0x2010, 0x2d]) {
    const gid = item.font.glyph(cp);
    if (gid) return { font: item.font, gid, advance: item.font.advance(gid) * item.scale, item };
  }
  return null;
}

/** `text-wrap: balance`: the narrowest width that keeps the greedy line count (Chromium limits balancing to short paragraphs). */
function balance(sp: ShapedParagraph, available: number, indent: number, lines: Break[]): Break[] {
  if (lines.length < 2 || lines.length > MAX_BALANCE_LINES || lines.some((l) => sp.breaks[l.end] === MANDATORY_BREAK && l.end < sp.length)) return lines;
  let lo = 0;
  let hi = available;
  let best = lines;
  for (let iter = 0; iter < 20 && hi - lo > 1 / 64; iter++) {
    const mid = (lo + hi) / 2;
    const attempt = breakLines(sp, mid, indent);
    if (attempt.length <= lines.length && !overflows(sp, attempt, mid, indent)) {
      hi = mid;
      best = attempt;
    } else lo = mid;
  }
  return best;
}

const MAX_BALANCE_LINES = 4;

function overflows(sp: ShapedParagraph, lines: Break[], width: number, indent: number): boolean {
  return lines.some((l, i) => lineContentWidth(sp, l, i === 0 ? indent : 0) > width + EPSILON);
}

function lineContentWidth(sp: ShapedParagraph, l: Break, x0: number): number {
  const flags = sp.prepared.flags;
  const breakSpaces = sp.input.style.whiteSpaceCollapse === "break-spaces";
  let x = x0;
  let visible = x0;
  let started = false;
  for (let i = l.start; i < l.end; i++) {
    const f = flags[i]!;
    if (!started && f & CHAR_COLLAPSIBLE_SPACE) continue;
    let w = sp.advance[i]!;
    if (Number.isNaN(w)) w = tabAdvance(x, sp.spaceAdvance * sp.input.style.tabSize, sp.tabMinimum);
    x += w;
    if (!isSpaceFlag(f, breakSpaces)) {
      visible = x;
      started = true;
    }
  }
  return visible + (l.hyphen ? hyphenWidth(sp, l.end - 1) : 0);
}

/**
 * `text-wrap: pretty`: avoids a last line holding a single short word by
 * moving one word down from the previous line when that keeps the line
 * count (a simplification of the score-based breaking browsers use).
 */
function pretty(sp: ShapedParagraph, available: number, lines: Break[]): Break[] {
  if (lines.length < 2) return lines;
  const last = lines[lines.length - 1]!;
  const prev = lines[lines.length - 2]!;
  if (sp.breaks[prev.end] === MANDATORY_BREAK && prev.end < sp.length) return lines;
  // Is the last line a single word (no break opportunity inside)?
  let words = 0;
  for (let i = last.start + 1; i < last.end; i++) if (sp.breaks[i] !== NO_BREAK) words++;
  if (words > 0) return lines;
  const lastWidth = lineContentWidth(sp, last, 0);
  if (lastWidth > available / 3) return lines;
  // Move the last word of the previous line down.
  let k = prev.end - 1;
  while (k > prev.start && sp.breaks[k] === NO_BREAK) k--;
  if (k <= prev.start) return lines;
  const moved = { start: k, end: last.end, hyphen: false };
  if (lineContentWidth(sp, moved, 0) > available + EPSILON) return lines;
  return [...lines.slice(0, -2), { start: prev.start, end: k, hyphen: false }, moved];
}

export interface LineOptions {
  /** Maximum lines (overrides the paragraph's own line-clamp). */
  readonly maxLines?: number | null;
  /** More text follows this paragraph (a clamp that ends on its last line still shows an ellipsis). */
  readonly moreFollows?: boolean;
}

/** Lays out a shaped paragraph at `available` px. */
export function layoutLines(sp: ShapedParagraph, available: number, options: LineOptions = {}): ParagraphLayout {
  const inset = sp.input.inlineStart ?? 0;
  if (inset === 0 && !sp.input.marker) return layoutContent(sp, available, options);
  // A list item: content inset on the inline-start side, the marker outside it on the first line.
  const content = layoutContent(sp, Math.max(0, available - inset), options);
  const rtl = (sp.baseLevel & 1) === 1;
  const dx = rtl ? 0 : inset;
  const shiftRun = (r: GlyphRun): GlyphRun => {
    const g = Float64Array.from(r.glyphs);
    for (let i = 1; i < g.length; i += 3) g[i] = g[i]! + dx;
    return { ...r, glyphs: g, left: r.left + dx, right: r.right + dx };
  };
  const lines = content.lines.map((l) => ({
    ...l,
    left: l.left + dx,
    runs: l.runs.map(shiftRun),
    chars: l.chars.map((c) => ({ ...c, left: c.left + dx, right: c.right + dx })),
  }));
  const marker = sp.input.marker ? shapeMarker(sp, sp.input.marker) : null;
  if (marker && lines[0] && !lines[0].hidden) {
    const first = lines[0];
    const edge = rtl ? available - inset : inset;
    const x0 = rtl ? edge : edge - marker.width;
    const data: number[] = [];
    let x = x0;
    marker.gids.forEach((gid, k) => {
      data.push(gid, x, first.baseline);
      x += marker.advances[k]!;
    });
    lines[0] = { ...first, runs: [...first.runs, { font: marker.font, size: marker.box.size, span: -1, syntheticBold: false, syntheticOblique: false, glyphs: Float64Array.from(data), left: x0, right: x0 + marker.width, baseline: first.baseline }] };
  }
  return {
    ...content,
    width: available,
    lines,
    decorations: content.decorations.map((d) => ({ ...d, x: d.x + dx })),
    contentWidth: content.contentWidth + inset,
  };
}

function layoutContent(sp: ShapedParagraph, available: number, options: LineOptions): ParagraphLayout {
  const style = sp.input.style;
  if (sp.length === 0 && sp.input.emptyLine) {
    // One line box holding only the strut (a forced break's line).
    const [ascent, descent] = leadingBox(sp.rootBox, sp.rootBox.lineHeight);
    const line: Line = { start: 0, end: 0, top: 0, height: ascent + descent, baseline: ascent, left: 0, width: 0, runs: [], chars: [], ellipsis: false, hyphenated: false, hidden: false };
    return { width: available, height: line.height, lines: [line], decorations: [], contentWidth: 0, firstBaseline: ascent, lastBaseline: ascent, clamped: false };
  }
  const indent = indentOf(sp, available);
  let breaks = breakLines(sp, available, indent);
  if (style.textWrapStyle === "balance" && style.textWrapMode === "wrap") breaks = balance(sp, available, indent, breaks);
  else if (style.textWrapStyle === "pretty" && style.textWrapMode === "wrap") breaks = pretty(sp, available, breaks);
  let clamped = false;
  const maxLines = options.maxLines !== undefined ? options.maxLines : style.lineClamp;
  let visibleCount = breaks.length;
  if (maxLines !== null && breaks.length > maxLines) {
    visibleCount = maxLines;
    clamped = true;
  } else if (maxLines !== null && options.moreFollows && breaks.length === maxLines) clamped = true;
  const lines: Line[] = [];
  const decorations: DecorationRect[] = [];
  let y = 0;
  let height = 0;
  let contentWidth = 0;
  breaks.forEach((b, index) => {
    const hidden = index >= visibleCount;
    const lastVisible = index === visibleCount - 1;
    // -webkit-line-clamp: the last shown line ends with an ellipsis; text-overflow: ellipsis on an unwrapped line that overflows.
    const ellipsis: EllipsisMode = clamped && lastVisible ? "always" : style.textOverflow === "ellipsis" && style.overflowHidden && !hidden ? "overflow" : "none";
    const line = buildLine(sp, b, available, index === 0 ? indent : 0, y, index === breaks.length - 1, ellipsis, hidden, hidden ? [] : decorations);
    lines.push(line);
    y += line.height;
    if (!hidden) {
      height = y;
      contentWidth = Math.max(contentWidth, line.width + (index === 0 ? Math.abs(indent) : 0));
    }
  });
  const shown = lines.slice(0, visibleCount);
  return {
    width: available,
    height,
    lines,
    decorations,
    contentWidth,
    firstBaseline: shown[0]?.baseline,
    lastBaseline: shown.at(-1)?.baseline,
    clamped,
  };
}

type EllipsisMode = "none" | "overflow" | "always";

/** CSS Inline 3 §4.2: an inline box's ascent and descent including half-leading (ascent takes the floored half). */
function leadingBox(m: FontMetricsPx, lineHeight: number | null): [number, number] {
  if (lineHeight === null) {
    const half = Math.floor(m.lineGap / 2);
    return [m.ascent + half, m.descent + m.lineGap - half];
  }
  const L = Math.floor(lineHeight * 64 + 1e-6) / 64;
  const half = Math.floor((L - (m.ascent + m.descent)) / 2);
  const a = m.ascent + half;
  return [a, L - a];
}

interface VisualRun {
  item: Item;
  start: number;
  end: number;
  level: number;
}

function buildLine(
  sp: ShapedParagraph,
  b: Break,
  available: number,
  indent: number,
  top: number,
  lastLine: boolean,
  ellipsis: EllipsisMode,
  hidden: boolean,
  decorations: DecorationRect[],
): Line {
  const style = sp.input.style;
  const flags = sp.prepared.flags;
  const breakSpaces = style.whiteSpaceCollapse === "break-spaces";
  const n = sp.length;
  const rtlPara = (sp.baseLevel & 1) === 1;

  // Content range: skip leading collapsible spaces; trailing spaces hang or are removed.
  let s = b.start;
  while (s < b.end && flags[s]! & CHAR_COLLAPSIBLE_SPACE) s++;
  let e = b.end;
  while (e > s && isSpaceFlag(flags[e - 1]!, breakSpaces)) e--;
  // Trailing preserved spaces (pre-wrap) stay on the line but hang; collapsible ones are removed.
  let drawEnd = e;
  while (drawEnd < b.end && flags[drawEnd]! & (CHAR_PRESERVED_SPACE) && !(flags[drawEnd]! & CHAR_FORCED_BREAK)) drawEnd++;

  // Line edges inside a word are shaped on their own; advances with tab stops resolved.
  const local = lineShaping(sp, s, drawEnd);
  const tabInterval = sp.spaceAdvance * style.tabSize;
  const adv = new Float64Array(drawEnd - s);
  let x = indent;
  for (let i = s; i < drawEnd; i++) {
    let w = local.advance[i - s]!;
    if (Number.isNaN(w)) w = tabAdvance(x, tabInterval, sp.tabMinimum);
    adv[i - s] = w;
    x += w;
  }
  let contentWidth = 0;
  for (let i = s; i < e; i++) contentWidth += adv[i - s]!;
  // CSS Text 3 §4.1.3: preserved spaces before a forced break hang only conditionally: when they fit, they count.
  const forcedEnd = b.end > 0 && b.end <= n && (flags[b.end - 1]! & CHAR_FORCED_BREAK) !== 0;
  if (forcedEnd && !breakSpaces) {
    while (e < drawEnd && contentWidth + adv[e - s]! <= available - indent + EPSILON && flags[e]! & CHAR_PRESERVED_SPACE) {
      contentWidth += adv[e - s]!;
      e++;
    }
  }
  // Chromium sizes the text of each inline item on a line (a style run at one bidi
  // level) in whole layout units, 1/64 px rounded up; the slack follows the item's
  // text on its visual right.
  const fragments: { anchor: number; slack: number }[] = [];
  for (let a = s; a < e; ) {
    const span = sp.prepared.span[a];
    const level = sp.levels[a];
    let w = 0;
    let z = a;
    for (; z < e && sp.prepared.span[z] === span && sp.levels[z] === level; z++) w += Number.isNaN(adv[z - s]!) ? 0 : adv[z - s]!;
    const slack = Math.ceil(w * 64 - 1e-6) / 64 - w;
    if (slack > 0) {
      fragments.push({ anchor: level! & 1 ? a : z - 1, slack });
      contentWidth += slack;
    }
    a = z;
  }

  // Hyphen, and ellipsis truncation: graphemes from `truncateAt` on keep their
  // geometry (as in browsers) but are not drawn; the ellipsis follows the rest.
  let hyphenInfo = b.hyphen ? hyphenGlyph(sp, b.end - 1) : null;
  let ellipsisInfo: { font: FontInstance; gids: number[]; advances: number[]; width: number; box: BoxMetrics } | null = null;
  let truncateAt = drawEnd;
  if (ellipsis !== "none" && (ellipsis === "always" || contentWidth > available - indent + EPSILON)) {
    ellipsisInfo = shapeEllipsis(sp);
    const roomForText = available - indent - (ellipsisInfo?.width ?? 0);
    let w = contentWidth + (hyphenInfo?.advance ?? 0);
    let te = e;
    if (w > roomForText + EPSILON) {
      hyphenInfo = null;
      w = contentWidth;
      while (te > s && w > roomForText + EPSILON) {
        let g = te - 1;
        while (g > s && !sp.graphemes[g]) g--;
        for (let i = g; i < te; i++) w -= adv[i - s]!;
        te = g;
      }
      while (te > s && isSpaceFlag(flags[te - 1]!, breakSpaces)) {
        w -= adv[te - 1 - s]!;
        te--;
      }
    }
    truncateAt = te;
  }
  const extra = hyphenInfo?.advance ?? 0;
  const lineWidth = contentWidth + extra;

  // Alignment.
  let align: string = style.textAlign;
  if (align === "justify" && (lastLine || forcedEnd)) align = style.textAlignLast === "auto" ? "start" : style.textAlignLast;
  if (align === "start") align = rtlPara ? "right" : "left";
  else if (align === "end") align = rtlPara ? "left" : "right";
  const room = available - indent;
  // An overflowing line is aligned to its start edge.
  if (lineWidth > room && align !== "justify") align = rtlPara ? "right" : "left";
  let offset = 0;
  if (align === "right") offset = room - lineWidth;
  else if (align === "center") offset = Math.floor(((room - lineWidth) / 2) * 64) / 64;
  // Justification: spread the free space over word separators (and between CJK characters).
  let expansion = 0;
  const opportunities = new Uint8Array(drawEnd - s);
  if (align === "justify" && room > lineWidth) {
    let count = 0;
    for (let i = s; i < e; i++) {
      const f = flags[i]!;
      if (f & CHAR_WORD_SEPARATOR) {
        opportunities[i - s] = 1;
        count++;
      } else if (sp.graphemes[i] && i + 1 < e && isEastAsianFWH(codePointAt(sp.prepared.text, i))) {
        opportunities[i - s] = 1;
        count++;
      }
    }
    if (count > 0) expansion = (room - lineWidth) / count;
  }
  const left = (rtlPara ? 0 : indent) + offset;
  // Bidi reordering (L1: trailing white space at the paragraph level; L2: reverse runs).
  const levels = new Uint8Array(drawEnd - s);
  for (let i = s; i < drawEnd; i++) levels[i - s] = sp.levels[i]!;
  for (let i = drawEnd - 1; i >= s && isSpaceFlag(flags[i]!, false); i--) levels[i - s] = sp.baseLevel;
  const runs: VisualRun[] = [];
  for (let i = s; i < drawEnd; ) {
    const item = local.item[i - s]!;
    const level = levels[i - s]!;
    let j = i + 1;
    while (j < drawEnd && local.item[j - s] === item && levels[j - s] === level) j++;
    runs.push({ item, start: i, end: j, level });
    i = j;
  }
  // Hyphen and ellipsis go at the logical end of the line.
  const maxLevel = runs.reduce((m, r) => Math.max(m, r.level), 0);
  let minOdd = runs.reduce((m, r) => (r.level & 1 ? Math.min(m, r.level) : m), 255);
  if (minOdd === 255) minOdd = maxLevel + 1;
  for (let lvl = maxLevel; lvl >= minOdd; lvl--) {
    for (let i = 0; i < runs.length; ) {
      if (runs[i]!.level < lvl) {
        i++;
        continue;
      }
      let j = i;
      while (j < runs.length && runs[j]!.level >= lvl) j++;
      runs.splice(i, j - i, ...runs.slice(i, j).reverse());
      i = j;
    }
  }

  // Line box: the strut plus every inline box (span) on the line; with line-height normal the fonts used count too.
  const boxes = new Map<number, Set<FontMetricsPx>>();
  for (const r of runs) {
    let set = boxes.get(r.item.span);
    if (!set) boxes.set(r.item.span, (set = new Set()));
    if (r.item.font) set.add(r.item.metrics);
  }
  if (boxes.size === 0 && b.end > b.start) boxes.set(sp.prepared.span[Math.min(b.start, n - 1)]!, new Set());
  let ascent = 0;
  let descent = 0;
  const include = (m: FontMetricsPx, lh: number | null): void => {
    const [a, d] = leadingBox(m, lh);
    ascent = Math.max(ascent, a);
    descent = Math.max(descent, d);
  };
  const root = sp.rootBox;
  include(root, root.lineHeight);
  let firstBox = true;
  for (const [span, used] of boxes) {
    const box = sp.spanBoxes[span]!;
    if (firstBox) {
      ascent = Math.max(ascent, leadingBox(root, root.lineHeight)[0]);
      firstBox = false;
    }
    include(box, box.lineHeight);
    if (box.lineHeight === null) for (const m of used) include(m, null);
  }
  if (ellipsisInfo) include(ellipsisInfo.box, ellipsisInfo.box.lineHeight);
  const height = ascent + descent;
  const baseline = top + ascent;

  // Glyph placement in visual order. Letter and word spacing and justification
  // follow each cluster in logical order: on its right in LTR, on its left in RTL.
  const glyphRuns: GlyphRun[] = [];
  const chars: CharBox[] = [];
  // Hanging trailing spaces (pre-wrap) sit after the content in logical order: on the
  // right in LTR, on the left in RTL, where they hang outside the aligned line.
  let hang = 0;
  for (let i = e; i < truncateAt && i < drawEnd; i++) hang += adv[i - s]!;
  let pen = rtlPara ? left - hang : left;
  const spacing = (cs: number): number => (local.advance[cs - s]! || 0) - local.glyphAdvance[cs - s]! + (opportunities[cs - s] ? expansion : 0) + (Number.isNaN(local.advance[cs - s]!) ? adv[cs - s]! : 0);
  for (const r of runs) {
    const item = r.item;
    const rtl = (r.level & 1) === 1;
    const runLeft = pen;
    const boxes: [number, number, number][] = []; // cluster start, left, right
    const glyphData: number[] = [];
    const g = item.glyphs;
    if (g && item.font) {
      let prev = -1;
      let boxLeft = pen;
      for (let k = 0; k < g.gids.length; k++) {
        const c = g.clusters[k]!;
        if (c < r.start || c >= r.end) continue;
        const cs = local.clusterStart[c - s]!;
        if (cs !== prev) {
          if (prev >= 0) {
            if (!rtl) pen += spacing(prev);
            boxes.push([prev, boxLeft, pen]);
          }
          boxLeft = pen;
          if (rtl) pen += spacing(cs);
          prev = cs;
        }
        if (cs < truncateAt && !hidden) glyphData.push(g.gids[k]!, pen + g.offsetsX[k]! * item.scale, baseline - g.offsetsY[k]! * item.scale);
        pen += g.advances[k]! * item.scale;
      }
      if (prev >= 0) {
        if (!rtl) pen += spacing(prev);
        boxes.push([prev, boxLeft, pen]);
      }
    } else {
      // No glyphs (tabs, forced breaks, characters no font has): advances only.
      const order = [];
      for (let i = r.start; i < r.end; i++) if (local.clusterStart[i - s] === i) order.push(i);
      if (rtl) order.reverse();
      for (const i of order) {
        const w = (adv[i - s] ?? 0) + (opportunities[i - s] ? expansion : 0);
        boxes.push([i, pen, pen + w]);
        pen += w;
      }
    }
    if (glyphData.length > 0) {
      // The run's box covers the clusters that are drawn (an ellipsis may hide the rest).
      let runL = Infinity;
      let runR = -Infinity;
      for (const [cs, bl, br] of boxes) {
        if (cs >= truncateAt) continue;
        runL = Math.min(runL, bl);
        runR = Math.max(runR, br);
      }
      glyphRuns.push({
        font: item.font!,
        size: item.size,
        span: item.span,
        syntheticBold: item.match?.syntheticBold ?? false,
        syntheticOblique: item.match?.syntheticOblique ?? false,
        glyphs: Float64Array.from(glyphData),
        left: runL === Infinity ? runLeft : runL,
        right: runR === -Infinity ? pen : runR,
        baseline,
      });
    }
    // Grapheme boxes: each cluster's box split evenly over its graphemes.
    for (const [cs, bl, br] of boxes) {
      let ce = cs + 1;
      while (ce < r.end && local.clusterStart[ce - s] === cs) ce++;
      const gs: number[] = [];
      for (let i = cs; i < ce; i++) if (sp.graphemes[i] || i === cs) gs.push(i);
      const w = br - bl;
      gs.forEach((gi, k) => {
        const a = (w * k) / gs.length;
        const bb = (w * (k + 1)) / gs.length;
        chars.push(rtl ? { index: gi, left: br - bb, right: br - a, span: item.span, rtl } : { index: gi, left: bl + a, right: bl + bb, span: item.span, rtl });
      });
    }
    for (const f of fragments) if (f.anchor >= r.start && f.anchor < r.end) pen += f.slack;
  }
  // Hyphen or ellipsis at the end (visual right in LTR, left in RTL).
  // The ellipsis sits after the last drawn grapheme (before the first one in RTL).
  let drawnLeft = Infinity;
  let drawnRight = -Infinity;
  for (const c of chars) {
    if (c.index >= truncateAt) continue;
    drawnLeft = Math.min(drawnLeft, c.left);
    drawnRight = Math.max(drawnRight, c.right);
  }
  if (drawnLeft === Infinity) drawnLeft = drawnRight = left;
  const tail = (font: FontInstance, size: number, span: number, gids: number[], advances: number[], width: number, ellipsisMark: boolean): void => {
    if (hidden) return;
    const at = ellipsisMark ? (rtlPara ? drawnLeft - width : drawnRight) : rtlPara ? left - width : pen;
    let px = at;
    const data: number[] = [];
    gids.forEach((g, k) => {
      data.push(g, px, baseline);
      px += advances[k]!;
    });
    glyphRuns.push({ font, size, span, syntheticBold: false, syntheticOblique: false, glyphs: Float64Array.from(data), left: at, right: at + width, baseline });
    if (!rtlPara) pen += width;
  };
  if (hyphenInfo) tail(hyphenInfo.font, hyphenInfo.item.size, hyphenInfo.item.span, [hyphenInfo.gid], [hyphenInfo.advance], hyphenInfo.advance, false);
  if (ellipsisInfo) tail(ellipsisInfo.font, ellipsisInfo.box.size, -1, ellipsisInfo.gids, ellipsisInfo.advances, ellipsisInfo.width, true);
  chars.sort((a, b) => a.index - b.index);

  // Decorations per span segment on the line.
  for (const r of glyphRuns) {
    if (r.span < 0) continue;
    const st = sp.input.spans[r.span]!.style;
    const d = st.textDecorationLine;
    if (!d.underline && !d.overline && !d.lineThrough) continue;
    const box = sp.spanBoxes[r.span]!;
    const m = box.font?.metrics;
    const scale = box.font ? effectiveFontSize(st.fontSize) / box.font.unitsPerEm : 0;
    const autoThickness = m ? Math.max(1, m.underlineThickness * scale) : st.fontSize / 16;
    const thickness = typeof st.textDecorationThickness === "number" ? st.textDecorationThickness : autoThickness;
    const width = r.right - r.left;
    if (d.underline) {
      const offset = typeof st.textUnderlineOffset === "number" ? st.textUnderlineOffset : m ? -m.underlinePosition * scale : st.fontSize / 10;
      decorations.push({ kind: "underline", span: r.span, x: r.left, y: r.baseline + offset, width, thickness });
    }
    if (d.overline) decorations.push({ kind: "overline", span: r.span, x: r.left, y: r.baseline - box.ascent, width, thickness });
    if (d.lineThrough) {
      const pos = m ? m.strikeoutPosition * scale : st.fontSize * 0.3;
      const size = m ? Math.max(1, m.strikeoutSize * scale) : thickness;
      decorations.push({ kind: "line-through", span: r.span, x: r.left, y: r.baseline - pos - size / 2, width, thickness: size });
    }
  }

  return {
    start: b.start,
    end: b.end,
    top,
    height,
    baseline,
    left,
    width: lineWidth,
    runs: glyphRuns,
    chars,
    ellipsis: ellipsisInfo !== null,
    hyphenated: hyphenInfo !== null,
    hidden,
  };
}

/**
 * The paragraph's shaping as one line sees it, for `[s, end)`: where the
 * line starts or ends inside a word at a point HarfBuzz marks unsafe to
 * break (kerning, a ligature or contextual shaping across it), that part
 * is shaped on its own, as browsers re-shape line edges.
 */
function lineShaping(sp: ShapedParagraph, s: number, end: number): { item: Item[]; advance: Float64Array; glyphAdvance: Float64Array; clusterStart: Int32Array } {
  const n = end - s;
  const item: Item[] = new Array(n);
  const advance = sp.advance.slice(s, end);
  const glyphAdvance = sp.glyphAdvance.slice(s, end);
  const clusterStart = sp.clusterStart.slice(s, end);
  for (let i = 0; i < n; i++) item[i] = sp.items[sp.itemOf[s + i]!]!;
  if (n === 0) return { item, advance, glyphAdvance, clusterStart };
  const apply = (itemIndex: number, a: number, b: number): void => {
    const r = sp.reshape(itemIndex, a, b);
    for (let i = a; i < b; i++) {
      item[i - s] = r.item;
      advance[i - s] = r.advance[i - a]!;
      glyphAdvance[i - s] = r.glyphAdvance[i - a]!;
      clusterStart[i - s] = r.clusterStart[i - a]!;
    }
  };
  const first = sp.itemOf[s]!;
  const last = sp.itemOf[end - 1]!;
  const cutStart = sp.unsafeToBreak(s);
  const cutEnd = sp.unsafeToBreak(end);
  if (cutStart && cutEnd && first === last) apply(first, s, end);
  else {
    if (cutStart) apply(first, s, Math.min(sp.items[first]!.end, end));
    if (cutEnd) apply(last, Math.max(sp.items[last]!.start, s), end);
  }
  return { item, advance, glyphAdvance, clusterStart };
}

function shapeEllipsis(sp: ShapedParagraph): { font: FontInstance; gids: number[]; advances: number[]; width: number; box: BoxMetrics } | null {
  return shapeMarker(sp, "\u2026");
}

/** Shapes a short string (ellipsis, list marker) in the paragraph's root style with the font of its first character. */
function shapeMarker(sp: ShapedParagraph, text: string): { font: FontInstance; gids: number[]; advances: number[]; width: number; box: BoxMetrics } | null {
  const root = sp.input.root;
  const match = sp.fonts.fontFor(text.codePointAt(0)!, { families: root.fontFamily, request: requestOf(root) });
  if (!match) return null;
  const font = instanceFor(match, requestOf(root), root.fontSize, root.fontOpticalSizing, root.fontVariationSettings);
  const glyphs = shapeItem(text, 0, text.length, font, false, "Zyyy", root.language, featuresFor(root));
  const scale = effectiveFontSize(root.fontSize) / font.unitsPerEm;
  const spacing = (root.letterSpacing * [...text].length) / Math.max(1, glyphs.advances.length);
  const advances = Array.from(glyphs.advances, (a) => a * scale + spacing);
  const m = fontMetricsPx(font, root.fontSize);
  return { font, gids: Array.from(glyphs.gids), advances, width: advances.reduce((a, b) => a + b, 0), box: { ...m, lineHeight: sp.rootBox.lineHeight, font, match, size: root.fontSize } };
}
