import { expect, test, type Page } from "@playwright/test";
import { backends, diff, expectGolden, pixel, type BackendName, type Image } from "./pixels";

/**
 * The editor at `/`: the sample document (apps/editor/app/sample-document.ts)
 * rendered through the document bridge, on both backends. Coordinates below
 * are world coordinates from the sample; the page maps them to canvas pixels.
 */

async function openEditor(page: Page, backend: BackendName): Promise<void> {
  await page.goto(`/?renderer=${backend}`);
  await page.waitForFunction(() => window.__figtree !== undefined, null, { timeout: 90_000 });
  expect(await page.evaluate(() => window.__figtree!.backend)).toBe(backend);
}

async function frame(page: Page): Promise<Image> {
  const r = await page.evaluate(() => window.__figtree!.renderPixels());
  return { width: r.width, height: r.height, data: new Uint8Array(Buffer.from(r.pixels, "base64")) };
}

/** Pixel at a world point. */
async function worldPixel(page: Page, img: Image, x: number, y: number): Promise<number[]> {
  const c = await page.evaluate(([wx, wy]) => window.__figtree!.toCanvas(wx!, wy!), [x, y]);
  return pixel(img, Math.floor(c.x), Math.floor(c.y)).slice(0, 3);
}

function expectColor(got: number[], want: readonly number[], label: string, tolerance = 2): void {
  for (let k = 0; k < 3; k++) expect(Math.abs(got[k]! - want[k]!), `${label}: got ${got}, want ${want}`).toBeLessThanOrEqual(tolerance);
}

// Solid-filled points of the sample (world coordinates) and their colors.
const SOLIDS: [string, number, number, readonly number[]][] = [
  ["page background", 440, 300, [238, 238, 234]],
  ["card body", 200, 150, [255, 255, 255]],
  ["progress bar (group at 85% over white)", 124, 223, [52, 196, 148]],
  ["hexagon", 548, 108, [244, 63, 94]],
  ["star", 660, 118, [250, 204, 21]],
  ["donut", 806, 108, [139, 92, 246]],
  ["vector region", 730, 255, [34, 197, 94]],
  ["panel", 60, 545, [24, 24, 27]],
  ["clip frame fill", 600, 390, [255, 237, 213]],
  ["clipped hill", 560, 515, [22, 163, 74]],
  // Laid out by the layout engine (see apps/editor/app/sample-document.ts).
  ["toolbar avatar (flex row, padding 12)", 68, 648, [249, 115, 22]],
  ["toolbar search (fills the remaining width)", 200, 648, [228, 228, 231]],
  ["toolbar button (centered on the cross axis)", 352, 648, [24, 24, 27]],
  ["list row 1 (column, stretched)", 220, 732, [14, 165, 233]],
  ["list row 2", 220, 787, [74, 165, 183]],
  ["list row 3", 220, 852, [134, 165, 133]],
  ["grid cell spanning two columns", 602, 689, [139, 92, 246]],
  ["grid cell spanning two rows", 774, 750, [236, 72, 153]],
  ["grid cell a", 545, 811, [34, 197, 94]],
  ["grid cell b", 660, 811, [234, 179, 8]],
  ["grid column gap", 602.67, 811, [255, 255, 255]],
];

