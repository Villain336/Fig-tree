import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backends } from "./pixels";

/**
 * Input-to-frame latency (CPU) of editing on 10,000-node documents: real
 * mouse and keyboard input through Playwright, measured from each input
 * event's timestamp to the end of the CPU work of the frame that shows it
 * (event handling, command, Yjs transaction, layout, bridge recompile,
 * draw-list update, frame planning and encoding). GPU time is not included:
 * this machine renders with SwiftShader, whose rasterization dominates the
 * wall clock (also recorded). Also records how many nodes each
 * frame recompiled, which must stay small: editing one node must not
 * recompile unrelated ones. Results: test-results/editing-bench.json.
 */

interface Sample {
  wall: number;
  latency: number;
  input: number;
  frameCpu: number;
  compiled: number;
  /** Font faces that arrived before the frame: every text is laid out again then, which is not the edit's doing. */
  fonts: readonly string[];
}

interface Result {
  backend: string;
  scenario: string;
  frames: number;
  latencyMedianMs: number;
  latencyP95Ms: number;
  inputMedianMs: number;
  frameCpuMedianMs: number;
  wallMedianMs: number;
  maxCompiled: number;
  /** Frames that followed a font arrival (excluded from maxCompiled). */
  fontFrames: string[];
}

const results: Result[] = [];
const pct = (v: number[], p: number): number => [...v].sort((a, b) => a - b)[Math.min(v.length - 1, Math.floor(v.length * p))]!;

test.use({ viewport: { width: 1280, height: 800 } });

async function open(page: Page, backend: string, doc: string, view: [number, number, number]): Promise<void> {
  await page.goto(`/?renderer=${backend}&doc=${doc}`);
  await page.waitForFunction(() => window.__figtree !== undefined, null, { timeout: 300_000 });
  await page.evaluate(() => window.__figtree!.fontsReady());
  await page.evaluate(([s, x, y]) => window.__figtree!.setView(s!, x!, y!), view);
  await page.evaluate(() => window.__figtree!.finish());
  await page.waitForTimeout(500);
}

async function at(page: Page, x: number, y: number): Promise<[number, number]> {
  const box = (await page.getByTestId("canvas").boundingBox())!;
  const c = await page.evaluate(([wx, wy]) => window.__figtree!.toCanvas(wx!, wy!), [x, y]);
  return [box.x + c.x, box.y + c.y];
}

/**
 * Moves the mouse in `steps` steps, waiting after each for the frame that
 * shows it (SwiftShader takes long to rasterize, so each step gets its own
 * frame instead of many moves coalescing into one).
 */
async function slowMove(page: Page, from: [number, number], to: [number, number], steps: number): Promise<void> {
  for (let i = 1; i <= steps; i++) {
    const before = await page.evaluate(() => window.__figtree!.frames());
    await page.mouse.move(from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps);
    await withTimeout(page.evaluate((n) => window.__figtree!.afterFrame(n), before));
  }
}

/** A frame that does not come within 20 s means the input did nothing: fail instead of hanging. */
async function withTimeout(p: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([p, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("no frame within 20 s after an input")), 20_000)))]);
  clearTimeout(timer);
}

function record(backend: string, scenario: string, samples: Sample[]): Result {
  const r: Result = {
    backend,
    scenario,
    frames: samples.length,
    latencyMedianMs: pct(samples.map((s) => s.latency), 0.5),
    latencyP95Ms: pct(samples.map((s) => s.latency), 0.95),
    inputMedianMs: pct(samples.map((s) => s.input), 0.5),
    frameCpuMedianMs: pct(samples.map((s) => s.frameCpu), 0.5),
    wallMedianMs: pct(samples.map((s) => s.wall), 0.5),
    maxCompiled: Math.max(...samples.filter((s) => s.fonts.length === 0).map((s) => s.compiled)),
    fontFrames: samples.filter((s) => s.fonts.length > 0).map((s) => `${s.compiled} nodes after ${s.fonts.join(", ")}`),
  };
  results.push(r);
  console.log(
    `[editing-bench] ${backend} ${scenario}: ${r.frames} frames, input-to-frame CPU median ${r.latencyMedianMs.toFixed(1)} ms, p95 ${r.latencyP95Ms.toFixed(1)} ms ` +
      `(input handling ${r.inputMedianMs.toFixed(1)} ms + frame ${r.frameCpuMedianMs.toFixed(1)} ms), wall clock median ${r.wallMedianMs.toFixed(0)} ms, at most ${r.maxCompiled} nodes recompiled per frame${r.fontFrames.length ? ` (font arrivals: ${r.fontFrames.join("; ")})` : ""}`,
  );
  return r;
}

