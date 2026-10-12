import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_PARAGRAPH_STYLE, loadHarfBuzz, parseParagraphStyle, parseTextStyle, prepareText, TextBlock, type FontRegistry, type TextStyle } from "../src/index";
import { fixtureRegistry } from "../conformance/fonts";

/**
 * Paragraph layout through the public API: white space processing,
 * intrinsic sizes, line boxes, truncation, hit-testing and caret rects.
 * Geometry against Chromium is the conformance suite's job; these check
 * the API's contracts and invariants.
 */

let fonts: FontRegistry;
beforeAll(async () => {
  await loadHarfBuzz();
  fonts = fixtureRegistry();
});

const root = (css = ""): TextStyle => parseTextStyle(`font: 16px Inter; ${css}`);
function block(text: string, css = "", paraCss = ""): TextBlock {
  const r = root(css);
  return new TextBlock(fonts, { paragraphs: [{ text, spans: [{ start: 0, end: text.length, style: r }], style: parseParagraphStyle(paraCss), root: r }] });
}

describe("white space processing", () => {
  const prep = (text: string, ws: string) => prepareText(text, [{ start: 0, end: text.length, style: root() }], parseParagraphStyle(`white-space: ${ws}`));

  it("collapses spaces, tabs and newlines in normal and nowrap", () => {
    expect(prep("  a \t b\n\n c  ", "normal").text).toBe(" a b c ");
    expect(prep("a​\nb", "normal").text).toBe("a​b");
  });

  it("keeps newlines in pre-line and everything in pre and pre-wrap", () => {
    expect(prep("a  \n  b", "pre-line").text).toBe("a\nb");
    expect(prep("a \t\n b", "pre-wrap").text).toBe("a \t\n b");
  });

  it("maps every prepared character to its source index", () => {
    const p = prep("a   b", "normal");
    expect([...p.source]).toEqual([0, 1, 4, 5]);
  });

  it("applies text-transform before collapsing, keeping source indices", () => {
    const text = "straße";
    const p = prepareText(text, [{ start: 0, end: text.length, style: root("text-transform: uppercase") }], DEFAULT_PARAGRAPH_STYLE);
    expect(p.text).toBe("STRASSE");
    expect([...p.source].slice(0, 7)).toEqual([0, 1, 2, 3, 4, 4, 5]);
  });
});

describe("paragraph layout", () => {
  it("reports intrinsic sizes: min-content is the widest word, max-content the unbroken line", () => {
    const b = block("aa bbbbbb c");
    const words = ["aa", "bbbbbb", "c"].map((w) => block(w).maxContentWidth());
    expect(b.minContentWidth()).toBe(Math.max(...words));
    expect(b.maxContentWidth()).toBeGreaterThan(words.reduce((a, c) => a + c, 0));
    // Laid out at its max-content width, the text is one line; at min-content every word gets a line.
    expect(b.layout(b.maxContentWidth()).lineCount).toBe(1);
    expect(b.layout(b.minContentWidth()).lineCount).toBe(3);
  });

  it("stacks line boxes: line height 20 for Inter 16px, half-leading with line-height", () => {
    const l = block("one two three four five six", "", "").layout(60);
    expect(l.lineCount).toBeGreaterThan(1);
    const lines = l.paragraphs[0]!.layout.lines;
    lines.forEach((line, i) => {
      expect(line.height).toBe(20);
      expect(line.top).toBe(i * 20);
      expect(line.baseline - line.top).toBe(16);
    });
    const tall = block("one", "line-height: 30px").layout(100).paragraphs[0]!.layout.lines[0]!;
    expect([tall.height, tall.baseline]).toEqual([30, 21]);
    expect(block("one").firstBaseline(100)).toBe(16);
  });

  it("aligns lines", () => {
    const at = (align: string): number => block("short", "", `text-align: ${align}`).layout(200).paragraphs[0]!.layout.lines[0]!.left;
    const w = block("short").maxContentWidth();
    expect(at("left")).toBe(0);
    expect(at("right")).toBeCloseTo(200 - w, 1);
    expect(at("center")).toBeCloseTo((200 - w) / 2, 1);
    expect(block("short", "", "direction: rtl").layout(200).paragraphs[0]!.layout.lines[0]!.left).toBeCloseTo(200 - w, 1);
  });

  it("truncates with an ellipsis, keeping the geometry of hidden text", () => {
    const b = block("The quick brown fox jumps over the lazy dog", "", "white-space: nowrap; overflow: hidden; text-overflow: ellipsis");
    const line = b.layout(120).paragraphs[0]!.layout.lines[0]!;
    expect(line.ellipsis).toBe(true);
    const drawnRight = Math.max(...line.runs.map((r) => r.right));
    expect(drawnRight).toBeLessThanOrEqual(120 + 0.01);
    // Every character still has a box (hidden ones extend past the width).
    expect(line.chars.length).toBe("The quick brown fox jumps over the lazy dog".length);
    expect(Math.max(...line.chars.map((c) => c.right))).toBeGreaterThan(120);
  });

  it("clamps lines and ends the last one with an ellipsis", () => {
    const text = "one two three four five six seven eight nine ten";
    const r = root();
    const b = new TextBlock(fonts, { paragraphs: [{ text, spans: [{ start: 0, end: text.length, style: r }], style: DEFAULT_PARAGRAPH_STYLE, root: r }], lineClamp: 2 });
    const l = b.layout(80);
    expect(l.lineCount).toBeGreaterThan(2);
    const lines = l.paragraphs[0]!.layout.lines;
    expect(lines.filter((x) => !x.hidden).length).toBe(2);
    expect(l.height).toBe(40);
    expect(lines[1]!.ellipsis).toBe(true);
  });

  it("stacks paragraphs with paragraph spacing", () => {
    const r = root();
    const para = (text: string) => ({ text, spans: [{ start: 0, end: text.length, style: r }], style: DEFAULT_PARAGRAPH_STYLE, root: r });
    const b = new TextBlock(fonts, { paragraphs: [para("first"), para("second")], paragraphSpacing: 12 });
    const l = b.layout(200);
    expect(l.paragraphs.map((p) => p.top)).toEqual([0, 32]);
    expect(l.height).toBe(52);
    expect(l.lastBaseline).toBe(48);
  });
});

