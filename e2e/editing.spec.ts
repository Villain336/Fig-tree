import { expect, test, type Page } from "@playwright/test";
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
  const box = (await page.evaluate((i) => window.__figtree!.box(i), id))!;
  expect(box.height).toBeGreaterThan(55);
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
