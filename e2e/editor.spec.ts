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
  // Text is laid out again as its fonts arrive (fetched from /fonts on first use).
  await page.evaluate(() => window.__figtree!.fontsReady());
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

/**
 * Pixels in a world rectangle that differ from `bg` by more than 64 in some
 * channel ("ink"), and the horizontal extent of the inked columns in world units.
 */
async function ink(page: Page, img: Image, x0: number, y0: number, x1: number, y1: number, bg: readonly number[] = [255, 255, 255]): Promise<{ count: number; minX: number; maxX: number }> {
  const a = await page.evaluate(([x, y]) => window.__figtree!.toCanvas(x!, y!), [x0, y0]);
  const b = await page.evaluate(([x, y]) => window.__figtree!.toCanvas(x!, y!), [x1, y1]);
  const scale = (b.x - a.x) / (x1 - x0);
  let count = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  for (let y = Math.ceil(a.y); y < Math.floor(b.y); y++) {
    for (let x = Math.ceil(a.x); x < Math.floor(b.x); x++) {
      const p = pixel(img, x, y);
      if (Math.max(Math.abs(p[0] - bg[0]!), Math.abs(p[1] - bg[1]!), Math.abs(p[2] - bg[2]!)) > 64) {
        count++;
        minX = Math.min(minX, x0 + (x - a.x) / scale);
        maxX = Math.max(maxX, x0 + (x + 1 - a.x) / scale);
      }
    }
  }
  return { count, minX, maxX };
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
      await expect(page.getByTestId("status")).toContainText(`${backend} · 60 nodes`);
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

    test("renders typography with the text engine", async ({ page }) => {
      await openEditor(page, backend);
      const box = async (id: string) => (await page.evaluate((i) => window.__figtree!.box(i), id))!;
      // 1:1 on the typography frame (world x 920..1300, y 40..513).
      await page.evaluate(() => window.__figtree!.setView(1, -900, -20));
      const img = await frame(page);
      const frameBox = await box("type");
      const at = async (id: string) => {
        const b = await box(id);
        return { ...b, x: frameBox.x + b.x, y: frameBox.y + b.y };
      };

      // Heading: Inter Bold 32 px, hugging its text; ink stays inside the box.
      const heading = await at("type-heading");
      expect(heading.height).toBe(39);
      const h = await ink(page, img, heading.x - 4, heading.y, heading.x + heading.width + 8, heading.y + heading.height);
      expect(h.count).toBeGreaterThan(400);
      expect(h.minX).toBeGreaterThanOrEqual(heading.x);
      expect(h.minX).toBeLessThan(heading.x + 4);
      expect(h.maxX).toBeLessThanOrEqual(heading.x + heading.width + 1);
      expect(h.maxX).toBeGreaterThan(heading.x + heading.width - 4);

      // Body: wraps to four 22.5 px lines inside the column's content width.
      const body = await at("type-body");
      expect(body.width).toBe(332);
      expect(body.height).toBe(91);
      for (let line = 0; line < 4; line++) expect((await ink(page, img, body.x, body.y + line * 22.5 + 4, body.x + body.width, body.y + line * 22.5 + 18)).count, `body line ${line + 1}`).toBeGreaterThan(100);

      // Buttons hug their labels (padding 8 / 16) and sit 8 px apart.
      const row: { x: number; width: number }[] = [];
      for (const id of ["save", "cancel", "publish"]) {
        const button = await box(`btn-${id}`);
        const label = await box(`label-${id}`);
        expect(button.width).toBeCloseTo(label.width + 32, 5);
        expect(button.height).toBeCloseTo(label.height + 16, 5);
        expect([label.x, label.y]).toEqual([16, 8]);
        row.push(button);
      }
      expect(row[1]!.x).toBeCloseTo(row[0]!.width + 8, 5);
      expect(row[2]!.x).toBeCloseTo(row[1]!.x + row[1]!.width + 8, 5);
      // White label glyphs on the black button.
      const buttons = await at("type-buttons");
      const label = await box("label-save");
      expect((await ink(page, img, buttons.x + 16, buttons.y + 8, buttons.x + 16 + label.width, buttons.y + 8 + label.height, [24, 24, 27])).count).toBeGreaterThan(40);

      // Arabic (from the script fallback font) is right-to-left: its first line starts at the right edge.
      const arabic = await at("type-arabic");
      expect(arabic.height).toBe(84); // two 42 px lines (Noto Sans Arabic's normal line height at 20 px)
      const first = await ink(page, img, arabic.x, arabic.y, arabic.x + arabic.width, arabic.y + 42);
      expect(first.maxX).toBeGreaterThan(arabic.x + arabic.width - 3);
      expect(first.minX).toBeGreaterThan(arabic.x + 20);
      const second = await ink(page, img, arabic.x, arabic.y + 42, arabic.x + arabic.width, arabic.y + 84);
      expect(second.maxX).toBeGreaterThan(arabic.x + arabic.width - 3);
      expect(second.minX).toBeGreaterThan(arabic.x + arabic.width / 2);

      // Devanagari shapes into conjuncts and draws.
      const deva = await at("type-devanagari");
      expect((await ink(page, img, deva.x, deva.y, deva.x + deva.width, deva.y + deva.height)).count).toBeGreaterThan(150);

      // One variable font at weights 100 to 900: heavier words carry more ink per pixel of width.
      const weights = await at("type-weights");
      const thin = await ink(page, img, weights.x, weights.y, weights.x + 40, weights.y + weights.height);
      const black = await ink(page, img, weights.x + weights.width - 60, weights.y, weights.x + weights.width, weights.y + weights.height);
      expect(black.count).toBeGreaterThan(thin.count * 3);

      // Violet text: its fill paints the glyphs.
      const variable = await at("type-variable");
      const c = await page.evaluate(([x, y]) => window.__figtree!.toCanvas(x!, y!), [variable.x, variable.y]);
      let violet = 0;
      for (let y = Math.ceil(c.y); y < c.y + variable.height; y++) {
        for (let x = Math.ceil(c.x); x < c.x + variable.width; x++) {
          const p = pixel(img, x, y);
          if (Math.abs(p[0] - 124) <= 8 && Math.abs(p[1] - 58) <= 8 && Math.abs(p[2] - 237) <= 8) violet++;
        }
      }
      expect(violet).toBeGreaterThan(150);
      expectGolden(`editor-typography.${backend}`, img);
    });

    test("reflows layout and pixels when text is edited through the command API", async ({ page }) => {
      await openEditor(page, backend);
      const box = async (id: string) => (await page.evaluate((i) => window.__figtree!.box(i), id))!;
      await page.evaluate(() => window.__figtree!.setView(1, -900, -20));
      const frameBox = await box("type");
      const save0 = await box("btn-save");
      const cancel0 = await box("btn-cancel");
      const buttons = await box("type-buttons");
      const rowY = frameBox.y + buttons.y;

      // Typing into the first button's label widens it and pushes the next ones along.
      let r = await page.evaluate(() => window.__figtree!.apply([{ type: "insertText", id: "label-save", index: 4, text: " changes" }]));
      expect(r).toEqual({ affected: ["label-save"] });
      const save1 = await box("btn-save");
      const cancel1 = await box("btn-cancel");
      expect(save1.width).toBeGreaterThan(save0.width + 40);
      expect(cancel1.x).toBeCloseTo(save1.width + 8, 5);
      expect((await box("type-buttons"))!.width).toBeCloseTo(buttons.width + (save1.width - save0.width), 5);
      // The label, its button, the buttons it moved and the row: nothing else recompiled.
      expect(await page.evaluate(() => window.__figtree!.bridge.lastCompiled)).toBe(5);
      let img = await frame(page);
      // Where "Cancel" used to start, the black save button now shows its label.
      const x0 = frameBox.x + buttons.x + cancel0.x;
      expect((await ink(page, img, x0, rowY + 8, x0 + 20, rowY + 25, [24, 24, 27])).count).toBeGreaterThan(10);
      expectColor(await worldPixel(page, img, frameBox.x + buttons.x + save1.width - 6, rowY + 16), [24, 24, 27], "widened save button");

      // A heavier weight of the variable font widens the line and darkens it.
      const v0 = await box("type-variable");
      const vy = frameBox.y + v0.y;
      const ink0 = await ink(page, img, frameBox.x + v0.x, vy, frameBox.x + v0.x + 300, vy + v0.height);
      r = await page.evaluate(() => window.__figtree!.apply([{ type: "updateProps", id: "type-variable", props: { fontWeight: 900 } }]));
      expect("affected" in r).toBe(true);
      const v1 = await box("type-variable");
      expect(v1.width).toBeGreaterThan(v0.width + 15);
      img = await frame(page);
      const ink1 = await ink(page, img, frameBox.x + v0.x, vy, frameBox.x + v0.x + 300, vy + v1.height);
      expect(ink1.count).toBeGreaterThan(ink0.count * 1.5);
      expect(ink1.maxX).toBeGreaterThan(ink0.maxX + 15);

      // A family that has not loaded yet: the text lays out again (and redraws) when it arrives.
      const w0 = (await box("type-weights")).width;
      await page.evaluate(() => window.__figtree!.apply([{ type: "updateProps", id: "type-weights", props: { fontFamily: "Noto Sans" } }]));
      await page.evaluate(() => window.__figtree!.fontsReady());
      expect((await box("type-weights")).width).not.toBeCloseTo(w0, 1);
      img = await frame(page);
      const weights = await box("type-weights");
      expect((await ink(page, img, frameBox.x + weights.x, frameBox.y + weights.y, frameBox.x + weights.x + weights.width, frameBox.y + weights.y + weights.height)).count).toBeGreaterThan(300);
    });

    test("pans text without rasterizing glyphs again", async ({ page }) => {
      await openEditor(page, backend);
      await page.evaluate(() => window.__figtree!.setView(1, -900, -20));
      await page.evaluate(() => window.__figtree!.renderFrame());
      const rasterized: number[] = [];
      for (let i = 1; i <= 10; i++) {
        // Whole-pixel steps keep every glyph's subpixel phase, so the atlas serves them all.
        rasterized.push(await page.evaluate((dx) => {
          window.__figtree!.setView(1, -900 + dx, -20 + dx);
          return window.__figtree!.renderFrame().glyphsRasterized;
        }, i * 7));
      }
      expect(rasterized).toEqual(Array(10).fill(0));
      // Zooming changes glyph sizes: those are rasterized once (the first still frame
      // after a zoom also fills the tiles around the view), then served from the atlas.
      const view = (scale: number, x: number, y: number) =>
        page.evaluate(([s, tx, ty]) => {
          window.__figtree!.setView(s!, tx!, ty!);
          return window.__figtree!.renderFrame().glyphsRasterized;
        }, [scale, x, y]);
      expect(await view(1.5, -1350, -30)).toBeGreaterThan(50);
      await view(1.5, -1350, -30);
      const zoomed: number[] = [];
      for (let i = 1; i <= 10; i++) zoomed.push(await view(1.5, -1350 - i * 3, -30 - i * 3));
      expect(zoomed).toEqual(Array(10).fill(0));
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
  await expect(layers.locator("[data-node]")).toHaveCount(59);
  // Everything in the sample renders, text included.
  await expect(layers.locator('[aria-label="has unsupported features"]')).toHaveCount(0);
  // The CSS view is a tab of the design panel.
  await page.getByTestId("tab-css").click();
  await layers.locator('[data-node="shapes"]').click();
  await expect(page.getByTestId("css")).toContainText("left: 480px;");
  await expect(page.getByTestId("css")).toContainText("overflow: hidden;");
  // Clicking the canvas hit-tests through the bridge and selects the layer.
  const c = await page.evaluate(() => window.__figtree!.toCanvas(660, 118));
  const box = (await page.getByTestId("canvas").boundingBox())!;
  await page.mouse.click(box.x + c.x, box.y + c.y);
  await expect(layers.locator('[data-node="star"]').locator("xpath=..")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("css")).toContainText("width: 88px;");
  // The inspector shows the computed layout box of a grid item and the frame's padding.
  await layers.locator('[data-node="cell-tall"]').click();
  await expect(page.getByTestId("box")).toContainText("x241.33y12w106.67h236");
  await expect(page.getByTestId("css")).toContainText("align-self: stretch;");
  await layers.locator('[data-node="gallery"]').click();
  await expect(page.getByTestId("box")).toContainText("padding12 12 12 12");
  await expect(page.getByTestId("css")).toContainText("grid-template-columns: repeat(3, 1fr);");
  // A text node's typography is CSS, and its box is the text engine's measurement.
  await layers.locator('[data-node="type-heading"]').click();
  await expect(page.getByTestId("css")).toContainText("font-weight: 700;");
  await expect(page.getByTestId("css")).toContainText("width: max-content;");
  await expect(page.getByTestId("box")).toContainText("h39");
});
