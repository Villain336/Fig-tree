import { expect, test } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { buildEngineTree, caseHtml, engineResult, pageHtml, type TextCase } from "../packages/text/conformance/case";
import { FONT_DIR, FONT_ORIGIN, fixtureRegistry } from "../packages/text/conformance/fonts";
import { allTextCases } from "../packages/text/conformance/index";
import { glyphScene } from "../packages/text/conformance/visual";
import { loadHarfBuzz } from "../packages/text/src/index";
import { backends, writePng, type Image } from "./pixels";

/**
 * Visual text conformance: every text conformance case drawn by our
 * renderer (glyph atlas, exact-area coverage) next to Chromium's own
 * rendering of the same HTML with the same fonts, compared pixel by pixel.
 * Text is black on white; box borders and backgrounds are hidden in the
 * reference so only text is compared. Per case we report, over the text
 * region (the bounding box of every pixel either image inked, plus 2 px):
 * the fraction of pixels whose channels differ by more than 25/255, the
 * mean absolute difference and the largest one. Chromium hints and gamma-
 * adjusts its glyph coverage, and positions glyphs on its own subpixel
 * grid, so edges differ by design; geometry is what the layout conformance
 * suite checks exactly. Summary: test-results/text-visual/summary.<backend>.json.
 */

const THRESHOLD = 25;
/** The target: at most this fraction of a case's text region differs by more than THRESHOLD. */
const MAX_FRACTION = 0.02;
/**
 * The gate. Cases between the target and the gate are dense glyphs (CJK,
 * Devanagari, bold) or tiny regions, where Chromium's gamma-adjusted
 * coverage (lighter thin strokes) differs from exact-area coverage on many
 * edge pixels; summary.json lists them.
 */
const LIMIT = 0.04;

const HIDE_BOXES = "<style>#vp, #vp * { background: none !important; border-color: transparent !important; outline: none !important; }</style>";

interface CaseStats {
  readonly name: string;
  readonly area: string;
  readonly region: number;
  readonly fractionOver: number;
  readonly meanDelta: number;
  readonly maxDelta: number;
}

function decodePng(buffer: Buffer): Image {
  const png = PNG.sync.read(buffer);
  return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
}

function compare(name: string, area: string, ours: Image, ref: Image): CaseStats {
  const w = Math.min(ours.width, ref.width);
  const h = Math.min(ours.height, ref.height);
  const at = (img: Image, x: number, y: number, c: number): number => img.data[(y * img.width + x) * 4 + c]!;
  // The text region: pixels either image inked.
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let ink = false;
      for (let c = 0; c < 3 && !ink; c++) ink = at(ours, x, y, c) < 247 || at(ref, x, y, c) < 247;
      if (!ink) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < 0) return { name, area, region: 0, fractionOver: 0, meanDelta: 0, maxDelta: 0 };
  minX = Math.max(0, minX - 2);
  minY = Math.max(0, minY - 2);
  maxX = Math.min(w - 1, maxX + 2);
  maxY = Math.min(h - 1, maxY + 2);
  let over = 0;
  let sum = 0;
  let max = 0;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      let worst = 0;
      for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(at(ours, x, y, c) - at(ref, x, y, c)));
      sum += worst;
      max = Math.max(max, worst);
      if (worst > THRESHOLD) over++;
    }
  }
  const region = (maxX - minX + 1) * (maxY - minY + 1);
  return { name, area, region, fractionOver: over / region, meanDelta: sum / region, maxDelta: max };
}

test.use({ viewport: { width: 1000, height: 800 }, deviceScaleFactor: 1 });

for (const backend of backends) {
  test(`text cases look like Chromium's rendering on ${backend}`, async ({ page, browser }) => {
    test.setTimeout(900_000);
    await loadHarfBuzz();
    const fonts = fixtureRegistry();
    const reference = await browser.newPage({ viewport: { width: 1000, height: 800 }, deviceScaleFactor: 1 });
    await reference.route(`${FONT_ORIGIN}**`, (route) => {
      const file = decodeURI(new URL(route.request().url()).pathname.slice(1));
      route.fulfill({ body: readFileSync(join(FONT_DIR, file)), contentType: file.endsWith(".woff2") ? "font/woff2" : "font/ttf", headers: { "access-control-allow-origin": "*" } });
    });
    await page.goto(`/text-render?renderer=${backend}`);
    await page.waitForFunction(() => window.__renderGlyphScene !== undefined, null, { timeout: 90_000 });

    const outDir = join(process.cwd(), "test-results", "text-visual", backend);
    mkdirSync(outDir, { recursive: true });
    const only = process.env.CONFORMANCE_FILTER;
    const stats: CaseStats[] = [];
    for (const c of allTextCases() as TextCase[]) {
      if (only && !c.name.includes(only)) continue;
      await reference.setContent(pageHtml(HIDE_BOXES + caseHtml(c)));
      await reference.evaluate(async () => {
        await Promise.all([...document.fonts].map((f) => f.load().catch(() => null)));
        await document.fonts.ready;
      });
      const ref = decodePng(await reference.locator("#vp").screenshot({ animations: "disabled", caret: "hide" }));
      const tree = buildEngineTree(c, fonts);
      engineResult(c, tree);
      const scene = glyphScene(c, tree);
      const r = await page.evaluate((s) => window.__renderGlyphScene!(s), scene);
      expect(r.backend).toBe(backend);
      const ours: Image = { width: r.width, height: r.height, data: new Uint8Array(Buffer.from(r.pixels, "base64")) };
      const s = compare(c.name, c.area, ours, ref);
      stats.push(s);
      if (s.fractionOver > MAX_FRACTION || only) {
        const file = c.name.replace(/[^a-z0-9-]+/gi, "_");
        writePng(join(outDir, `${file}.ours.png`), ours);
        writePng(join(outDir, `${file}.chromium.png`), ref);
      }
    }
    await reference.close();

    // Per-area summary.
    const areas = new Map<string, CaseStats[]>();
    for (const s of stats) areas.set(s.area, [...(areas.get(s.area) ?? []), s]);
    const summarize = (list: CaseStats[]) => ({
      cases: list.length,
      passing: list.filter((s) => s.fractionOver <= MAX_FRACTION).length,
      meanFractionOver: list.reduce((a, s) => a + s.fractionOver, 0) / list.length,
      worstFractionOver: Math.max(...list.map((s) => s.fractionOver)),
      meanDelta: list.reduce((a, s) => a + s.meanDelta, 0) / list.length,
      maxDelta: Math.max(...list.map((s) => s.maxDelta)),
    });
    const summary = {
      backend,
      threshold: THRESHOLD,
      maxFraction: MAX_FRACTION,
      all: summarize(stats),
      areas: Object.fromEntries([...areas].map(([a, l]) => [a, summarize(l)])),
      worst: [...stats].sort((a, b) => b.fractionOver - a.fractionOver).slice(0, 10),
    };
    writeFileSync(join(process.cwd(), "test-results", "text-visual", `summary.${backend}.json`), JSON.stringify(summary, null, 2));
    console.log(`text visual (${backend}):`, JSON.stringify(summary.all), "\nworst:", summary.worst.map((s) => `${s.name} ${(s.fractionOver * 100).toFixed(2)}%`).join(", "));
    const failing = stats.filter((s) => s.fractionOver > LIMIT).map((s) => `${s.name}: ${(s.fractionOver * 100).toFixed(2)}% of ${s.region} px differ by more than ${THRESHOLD}`);
    expect(failing).toEqual([]);
  });
}
