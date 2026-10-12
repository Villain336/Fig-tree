import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { backends, pixel, type BackendName, type Image } from "./pixels";

/**
 * Editing flows in the editor with real mouse and keyboard input: drawing,
 * auto layout, the design panel, handles, multi-selection and alignment,
 * undo/redo, the layers panel, text editing, SVG paste and copy/paste
 * between pages. Each test checks the document and the rendered pixels.
 */

test.use({ viewport: { width: 1400, height: 900 } });

async function open(page: Page, backend: BackendName, doc = "blank"): Promise<void> {
  await page.goto(`/?renderer=${backend}&doc=${doc}`);
  await page.waitForFunction(() => window.__figtree !== undefined, null, { timeout: 90_000 });
  expect(await page.evaluate(() => window.__figtree!.backend)).toBe(backend);
  await page.evaluate(() => window.__figtree!.fontsReady());
  // 100% zoom with the world origin 40 px into the canvas.
  await page.evaluate(() => window.__figtree!.setView(1, 40, 40));
}

/** Client coordinates of a world point. */
async function at(page: Page, x: number, y: number): Promise<[number, number]> {
  const box = (await page.getByTestId("canvas").boundingBox())!;
  const c = await page.evaluate(([wx, wy]) => window.__figtree!.toCanvas(wx!, wy!), [x, y]);
  return [box.x + c.x, box.y + c.y];
}

async function drag(page: Page, from: [number, number], to: [number, number], steps = 8): Promise<void> {
  await page.mouse.move(...from);
  await page.mouse.down();
  await page.mouse.move(...to, { steps });
  await page.mouse.up();
}

async function clickWorld(page: Page, x: number, y: number, modifiers: ("Shift" | "Control" | "Alt")[] = []): Promise<void> {
  for (const m of modifiers) await page.keyboard.down(m);
  await page.mouse.click(...(await at(page, x, y)));
  for (const m of modifiers) await page.keyboard.up(m);
}

async function frame(page: Page): Promise<Image> {
  const r = await page.evaluate(() => window.__figtree!.renderPixels());
  return { width: r.width, height: r.height, data: new Uint8Array(Buffer.from(r.pixels, "base64")) };
}

async function worldPixel(page: Page, img: Image, x: number, y: number): Promise<number[]> {
  const c = await page.evaluate(([wx, wy]) => window.__figtree!.toCanvas(wx!, wy!), [x, y]);
  return pixel(img, Math.floor(c.x), Math.floor(c.y)).slice(0, 3);
}

function near(got: number[], want: number[], label: string, tol = 3): void {
  for (let k = 0; k < 3; k++) expect(Math.abs(got[k]! - want[k]!), `${label}: got ${got}, want ${want}`).toBeLessThanOrEqual(tol);
}

/** The page's tree with the properties tests care about. */
function snapshot(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const f = window.__figtree!;
    const doc = f.doc;
    const walk = (id: string): unknown => ({
      type: doc.typeOf(id),
      props: doc.storedProps(id),
      text: doc.typeOf(id) === "text" ? doc.text(id) : undefined,
      children: doc.tree.childrenOf(id).map(walk),
    });
    return doc.tree.childrenOf(f.editor.page).map(walk);
  });
}

const sel = (page: Page): Promise<readonly string[]> => page.evaluate(() => window.__figtree!.selection());
const prop = (page: Page, id: string, key: string): Promise<unknown> => page.evaluate(([i, k]) => window.__figtree!.doc.get(i, k), [id, key]);
const children = (page: Page, id: string): Promise<string[]> => page.evaluate((i) => [...window.__figtree!.doc.tree.childrenOf(i)], id);

