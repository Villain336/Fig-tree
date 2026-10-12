import { readFileSync } from "node:fs";
import { join } from "node:path";
import bidiFactory from "bidi-js";
import { describe, expect, it } from "vitest";
import { firstStrongDirection, graphemeBoundaries, lineBreaks, MANDATORY_BREAK, NO_BREAK } from "../src/index";
import { lineBreakClass, script } from "../src/unicode/props";

/**
 * Unicode segmentation against the UCD test files (subsets in
 * test/fixtures): UAX #14 line breaking, UAX #29 grapheme clusters, and
 * the UAX #9 bidi levels from bidi-js. Plus Chromium's tailoring of line
 * breaking for ASCII punctuation, which `docs/conformance.md` describes.
 */

const fixture = (name: string): string[] =>
  readFileSync(join(__dirname, "fixtures", name), "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#"));

/** Parses "× 0041 ÷ 0020 × …" into the text and the expected break flags after each code point. */
function parseBreakTest(line: string): { text: string; expected: number[] } {
  const toks = line.trim().split(/\s+/);
  let text = "";
  const expected: number[] = [];
  for (let i = 1; i < toks.length; i += 2) {
    text += String.fromCodePoint(parseInt(toks[i]!, 16));
    expected.push(toks[i + 1] === "÷" ? 1 : 0);
  }
  return { text, expected };
}

describe("UAX #14 line breaking", () => {
  const lines = fixture("LineBreakTest-subset.txt");

  it(`matches ${lines.length} cases of LineBreakTest.txt (plain UAX #14, strict line-break)`, () => {
    const failures: string[] = [];
    for (const line of lines) {
      const { text, expected } = parseBreakTest(line);
      const b = lineBreaks(text, { lineBreak: "strict", chromiumAscii: false });
      const got: number[] = [];
      let off = 0;
      for (const ch of text) {
        off += ch.length;
        got.push(b[off] === NO_BREAK ? 0 : 1);
      }
      if (got.join() !== expected.join()) failures.push(line);
    }
    expect(failures.slice(0, 5)).toEqual([]);
    expect(lines.length).toBeGreaterThan(3000);
  });

  it("forbids breaks inside words and allows them after spaces", () => {
    const b = lineBreaks("hello world");
    expect(b[1]).toBe(NO_BREAK);
    expect(b[6]).not.toBe(NO_BREAK);
    expect(b[11]).toBe(MANDATORY_BREAK);
  });

  it("applies CSS word-break", () => {
    const all = lineBreaks("abc def", { wordBreak: "break-all" });
    expect([all[1], all[2]]).not.toContain(NO_BREAK);
    const keep = lineBreaks("中文排版", { wordBreak: "keep-all" });
    expect([keep[1], keep[2], keep[3]]).toEqual([NO_BREAK, NO_BREAK, NO_BREAK]);
    const normal = lineBreaks("中文排版");
    expect([normal[1], normal[2], normal[3]]).not.toContain(NO_BREAK);
  });

  it("follows Chromium for ASCII punctuation pairs", () => {
    const breaksIn = (s: string): number[] => {
      const b = lineBreaks(s);
      return [...s].map((_, i) => i).filter((i) => i > 0 && b[i] !== NO_BREAK);
    };
    // No break after a slash, an exclamation mark or a closing brace (UAX #14 allows them).
    expect(breaksIn("a/b/c")).toEqual([]);
    expect(breaksIn("a!b")).toEqual([]);
    expect(breaksIn("a}b")).toEqual([]);
    // A hyphen after a letter or digit may break before a digit; a leading minus sign may not.
    expect(breaksIn("a-1")).toEqual([2]);
    expect(breaksIn("1-2")).toEqual([2]);
    expect(breaksIn("-1")).toEqual([]);
    // Breaks before an opening bracket after these symbols.
    expect(breaksIn("a=(b")).toEqual([2]);
    // Plain UAX #14 keeps the original decisions.
    const plain = lineBreaks("a/b", { chromiumAscii: false });
    expect(plain[2]).not.toBe(NO_BREAK);
  });

  it("resolves classes from the UCD", () => {
    expect(lineBreakClass(0x20)).toBe("SP");
    expect(lineBreakClass(0x4e2d)).toBe("ID");
    expect(lineBreakClass(0x0e01)).toBe("SA");
    expect(lineBreakClass(0x1f600)).toBe("ID");
    expect(script(0x0627)).toBe("Arab");
    expect(script(0x0915)).toBe("Deva");
    expect(script(0x41)).toBe("Latn");
  });
});

describe("UAX #29 grapheme clusters", () => {
  const lines = fixture("GraphemeBreakTest.txt");

  it(`matches all ${lines.length} cases of GraphemeBreakTest.txt`, () => {
    const failures: string[] = [];
    for (const line of lines) {
      const { text, expected } = parseBreakTest(line);
      const b = graphemeBoundaries(text);
      const got: number[] = [];
      let off = 0;
      for (const ch of text) {
        off += ch.length;
        got.push(b[off]!);
      }
      if (got.join() !== expected.join()) failures.push(line);
    }
    expect(failures).toEqual([]);
  });

  it("keeps Devanagari conjuncts (GB9c), emoji ZWJ sequences and flags together", () => {
    const count = (s: string): number => graphemeBoundaries(s).reduce((n, v, i) => n + (i < s.length ? v : 0), 0);
    expect(count("क्ष")).toBe(1);
    expect(count("👩‍👩‍👧")).toBe(1);
    expect(count("🇫🇷🇩🇪")).toBe(2);
    expect(count("é")).toBe(1);
  });
});

describe("UAX #9 bidi levels (bidi-js)", () => {
  const lines = fixture("BidiCharacterTest-subset.txt");
  const bidi = bidiFactory();

  it(`matches ${lines.length} cases of BidiCharacterTest.txt`, () => {
    const failures: string[] = [];
    for (const line of lines) {
      const [cps, dir, paraLevel, levels] = line.split(";");
      const text = cps!.split(" ").map((h) => String.fromCodePoint(parseInt(h, 16))).join("");
      const r = bidi.getEmbeddingLevels(text, dir === "0" ? "ltr" : dir === "1" ? "rtl" : undefined);
      const expected = levels!.split(" ");
      let ok = String(r.paragraphs[0]!.level) === paraLevel;
      let u = 0;
      for (const e of expected) {
        const cp = text.codePointAt(u)!;
        if (e !== "x" && String(r.levels[u]) !== e) ok = false;
        u += cp > 0xffff ? 2 : 1;
      }
      if (!ok) failures.push(line);
    }
    expect(failures).toEqual([]);
  });
});

describe("first strong direction (HTML dir=auto)", () => {
  it("takes the first L, R or AL character, skipping isolates", () => {
    expect(firstStrongDirection("Hello")).toBe("ltr");
    expect(firstStrongDirection("123 مرحبا Hello")).toBe("rtl");
    expect(firstStrongDirection("«שלום» world")).toBe("rtl");
    expect(firstStrongDirection("\u2067مرحبا\u2069 Hello")).toBe("ltr");
    expect(firstStrongDirection("123 ... !")).toBeNull();
    expect(firstStrongDirection("")).toBeNull();
  });
});
