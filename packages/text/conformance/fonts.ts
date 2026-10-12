import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FontRegistry, Typeface, type FaceDescriptor } from "../src/index";

/**
 * The vendored test fonts (fixtures/fonts, SIL OFL 1.1) as `@font-face`
 * rules for Chromium and as faces of a {@link FontRegistry} for the engine,
 * with identical descriptors.
 */

export interface FixtureFace extends FaceDescriptor {
  /** Path under fixtures/fonts. */
  readonly file: string;
}

export const FIXTURE_FACES: readonly FixtureFace[] = [
  { family: "Inter", file: "inter/Inter[opsz,wght].ttf", weight: [100, 900] },
  { family: "Noto Sans", file: "noto-sans/NotoSans[wdth,wght].ttf", weight: [100, 900], stretch: [62.5, 100] },
  { family: "Noto Sans", file: "noto-sans/NotoSans-Italic[wdth,wght].ttf", weight: [100, 900], stretch: [62.5, 100], style: "italic" },
  { family: "Noto Static", file: "noto-sans/NotoSans-Light.ttf", weight: 300 },
  { family: "Noto Static", file: "noto-sans/NotoSans-Regular.ttf", weight: 400 },
  { family: "Noto Static", file: "noto-sans/NotoSans-Bold.ttf", weight: 700 },
  { family: "Noto Static", file: "noto-sans/NotoSans-Black.ttf", weight: 900 },
  { family: "Noto Static", file: "noto-sans/NotoSans-Italic.ttf", weight: 400, style: "italic" },
  { family: "Noto Static", file: "noto-sans/NotoSans-BoldItalic.ttf", weight: 700, style: "italic" },
  { family: "Noto Static", file: "noto-sans/NotoSans-Condensed.ttf", weight: 400, stretch: 75 },
  { family: "Noto Sans Arabic", file: "noto-sans-arabic/NotoSansArabic[wdth,wght].ttf", weight: [100, 900], stretch: [62.5, 100] },
  { family: "Noto Sans Devanagari", file: "noto-sans-devanagari/NotoSansDevanagari[wdth,wght].ttf", weight: [100, 900], stretch: [62.5, 100] },
  { family: "Noto Sans SC", file: "noto-sans-sc/NotoSansSC-Regular.ttf", weight: 400 },
  // A WOFF2 file as served by Google Fonts, under its own family name.
  { family: "Inter Woff2", file: "inter/Inter-latin.woff2", weight: [100, 900] },
];

/** Origin the browser loads fixture fonts from (served by a Playwright route). */
export const FONT_ORIGIN = "https://fonts.test/";

export const FONT_DIR = join(process.cwd(), "fixtures", "fonts");

function range(v: number | readonly [number, number] | undefined, unit = ""): string {
  if (v === undefined) return "";
  return typeof v === "number" ? `${v}${unit}` : `${v[0]}${unit} ${v[1]}${unit}`;
}

/** `@font-face` rules for every fixture face. */
export function fontFaceCss(): string {
  return FIXTURE_FACES.map((f) => {
    const parts = [`font-family:"${f.family}"`, `src:url("${FONT_ORIGIN}${encodeURI(f.file)}")`];
    if (f.weight !== undefined) parts.push(`font-weight:${range(f.weight)}`);
    if (f.style) parts.push(`font-style:${f.style}`);
    if (f.stretch !== undefined) parts.push(`font-stretch:${range(f.stretch, "%")}`);
    parts.push("font-display:block");
    return `@font-face{${parts.join(";")}}`;
  }).join("\n");
}

let digest: string | null = null;

/** A hash of every fixture font file, so fixtures go stale when a font changes. */
export function fontDigest(): string {
  if (digest) return digest;
  let h = 0x811c9dc5;
  for (const f of FIXTURE_FACES) {
    const bytes = readFileSync(join(FONT_DIR, f.file));
    for (let i = 0; i < bytes.length; i += 7) h = Math.imul(h ^ bytes[i]!, 0x01000193) >>> 0;
    h = Math.imul(h ^ bytes.length, 0x01000193) >>> 0;
  }
  digest = h.toString(16).padStart(8, "0");
  return digest;
}

const typefaces = new Map<string, Typeface>();

/**
 * A registry with every fixture face loaded, and no script fallback: like
 * the conformance pages, text only uses the families its CSS lists.
 */
export function fixtureRegistry(): FontRegistry {
  const reg = new FontRegistry();
  reg.scriptFallback = false;
  for (const f of FIXTURE_FACES) {
    let tf = typefaces.get(f.file);
    if (!tf) {
      tf = new Typeface(new Uint8Array(readFileSync(join(FONT_DIR, f.file))));
      typefaces.set(f.file, tf);
    }
    const { file: _file, ...descriptor } = f;
    void _file;
    reg.addTypeface(tf, descriptor);
  }
  return reg;
}
