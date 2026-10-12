import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { FontRegistry, GoogleFontsError, GoogleFontsLoader, TextBlock, googleFamilyDirectory, loadHarfBuzz, parseParagraphStyle, parseTextStyle, parseTextProto } from "../src/index";

/**
 * The Google Fonts loader against a fake repository (no network): family
 * lookup across license directories, METADATA.pb parsing, license checks,
 * and faces that load their files on first use.
 */

const BASE = "https://fonts.example/";
const metadata = readFileSync(join(__dirname, "fixtures", "google", "inter-METADATA.pb"), "utf8");
const interFile = readFileSync(join(process.cwd(), "fixtures", "fonts", "inter", "Inter[opsz,wght].ttf"));

function fakeRepo(files: Record<string, string | Uint8Array>) {
  const requests: string[] = [];
  const fetch = async (url: string): Promise<Response> => {
    requests.push(url);
    const body = files[url.slice(BASE.length)];
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(typeof body === "string" ? body : new Uint8Array(body), { status: 200 });
  };
  return { fetch, requests };
}

beforeAll(async () => {
  await loadHarfBuzz();
});

describe("METADATA.pb", () => {
  it("parses protocol buffer text format: repeated fields, nested messages, escapes and comments", () => {
    const m = parseTextProto('# comment\nname: "A\\"b" \'c\'\nn: 2.5\nflag: TRUE\nsub { x: 1 sub { y: "\\303\\251" } }\nsub { x: 2 }\nlist: "p"\nlist: "q"');
    expect(m.get("name")).toEqual(['A"bc']);
    expect(m.get("n")).toEqual([2.5]);
    expect(m.get("flag")).toEqual(["TRUE"]);
    const subs = m.get("sub") as Map<string, unknown[]>[];
    expect(subs.map((s) => s.get("x"))).toEqual([[1], [2]]);
    expect((subs[0]!.get("sub") as Map<string, unknown[]>[])[0]!.get("y")).toEqual(["é"]);
    expect(m.get("list")).toEqual(["p", "q"]);
    expect(() => parseTextProto("a { b: 1")).toThrow(GoogleFontsError);
  });

  it("maps family names to repository directories", () => {
    expect(googleFamilyDirectory("Noto Sans Arabic")).toBe("notosansarabic");
    expect(googleFamilyDirectory("IBM Plex Sans")).toBe("ibmplexsans");
  });
});