for (const backend of backends) {
  test(`draws, lays out, transforms and aligns, then undoes and redoes all of it (${backend})`, async ({ page }) => {
    await open(page, backend);
    const pageId = await page.evaluate(() => window.__figtree!.editor.page as string);

    // A frame, drawn with the frame tool.
    await page.keyboard.press("f");
    await drag(page, await at(page, 100, 100), await at(page, 500, 400));
    const [frameId] = await sel(page);
    expect(await page.evaluate((id) => window.__figtree!.doc.storedProps(id), frameId!)).toMatchObject({ x: 100, y: 100, width: 400, height: 300 });
    expect(await page.evaluate(() => window.__figtree!.editor.tool.id)).toBe("select");

    // A rectangle inside it.
    await page.keyboard.press("r");
    await drag(page, await at(page, 120, 120), await at(page, 220, 200));
    const [rectId] = await sel(page);
    expect(await children(page, frameId!)).toEqual([rectId]);
    expect(await page.evaluate((id) => window.__figtree!.doc.storedProps(id), rectId!)).toMatchObject({ x: 20, y: 20, width: 100, height: 80 });

    // Text inside it, typed on the canvas.
    await page.keyboard.press("t");
    await clickWorld(page, 120, 240);
    await page.keyboard.type("Hello");
    await page.keyboard.press("Escape");
    const [textId] = await sel(page);
    expect(await page.evaluate((id) => window.__figtree!.doc.text(id).content, textId!)).toBe("Hello");
    expect(await children(page, frameId!)).toEqual([rectId, textId]);

    // Auto layout on the frame (Shift+A), then gap and padding in the design panel.
    await clickWorld(page, 104, 94); // the frame's name label
    expect(await sel(page)).toEqual([frameId]);
    await page.keyboard.press("Shift+A");
    expect(await prop(page, frameId!, "display")).toBe("flex");
    expect(await prop(page, frameId!, "flexDirection")).toBe("column");
    await page.getByTestId("gap").fill("24");
    await page.getByTestId("gap").press("Enter");
    await page.getByTestId("padding-h").fill("16");
    await page.getByTestId("padding-h").press("Enter");
    expect(await prop(page, frameId!, "rowGap")).toBe(24);
    expect(await prop(page, frameId!, "padding")).toMatchObject({ left: 16, right: 16 });
    // The layout moved the text below the rectangle with the new gap.
    const rectBox = (await page.evaluate((id) => window.__figtree!.box(id), rectId!))!;
    const textBox = (await page.evaluate((id) => window.__figtree!.box(id), textId!))!;
    expect(rectBox.x).toBe(16);
    expect(textBox.y).toBe(rectBox.y + rectBox.height + 24);
    // Alignment matrix: center the items horizontally.
    await page.getByTestId("align-11").click();
    expect(await prop(page, frameId!, "alignItems")).toBe("center");

    // Resize the rectangle with its corner handle (Shift keeps the ratio).
    const centered = (await page.evaluate((id) => window.__figtree!.editor.geometry.bounds(id), rectId!)) as { x: number; y: number };
    await clickWorld(page, centered.x + 10, centered.y + 10);
    expect(await sel(page)).toEqual([rectId]);
    const se = await page.evaluate(() => window.__figtree!.anchors().find((a) => a.id === "canvas.handle.resize.se")!.rect!);
    await page.keyboard.down("Shift");
    await drag(page, [se.x + se.width / 2, se.y + se.height / 2], [se.x + se.width / 2 + 50, se.y + se.height / 2 + 10]);
    await page.keyboard.up("Shift");
    expect(await prop(page, rectId!, "width")).toBe(150);
    expect(await prop(page, rectId!, "height")).toBe(120);

    // Rotate it from just outside a corner, snapping to 15° steps with Shift.
    const zone = await page.evaluate(() => window.__figtree!.anchors().find((a) => a.id === "canvas.handle.rotate.ne")!.rect!);
    const rb = (await page.evaluate((id) => window.__figtree!.editor.geometry.bounds(id), rectId!)) as { x: number; y: number; width: number; height: number };
    const center = await at(page, rb.x + rb.width / 2, rb.y + rb.height / 2);
    await page.keyboard.down("Shift");
    await drag(page, [zone.x + zone.width / 2, zone.y + zone.height / 2], [center[0] + 120, center[1] + 20]);
    await page.keyboard.up("Shift");
    const rotation = (await prop(page, rectId!, "rotation")) as number;
    expect(rotation).not.toBe(0);
    expect(Math.abs(rotation % 15)).toBeLessThan(1e-6);

    // Two shapes on the canvas, multi-selected with Shift and aligned to the left.
    await page.keyboard.press("o");
    await drag(page, await at(page, 600, 100), await at(page, 660, 160));
    const [ellipseId] = await sel(page);
    await page.keyboard.press("r");
    await drag(page, await at(page, 640, 220), await at(page, 720, 260));
    const [otherId] = await sel(page);
    await clickWorld(page, 630, 130, ["Shift"]);
    expect([...(await sel(page))].sort()).toEqual([ellipseId, otherId].sort());
    await page.getByTestId("align.left").click();
    expect(await prop(page, otherId!, "x")).toBe(600);
    expect(await prop(page, ellipseId!, "x")).toBe(600);

    // The pixels: white frame, gray rectangle, gray ellipse.
    let img = await frame(page);
    near(await worldPixel(page, img, 105, 390), [255, 255, 255], "frame fill");
    near(await worldPixel(page, img, 630, 130), [217, 217, 217], "ellipse");
    near(await worldPixel(page, img, 640, 240), [217, 217, 217], "aligned rectangle");
    near(await worldPixel(page, img, 715, 240), [238, 238, 234], "where the rectangle was");

    // Undo everything, then redo everything.
    const final = await snapshot(page);
    for (let i = 0; i < 40 && (await page.evaluate(() => window.__figtree!.editor.history.canUndo())); i++) await page.keyboard.press("Control+z");
    expect(await page.evaluate((p) => window.__figtree!.doc.tree.childrenOf(p).length, pageId)).toBe(0);
    img = await frame(page);
    near(await worldPixel(page, img, 105, 390), [238, 238, 234], "empty page after undo");
    for (let i = 0; i < 40 && (await page.evaluate(() => window.__figtree!.editor.history.canRedo())); i++) await page.keyboard.press("Control+Shift+z");
    expect(await snapshot(page)).toEqual(final);
    img = await frame(page);
    near(await worldPixel(page, img, 105, 390), [255, 255, 255], "frame fill after redo");
  });
}

