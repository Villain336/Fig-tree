import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { caseJson, effectCases, type EffectCase } from "./effects-cases";
import { backends, writePng, type Image } from "./pixels";

/**
 * Effects against Chromium: every case (e2e/effects-cases.ts) is a document
 * whose effects, blend modes, gradients, image modes and masks have an
 * exact CSS form. Chromium renders the HTML our CSS export produces; our
 * renderer renders the document through the bridge, on both backends. Per
 * case we report, over the whole viewport, the mean absolute difference of
 * the worst channel and the fraction of pixels differing by more than
 * 25/255. Threshold: mean ≤ 1.5/255 and at most 1% of pixels over 25/255.
 * Cases marked `known` are expected to miss it and say why; they are
 * reported, not failed. Summary: test-results/effects-reference/summary.<backend>.json.
 */

const MEAN_LIMIT = 1.5;
const OVER_LIMIT = 0.01;
const THRESHOLD = 25;

interface Stats {
  readonly name: string;
  readonly area: string;
  readonly meanDelta: number;
  readonly fractionOver: number;
  readonly maxDelta: number;
  readonly pass: boolean;
  readonly known?: string;
}

function decodePng(buffer: Buffer): Image {
  const png = PNG.sync.read(buffer);
  return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
}

/** Our pixels are premultiplied over the page color (opaque here), so they compare directly. */
function compare(c: EffectCase, ours: Image, ref: Image): Stats {
  let sum = 0;
  let max = 0;
  let over = 0;
  const n = c.width * c.height;
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      const i = (y * ours.width + x) * 4;
      const j = (y * ref.width + x) * 4;
      let worst = 0;
      for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(ours.data[i + k]! - ref.data[j + k]!));
      sum += worst;
      max = Math.max(max, worst);
      if (worst > THRESHOLD) over++;
    }
  }
  const meanDelta = sum / n;
  const fractionOver = over / n;
  return { name: c.name, area: c.area, meanDelta, fractionOver, maxDelta: max, pass: meanDelta <= MEAN_LIMIT && fractionOver <= OVER_LIMIT, ...(c.known ? { known: c.known } : {}) };
}

test.use({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });

for (const backend of backends) {
  test(`effects match Chromium's rendering of their CSS on ${backend}`, async ({ page, browser }) => {
    test.setTimeout(900_000);
    const reference = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
    await page.goto(`/doc-render?renderer=${backend}`);
    await page.waitForFunction(() => window.__renderDocument !== undefined, null, { timeout: 90_000 });
    const outDir = join(process.cwd(), "test-results", "effects-reference", backend);
    mkdirSync(outDir, { recursive: true });
    const only = process.env.EFFECTS_FILTER;
    const stats: Stats[] = [];
    for (const c of effectCases()) {
      if (only && !c.name.includes(only)) continue;
      await reference.setContent(c.html);
      // Background and mask images decode asynchronously: wait for every one, then for two frames.
      await reference.evaluate(async () => {
        const urls = new Set<string>();
        for (const el of document.querySelectorAll<HTMLElement>("[style]")) {
          for (const m of el.getAttribute("style")!.matchAll(/url\("([^"]+)"\)/g)) urls.add(m[1]!);
        }
        await Promise.all([...urls].map((u) => { const img = new Image(); img.src = u; return img.decode().catch(() => {}); }));
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      });
      const ref = decodePng(await reference.locator("#vp").screenshot({ animations: "disabled" }));
      const assets: Record<string, string> = {};
      for (const [id, bytes] of Object.entries(c.assets)) assets[id] = Buffer.from(bytes).toString("base64");
      const result = await page.evaluate((req) => window.__renderDocument!(req), { json: caseJson(c), assets, width: c.width, height: c.height });
      expect(result.backend).toBe(backend);
      expect(result.unsupported, `${c.name}: nothing unsupported`).toEqual({});
      const ours: Image = { width: result.width, height: result.height, data: new Uint8Array(Buffer.from(result.pixels, "base64")) };
      const s = compare(c, ours, ref);
      stats.push(s);
      if (!s.pass || process.env.EFFECTS_IMAGES) {
        writePng(join(outDir, `${c.name}.ours.png`), ours);
        writePng(join(outDir, `${c.name}.chromium.png`), ref);
        writeFileSync(join(outDir, `${c.name}.html`), c.html);
      }
    }
    await reference.close();
    writeFileSync(join(process.cwd(), "test-results", "effects-reference", `summary.${backend}.json`), JSON.stringify(stats, null, 2));
    const fmt = (s: Stats) => `${s.name.padEnd(30)} mean ${s.meanDelta.toFixed(2).padStart(6)}  >25: ${(s.fractionOver * 100).toFixed(2).padStart(6)}%  max ${String(s.maxDelta).padStart(3)}${s.pass ? "" : s.known ? "  (known)" : "  FAIL"}`;
    console.log(`[effects ${backend}]\n${stats.map(fmt).join("\n")}`);
    const failing = stats.filter((s) => !s.pass && !s.known);
    expect(failing.map(fmt), "cases over the threshold").toEqual([]);
    // Known failures that start passing should lose their mark.
    expect(stats.filter((s) => s.pass && s.known).map((s) => s.name), "known failures that now pass").toEqual([]);
  });
}
