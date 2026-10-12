import type { GlyphSource } from "@fig-tree/renderer";
import {
  DEFAULT_TEXT_STYLE,
  TextBlock,
  firstStrongDirection,
  parseParagraphStyle,
  parseTextStyle,
  type FontInstance,
  type FontRegistry,
  type ParagraphInput,
  type TextBlockInput,
  type TextStyle as EngineStyle,
} from "@fig-tree/text";
import { textStyleDeclarations } from "../css";
import type { FigDocument } from "../document";
import { canonicalJson } from "../json";
import type { Paint, TextContent, TextStyle } from "../schema";

const LINE_SEPARATOR = String.fromCharCode(0x2028);

/**
 * A text node's content as the text engine's input. The node's CSS (from
 * `cssDeclarations`, the same CSS code export emits) gives the block's own
 * style and paragraph properties; each style run becomes a span with the
 * declarations `textStyleDeclarations` states for it. Paragraphs are split
 * at "\n" (each one a `<p>`, with `paragraphSpacing` between them); U+2028
 * LINE SEPARATOR is a forced line break inside a paragraph. List paragraphs
 * are `<li>`s: inset by 1.5em per level, with an outside marker. Direction
 * `auto` is HTML `dir="auto"` on the text's element: every paragraph takes
 * the direction of the first strong character of the whole text.
 */
export function textBlockInput(doc: FigDocument, id: string, css: Readonly<Record<string, string>>, content: TextContent = doc.text(id)): TextBlockInput {
  const nodeFills = doc.get<Paint[]>(id, "fills");
  const root: EngineStyle = { ...parseTextStyle(css, DEFAULT_TEXT_STYLE), paint: nodeFills };
  const text = content.content;
  let para = parseParagraphStyle(css);
  if (doc.get<string>(id, "direction") === "auto") para = { ...para, direction: firstStrongDirection(text) ?? "ltr" };
  const runs = content.runs;
  const paragraphs: ParagraphInput[] = [];
  const counters: number[] = [];
  let start = 0;
  const runStyleCache = new Map<number, EngineStyle>();
  const runStyle = (i: number): EngineStyle => {
    let s = runStyleCache.get(i);
    if (!s) {
      const style = runs[i]!.style;
      s = { ...parseTextStyle(textStyleDeclarations(style), root), paint: style.fills ?? nodeFills };
      runStyleCache.set(i, s);
    }
    return s;
  };
  while (start <= text.length) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    const ptext = text.slice(start, end).split(LINE_SEPARATOR).join("\n");
    const spans: { start: number; end: number; style: EngineStyle }[] = [];
    let at = start;
    let firstStyle: TextStyle = {};
    for (let i = 0; i < runs.length && at < end; i++) {
      const r = runs[i]!;
      if (r.end <= at) continue;
      if (r.start >= end) break;
      if (r.start > at) {
        spans.push({ start: at - start, end: r.start - start, style: root });
        at = r.start;
      }
      if (at === start) firstStyle = r.style;
      const e = Math.min(r.end, end);
      spans.push({ start: at - start, end: e - start, style: runStyle(i) });
      at = e;
    }
    if (at < end) spans.push({ start: at - start, end: end - start, style: root });
    if (spans.length === 0) spans.push({ start: 0, end: 0, style: root });
    // List formatting comes from the paragraph's first character (or the node).
    const listStyle = firstStyle.listStyle ?? doc.get<string>(id, "listStyle");
    const level = firstStyle.listLevel ?? doc.get<number>(id, "listLevel");
    let marker: string | undefined;
    let inlineStart = 0;
    if (listStyle !== "none") {
      inlineStart = (level + 1) * 1.5 * root.fontSize;
      counters.length = level + 1;
      if (listStyle === "ordered") {
        counters[level] = (counters[level] ?? 0) + 1;
        marker = `${counters[level]}. `;
      } else marker = "• ";
    } else counters.length = 0;
    paragraphs.push({ text: ptext, spans, style: para, root, emptyLine: true, ...(marker ? { marker, inlineStart } : {}) });
    start = end + 1;
  }
  const maxLines = doc.stored(id, "maxLines") !== undefined ? doc.get<number>(id, "maxLines") : null;
  return { paragraphs, paragraphSpacing: doc.get<number>(id, "paragraphSpacing"), lineClamp: maxLines };
}

/** A key that changes whenever the text's layout input may have changed. */
export function textKey(doc: FigDocument, id: string, css: Readonly<Record<string, string>>, content: TextContent): string {
  return canonicalJson({
    content,
    css,
    fills: doc.get<Paint[]>(id, "fills"),
    list: [doc.get<string>(id, "listStyle"), doc.get<number>(id, "listLevel")],
    direction: doc.get<string>(id, "direction"),
    spacing: doc.get<number>(id, "paragraphSpacing"),
    maxLines: doc.stored(id, "maxLines") ?? null,
  });
}

export function makeTextBlock(fonts: FontRegistry, input: TextBlockInput): TextBlock {
  return new TextBlock(fonts, input);
}

const sources = new WeakMap<FontInstance, GlyphSource>();

/** The renderer's view of a font instance: outlines and bounds in font units, y down. */
export function glyphSource(font: FontInstance): GlyphSource {
  let s = sources.get(font);
  if (!s) {
    s = {
      key: `${font.typeface.id}/${font.key}`,
      unitsPerEm: font.unitsPerEm,
      path: (gid) => font.path(gid),
      bounds: (gid) => {
        const e = font.extents(gid);
        return e ? { minX: e.left, minY: e.top, maxX: e.right, maxY: e.bottom } : null;
      },
    };
    sources.set(font, s);
  }
  return s;
}