for (const backend of backends) {
  test(`drag and resize on a 10k-node document (${backend})`, async ({ page }) => {
    await open(page, backend, "grid10k", [1.5, -1500, -400]);
    expect(await page.evaluate(() => window.__figtree!.doc.tree.size)).toBe(10_001);
    // n12-11: frame 12 at (1200, 400), shape at (70, 47) in it, 50×30.
    const start = await at(page, 1295, 462);
    await page.mouse.move(...start);
    await page.mouse.down();
    await page.evaluate(() => window.__figtree!.takeSamples());
    await slowMove(page, start, [start[0] + 150, start[1] + 90], 30);
    const drag = await page.evaluate(() => window.__figtree!.takeSamples());
    await page.mouse.up();
    expect(await page.evaluate(() => window.__figtree!.selection())).toEqual(["n12-11"]);
    const moved = record(backend, "drag one shape", drag);
    // A move recompiles the moved node only.
    expect(moved.maxCompiled).toBeLessThanOrEqual(2);
    expect(moved.frames).toBeGreaterThan(20);
    // Wall-clock latency includes waiting for SwiftShader to finish the previous frame.

    // Resize it with its corner handle.
    const se = await page.evaluate(() => window.__figtree!.anchors().find((a) => a.id === "canvas.handle.resize.se")!.rect!);
    const h: [number, number] = [se.x + se.width / 2, se.y + se.height / 2];
    await page.mouse.move(...h);
    await page.mouse.down();
    await page.evaluate(() => window.__figtree!.takeSamples());
    await slowMove(page, h, [h[0] + 120, h[1] + 60], 30);
    const resize = await page.evaluate(() => window.__figtree!.takeSamples());
    await page.mouse.up();
    const resized = record(backend, "resize one shape", resize);
    expect(resized.maxCompiled).toBeLessThanOrEqual(2);
    expect(await page.evaluate(() => window.__figtree!.doc.get("n12-11", "width"))).toBeGreaterThan(100);
  });

  test(`type into text on a 10k-node document with 2,000 texts (${backend})`, async ({ page }) => {
    await open(page, backend, "text10k", [1, -1200, -400]);
    // Paragraph t12-1 of card 12 (at 1200, 400).
    const b = (await page.evaluate(() => {
      const f = window.__figtree!;
      return f.editor.geometry.bounds("t12-1");
    })) as { x: number; y: number; width: number; height: number };
    await page.mouse.dblclick(...(await at(page, b.x + b.width - 4, b.y + 6)));
    await page.mouse.dblclick(...(await at(page, b.x + b.width - 4, b.y + 6)));
    await expect.poll(() => page.evaluate(() => window.__figtree!.editor.session?.nodeId ?? null)).toBe("t12-1");
    const beforeEnd = await page.evaluate(() => window.__figtree!.frames());
    await page.keyboard.press("End");
    await withTimeout(page.evaluate((n) => window.__figtree!.afterFrame(n), beforeEnd));
    await page.evaluate(() => window.__figtree!.takeSamples());
    const typed = " The quick brown fox jumps over the lazy dog.";
    for (const ch of typed) {
      const before = await page.evaluate(() => window.__figtree!.frames());
      await page.keyboard.type(ch);
      await withTimeout(page.evaluate((n) => window.__figtree!.afterFrame(n), before));
    }
    const samples = await page.evaluate(() => window.__figtree!.takeSamples());
    expect(await page.evaluate(() => window.__figtree!.doc.text("t12-1").content as string)).toContain("lazy dog.");
    const r = record(backend, "type into a paragraph", samples);
    // Typing recompiles the text and the nodes its new height moves in its card, not the document.
    expect(r.maxCompiled).toBeLessThan(120);
  });
}

test.afterAll(() => {
  const dir = join(__dirname, "..", "test-results");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "editing-bench.json"), JSON.stringify(results, null, 2));
});
