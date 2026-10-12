import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backends } from "./pixels";

/**
 * A 10,000-node document (`/?doc=grid10k`) in the editor: time to apply a
 * single-property update through the command API (validation, Yjs
 * transaction, change event, bridge recompile of the one node), and the CPU
 * of the next frame (draw-list update, frame planning, encoding), both at
 * the overview (all 10k nodes visible) and zoomed in on one frame.
 * Results go to test-results/document-bench.json.
 */

interface Sample {
  update: number;
  frameCpu: number;
}

interface Result {
  backend: string;
  view: string;
  edit: string;
  updateMedianMs: number;
  updateMaxMs: number;
  frameCpuMedianMs: number;
  loadMs: number;
}

const results: Result[] = [];

const median = (v: number[]): number => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]!;

test.use({ viewport: { width: 1280, height: 720 } });

for (const backend of backends) {
  test(`single-property updates on a 10k-node document (${backend})`, async ({ page }) => {
    const t0 = Date.now();
    await page.goto(`/?renderer=${backend}&doc=grid10k`);
    await page.waitForFunction(() => window.__figtree !== undefined, null, { timeout: 300_000 });
    const loadMs = Date.now() - t0;
    expect(await page.evaluate(() => window.__figtree!.doc.tree.size)).toBe(10_001);
    await page.evaluate(() => window.__figtree!.finish());

    for (const view of ["overview", "zoomed"] as const) {
      if (view === "zoomed") await page.evaluate(() => window.__figtree!.setView(1.5, -1200, -800));
      for (const edit of ["fill", "x", "width"] as const) {
        // Overview frames rasterize all 10k nodes in software, so they get fewer samples.
        const runs = view === "overview" ? 9 : 21;
        const samples: Sample[] = await page.evaluate(async ([edit, runs]) => {
          const f = window.__figtree!;
          f.renderFrame();
          await f.finish();
          const out: { update: number; frameCpu: number }[] = [];
          for (let k = 0; k < runs; k++) {
            const props =
              edit === "fill" ? { fills: [{ type: "solid", color: { r: (k % 10) / 10, g: 0.2, b: 0.4, a: 1 } }] }
              : edit === "x" ? { x: 100 + k }
              : { width: 40 + k };
            const start = performance.now();
            const r = f.apply([{ type: "updateProps", id: "n23-42", props }]);
            const update = performance.now() - start;
            if ("error" in r) throw new Error(r.error);
            if (f.bridge.lastCompiled !== 1) throw new Error(`compiled ${f.bridge.lastCompiled} nodes`);
            const stats = f.renderFrame();
            await f.finish();
            out.push({ update, frameCpu: stats.cpuMs });
          }
          return out;
        }, [edit, runs] as const);
        const result: Result = {
          backend,
          view,
          edit,
          updateMedianMs: median(samples.map((s) => s.update)),
          updateMaxMs: Math.max(...samples.map((s) => s.update)),
          frameCpuMedianMs: median(samples.map((s) => s.frameCpu)),
          loadMs,
        };
        results.push(result);
        console.log(
          `[document-bench] ${backend} ${view} ${edit}: update median ${result.updateMedianMs.toFixed(2)} ms (max ${result.updateMaxMs.toFixed(2)}), ` +
            `next frame cpu median ${result.frameCpuMedianMs.toFixed(1)} ms, page load ${loadMs} ms`,
        );
        expect(result.updateMedianMs, "applying a single-property update").toBeLessThan(16);
      }
    }
  });
}

interface LayoutResult {
  backend: string;
  edit: string;
  updateMedianMs: number;
  updateMaxMs: number;
  compiledMedian: number;
  frameCpuMedianMs: number;
  loadMs: number;
}

const layoutResults: LayoutResult[] = [];