test("renames, reorders and reparents in the layers panel, synced with the canvas", async ({ page }) => {
  await open(page, "webgl2");
  for (const [x, y] of [[0, 0], [150, 0], [300, 0]]) {
    await page.keyboard.press("r");
    await drag(page, await at(page, x!, y!), await at(page, x! + 100, y! + 100));
  }
  await page.keyboard.press("f");
  await drag(page, await at(page, 0, 300), await at(page, 400, 600));
  const pageId = await page.evaluate(() => window.__figtree!.editor.page as string);
  const [r1, r2, r3, f] = await children(page, pageId);
  // Rename by double-clicking a row.
  await page.getByTestId(`layer-${r1}`).dblclick();
  await page.getByTestId("layer-rename").fill("Hero");
  await page.getByTestId("layer-rename").press("Enter");
  expect(await prop(page, r1!, "name")).toBe("Hero");
  // Clicking rows selects on the canvas; Shift selects a range, Ctrl toggles.
  await page.getByTestId(`layer-${r3}`).click();
  expect(await sel(page)).toEqual([r3]);
  await page.getByTestId(`layer-${r1}`).click({ modifiers: ["Shift"] });
  expect([...(await sel(page))].sort()).toEqual([r1, r2, r3].sort());
  await page.getByTestId(`layer-${r2}`).click({ modifiers: ["Control"] });
  expect([...(await sel(page))].sort()).toEqual([r1, r3].sort());
  // Selecting on the canvas highlights the row.
  await clickWorld(page, 200, 50);
  await expect(page.getByTestId(`layer-${r2}`).locator("xpath=..")).toHaveAttribute("aria-selected", "true");
  // Drag r1 above r3 in the list (the list shows the top of the stack first).
  const target = (await page.getByTestId(`layer-${r3}`).boundingBox())!;
  const source = (await page.getByTestId(`layer-${r1}`).boundingBox())!;
  await drag(page, [source.x + 40, source.y + source.height / 2], [target.x + 40, target.y + 3]);
  expect(await children(page, pageId)).toEqual([r2, r3, r1, f]);
  // Drop r2 into the frame: it becomes a child and stays where it is on the canvas.
  const before = await page.evaluate((id) => window.__figtree!.editor.geometry.bounds(id), r2!);
  const fr = (await page.getByTestId(`layer-${f}`).boundingBox())!;
  const r2box = (await page.getByTestId(`layer-${r2}`).boundingBox())!;
  await drag(page, [r2box.x + 40, r2box.y + r2box.height / 2], [fr.x + 40, fr.y + fr.height / 2]);
  expect(await children(page, f!)).toEqual([r2]);
  expect(await page.evaluate((id) => window.__figtree!.editor.geometry.bounds(id), r2!)).toEqual(before);
  // Lock and hide toggles.
  await page.getByTestId(`layer-${r3}`).hover();
  await page.locator(`[data-anchor="layers.row.${r3}.visibility"]`).click();
  expect(await prop(page, r3!, "visible")).toBe(false);
  await page.locator(`[data-anchor="layers.row.${r3}.lock"]`).click();
  expect(await prop(page, r3!, "locked")).toBe(true);
  const img = await frame(page);
  near(await worldPixel(page, img, 350, 50), [238, 238, 234], "hidden rectangle");
});