for (const backend of backends) {
  test.describe(`editor on ${backend}`, () => {
    test("renders the sample document", async ({ page }) => {
      await openEditor(page, backend);
      const img = await frame(page);
      for (const [label, x, y, color] of SOLIDS) expectColor(await worldPixel(page, img, x, y), color, label);
      // The avatar spills past the card's rounded corner: clipped to the page background.
      expectColor(await worldPixel(page, img, 395, 30), [238, 238, 234], "avatar clipped by the card");
      // The card header's linear gradient: from (0, 0) to the far corner of its 360x104 box,
      // violet (91, 33, 182) to blue (37, 99, 235), interpolated in sRGB.
      const header = (lx: number, ly: number): number[] => {
        const t = (lx * 360 + ly * 104) / (360 * 360 + 104 * 104);
        return [91 + (37 - 91) * t, 33 + (99 - 33) * t, 182 + (235 - 182) * t];
      };
      for (const [lx, ly] of [[10, 10], [120, 50], [250, 90]] as const) {
        expectColor(await worldPixel(page, img, 40 + lx, 40 + ly), header(lx, ly), `header gradient at ${lx},${ly}`, 4);
      }
      expectGolden(`editor.${backend}`, img);
      await expect(page.getByTestId("status")).toContainText(`${backend} · 46 nodes`);
    });

    test("updates the pixels when a property is edited through the command API", async ({ page }) => {
      await openEditor(page, backend);
      let img = await frame(page);
      expectColor(await worldPixel(page, img, 548, 108), [244, 63, 94], "hexagon before");

      // Paint.
      let r = await page.evaluate(() => window.__figtree!.apply([{ type: "updateProps", id: "hexagon", props: { fills: [{ type: "solid", color: { r: 0, g: 0, b: 1, a: 1 } }] } }]));
      expect(r).toEqual({ affected: ["hexagon"] });
      expect(await page.evaluate(() => window.__figtree!.bridge.lastCompiled)).toBe(1);
      img = await frame(page);
      expectColor(await worldPixel(page, img, 548, 108), [0, 0, 255], "hexagon recolored");

      // Geometry: move it 200px down; its old place shows the frame's paint stack again.
      await page.evaluate(() => window.__figtree!.apply([{ type: "updateProps", id: "hexagon", props: { y: 124 } }]));
      img = await frame(page);
      expectColor(await worldPixel(page, img, 548, 248), [0, 0, 255], "hexagon moved");
      const where = await worldPixel(page, img, 548, 108);
      expect(where[2]!).toBeGreaterThan(where[0]!); // light blue tint of the frame's gradient fill

      // Structure: delete the clip frame's sun; the frame's own fill shows through.
      await page.evaluate(() => window.__figtree!.apply([{ type: "delete", ids: ["sun"] }]));
      img = await frame(page);
      expectColor(await worldPixel(page, img, 790, 440), [255, 237, 213], "sun deleted");

      // Invalid commands are rejected and change nothing.
      r = await page.evaluate(() => window.__figtree!.apply([{ type: "updateProps", id: "star", props: { opacity: 4 } }]));
      expect("error" in r && r.error).toMatch(/opacity: Too big/);
    });

    test("lays out auto-layout and grid frames, and reflows gap, padding and alignment edits", async ({ page }) => {
      await openEditor(page, backend);
      const box = (id: string) => page.evaluate((i) => window.__figtree!.box(i), id);
      expect(await box("tb-search")).toEqual({ x: 52, y: 12, width: 216, height: 32 });
      expect(await box("list")).toEqual({ x: 40, y: 700, width: 360, height: 194 });
      const tall = (await box("cell-tall"))!;
      expect([tall.x, tall.y, tall.width, tall.height].map((v) => Math.round(v * 100) / 100)).toEqual([241.33, 12, 106.67, 236]);
      let img = await frame(page);
      expectColor(await worldPixel(page, img, 595, 811), [34, 197, 94], "grid cell a before the gap edit");
      expectColor(await worldPixel(page, img, 60, 648), [249, 115, 22], "avatar before the padding edit");
      expectColor(await worldPixel(page, img, 352, 634), [255, 255, 255], "above the centered button");

      // Gap: three 96 px columns with 24 px gutters; cell a now ends at x = 588.
      let r = await page.evaluate(() => window.__figtree!.apply([{ type: "updateProps", id: "gallery", props: { columnGap: 24 } }]));
      expect(r).toEqual({ affected: ["gallery"] });
      // The frame plus the cells that moved or resized, nothing else.
      expect(await page.evaluate(() => window.__figtree!.bridge.lastCompiled)).toBe(5);
      img = await frame(page);
      expectColor(await worldPixel(page, img, 595, 811), [255, 255, 255], "grid gap after the gap edit");
      expectColor(await worldPixel(page, img, 560, 811), [34, 197, 94], "grid cell a after the gap edit");
      expectColor(await worldPixel(page, img, 660, 811), [234, 179, 8], "grid cell b after the gap edit");

      // Padding: the avatar moves 28 px right.
      r = await page.evaluate(() => window.__figtree!.apply([{ type: "updateProps", id: "toolbar", props: { padding: { top: 12, right: 12, bottom: 12, left: 40 } } }]));
      expect("affected" in r).toBe(true);
      img = await frame(page);
      expectColor(await worldPixel(page, img, 60, 648), [255, 255, 255], "toolbar padding after the edit");
      expectColor(await worldPixel(page, img, 96, 648), [249, 115, 22], "avatar after the padding edit");

      // Alignment: flex-start moves the 24 px button to the top of the content box.
      await page.evaluate(() => window.__figtree!.apply([{ type: "updateProps", id: "toolbar", props: { alignItems: "flex-start" } }]));
      img = await frame(page);
      expectColor(await worldPixel(page, img, 352, 634), [24, 24, 27], "button after align-items: flex-start");
      expect((await box("tb-button"))!.y).toBe(12);
    });
  });
}

test("backends agree on the sample document", async ({ page }) => {
  await openEditor(page, "webgpu");
  const gpu = await frame(page);
  await openEditor(page, "webgl2");
  const gl = await frame(page);
  const d = diff(gpu, gl, 24);
  // Differences are confined to anti-aliased edges (analytic coverage vs 4x MSAA).
  expect(d.meanDelta).toBeLessThan(1.5);
  expect(d.fractionOver).toBeLessThan(0.02);
});

test("lists layers and inspects a selected node's CSS", async ({ page }) => {
  await openEditor(page, "webgl2");
  const layers = page.getByTestId("layers");
  await expect(layers.locator("button[data-node]")).toHaveCount(45);
  // The text node is stored but not rendered yet, and says so.
  await expect(layers.locator('button[data-node="title"] [aria-label="has unsupported features"]')).toHaveCount(1);
  await layers.locator('button[data-node="shapes"]').click();
  await expect(page.getByTestId("css")).toContainText("left: 480px;");
  await expect(page.getByTestId("css")).toContainText("overflow: hidden;");
  // Clicking the canvas hit-tests through the bridge.
  const c = await page.evaluate(() => window.__figtree!.toCanvas(660, 118));
  const box = (await page.getByTestId("canvas").boundingBox())!;
  await page.mouse.click(box.x + c.x, box.y + c.y);
  await expect(layers.locator('button[data-node="star"]')).toHaveClass(/bg-sky-100/);
  await expect(page.getByTestId("css")).toContainText("width: 88px;");
  // The inspector shows the computed layout box of a grid item and the frame's padding.
  await layers.locator('button[data-node="cell-tall"]').click();
  await expect(page.getByTestId("box")).toContainText("x241.33y12w106.67h236");
  await expect(page.getByTestId("css")).toContainText("align-self: stretch;");
  await layers.locator('button[data-node="gallery"]').click();
  await expect(page.getByTestId("box")).toContainText("padding12 12 12 12");
  await expect(page.getByTestId("css")).toContainText("grid-template-columns: repeat(3, 1fr);");
});