describe("shaping across style and line boundaries (as Chromium does it)", () => {
  const charWidth = (b: TextBlock, width: number, index: number): number => {
    for (const line of b.layout(width).paragraphs[0]!.layout.lines) for (const c of line.chars) if (c.index === index) return c.right - c.left;
    return NaN;
  };

  it("kerns across a soft hyphen that does not break", () => {
    // Inter kerns "r" before "e"; an unused soft hyphen between them changes nothing.
    expect(charWidth(block("ter\u00ade"), 400, 2)).toBeCloseTo(charWidth(block("tere"), 400, 2), 6);
    expect(charWidth(block("tere"), 400, 2)).toBeLessThan(charWidth(block("ter"), 400, 2));
  });

  it("shapes a line that ends inside a word on its own (no kerning across the break)", () => {
    const b = block("oxoxoxoxoxox", "", "word-break: break-all");
    const one = b.layout(1000);
    const narrow = b.layout(40);
    expect(one.lineCount).toBe(1);
    expect(narrow.lineCount).toBeGreaterThan(1);
    const lines = narrow.paragraphs[0]!.layout.lines;
    const first = lines[0]!;
    const last = first.chars[first.chars.length - 1]!;
    // "o" kerns with the "x" after it, except where the line ends between them.
    const kerned = one.paragraphs[0]!.layout.lines[0]!.chars[last.index]!;
    expect(last.right - last.left).toBeGreaterThan(kerned.right - kerned.left + 0.1);
  });

  it("sizes each style run on a line in whole layout units (1/64 px, rounded up)", () => {
    const r = root();
    const bold = parseTextStyle("font-weight: 700", r);
    const text = "Regular bold";
    const b = new TextBlock(fonts, { paragraphs: [{ text, spans: [{ start: 0, end: 8, style: r }, { start: 8, end: 12, style: bold }], style: DEFAULT_PARAGRAPH_STYLE, root: r }] });
    const chars = b.layout(1000).paragraphs[0]!.layout.lines[0]!.chars;
    // The bold run starts on the layout-unit grid, after the regular run rounded up.
    expect((chars[8]!.left * 64) % 1).toBeCloseTo(0, 6);
    expect(chars[8]!.left).toBeGreaterThanOrEqual(chars[7]!.right);
    expect(chars[8]!.left - chars[7]!.right).toBeLessThan(1 / 64);
  });

  it("keeps paired brackets in the script run of their opening bracket", () => {
    // Brackets around Latin text after an Arabic word belong to the Arabic run: no kerning with "b".
    const t = "\u0639\u0631\u0628\u064a (b) end";
    const css = "font-family: Inter, 'Noto Sans Arabic'";
    const after = block(t, css);
    const alone = block("(b) end", css);
    const w = (b: TextBlock, i: number) => charWidth(b, 1000, i);
    expect(w(after, 6)).toBeCloseTo(charWidth(block("b", css), 1000, 0), 6);
    expect(w(alone, 1)).toBeLessThan(w(after, 6));
  });
});

describe("hit-testing", () => {
  it("maps points to caret positions and back", () => {
    const text = "hello world";
    const b = block(text);
    const l = b.layout(500);
    for (let i = 0; i <= text.length; i++) {
      const rect = b.caretRect(l, { paragraph: 0, index: i })!;
      expect(rect.height).toBe(20);
      // A point just right of the caret maps back to it.
      expect(b.hitTest(l, rect.x + 0.5, 10).index, `index ${i}`).toBe(i);
    }
    expect(b.hitTest(l, -50, 10).index).toBe(0);
    expect(b.hitTest(l, 1000, 10).index).toBe(text.length);
  });

  it("hit-tests RTL text from the right", () => {
    const text = "مرحبا بالعالم";
    const r = parseTextStyle("font: 16px 'Noto Sans Arabic'");
    const b = new TextBlock(fonts, { paragraphs: [{ text, spans: [{ start: 0, end: text.length, style: r }], style: parseParagraphStyle("direction: rtl"), root: r }] });
    const l = b.layout(300);
    const first = b.caretRect(l, { paragraph: 0, index: 0 })!;
    const last = b.caretRect(l, { paragraph: 0, index: text.length })!;
    expect(first.x).toBeGreaterThan(last.x);
    expect(first.x).toBeCloseTo(300, 0);
  });

  it("finds lines by y", () => {
    const b = block("one two three four five six");
    const l = b.layout(60);
    const second = b.lines(l)[1]!.line;
    const hit = b.hitTest(l, 0, second.top + 5);
    expect(hit.index).toBeGreaterThanOrEqual(b.shaped[0]!.prepared.source[second.start]!);
  });
});
