import { readFileSync } from "node:fs";
import { join } from "node:path";
import { zlibSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { decodeWoff, detectFormat, FontRegistry, loadHarfBuzz, NORMAL_REQUEST, Typeface, fallbackFamilyFor, type FontRequest } from "../src/index";

/**
 * Font loading (TTF, WOFF, WOFF2, variable fonts), table reading and the
 * CSS Fonts 4 §5.2 font matching algorithm.
 */

const FONTS = join(process.cwd(), "fixtures", "fonts");
const bytes = (file: string): Uint8Array => new Uint8Array(readFileSync(join(FONTS, file)));

beforeAll(async () => {
  await loadHarfBuzz();
});

describe("font files", () => {
  it("detects formats", () => {
    expect(detectFormat(bytes("inter/Inter[opsz,wght].ttf"))).toBe("truetype");
    expect(detectFormat(bytes("inter/Inter-latin.woff2"))).toBe("woff2");
    expect(detectFormat(new Uint8Array([1, 2]))).toBe("unknown");
  });

  it("reads names, metrics and variation axes", () => {
    const inter = new Typeface(bytes("inter/Inter[opsz,wght].ttf"));
    expect(inter.familyName).toBe("Inter");
    expect(inter.unitsPerEm).toBe(2048);
    expect(inter.axes.map((a) => a.tag).sort()).toEqual(["opsz", "wght"]);
    expect(inter.axis("wght")).toMatchObject({ min: 100, default: 400, max: 900 });
    expect(inter.info.useTypoMetrics).toBe(true);
    expect(inter.instance().metrics).toMatchObject({ ascender: 1984, descender: 494, lineGap: 0 });
    const sc = new Typeface(bytes("noto-sans-sc/NotoSansSC-Regular.ttf"));
    // Not USE_TYPO_METRICS: hhea ascent and descent.
    expect(sc.instance().metrics).toMatchObject({ ascender: 1160, descender: 288 });
    const condensed = new Typeface(bytes("noto-sans/NotoSans-Condensed.ttf"));
    expect(condensed.stretch).toBe(75);
    expect(condensed.isVariable).toBe(false);
    expect(new Typeface(bytes("noto-sans/NotoSans-BoldItalic.ttf"))).toMatchObject({ style: "italic", weight: 700 });
  });

  it("decodes WOFF2 (Google Fonts' Inter) to a font with the same advances and outlines", () => {
    const woff2 = new Typeface(bytes("inter/Inter-latin.woff2"));
    const ttf = new Typeface(bytes("inter/Inter[opsz,wght].ttf"));
    expect(woff2.familyName).toBe("Inter");
    // Google Fonts serves this file with the wght axis only (opsz pinned at its default).
    expect(woff2.axes.map((a) => a.tag)).toEqual(["wght"]);
    const a = woff2.instance();
    const b = ttf.instance();
    for (const ch of "Hamburgefonstiv0123") {
      const ga = a.glyph(ch.codePointAt(0)!);
      const gb = b.glyph(ch.codePointAt(0)!);
      expect(ga, ch).toBeGreaterThan(0);
      expect(a.advance(ga), ch).toBe(b.advance(gb));
      const pa = a.path(ga).bounds();
      const pb = b.path(gb).bounds();
      expect([pa.minX, pa.minY, pa.maxX, pa.maxY], ch).toEqual([pb.minX, pb.minY, pb.maxX, pb.maxY]);
    }
    // Variations apply to the decoded glyf/gvar data too.
    const bold = woff2.instance({ wght: 700 });
    expect(bold.advance(bold.glyph(0x6d))).toBeGreaterThan(a.advance(a.glyph(0x6d)));
  });

  it("decodes WOFF 1.0", () => {
    // Build a WOFF 1.0 file from the TTF (zlib-compressed tables), then decode it.
    const ttf = bytes("noto-sans/NotoSans-Regular.ttf");
    const v = new DataView(ttf.buffer, ttf.byteOffset, ttf.byteLength);
    const n = v.getUint16(4);
    const tables: { tag: number; data: Uint8Array; orig: Uint8Array; checksum: number }[] = [];
    for (let i = 0; i < n; i++) {
      const p = 12 + i * 16;
      const offset = v.getUint32(p + 8);
      const length = v.getUint32(p + 12);
      const orig = ttf.subarray(offset, offset + length);
      const comp = zlibSync(orig);
      tables.push({ tag: v.getUint32(p), data: comp.length < orig.length ? comp : orig, orig, checksum: v.getUint32(p + 4) });
    }
    let size = 44 + n * 20;
    for (const t of tables) size += (t.data.length + 3) & ~3;
    const woff = new Uint8Array(size);
    const w = new DataView(woff.buffer);
    w.setUint32(0, 0x774f4646);
    w.setUint32(4, v.getUint32(0));
    w.setUint32(8, size);
    w.setUint16(12, n);
    w.setUint32(16, ttf.length);
    let at = 44 + n * 20;
    tables.forEach((t, i) => {
      const p = 44 + i * 20;
      w.setUint32(p, t.tag);
      w.setUint32(p + 4, at);
      w.setUint32(p + 8, t.data.length);
      w.setUint32(p + 12, t.orig.length);
      w.setUint32(p + 16, t.checksum);
      woff.set(t.data, at);
      at += (t.data.length + 3) & ~3;
    });
    const sfnt = decodeWoff(woff);
    const decoded = new Typeface(sfnt);
    const original = new Typeface(ttf);
    expect(decoded.familyName).toBe(original.familyName);
    const g = decoded.instance().glyph(0x61);
    expect(decoded.instance().advance(g)).toBe(original.instance().advance(original.instance().glyph(0x61)));
  });

  it("rejects malformed files with a clear error", () => {
    expect(() => new Typeface(new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0]))).toThrow(/WOFF2/);
    expect(() => new Typeface(new Uint8Array(64))).toThrow();
    const ttf = bytes("noto-sans/NotoSans-Regular.ttf").slice(0, 200);
    expect(() => new Typeface(ttf)).toThrow(/past the end|truncated/);
  });

  it("instances variable fonts and caches instances", () => {
    const tf = new Typeface(bytes("noto-sans/NotoSans[wdth,wght].ttf"));
    const a = tf.instance({ wght: 700, wdth: 75 });
    expect(tf.instance({ wdth: 75, wght: 700 })).toBe(a);
    // Out-of-range values clamp to the axis.
    expect(tf.instance({ wght: 5000 }).coords).toEqual({ wght: 900 });
    const narrow = tf.instance({ wdth: 62.5 });
    const g = narrow.glyph(0x6d);
    expect(narrow.advance(g)).toBeLessThan(tf.instance().advance(g));
  });
});

