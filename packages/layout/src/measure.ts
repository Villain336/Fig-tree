/**
 * Intrinsic sizes of leaf content the engine cannot see into: text (module
 * 4 shapes it) or anything else that wraps like text in the inline axis.
 * All sizes are of the content box, in px.
 */
export interface Measurer {
  /** The narrowest the content can be without overflowing (the longest unbreakable run). */
  minContentWidth(): number;
  /** The content's width with no line breaks other than forced ones. */
  maxContentWidth(): number;
  /** The content's height when laid out at `width`. */
  heightForWidth(width: number): number;
  /** The first baseline from the content-box top at `width`, or undefined when the content has none. */
  firstBaseline?(width: number): number | undefined;
  /** The last baseline from the content-box top at `width`. */
  lastBaseline?(width: number): number | undefined;
}

/**
 * Replaced content (images, canvases): a natural size and/or a natural
 * aspect ratio (width / height). Sized by CSS 2 §10.3.2 / §10.6.2 and the
 * CSS Sizing rules for replaced elements.
 */
export interface ReplacedSize {
  readonly width?: number;
  readonly height?: number;
  readonly ratio?: number;
}

/**
 * A deterministic text-like measurer: "words" of fixed width and height laid
 * out in lines, greedily, with zero-width break opportunities between them.
 * A line is as tall as its tallest word and the words sit on the line's
 * baseline by their bottom edge. It mirrors exactly what Chromium does for
 * `<div style="font-size:0; line-height:0">` holding inline-block spans of
 * those sizes separated by spaces, so conformance cases can use it.
 */
export class WordsMeasurer implements Measurer {
  constructor(readonly words: readonly (readonly [width: number, height: number])[]) {}

  minContentWidth(): number {
    let m = 0;
    for (const [w] of this.words) m = Math.max(m, w);
    return m;
  }

  maxContentWidth(): number {
    let s = 0;
    for (const [w] of this.words) s += w;
    return s;
  }

  /** Line heights at a width. */
  lines(width: number): number[] {
    const out: number[] = [];
    let used = 0;
    let height = 0;
    let count = 0;
    for (const [w, h] of this.words) {
      // 1/128 px slack: layout widths are fractional, word widths sum exactly.
      if (count > 0 && used + w > width + 1 / 128) {
        out.push(height);
        used = 0;
        height = 0;
        count = 0;
      }
      used += w;
      height = Math.max(height, h);
      count++;
    }
    if (count > 0) out.push(height);
    return out;
  }

  heightForWidth(width: number): number {
    let s = 0;
    for (const h of this.lines(width)) s += h;
    return s;
  }

  firstBaseline(width: number): number | undefined {
    return this.lines(width)[0];
  }

  lastBaseline(width: number): number | undefined {
    const lines = this.lines(width);
    if (lines.length === 0) return undefined;
    let s = 0;
    for (const h of lines) s += h;
    return s;
  }
}

/** Fixed content of one size (a provisional measurer for text until shaping exists). */
export class FixedMeasurer implements Measurer {
  constructor(
    readonly width: number,
    readonly height: number,
    readonly baseline: number | undefined = undefined,
  ) {}

  minContentWidth(): number {
    return this.width;
  }

  maxContentWidth(): number {
    return this.width;
  }

  heightForWidth(): number {
    return this.height;
  }

  firstBaseline(): number | undefined {
    return this.baseline;
  }

  lastBaseline(): number | undefined {
    return this.baseline;
  }
}