for (const backend of backends) {
  test(`layout edits on a 10k-node auto-layout document (${backend})`, async ({ page }) => {
    const t0 = Date.now();
    await page.goto(`/?renderer=${backend}&doc=layout10k`);
    await page.waitForFunction(() => window.__figtree !== undefined, null, { timeout: 300_000 });
    const loadMs = Date.now() - t0;
    expect(await page.evaluate(() => window.__figtree!.doc.tree.size)).toBe(10_001);
    await page.evaluate(() => window.__figtree!.setView(1.5, -1200, -800));
    for (const edit of ["child width", "frame gap", "frame padding"] as const) {
      const samples: { update: number; compiled: number; frameCpu: number }[] = await page.evaluate(async (edit) => {
        const f = window.__figtree!;
        f.renderFrame();
        await f.finish();
        const out: { update: number; compiled: number; frameCpu: number }[] = [];
        for (let k = 0; k < 21; k++) {
          const frame = `f${23 + (k % 2)}`;
          const command =
            edit === "child width" ? { type: "updateProps", id: `n${23 + (k % 2)}-42`, props: { width: 30 + k } }
            : edit === "frame gap" ? { type: "updateProps", id: frame, props: { columnGap: 4 + k, rowGap: 4 + (k % 5) } }
            : { type: "updateProps", id: frame, props: { padding: { top: 10, right: 10, bottom: 10, left: 10 + k } } };
          const start = performance.now();
          const r = f.apply([command]);
          const update = performance.now() - start;
          if ("error" in r) throw new Error(r.error);
          const compiled = f.bridge.lastCompiled;
          const stats = f.renderFrame();
          await f.finish();
          out.push({ update, compiled, frameCpu: stats.cpuMs });
        }
        return out;
      }, edit);
      const result: LayoutResult = {
        backend,
        edit,
        updateMedianMs: median(samples.map((s) => s.update)),
        updateMaxMs: Math.max(...samples.map((s) => s.update)),
        compiledMedian: median(samples.map((s) => s.compiled)),
        frameCpuMedianMs: median(samples.map((s) => s.frameCpu)),
        loadMs,
      };
      layoutResults.push(result);
      console.log(
        `[layout-bench] ${backend} ${edit}: update (command + layout + bridge) median ${result.updateMedianMs.toFixed(2)} ms (max ${result.updateMaxMs.toFixed(2)}), ` +
          `nodes recompiled median ${result.compiledMedian}, next frame cpu median ${result.frameCpuMedianMs.toFixed(1)} ms, page load ${loadMs} ms`,
      );
      // An edit relays out one frame: at most its 100 nodes are recompiled.
      expect(result.compiledMedian).toBeLessThanOrEqual(100);
      expect(result.updateMedianMs, "applying a layout-affecting update").toBeLessThan(16);
    }
  });
}

interface TextResult {
  backend: string;
  edit: string;
  updateMedianMs: number;
  updateMaxMs: number;
  compiledMedian: number;
  frameCpuMedianMs: number;
  glyphsRasterizedMedian: number;
}

const textResults: TextResult[] = [];
const panResults: { backend: string; frames: number; frameCpuMedianMs: number; frameCpuMaxMs: number; glyphsRasterized: number; firstSweepGlyphs: number; loadMs: number; overviewFrameCpuMs: number; overviewGlyphs: number }[] = [];

