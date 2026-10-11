import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backends } from "./pixels";

/**
 * Pans and zooms the 10k-shape benchmark for 5 s per backend with real mouse
 * input and records frame intervals. Results go to test-results/bench.json;
 * set UPDATE_DOCS=1 to also refresh the screenshots in docs/img.
 */
const DURATION_MS = 5000;
const VIEWPORT = { width: 1280, height: 720 };

interface BenchResult {
  backend: string;
  frames: number;
  avgMs: number;
  p95Ms: number;
  maxMs: number;
  cpuMedianMs: number;
  uploadedBytes: number;
  gpu: Record<string, number> | null;
}

const results: BenchResult[] = [];

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

test.use({ viewport: VIEWPORT });

for (const backend of backends) {
  test(`pan and zoom 10k shapes (${backend})`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await page.goto(`/bench?renderer=${backend}`);
    await page.waitForFunction(() => window.__bench !== undefined, null, { timeout: 120_000 });
    expect(await page.evaluate(() => window.__bench!.backend)).toBe(backend);
    // Wait until the first frames are on screen (the HUD shows frame stats).
    const hudShowsFrames = (): Promise<unknown> =>
      page.waitForFunction(() => /\d fps/.test(document.querySelector("pre")?.textContent ?? ""), null, { timeout: 300_000 });
    await hudShowsFrames();
    const docsImg = join(__dirname, "..", "docs", "img");
    if (process.env.UPDATE_DOCS === "1") {
      mkdirSync(docsImg, { recursive: true });
      await page.screenshot({ path: join(docsImg, `bench-${backend}.png`), timeout: 120_000 });
    }

    const readGpu = (): Promise<Record<string, number> | null> =>
      page.evaluate(() => {
        const text = document.querySelector("pre")?.textContent ?? "";
        const m = /bin ([\d.]+) · tiles ([\d.]+) · coverage ([\d.]+) · composite ([\d.]+)/.exec(text);
        return m ? { bin: Number(m[1]), tiles: Number(m[2]), coverage: Number(m[3]), composite: Number(m[4]) } : null;
      });
    const cx = VIEWPORT.width / 2;
    const cy = VIEWPORT.height / 2;
    await page.mouse.move(cx, cy);

    // Panning at a fixed zoom must not upload anything: geometry lives in
    // local space and every shape is already resident at the initial view.
    await page.evaluate(() => window.__bench!.startRecording());
    for (const dx of [120, -120]) {
      await page.mouse.down();
      await page.mouse.move(cx + dx, cy + dx / 3, { steps: 3 });
      await page.mouse.up();
      await page.mouse.move(cx, cy);
    }
    await page.waitForTimeout(3000);
    const pan = await page.evaluate(() => window.__bench!.stopRecording());
    expect(pan.cpuMs.length, "frames rendered while panning").toBeGreaterThan(0);
    expect(pan.uploadedBytes, "bytes uploaded while panning").toBe(0);

    await page.evaluate(() => window.__bench!.startRecording());
    const start = Date.now();
    let step = 0;
    while (Date.now() - start < DURATION_MS) {
      // Alternate a drag-pan with a zoom in or out about the cursor.
      const angle = step * 0.9;
      await page.mouse.down();
      await page.mouse.move(cx + Math.cos(angle) * 140, cy + Math.sin(angle) * 90, { steps: 4 });
      await page.mouse.up();
      await page.mouse.move(cx, cy);
      await page.mouse.wheel(0, step % 4 < 2 ? -240 : 240);
      await page.waitForTimeout(50);
      step++;
    }
    const rec = await page.evaluate(() => window.__bench!.stopRecording());
    const mixedGpu = await readGpu();
    if (process.env.UPDATE_DOCS === "1") {
      // A close-up shows edge quality, gradients and strokes at 4x zoom.
      await page.evaluate(() => window.__bench!.startRecording());
      for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -300);
      await page.waitForTimeout(500);
      await page.evaluate(() => window.__bench!.stopRecording());
      await page.waitForTimeout(8000);
      await hudShowsFrames();
      await page.screenshot({ path: join(docsImg, `bench-${backend}-zoomed.png`), timeout: 120_000 });
    }
    const intervals = rec.frameIntervals;
    expect(intervals.length, "frames rendered while recording").toBeGreaterThan(1);
    expect(errors).toEqual([]);
    const result: BenchResult = {
      backend,
      frames: intervals.length,
      avgMs: intervals.reduce((s, v) => s + v, 0) / intervals.length,
      p95Ms: percentile(intervals, 95),
      maxMs: Math.max(...intervals),
      cpuMedianMs: percentile(rec.cpuMs, 50),
      uploadedBytes: rec.uploadedBytes,
      gpu: mixedGpu,
    };
    results.push(result);
    console.log(
      `[bench] ${backend}: ${result.frames} frames, avg ${result.avgMs.toFixed(1)} ms, p95 ${result.p95Ms.toFixed(1)} ms, ` +
        `cpu median ${result.cpuMedianMs.toFixed(1)} ms, uploaded ${result.uploadedBytes} B` +
        (mixedGpu ? `, gpu ${JSON.stringify(mixedGpu)}` : ""),
    );

    // Sustained panning at a fixed zoom: the tile cache only rasterizes
    // tiles that scroll into view.
    await page.mouse.move(cx, cy);
    await page.evaluate(() => window.__bench!.startRecording());
    const panStart = Date.now();
    let dir = 1;
    while (Date.now() - panStart < DURATION_MS) {
      await page.mouse.down();
      await page.mouse.move(cx + dir * 160, cy + dir * 40, { steps: 8 });
      await page.mouse.up();
      await page.mouse.move(cx, cy);
      dir = -dir;
    }
    const panRec = await page.evaluate(() => window.__bench!.stopRecording());
    const panResult: BenchResult = {
      backend: `${backend} (pan only)`,
      frames: panRec.frameIntervals.length,
      avgMs: panRec.frameIntervals.reduce((s, v) => s + v, 0) / Math.max(1, panRec.frameIntervals.length),
      p95Ms: percentile(panRec.frameIntervals, 95),
      maxMs: Math.max(0, ...panRec.frameIntervals),
      cpuMedianMs: percentile(panRec.cpuMs, 50),
      uploadedBytes: panRec.uploadedBytes,
      gpu: await readGpu(),
    };
    results.push(panResult);
    console.log(
      `[bench] ${panResult.backend}: ${panResult.frames} frames, avg ${panResult.avgMs.toFixed(1)} ms, ` +
        `p95 ${panResult.p95Ms.toFixed(1)} ms, uploaded ${panResult.uploadedBytes} B`,
    );
  });
}

test.afterAll(() => {
  const dir = join(__dirname, "..", "test-results");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "bench.json"), JSON.stringify(results, null, 2));
});