test("types and styles text with caret navigation", async ({ page }) => {
  await open(page, "webgpu");
  await page.keyboard.press("t");
  await clickWorld(page, 100, 100);
  await page.keyboard.type("Hello world");
  const id = (await sel(page))[0]!;
  const text = (): Promise<{ content: string; runs: { start: number; end: number; style: Record<string, unknown> }[] }> => page.evaluate((i) => window.__figtree!.doc.text(i), id);
  // Select "world" with Ctrl+Shift+Left and make it bold.
  await page.keyboard.press("Control+Shift+ArrowLeft");
  await page.keyboard.press("Control+b");
  expect((await text()).runs).toEqual([{ start: 6, end: 11, style: { fontWeight: 700 } }]);
  // Home, then type at the start of the line.
  await page.keyboard.press("Home");
  await page.keyboard.type("Say: ");
  expect((await text()).content).toBe("Say: Hello world");
  // Word steps and Backspace by word.
  await page.keyboard.press("Control+ArrowRight");
  await page.keyboard.press("Control+Backspace");
  expect((await text()).content).toBe("Say:  world");
  // A new paragraph at the end.
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Second");
  expect((await text()).content).toBe("Say:  world\nSecond");
  // Font size from the design panel applies to the selected characters.
  await page.keyboard.press("Shift+Home");
  await page.getByTestId("font-size").fill("32");
  await page.getByTestId("font-size").press("Enter");
  // Typing after the bold word continued it; the second paragraph is now also 32 px.
  const runs = (await text()).runs;
  expect(runs).toEqual([
    { start: 6, end: 12, style: { fontWeight: 700 } },
    { start: 12, end: 18, style: { fontWeight: 700, fontSize: 32 } },
  ]);
  // The second paragraph is drawn larger: its box grew.
  await expect.poll(() => page.evaluate((i) => window.__figtree!.box(i)?.height ?? 0, id)).toBeGreaterThan(55);
  // Escape leaves editing with the text selected; undo steps back through the edits.
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => window.__figtree!.editor.session)).toBeNull();
  await page.keyboard.press("Control+z");
  expect((await text()).runs.some((r) => r.style.fontSize === 32)).toBe(false);
  const img = await frame(page);
  // Black ink where the text starts.
  const c = await page.evaluate(() => window.__figtree!.toCanvas(100, 100));
  let inked = 0;
  for (let y = Math.floor(c.y); y < c.y + 20; y++) for (let x = Math.floor(c.x); x < c.x + 120; x++) if (pixel(img, x, y)[0] < 128) inked++;
  expect(inked).toBeGreaterThan(50);
});

