import type { SceneBridge } from "@fig-tree/document";

/** A laid-out line of a text node, in the node's local coordinates (source UTF-16 indices). */
export interface VisualLine {
  readonly paragraph: number;
  /** Source range of the line, excluding a paragraph's closing "\n". */
  readonly start: number;
  readonly end: number;
  readonly top: number;
  readonly height: number;
  readonly left: number;
  readonly right: number;
}

export interface CaretBox {
  readonly x: number;
  readonly y: number;
  readonly height: number;
}

/**
 * Text geometry for editing, read from the bridge's text layout: caret
 * rectangles, the caret index nearest a point, and visual lines with their
 * grapheme boxes (for selection highlights and line navigation). All
 * coordinates are local to the text node's box.
 */
export class TextLayoutView {
  constructor(
    readonly bridge: SceneBridge,
    readonly id: string,
  ) {}

  private get content(): string {
    return this.bridge.doc.text(this.id).content;
  }

  /** Offsets of the text block inside the box: padding, border and vertical alignment. */
  private origin(): { x: number; y: number; height: number } | null {
    const t = this.bridge.layout.text(this.id);
    const box = this.bridge.box(this.id);
    if (!t || !box) return null;
    const valign = this.bridge.doc.get<string>(this.id, "verticalAlign");
    const inner = box.height - box.padding.top - box.padding.bottom - box.border.top - box.border.bottom;
    const dy = valign === "center" ? (inner - t.layout.height) / 2 : valign === "bottom" ? inner - t.layout.height : 0;
    return { x: box.padding.left + box.border.left, y: box.padding.top + box.border.top + dy, height: t.layout.height };
  }

  private paragraphStarts(): number[] {
    const content = this.content;
    const starts = [0];
    for (let i = content.indexOf("\n"); i >= 0; i = content.indexOf("\n", i + 1)) starts.push(i + 1);
    return starts;
  }

  /** The caret before `index`, or a default caret at the top left when the text has no lines yet. */
  caret(index: number): CaretBox {
    const r = this.bridge.textCaretRect(this.id, index);
    if (r) return r;
    // Empty paragraphs (and empty text) have no characters to measure: use the line box.
    const line = this.lines().find((l) => l.start <= index && index <= l.end);
    if (line) return { x: line.left, y: line.top, height: line.height };
    const o = this.origin();
    const size = this.bridge.doc.get<number>(this.id, "fontSize");
    return { x: o?.x ?? 0, y: o?.y ?? 0, height: Math.max(o?.height ?? 0, size * 1.2) };
  }

  /** The caret index nearest a local point. */
  indexAt(x: number, y: number): number {
    const lines = this.lines();
    if (lines.length === 0) return 0;
    // The bridge's hit test picks the paragraph and line by y; clamp y into the text first.
    const first = lines[0]!;
    const last = lines[lines.length - 1]!;
    const cy = Math.min(Math.max(y, first.top + 0.01), last.top + last.height - 0.01);
    const hit = this.bridge.textCaretAt(this.id, x, cy);
    if (hit === null) return 0;
    // A line that is empty (an empty paragraph) has no characters: its start is the only caret.
    const line = lines.find((l) => cy >= l.top && cy < l.top + l.height);
    if (line && line.start === line.end) return line.start;
    return Math.min(hit, this.content.length);
  }

  /** Visual lines, top to bottom. */
  lines(): VisualLine[] {
    const t = this.bridge.layout.text(this.id);
    const o = this.origin();
    if (!t || !o) return [];
    const starts = this.paragraphStarts();
    const content = this.content;
    const out: VisualLine[] = [];
    for (const p of t.layout.paragraphs) {
      const shaped = t.block.shaped[p.index];
      if (!shaped) continue;
      const source = shaped.prepared.source;
      const base = starts[p.index] ?? 0;
      const paraEnd = p.index + 1 < starts.length ? starts[p.index + 1]! - 1 : content.length;
      for (const line of p.layout.lines) {
        if (line.hidden) continue;
        const s = base + (source[Math.min(line.start, source.length - 1)] ?? 0);
        let e = base + (source[Math.min(line.end, source.length - 1)] ?? 0);
        if (e > paraEnd) e = paraEnd;
        let left = Infinity;
        let right = -Infinity;
        for (const c of line.chars) {
          left = Math.min(left, c.left);
          right = Math.max(right, c.right);
        }
        if (left > right) {
          left = line.left;
          right = line.left;
        }
        out.push({ paragraph: p.index, start: s, end: Math.max(s, e), top: o.y + p.top + line.top, height: line.height, left: o.x + left, right: o.x + right });
      }
    }
    return out;
  }

  /**
   * Highlight rectangles of a source range [from, to): one per line it
   * touches, from the grapheme boxes (a selection that continues past a line
   * end extends to the line's right edge, as editors show the newline).
   */
  rangeRects(from: number, to: number): { x: number; y: number; width: number; height: number }[] {
    if (to <= from) return [];
    const t = this.bridge.layout.text(this.id);
    const o = this.origin();
    if (!t || !o) return [];
    const starts = this.paragraphStarts();
    const out: { x: number; y: number; width: number; height: number }[] = [];
    for (const p of t.layout.paragraphs) {
      const shaped = t.block.shaped[p.index];
      if (!shaped) continue;
      const source = shaped.prepared.source;
      const base = starts[p.index] ?? 0;
      const paraEnd = p.index + 1 < starts.length ? starts[p.index + 1]! - 1 : Infinity;
      for (const line of p.layout.lines) {
        if (line.hidden) continue;
        let left = Infinity;
        let right = -Infinity;
        for (const c of line.chars) {
          const si = base + (source[c.index] ?? 0);
          if (si >= from && si < to) {
            left = Math.min(left, c.left);
            right = Math.max(right, c.right);
          }
        }
        const lineEndSource = base + (source[Math.min(line.end, source.length - 1)] ?? 0);
        const lastLine = line === p.layout.lines[p.layout.lines.length - 1];
        // The selection runs on past this line (into the newline or the next line).
        const continues = to > Math.min(lineEndSource, paraEnd) && from <= Math.min(lineEndSource, paraEnd) && (lastLine ? to > paraEnd : true);
        if (left > right) {
          // Nothing selected on the line itself, but an empty line inside the range shows a sliver.
          const lineStartSource = base + (source[Math.min(line.start, source.length - 1)] ?? 0);
          if (line.chars.length === 0 && from <= lineStartSource && to > lineStartSource) out.push({ x: o.x + line.left, y: o.y + p.top + line.top, width: 4, height: line.height });
          continue;
        }
        if (continues) right += 4;
        out.push({ x: o.x + left, y: o.y + p.top + line.top, width: right - left, height: line.height });
      }
    }
    return out;
  }
}