for (const backend of backends) {
  test(`text edits and panning on a 10k-node document with 2,000 text nodes (${backend})`, async ({ page }) => {
    const t0 = Date.now();
    await page.goto(`/?renderer=${backend}&doc=text10k`);
    await page.waitForFunction(() => window.__figtree !== undefined, null, { timeout: 300_000 });
    await page.evaluate(() => window.__figtree!.fontsReady());
    const loadMs = Date.now() - t0;
    expect(await page.evaluate(() => window.__figtree!.doc.tree.size)).toBe(10_001);
    // The whole document in view (a new zoom level, so the frame renders directly and rasterizes its glyph sizes).
    const overview = await page.evaluate(async () => {
      const f = window.__figtree!;
      f.setView(0.125, 10, 10);
      const s = f.renderFrame();
      await f.finish();
      return { cpu: s.cpuMs, glyphs: s.glyphsRasterized };
    });
    await page.evaluate(() => window.__figtree!.setView(1.5, -1200, -800));

    for (const edit of ["paragraph", "label"] as const) {
      const samples: { update: number; compiled: number; frameCpu: number; glyphs: number }[] = await page.evaluate(async (edit) => {
        const f = window.__figtree!;
        f.renderFrame();
        await f.finish();
        const out: { update: number; compiled: number; frameCpu: number; glyphs: number }[] = [];
        for (let k = 0; k < 21; k++) {
          // Cards 23, 24, 33 and 34 are in view.
          const card = [23, 24, 33, 34][k % 4]!;
          const id = edit === "paragraph" ? `t${card}-${k % 13}` : `l${card}-${k % 6}`;
          const start = performance.now();
          const r = f.apply([{ type: "insertText", id, index: 0, text: k % 2 ? "More words here, " : "A" }]);
          const update = performance.now() - start;
          if ("error" in r) throw new Error(r.error);
          const compiled = f.bridge.lastCompiled;
          const stats = f.renderFrame();
          await f.finish();
          out.push({ update, compiled, frameCpu: stats.cpuMs, glyphs: stats.glyphsRasterized });
        }
        return out;
      }, edit);
      const result: TextResult = {
        backend,
        edit,
        updateMedianMs: median(samples.map((s) => s.update)),
        updateMaxMs: Math.max(...samples.map((s) => s.update)),
        compiledMedian: median(samples.map((s) => s.compiled)),
        frameCpuMedianMs: median(samples.map((s) => s.frameCpu)),
        glyphsRasterizedMedian: median(samples.map((s) => s.glyphs)),
      };
      textResults.push(result);
      console.log(
        `[text-bench] ${backend} ${edit} edit: update (command + text layout + layout + bridge) median ${result.updateMedianMs.toFixed(2)} ms (max ${result.updateMaxMs.toFixed(2)}), ` +
          `nodes recompiled median ${result.compiledMedian}, next frame cpu median ${result.frameCpuMedianMs.toFixed(1)} ms, glyphs rasterized median ${result.glyphsRasterizedMedian}`,
      );
      expect(result.updateMedianMs, "applying a text edit").toBeLessThan(16);
    }

    // Steady-state panning at a fixed zoom: a second sweep over the same ground rasterizes no glyphs.
    const pan = await page.evaluate(async () => {
      const f = window.__figtree!;
      const sweep = async () => {
        const out: { cpu: number; glyphs: number }[] = [];
        for (let i = 0; i < 40; i++) {
          const dx = i < 20 ? i * 13 : (40 - i) * 13;
          f.setView(1.5, -1200 - dx, -800 - Math.round(dx / 2));
          const s = f.renderFrame();
          await f.finish();
          out.push({ cpu: s.cpuMs, glyphs: s.glyphsRasterized });
        }
        return out;
      };
      const first = await sweep();
      const second = await sweep();
      return { first, second };
    });
    const cpu = pan.second.map((s) => s.cpu);
    const result = {
      backend,
      frames: pan.second.length,
      frameCpuMedianMs: median(cpu),
      frameCpuMaxMs: Math.max(...cpu),
      glyphsRasterized: pan.second.reduce((a, s) => a + s.glyphs, 0),
      firstSweepGlyphs: pan.first.reduce((a, s) => a + s.glyphs, 0),
      loadMs,
      overviewFrameCpuMs: overview.cpu,
      overviewGlyphs: overview.glyphs,
    };
    panResults.push(result);
    console.log(
      `[text-bench] ${backend} pan: ${result.frames} frames, frame cpu median ${result.frameCpuMedianMs.toFixed(1)} ms (max ${result.frameCpuMaxMs.toFixed(1)}), glyphs rasterized ${result.glyphsRasterized} ` +
        `(first sweep ${result.firstSweepGlyphs}); overview frame (direct, all 2,000 texts) cpu ${overview.cpu.toFixed(1)} ms, ${overview.glyphs} glyphs rasterized; page load with fonts ${loadMs} ms`,
    );
    expect(result.glyphsRasterized, "steady-state panning rasterizes no glyphs").toBe(0);
  });
}

test.afterAll(() => {
  const dir = join(__dirname, "..", "test-results");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "document-bench.json"), JSON.stringify({ updates: results, layout: layoutResults, text: textResults, pan: panResults }, null, 2));
});
