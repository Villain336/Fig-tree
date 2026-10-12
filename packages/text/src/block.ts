import type { Measurer } from "@fig-tree/layout";
import type { FontRegistry } from "./font/registry";
import { layoutLines, type CharBox, type Line, type ParagraphLayout } from "./layout/lines";
import { ShapedParagraph, type ParagraphInput } from "./layout/paragraph";

/**
 * A text box's content: paragraphs stacked as block containers (each one a
 * `<p>` in exported HTML), with optional spacing between them and a line
 * clamp across all of them. Implements the layout engine's {@link Measurer}
 * so text participates in flex and grid sizing.
 */

export interface TextBlockInput {
  readonly paragraphs: readonly ParagraphInput[];
  /** Space between consecutive paragraphs in px (CSS margin between the blocks). */
  readonly paragraphSpacing?: number;
  /** Maximum number of lines over all paragraphs (`-webkit-line-clamp` on the container). */
  readonly lineClamp?: number | null;
}

export interface PlacedParagraph {
  /** Top of the paragraph block within the text box. */
  readonly top: number;
  readonly index: number;
  readonly layout: ParagraphLayout;
}

export interface TextBlockLayout {
  readonly width: number;
  readonly height: number;
  readonly paragraphs: readonly PlacedParagraph[];
  /** Widest line (for hugging widths). */
  readonly contentWidth: number;
  readonly firstBaseline: number | undefined;
  readonly lastBaseline: number | undefined;
  readonly lineCount: number;
}

export interface CaretPosition {
  /** Paragraph and source index (in the paragraph's source text). */
  readonly paragraph: number;
  readonly index: number;
}

export interface CaretRect {
  readonly x: number;
  readonly top: number;
  readonly height: number;
}

const CACHE = 6;

export class TextBlock implements Measurer {
  private shapedCache: ShapedParagraph[] | null = null;
  private shapedVersion = -1;
  private layouts: { width: number; layout: TextBlockLayout }[] = [];

  constructor(
    readonly fonts: FontRegistry,
    readonly input: TextBlockInput,
  ) {}

  /** Shaped paragraphs (re-shaped when the font registry changed). */
  get shaped(): ShapedParagraph[] {
    if (!this.shapedCache || this.shapedVersion !== this.fonts.version) {
      this.shapedVersion = this.fonts.version;
      this.shapedCache = this.input.paragraphs.map((p) => new ShapedParagraph(p, this.fonts));
      this.layouts = [];
    }
    return this.shapedCache;
  }

  /** Whether a needed font is still loading. */
  get pendingFonts(): boolean {
    return this.shaped.some((p) => p.pendingFonts);
  }

  layout(width: number): TextBlockLayout {
    const shaped = this.shaped;
    const hit = this.layouts.find((l) => l.width === width);
    if (hit) return hit.layout;
    const spacing = this.input.paragraphSpacing ?? 0;
    let remaining = this.input.lineClamp ?? Infinity;
    const paragraphs: PlacedParagraph[] = [];
    let y = 0;
    let contentWidth = 0;
    let lineCount = 0;
    for (let i = 0; i < shaped.length && remaining > 0; i++) {
      const sp = shaped[i]!;
      const clamp = this.input.lineClamp ?? null;
      const layout = clamp === null ? layoutLines(sp, width) : layoutLines(sp, width, { maxLines: Number.isFinite(remaining) ? remaining : null, moreFollows: i + 1 < shaped.length });
      if (i > 0 && layout.lines.length > 0 && paragraphs.length > 0) y += spacing;
      paragraphs.push({ top: y, index: i, layout });
      y += layout.height;
      contentWidth = Math.max(contentWidth, layout.contentWidth);
      lineCount += layout.lines.length;
      remaining -= layout.lines.length;
    }
    const first = paragraphs.find((p) => p.layout.firstBaseline !== undefined);
    const last = [...paragraphs].reverse().find((p) => p.layout.lastBaseline !== undefined);
    const result: TextBlockLayout = {
      width,
      height: y,
      paragraphs,
      contentWidth,
      firstBaseline: first ? first.top + first.layout.firstBaseline! : undefined,
      lastBaseline: last ? last.top + last.layout.lastBaseline! : undefined,
      lineCount,
    };
    this.layouts.push({ width, layout: result });
    if (this.layouts.length > CACHE) this.layouts.shift();
    return result;
  }