describe("GoogleFontsLoader", () => {
  it("finds a family under its license directory and describes its faces", async () => {
    const repo = fakeRepo({ "ofl/inter/METADATA.pb": metadata });
    const loader = new GoogleFontsLoader({ fetch: repo.fetch, baseUrl: BASE });
    const family = await loader.family("Inter");
    expect(family).toMatchObject({ name: "Inter", license: "OFL", directory: "ofl/inter", category: "SANS_SERIF", designer: "Test étude", subsets: ["latin", "latin-ext"] });
    expect(family.fonts.map((f) => [f.style, f.weight, f.filename])).toEqual([
      ["normal", 400, "Inter[opsz,wght].ttf"],
      ["italic", 400, "Inter-Italic[opsz,wght].ttf"],
    ]);
    expect(family.axes).toEqual([{ tag: "opsz", min: 14, max: 32 }, { tag: "wght", min: 100, max: 900 }]);
    expect(loader.fileUrl(family, family.fonts[0]!)).toBe(`${BASE}ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf`);
    // Cached: a second lookup fetches nothing.
    await loader.family("inter");
    expect(repo.requests).toEqual([`${BASE}ofl/inter/METADATA.pb`]);
  });

  it("registers faces that download their file on first use, then lays text out with them", async () => {
    const repo = fakeRepo({ "ofl/inter/METADATA.pb": metadata, "ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf": interFile });
    const loader = new GoogleFontsLoader({ fetch: repo.fetch, baseUrl: BASE });
    const fonts = new FontRegistry();
    fonts.scriptFallback = false;
    const entries = await loader.register(fonts, "Inter");
    expect(entries.map((e) => [e.family, e.style, e.weight])).toEqual([
      ["Inter", "normal", [100, 900]],
      ["Inter", "italic", [100, 900]],
    ]);
    expect(repo.requests.length).toBe(1);
    const style = parseTextStyle("font: 700 16px Inter");
    const text = "Google Fonts";
    const block = new TextBlock(fonts, { paragraphs: [{ text, spans: [{ start: 0, end: text.length, style }], style: parseParagraphStyle(""), root: style }] });
    block.layout(500);
    expect(block.pendingFonts).toBe(true);
    await fonts.whenIdle();
    // Only the upright file was needed.
    expect(repo.requests).toEqual([`${BASE}ofl/inter/METADATA.pb`, `${BASE}ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf`]);
    const layout = block.layout(500);
    expect(block.pendingFonts).toBe(false);
    expect(layout.contentWidth).toBeGreaterThan(90);
  });

  it("looks in apache/ and ufl/ too, and accepts only OFL, Apache 2.0 and UFL", async () => {
    const ufl = metadata.replace('license: "OFL"', 'license: "UFL"');
    let loader = new GoogleFontsLoader({ fetch: fakeRepo({ "ufl/inter/METADATA.pb": ufl }).fetch, baseUrl: BASE });
    expect((await loader.family("Inter")).license).toBe("UFL");
    const proprietary = metadata.replace('license: "OFL"', 'license: "PROPRIETARY"');
    loader = new GoogleFontsLoader({ fetch: fakeRepo({ "ofl/inter/METADATA.pb": proprietary }).fetch, baseUrl: BASE });
    await expect(loader.family("Inter")).rejects.toThrow(/license PROPRIETARY is not accepted/);
    // A license that does not match the directory is refused as well.
    loader = new GoogleFontsLoader({ fetch: fakeRepo({ "ofl/inter/METADATA.pb": ufl }).fetch, baseUrl: BASE });
    await expect(loader.family("Inter")).rejects.toThrow(/says UFL but the family is in ofl\/inter/);
    loader = new GoogleFontsLoader({ fetch: fakeRepo({}).fetch, baseUrl: BASE });
    await expect(loader.family("Nope Sans")).rejects.toThrow(/no such family/);
  });

  it("refuses file names that leave the family directory, and oversized files", async () => {
    const evil = metadata.replace('filename: "Inter[opsz,wght].ttf"', 'filename: "../../x.ttf"');
    let loader = new GoogleFontsLoader({ fetch: fakeRepo({ "ofl/inter/METADATA.pb": evil }).fetch, baseUrl: BASE });
    await expect(loader.family("Inter")).rejects.toThrow(/unexpected font file name/);
    loader = new GoogleFontsLoader({ fetch: fakeRepo({ "ofl/inter/METADATA.pb": metadata, "ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf": interFile }).fetch, baseUrl: BASE, maxFontBytes: 1000 });
    const family = await loader.family("Inter");
    await expect(loader.fontFile(family, family.fonts[0]!)).rejects.toThrow(/over the 1000-byte limit/);
  });

  // Against the real repository: GOOGLE_FONTS_LIVE=1 npx vitest run packages/text/test/google-fonts.test.ts
  it.runIf(process.env.GOOGLE_FONTS_LIVE === "1")("loads a family from github.com/google/fonts", async () => {
    const loader = new GoogleFontsLoader();
    for (const name of ["Inter", "Roboto", "Ubuntu", "Noto Sans Arabic"]) {
      const family = await loader.family(name);
      expect(["OFL", "APACHE2", "UFL"]).toContain(family.license);
      expect(family.fonts.length).toBeGreaterThan(0);
    }
    const fonts = new FontRegistry();
    await loader.register(fonts, "Ubuntu");
    const entry = fonts.matchFamily("Ubuntu", { weight: 400, style: "normal", stretch: 100 })[0]!;
    await fonts.load(entry);
    expect(entry.state).toBe("loaded");
    expect(entry.typeface!.familyName).toBe("Ubuntu");
  }, 60_000);
});
