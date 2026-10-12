import { FontRegistry, loadHarfBuzz, type FaceDescriptor } from "@fig-tree/text";

/**
 * The editor's fonts: the OFL families bundled in fixtures/fonts (served at
 * /fonts), registered as `@font-face`-like faces that load on first use.
 * `sans-serif` (the default family of new text) resolves to Inter; scripts
 * Inter lacks fall back to the matching Noto family.
 */
const FACES: (FaceDescriptor & { file: string })[] = [
  { family: "Inter", file: "inter/Inter[opsz,wght].ttf", weight: [100, 900] },
  { family: "Noto Sans", file: "noto-sans/NotoSans[wdth,wght].ttf", weight: [100, 900], stretch: [62.5, 100] },
  { family: "Noto Sans", file: "noto-sans/NotoSans-Italic[wdth,wght].ttf", weight: [100, 900], stretch: [62.5, 100], style: "italic" },
  { family: "Noto Sans Arabic", file: "noto-sans-arabic/NotoSansArabic[wdth,wght].ttf", weight: [100, 900], stretch: [62.5, 100] },
  { family: "Noto Sans Devanagari", file: "noto-sans-devanagari/NotoSansDevanagari[wdth,wght].ttf", weight: [100, 900], stretch: [62.5, 100] },
  { family: "Noto Sans SC", file: "noto-sans-sc/NotoSansSC-Regular.ttf", weight: 400 },
];

export async function editorFonts(): Promise<FontRegistry> {
  await loadHarfBuzz();
  const registry = new FontRegistry();
  for (const { file, ...descriptor } of FACES) {
    registry.add(descriptor, async () => {
      const res = await fetch(`/fonts/${file.split("/").map(encodeURIComponent).join("/")}`);
      if (!res.ok) throw new Error(`font ${file}: HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    });
  }
  registry.generics.set("sans-serif", ["Inter"]);
  registry.generics.set("system-ui", ["Inter"]);
  registry.lastResort = ["Inter"];
  return registry;
}