describe("CSS font matching (CSS Fonts 4 §5.2)", () => {
  const registry = (): FontRegistry => {
    const reg = new FontRegistry();
    for (const [file, weight, style, stretch] of [
      ["NotoSans-Light.ttf", 300, "normal", 100],
      ["NotoSans-Regular.ttf", 400, "normal", 100],
      ["NotoSans-Bold.ttf", 700, "normal", 100],
      ["NotoSans-Black.ttf", 900, "normal", 100],
      ["NotoSans-Italic.ttf", 400, "italic", 100],
      ["NotoSans-BoldItalic.ttf", 700, "italic", 100],
      ["NotoSans-Condensed.ttf", 400, "normal", 75],
    ] as const) {
      reg.addTypeface(new Typeface(bytes(`noto-sans/${file}`)), { family: "Static", weight, style, stretch });
    }
    return reg;
  };
  const pick = (reg: FontRegistry, request: Partial<FontRequest>): string => {
    const r = { ...NORMAL_REQUEST, ...request };
    const faces = reg.matchFamily("static", r);
    return faces.map((f) => `${f.weight[0]}${f.style === "italic" ? "i" : ""}${f.stretch[0] !== 100 ? `@${f.stretch[0]}` : ""}`).join(",");
  };

  it("matches weights by the CSS rules (400–500 look heavier up to 500 first)", () => {
    const reg = registry();
    expect(pick(reg, { weight: 400 })).toBe("400");
    expect(pick(reg, { weight: 450 })).toBe("400"); // no face in 450–500: lighter first
    expect(pick(reg, { weight: 500 })).toBe("400");
    expect(pick(reg, { weight: 350 })).toBe("300"); // below 400: lighter first
    expect(pick(reg, { weight: 100 })).toBe("300"); // nothing lighter: heavier
    expect(pick(reg, { weight: 600 })).toBe("700"); // above 500: heavier first
    expect(pick(reg, { weight: 950 })).toBe("900");
  });

  it("matches style, falling back from italic to oblique to normal", () => {
    const reg = registry();
    expect(pick(reg, { style: "italic" })).toBe("400i");
    expect(pick(reg, { style: "italic", weight: 800 })).toBe("700i");
    expect(pick(reg, { style: "oblique" })).toBe("400i");
  });

  it("matches stretch before style and weight", () => {
    const reg = registry();
    expect(pick(reg, { stretch: 75 })).toBe("400@75");
    expect(pick(reg, { stretch: 50 })).toBe("400@75"); // nothing narrower: the closest wider
    expect(pick(reg, { stretch: 80, weight: 700 })).toBe("400@75"); // narrower first below 100%
    expect(pick(reg, { stretch: 125 })).toBe("400"); // nothing wider: the closest narrower
  });

  it("synthesizes bold and oblique only when the face lacks them", () => {
    const reg = registry();
    const cond = reg.fontFor(0x61, { families: ["Static"], request: { weight: 800, style: "normal", stretch: 75 } })!;
    expect(cond.syntheticBold).toBe(true);
    const bold = reg.fontFor(0x61, { families: ["Static"], request: { weight: 800, style: "normal", stretch: 100 } })!;
    expect(bold.syntheticBold).toBe(false);
    expect(bold.typeface.weight).toBe(900);
  });

  it("falls back per character through the family list, then the script table", () => {
    const reg = new FontRegistry();
    reg.addTypeface(new Typeface(bytes("inter/Inter[opsz,wght].ttf")), { family: "Inter" });
    reg.addTypeface(new Typeface(bytes("noto-sans-arabic/NotoSansArabic[wdth,wght].ttf")));
    const opts = { families: ["Inter"], request: NORMAL_REQUEST };
    expect(reg.fontFor(0x41, opts)!.typeface.familyName).toBe("Inter");
    // Arabic is not in Inter: the script fallback table names Noto Sans Arabic.
    expect(fallbackFamilyFor(0x0627)).toBe("Noto Sans Arabic");
    expect(reg.fontFor(0x0627, opts)!.typeface.familyName).toBe("Noto Sans Arabic");
    reg.scriptFallback = false;
    expect(reg.fontFor(0x0627, opts)).toBeNull();
    expect(fallbackFamilyFor(0x0915)).toBe("Noto Sans Devanagari");
    expect(fallbackFamilyFor(0x4e2d)).toBe("Noto Sans SC");
  });

  it("loads faces on demand and reports them", async () => {
    const reg = new FontRegistry();
    let loads = 0;
    const entry = reg.add({ family: "Lazy", weight: [100, 900] }, async () => {
      loads++;
      return bytes("inter/Inter[opsz,wght].ttf");
    });
    const loaded: string[] = [];
    reg.onLoad((e) => loaded.push(e.family));
    const pending = { value: false };
    expect(reg.fontFor(0x41, { families: ["Lazy"], request: NORMAL_REQUEST }, pending)).toBeNull();
    expect(pending.value).toBe(true);
    expect(entry.state).toBe("loading");
    const version = reg.version;
    await reg.whenIdle();
    expect(entry.state).toBe("loaded");
    expect(loaded).toEqual(["Lazy"]);
    expect(reg.version).toBeGreaterThan(version);
    expect(reg.fontFor(0x41, { families: ["Lazy"], request: NORMAL_REQUEST })!.typeface.familyName).toBe("Inter");
    expect(loads).toBe(1);
  });

  it("selects faces of a composite family by unicode-range", () => {
    const reg = new FontRegistry();
    reg.addTypeface(new Typeface(bytes("noto-sans-arabic/NotoSansArabic[wdth,wght].ttf")), { family: "Mixed", unicodeRange: [[0x0600, 0x06ff]] });
    reg.addTypeface(new Typeface(bytes("inter/Inter[opsz,wght].ttf")), { family: "Mixed", unicodeRange: [[0x0000, 0x00ff]] });
    const opts = { families: ["Mixed"], request: NORMAL_REQUEST };
    expect(reg.fontFor(0x41, opts)!.typeface.familyName).toBe("Inter");
    expect(reg.fontFor(0x0628, opts)!.typeface.familyName).toBe("Noto Sans Arabic");
  });
});