test("pastes SVG as vectors and copies nodes between pages", async ({ page }) => {
  await open(page, "webgl2");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="60" height="60" fill="#ff0000"/><path d="M70 0h50v60z" fill="#0000ff"/></svg>`;
  await page.evaluate((s) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", s);
    document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
  }, svg);
  await expect.poll(() => sel(page).then((s) => s.length)).toBe(1);
  const [svgFrame] = await sel(page);
  expect(await page.evaluate((i) => window.__figtree!.doc.tree.subtree(i).map((n: string) => window.__figtree!.doc.typeOf(n)), svgFrame!)).toEqual(["frame", "rectangle", "vector"]);
  const b = (await page.evaluate((i) => window.__figtree!.editor.geometry.bounds(i), svgFrame!)) as { x: number; y: number };
  let img = await frame(page);
  near(await worldPixel(page, img, b.x + 30, b.y + 30), [255, 0, 0], "pasted red rect");
  near(await worldPixel(page, img, b.x + 115, b.y + 50), [0, 0, 255], "pasted blue path");

  // Copy it, add a page, paste: same place on the new page.
  const copied = await page.evaluate(() => {
    const dt = new DataTransfer();
    document.dispatchEvent(new ClipboardEvent("copy", { clipboardData: dt, bubbles: true }));
    return { html: dt.getData("text/html"), text: dt.getData("text/plain") };
  });
  expect(copied.html).toContain("data-fig-tree");
  await page.getByTestId("add-page").click();
  const page2 = await page.evaluate(() => window.__figtree!.editor.page as string);
  await page.evaluate((html) => {
    const dt = new DataTransfer();
    dt.setData("text/html", html);
    document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
  }, copied.html);
  await expect.poll(() => page.evaluate((p) => window.__figtree!.doc.tree.childrenOf(p).length, page2)).toBe(1);
  const pasted = (await sel(page))[0]!;
  expect(await page.evaluate((i) => window.__figtree!.editor.geometry.bounds(i), pasted)).toEqual(b);
  img = await frame(page);
  near(await worldPixel(page, img, b.x + 30, b.y + 30), [255, 0, 0], "pasted on page 2");
  // Back on the first page the original is still there.
  await page.locator("button[data-page]").first().click();
  expect(await page.evaluate(() => window.__figtree!.editor.page)).not.toBe(page2);
});

test("opens context menus and the shortcuts sheet", async ({ page }) => {
  await open(page, "webgl2");
  await page.keyboard.press("r");
  await drag(page, await at(page, 50, 50), await at(page, 150, 150));
  await page.mouse.click(...(await at(page, 100, 100)), { button: "right" });
  await expect(page.getByTestId("context-menu")).toBeVisible();
  await page.getByTestId("menu-edit.duplicate").click();
  const pageId = await page.evaluate(() => window.__figtree!.editor.page as string);
  expect((await children(page, pageId)).length).toBe(2);
  await page.keyboard.press("Control+/");
  await expect(page.getByTestId("shortcuts")).toBeVisible();
  await expect(page.getByTestId("shortcuts")).toContainText("Frame selection");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("shortcuts")).toHaveCount(0);
});

test("registers every interactive control with a unique anchor and a rect", async ({ page }) => {
  await open(page, "webgl2", "sample");
  const check = async (state: string): Promise<number> => {
    const result = await page.evaluate(() => {
      const anchors = new Map(window.__figtree!.anchors().map((a) => [a.id, a]));
      const els = [...document.querySelectorAll<HTMLElement>("button, input:not([type=file]), select, textarea:not([data-text-input]), [role=menuitem], [role=tab], [role=slider]")].filter((el) => el.offsetParent !== null || el.getClientRects().length > 0);
      const missing: string[] = [];
      const seen = new Map<string, number>();
      for (const el of els) {
        const id = el.dataset.anchor;
        if (!id) {
          missing.push(el.outerHTML.slice(0, 120));
          continue;
        }
        seen.set(id, (seen.get(id) ?? 0) + 1);
        const a = anchors.get(id);
        if (!a || !a.rect || a.rect.width <= 0 || a.rect.height <= 0) missing.push(`${id} (no rect)`);
      }
      const dupes = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
      return { count: els.length, missing, dupes, registryDupes: [...window.__figtree!.editor.anchors.duplicates] };
    });
    expect(result.missing, `${state}: controls without an anchor`).toEqual([]);
    expect(result.dupes, `${state}: duplicate anchors`).toEqual([]);
    expect(result.registryDupes, `${state}: duplicate registrations`).toEqual([]);
    return result.count;
  };
  let total = await check("nothing selected");
  // A frame with auto layout, a text node, a shape.
  for (const id of ["toolbar", "type-heading", "star", "gallery"]) {
    await page.evaluate((i) => window.__figtree!.editor.select([i]), id);
    await page.waitForTimeout(100);
    total += await check(`${id} selected`);
  }
  // Canvas handles resolve while something is selected.
  const handles = await page.evaluate(() => window.__figtree!.anchors().filter((a) => a.id.startsWith("canvas.handle.resize") && a.rect));
  expect(handles.length).toBeGreaterThanOrEqual(4);
  // The color picker, the font picker, the zoom menu, the context menu and the shortcuts sheet.
  await page.evaluate(() => window.__figtree!.editor.select(["star"]));
  await page.getByTestId("design.fills.0.swatch").click();
  await expect(page.getByTestId("color-picker")).toBeVisible();
  total += await check("color picker");
  await page.getByTestId("paint-type").selectOption("linear-gradient");
  total += await check("gradient picker");
  await expect.poll(() => page.evaluate(() => window.__figtree!.anchors().filter((a) => a.id.startsWith("canvas.handle.gradient") && a.rect).length)).toBeGreaterThanOrEqual(4);
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.__figtree!.editor.select(["type-heading"]));
  await page.getByTestId("font-family").click();
  total += await check("font picker");
  await page.keyboard.press("Escape");
  await page.getByTestId("zoom").click();
  total += await check("zoom menu");
  await page.keyboard.press("Escape");
  const star = await at(page, 660, 118);
  await page.mouse.click(star[0], star[1], { button: "right" });
  total += await check("context menu");
  await page.keyboard.press("Escape");
  await page.getByTestId("tab-css").click();
  total += await check("css tab");
  await page.keyboard.press("Control+/");
  total += await check("shortcuts sheet");
  expect(total).toBeGreaterThan(200);
});

test("zooms and pans with keys, the wheel and the space bar; shows the pixel grid", async ({ page }) => {
  await open(page, "webgl2", "sample");
  const view = (): Promise<{ scale: number; x: number; y: number }> => page.evaluate(() => {
    const v = window.__figtree!.editor.viewport;
    return { scale: v.scale, x: v.x, y: v.y };
  });
  await page.keyboard.press("Shift+0");
  expect((await view()).scale).toBe(1);
  // Ctrl+wheel zooms about the pointer: the world point under it stays put.
  const p = await at(page, 660, 118);
  await page.mouse.move(...p);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  const zoomed = await view();
  expect(zoomed.scale).toBeGreaterThan(2);
  const back = await at(page, 660, 118);
  expect(Math.abs(back[0] - p[0])).toBeLessThan(1);
  // Space+drag pans.
  await page.keyboard.down(" ");
  await drag(page, [p[0], p[1]], [p[0] - 100, p[1] - 50]);
  await page.keyboard.up(" ");
  const panned = await view();
  expect(Math.round(panned.x - zoomed.x)).toBe(-100);
  expect(Math.round(panned.y - zoomed.y)).toBe(-50);
  // Plain wheel scrolls.
  await page.mouse.wheel(0, 40);
  expect(Math.round((await view()).y - panned.y)).toBe(-40);
  // Zoom to selection and to fit.
  await page.evaluate(() => window.__figtree!.editor.select(["star"]));
  await page.keyboard.press("Shift+2");
  const sel = await view();
  const star = (await page.evaluate(() => window.__figtree!.editor.geometry.bounds("star"))) as { x: number; y: number; width: number; height: number };
  const c = await page.evaluate(([x, y]) => window.__figtree!.toCanvas(x!, y!), [star.x + star.width / 2, star.y + star.height / 2]);
  const size = (await page.getByTestId("canvas").boundingBox())!;
  expect(Math.abs(c.x - size.width / 2)).toBeLessThan(2);
  expect(sel.scale).toBeGreaterThan(4);
  // The pixel grid shows at 800% and above, on the overlay (the document pixels do not change).
  const overlayInk = (): Promise<number> => page.evaluate(() => {
    const cv = document.querySelector<HTMLCanvasElement>("[data-testid=overlay]")!;
    const d = cv.getContext("2d")!.getImageData(0, 0, cv.width, cv.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4 * 97) if (d[i]! > 0) n++;
    return n;
  });
  await page.evaluate(() => window.__figtree!.editor.select([]));
  await page.evaluate(() => window.__figtree!.setView(12, -7000, -1000));
  await page.waitForTimeout(150);
  const withGrid = await overlayInk();
  await page.keyboard.press("Shift+Control+'");
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => window.__figtree!.editor.settings.pixelGrid)).toBe(false);
  expect(withGrid).toBeGreaterThan(await overlayInk());
  await page.keyboard.press("Shift+1");
  expect((await view()).scale).toBeLessThan(1.5);
  // Rulers.
  await page.keyboard.press("Shift+R");
  await expect(page.getByTestId("ruler-top")).toBeVisible();
});

test("places an image from a file as an image node backed by an asset", async ({ page }) => {
  await open(page, "webgl2");
  // A 3×2 PNG.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAEklEQVR4nGP4z8DwH4YZYBwAQJcF+5oUY1UAAAAASUVORK5CYII=", "base64");
  await page.keyboard.press("Shift+Control+k");
  await page.getByTestId("image-input").setInputFiles({ name: "dot.png", mimeType: "image/png", buffer: png });
  await expect.poll(() => sel(page).then((s) => s.length)).toBe(1);
  const [id] = await sel(page);
  expect(await page.evaluate((i) => window.__figtree!.doc.typeOf(i), id!)).toBe("image");
  expect(await page.evaluate((i) => [window.__figtree!.doc.get(i, "width"), window.__figtree!.doc.get(i, "height")], id!)).toEqual([3, 2]);
  const asset = await prop(page, id!, "asset");
  expect(await page.evaluate((a) => window.__figtree!.doc.assets().get(a)?.mimeType, asset as string)).toBe("image/png");
  expect(await page.evaluate(() => window.__figtree!.editor.tool.id)).toBe("select");
});

test("edits every design panel field: math, mixed values, scrubbing, paints, typography, layout", async ({ page }) => {
  await open(page, "webgl2");
  // Two rectangles and a text.
  await page.keyboard.press("r");
  await drag(page, await at(page, 0, 0), await at(page, 100, 50));
  const [a] = await sel(page);
  await page.keyboard.press("r");
  await drag(page, await at(page, 200, 0), await at(page, 260, 80));
  const [b] = await sel(page);
  const get = (id: string, key: string): Promise<unknown> => prop(page, id, key);
  const field = async (testId: string, value: string): Promise<void> => {
    await page.getByTestId(testId).fill(value);
    await page.getByTestId(testId).press("Enter");
  };

  // Math in fields, relative edits and mixed values over a multi-selection.
  await page.evaluate(([x, y]) => window.__figtree!.editor.select([x, y]), [a, b]);
  await expect(page.getByTestId("w")).toHaveValue("Mixed");
  await field("w", "+10");
  expect([await get(a!, "width"), await get(b!, "width")]).toEqual([110, 70]);
  await field("h", "12*5");
  expect([await get(a!, "height"), await get(b!, "height")]).toEqual([60, 60]);
  await expect(page.getByTestId("h")).toHaveValue("60");
  // Arrow keys step the value (Shift ×10).
  await page.getByTestId("x").focus();
  await page.getByTestId("x").press("Shift+ArrowUp");
  expect([await get(a!, "x"), await get(b!, "x")]).toEqual([10, 210]);
  // Scrubbing the label is one undo step.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const label = page.locator('[data-anchor="design.position.y.scrub"]');
  const lb = (await label.boundingBox())!;
  await drag(page, [lb.x + lb.width / 2, lb.y + lb.height / 2], [lb.x + lb.width / 2 + 30, lb.y + lb.height / 2], 6);
  expect(await get(a!, "y")).toBe(30);
  await page.keyboard.press("Control+z");
  expect(await get(a!, "y")).toBe(0);

  // Single node: rotation, radius per corner, smoothing, opacity, aspect lock, min/max, constraints.
  await page.evaluate((x) => window.__figtree!.editor.select([x]), a!);
  await field("rotation", "45");
  expect(await get(a!, "rotation")).toBe(45);
  await field("rotation", "0");
  await field("radius", "8");
  expect(await get(a!, "cornerRadius")).toBe(8);
  await page.locator('[data-anchor="design.appearance.radiusMode"]').click();
  await page.locator('[data-anchor="design.appearance.radius.topLeft"]').fill("20");
  await page.locator('[data-anchor="design.appearance.radius.topLeft"]').press("Enter");
  expect(await get(a!, "cornerRadius")).toEqual({ topLeft: 20, topRight: 8, bottomRight: 8, bottomLeft: 8 });
  await page.locator('[data-anchor="design.appearance.smoothing"]').fill("60");
  await page.locator('[data-anchor="design.appearance.smoothing"]').press("Enter");
  expect(await get(a!, "cornerSmoothing")).toBe(0.6);
  await field("opacity", "50");
  expect(await get(a!, "opacity")).toBe(0.5);
  await page.locator('[data-anchor="design.size.aspectLock"]').click();
  await field("w", "220");
  expect([await get(a!, "width"), await get(a!, "height")]).toEqual([220, 120]);
  await page.locator('[data-anchor="design.size.more"]').click();
  await page.locator('[data-anchor="design.size.minWidth"]').fill("50");
  await page.locator('[data-anchor="design.size.minWidth"]').press("Enter");
  expect(await get(a!, "minWidth")).toBe(50);

  // Fills: hex, opacity, add, hide, remove; the picker's hex field and paint types.
  await page.locator('[data-anchor="design.fills.0.hex"]').fill("ff8800");
  await page.locator('[data-anchor="design.fills.0.hex"]').press("Enter");
  expect(await get(a!, "fills")).toEqual([{ type: "solid", color: { r: 1, g: 136 / 255, b: 0, a: 1 } }]);
  await page.locator('[data-anchor="design.fills.add"]').click();
  expect(((await get(a!, "fills")) as unknown[]).length).toBe(2);
  await page.locator('[data-anchor="design.fills.1.visible"]').click();
  expect(((await get(a!, "fills")) as { visible?: boolean }[])[1]!.visible).toBe(false);
  await page.locator('[data-anchor="design.fills.1.remove"]').click();
  expect(((await get(a!, "fills")) as unknown[]).length).toBe(1);
  await page.getByTestId("design.fills.0.swatch").click();
  await page.locator('[data-anchor="picker.hex"]').fill("3366cc");
  await page.locator('[data-anchor="picker.hex"]').press("Enter");
  expect(((await get(a!, "fills")) as { color: unknown }[])[0]!.color).toEqual({ r: 0.2, g: 0.4, b: 0.8, a: 1 });
  await page.getByTestId("paint-type").selectOption("radial-gradient");
  expect(((await get(a!, "fills")) as { type: string }[])[0]!.type).toBe("radial-gradient");
  // Clicking the stop bar adds a stop.
  const bar = (await page.getByTestId("gradient-bar").boundingBox())!;
  await page.mouse.click(bar.x + bar.width / 2, bar.y + bar.height / 2);
  expect(((await get(a!, "fills")) as { stops: unknown[] }[])[0]!.stops.length).toBe(3);
  await page.keyboard.press("Escape");
  // Strokes.
  await page.locator('[data-anchor="design.strokes.add"]').click();
  await page.locator('[data-anchor="design.strokes.weight"]').fill("3");
  await page.locator('[data-anchor="design.strokes.weight"]').press("Enter");
  await page.locator('[data-anchor="design.strokes.align"]').selectOption("outside");
  expect([await get(a!, "strokeWeight"), await get(a!, "strokeAlign")]).toEqual([3, "outside"]);

  // Constraints inside a frame.
  await page.keyboard.press("f");
  await drag(page, await at(page, 0, 300), await at(page, 300, 500));
  const [f] = await sel(page);
  await page.keyboard.press("r");
  await drag(page, await at(page, 20, 320), await at(page, 60, 360));
  const [c] = await sel(page);
  await page.locator('[data-anchor="design.constraints.horizontal"]').selectOption("end");
  expect(await get(c!, "constraints")).toEqual({ horizontal: "end", vertical: "start" });

  // Grid layout with a track editor.
  await page.evaluate((x) => window.__figtree!.editor.select([x]), f!);
  await page.locator('[data-anchor="design.layout.addGrid"]').click();
  expect(await get(f!, "display")).toBe("grid");
  await page.locator('[data-anchor="design.grid.columns.add"]').click();
  await page.locator('[data-anchor="design.grid.columns.1.unit"]').selectOption("px");
  await page.locator('[data-anchor="design.grid.columns.1.value"]').fill("120");
  await page.locator('[data-anchor="design.grid.columns.1.value"]').press("Enter");
  expect(await get(f!, "gridTemplateColumns")).toEqual([{ type: "repeat", count: 2, tracks: [{ type: "fr", value: 1 }] }, { type: "px", value: 120 }]);
  await page.locator('[data-anchor="design.layout.toFlex"]').click();
  await page.locator('[data-anchor="design.layout.direction.column"]').click();
  await page.locator('[data-anchor="design.layout.wrap"]').click();
  expect([await get(f!, "display"), await get(f!, "flexDirection"), await get(f!, "flexWrap")]).toEqual(["flex", "column", "wrap"]);
  await page.getByTestId("width-mode").selectOption("hug");
  expect(await get(f!, "widthMode")).toBe("hug");

  // Typography on a whole text node.
  await page.keyboard.press("t");
  await clickWorld(page, 400, 300);
  await page.keyboard.type("Panel text");
  await page.keyboard.press("Escape");
  const [t] = await sel(page);
  await page.getByTestId("font-family").click();
  await page.getByLabel("Search fonts").fill("noto sans");
  await page.locator('[data-anchor="fontpicker.family.Noto-Sans"]').click();
  expect(await get(t!, "fontFamily")).toBe("Noto Sans");
  await page.getByTestId("font-weight").selectOption("700");
  await field("font-size", "24");
  await page.locator('[data-anchor="design.text.lineHeight"]').fill("30");
  await page.locator('[data-anchor="design.text.lineHeight"]').press("Enter");
  await page.locator('[data-anchor="design.text.letterSpacing"]').fill("2");
  await page.locator('[data-anchor="design.text.letterSpacing"]').press("Enter");
  await page.locator('[data-anchor="design.text.align.center"]').click();
  await page.locator('[data-anchor="design.text.decoration.underline"]').click();
  await page.locator('[data-anchor="design.text.case.uppercase"]').click();
  await page.locator('[data-anchor="design.text.resize.auto-height"]').click();
  // The panel re-renders on the next animation frame: click, then read the document.
  await page.locator('[data-anchor="design.text.truncate"]').click();
  expect(await page.evaluate((i) => {
    const d = window.__figtree!.doc;
    return ["fontWeight", "fontSize", "lineHeight", "letterSpacing", "textAlign", "textDecoration", "textTransform", "widthMode", "heightMode", "textOverflow"].map((k) => d.get(i, k));
  }, t!)).toEqual([700, 24, { unit: "px", value: 30 }, { unit: "px", value: 2 }, "center", "underline", "uppercase", "fixed", "hug", "ellipsis"]);
});

// `UPDATE_DOCS=1` refreshes the editor screenshots in docs/img.
test("documentation screenshots", async ({ page }) => {
  test.skip(process.env.UPDATE_DOCS !== "1", "set UPDATE_DOCS=1 to refresh docs/img");
  const dir = join(__dirname, "..", "docs", "img");
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, "webgpu", "sample");
  await page.keyboard.press("Shift+1");
  await page.evaluate(() => window.__figtree!.editor.select(["toolbar"]));
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(dir, "editor-auto-layout.png") });
  // Text editing with a selection, and the typography panel.
  await page.evaluate(() => window.__figtree!.editor.select(["type"]));
  await page.keyboard.press("Shift+2");
  await page.evaluate(() => window.__figtree!.editor.enterEditMode("type-body"));
  await page.evaluate(() => window.__figtree!.editor.session.setSelection(0, 24));
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(dir, "editor-text.png") });
  await page.keyboard.press("Escape");
  // A gradient being edited on the canvas, with smart guides from a drag in progress.
  await page.keyboard.press("Shift+1");
  await page.evaluate(() => window.__figtree!.editor.select(["header"]));
  await page.getByTestId("design.fills.0.swatch").click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(dir, "editor-gradient.png") });
});