  // ── Measurer ──────────────────────────────────────────────────────────

  minContentWidth(): number {
    let m = 0;
    for (const sp of this.shaped) m = Math.max(m, sp.intrinsic(indentPx(sp)).min);
    return ceil64(m);
  }

  maxContentWidth(): number {
    let m = 0;
    for (const sp of this.shaped) m = Math.max(m, sp.intrinsic(indentPx(sp)).max);
    return ceil64(m);
  }

  heightForWidth(width: number): number {
    return this.layout(width).height;
  }

  firstBaseline(width: number): number | undefined {
    return this.layout(width).firstBaseline;
  }

  lastBaseline(width: number): number | undefined {
    return this.layout(width).lastBaseline;
  }

  // ── Hit-testing ───────────────────────────────────────────────────────

  /** The caret position nearest to a point (in text box coordinates). */
  hitTest(layout: TextBlockLayout, x: number, y: number): CaretPosition {
    if (layout.paragraphs.length === 0) return { paragraph: 0, index: 0 };
    let para = layout.paragraphs[0]!;
    for (const p of layout.paragraphs) if (y >= p.top) para = p;
    const lines = para.layout.lines;
    if (lines.length === 0) return { paragraph: para.index, index: 0 };
    const ly = y - para.top;
    let line = lines[0]!;
    for (const l of lines) if (ly >= l.top) line = l;
    const sp = this.shaped[para.index]!;
    const source = sp.prepared.source;
    let best: { index: number; d: number } | null = null;
    for (const c of line.chars) {
      const mid = (c.left + c.right) / 2;
      // Left half of a box is before the character (after it in RTL).
      const before = x < mid !== c.rtl;
      const caretX = x < mid ? c.left : c.right;
      const d = Math.abs(x - caretX);
      const idx = before ? c.index : nextGrapheme(sp, c.index);
      if (!best || d < best.d) best = { index: idx, d };
    }
    const prepared = best ? best.index : line.start;
    return { paragraph: para.index, index: source[Math.min(prepared, source.length - 1)]! };
  }

  /** The caret rectangle before the character at source `index` of a paragraph. */
  caretRect(layout: TextBlockLayout, position: CaretPosition): CaretRect | null {
    const para = layout.paragraphs.find((p) => p.index === position.paragraph);
    if (!para) return null;
    const sp = this.shaped[para.index]!;
    const source = sp.prepared.source;
    // Prepared index of the first prepared character at or after the source index.
    let k = 0;
    while (k < source.length - 1 && source[k]! < position.index) k++;
    for (const line of para.layout.lines) {
      if (k < line.start || (k >= line.end && line !== para.layout.lines.at(-1))) continue;
      const c = line.chars.find((ch: CharBox) => ch.index >= k);
      const ascent = line.baseline - line.top;
      let x: number;
      if (c) x = c.rtl ? c.right : c.left;
      else {
        const lastChar = line.chars.at(-1);
        x = lastChar ? (lastChar.rtl ? lastChar.left : lastChar.right) : line.left;
      }
      void ascent;
      return { x, top: para.top + line.top, height: line.height };
    }
    return null;
  }

  /** Every line of every paragraph with its paragraph offset, top to bottom. */
  lines(layout: TextBlockLayout): { paragraph: number; top: number; line: Line }[] {
    return layout.paragraphs.flatMap((p) => p.layout.lines.map((line) => ({ paragraph: p.index, top: p.top, line })));
  }
}

function nextGrapheme(sp: ShapedParagraph, i: number): number {
  let j = i + 1;
  while (j < sp.length && !sp.graphemes[j]) j++;
  return j;
}

function indentPx(sp: ShapedParagraph): number {
  const ti = sp.input.style.textIndent;
  return typeof ti === "number" ? ti : 0;
}

/** Chromium stores intrinsic sizes as LayoutUnits (1/64 px), rounding text widths up. */
export function ceil64(v: number): number {
  return Math.ceil(v * 64 - 1e-6) / 64;
}
