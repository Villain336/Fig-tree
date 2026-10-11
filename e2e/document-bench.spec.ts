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

test.afterAll(() => {
  const dir = join(__dirname, "..", "test-results");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "document-bench.json"), JSON.stringify(results, null, 2));
});
