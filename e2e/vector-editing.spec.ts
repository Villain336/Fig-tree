import { expect, test, type Page } from "@playwright/test";
import { backends, expectGolden, pixel, type BackendName, type Image } from "./pixels";

/**
 * Vector editing with real mouse and keyboard input on both backends: the
 * pen (corner and smooth points, closing, branching), vector edit mode
 * (moving points, bending, adding and deleting a point keeping the shape,
 * the paint bucket), boolean groups from the menus with a child edited
 * afterwards, flatten, outline stroke, the pencil, pasting SVG and editing
 * its points, copy as SVG, and undo/redo through all of it. Each step checks
 * the document and the rendered pixels.
 */

test.use({ viewport: { width: 1400, height: 900 } });

const BG = [238, 238, 234];
const GRAY = [217, 217, 217];

async function open(page: Page, backend: BackendName): Promise<void> {
  await page.goto(`/?renderer=${backend}&doc=blank`);
  await page.waitForFunction(() => window.__figtree !== undefined, null, { timeout: 90_000 });
  expect(await page.evaluate(() => window.__figtree!.backend)).toBe(backend);
  await page.evaluate(() => window.__figtree!.fontsReady());
  await page.evaluate(() => window.__figtree!.setView(1, 40, 40));
}

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

async function dragWorld(page: Page, from: [number, number], to: [number, number], modifiers: ("Shift" | "Control" | "Alt")[] = []): Promise<void> {
  for (const m of modifiers) await page.keyboard.down(m);
  await drag(page, await at(page, ...from), await at(page, ...to));
  for (const m of modifiers) await page.keyboard.up(m);
}

async function clickWorld(page: Page, x: number, y: number, options: { button?: "left" | "right"; clickCount?: number } = {}): Promise<void> {
  await page.mouse.click(...(await at(page, x, y)), options);
  // Separate clicks must not count as a double-click.
  await page.waitForTimeout(options.clickCount ? 0 : 450);
}

async function frame(page: Page): Promise<Image> {
  const r = await page.evaluate(() => window.__figtree!.renderPixels());
  return { width: r.width, height: r.height, data: new Uint8Array(Buffer.from(r.pixels, "base64")) };
}

async function worldPixel(page: Page, img: Image, x: number, y: number): Promise<number[]> {
  const c = await page.evaluate(([wx, wy]) => window.__figtree!.toCanvas(wx!, wy!), [x, y]);
  return pixel(img, Math.floor(c.x), Math.floor(c.y)).slice(0, 3);
}

function near(got: number[], want: readonly number[], label: string, tol = 3): void {
  for (let k = 0; k < 3; k++) expect(Math.abs(got[k]! - want[k]!), `${label}: got ${got}, want ${want}`).toBeLessThanOrEqual(tol);
}

function dark(got: number[], label: string): void {
  expect(Math.max(...got), `${label}: got ${got}`).toBeLessThan(160);
}

function snapshot(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const f = window.__figtree!;
    const doc = f.doc;
    const walk = (id: string): unknown => ({ type: doc.typeOf(id), props: doc.storedProps(id), children: doc.tree.childrenOf(id).map(walk) });
    return doc.tree.childrenOf(f.editor.page).map(walk);
  });
}

interface Net {
  vertices: { x: number; y: number; handleMirroring?: string }[];
  segments: { start: number; end: number; tangentStart?: { x: number; y: number }; tangentEnd?: { x: number; y: number } }[];
  regions: { loops: number[][] }[];
}

const network = (page: Page, id: string): Promise<Net> => page.evaluate((i) => window.__figtree!.doc.get(i, "vectorNetwork") as Net, id);
const sel = (page: Page): Promise<readonly string[]> => page.evaluate(() => window.__figtree!.selection());
const session = (page: Page): Promise<{ mode: string; subTool: string; nodeId: string } | null> =>
  page.evaluate(() => {
    const s = window.__figtree!.editor.session;
    return s ? { mode: s.mode, subTool: s.subTool, nodeId: s.nodeId } : null;
  });

/** World positions of a vector's vertices, rounded to 1/100 px. */
const worldVertices = (page: Page, id: string): Promise<{ x: number; y: number }[]> =>
  page.evaluate((i) => {
    const f = window.__figtree!;
    const m = f.editor.geometry.worldMatrix(i) as number[];
    const n = f.doc.get(i, "vectorNetwork") as { vertices: { x: number; y: number }[] };
    const r = (v: number): number => Math.round(v * 100) / 100;
    return n.vertices.map((v) => ({ x: r(m[0]! * v.x + m[2]! * v.y + m[4]!), y: r(m[1]! * v.x + m[3]! * v.y + m[5]!) }));
  }, id);

async function undoAll(page: Page): Promise<void> {
  for (let i = 0; i < 80 && (await page.evaluate(() => window.__figtree!.editor.history.canUndo())); i++) await page.keyboard.press("Control+z");
}

async function redoAll(page: Page): Promise<void> {
  for (let i = 0; i < 80 && (await page.evaluate(() => window.__figtree!.editor.history.canRedo())); i++) await page.keyboard.press("Control+Shift+z");
}

function crop(img: Image, x0: number, y0: number, w: number, h: number): Image {
  const width = Math.min(w, img.width - x0), height = Math.min(h, img.height - y0);
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) data.set(img.data.subarray(((y + y0) * img.width + x0) * 4, ((y + y0) * img.width + x0 + width) * 4), y * width * 4);
  return { width, height, data };
}

for (const backend of backends) {
  test(`pen: draws a closed shape with corner and smooth points, branches it, then edits its points (${backend})`, async ({ page }) => {
    await open(page, backend);
    // ── Pen: corner (100,100), smooth (300,100) dragged right, corners (300,300) and (100,300), close on the first point.
    await page.keyboard.press("p");
    expect(await page.evaluate(() => window.__figtree!.editor.tool.id)).toBe("pen");
    await clickWorld(page, 100, 100);
    const [id] = await sel(page);
    expect(await session(page)).toEqual({ mode: "vector", subTool: "pen", nodeId: id });
    await dragWorld(page, [300, 100], [360, 100]);
    await clickWorld(page, 300, 300);
    await clickWorld(page, 100, 300);
    await clickWorld(page, 100, 100);
    let n = await network(page, id!);
    expect(n.vertices).toHaveLength(4);
    expect(n.segments).toHaveLength(4);
    expect(n.regions).toHaveLength(1);
    expect(n.vertices[1]!.handleMirroring).toBe("angle-length");
    expect(n.segments[1]!.tangentStart).toEqual({ x: 60, y: 0 });
    expect(await worldVertices(page, id!)).toEqual([{ x: 100, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 300 }, { x: 100, y: 300 }]);
    let img = await frame(page);
    near(await worldPixel(page, img, 200, 200), GRAY, "closed shape filled");
    near(await worldPixel(page, img, 50, 50), BG, "outside");
    // The smooth point's outgoing handle bulges the right edge outwards.
    near(await worldPixel(page, img, 318, 140), GRAY, "bulge of the smooth point");

    // ── Branch: from the middle of the left edge out to (30, 200), then Escape ends the path.
    await clickWorld(page, 100, 200);
    await clickWorld(page, 30, 200);
    await page.keyboard.press("Escape");
    n = await network(page, id!);
    expect(n.vertices).toHaveLength(6);
    expect(n.segments).toHaveLength(6);
    expect(n.regions).toHaveLength(1);
    const degree = new Map<number, number>();
    for (const s of n.segments) for (const v of [s.start, s.end]) degree.set(v, (degree.get(v) ?? 0) + 1);
    expect([...degree.values()].sort()).toEqual([1, 2, 2, 2, 2, 3]);
    img = await frame(page);
    dark(await worldPixel(page, img, 60, 200), "branch stroke");
    // A second Escape leaves the mode and the pen.
    await page.keyboard.press("Escape");
    expect(await session(page)).toBeNull();
    expect(await page.evaluate(() => window.__figtree!.editor.tool.id)).toBe("select");
    expect(await sel(page)).toEqual([id]);

    // ── Vector edit mode (Enter): move the bottom-right point.
    await page.keyboard.press("Enter");
    expect((await session(page))?.subTool).toBe("select");
    await clickWorld(page, 300, 300);
    await dragWorld(page, [300, 300], [340, 320]);
    expect((await worldVertices(page, id!))[2]).toEqual({ x: 340, y: 320 });
    // Bend the bottom edge (Ctrl-drag its middle down by 40).
    await dragWorld(page, [220, 310], [220, 350], ["Control"]);
    n = await network(page, id!);
    const bottom = n.segments.findIndex((s) => (s.start === 2 && s.end === 3) || (s.start === 3 && s.end === 2));
    expect(n.segments[bottom]!.tangentStart ?? n.segments[bottom]!.tangentEnd).toBeDefined();
    img = await frame(page);
    near(await worldPixel(page, img, 220, 335), GRAY, "bent edge bulges down");
    // Add a point on the top edge (double-click), then delete it: the edge is as before.
    const before = JSON.stringify((await network(page, id!)).segments.length);
    await clickWorld(page, 200, 100, { clickCount: 2 });
    expect((await network(page, id!)).vertices).toHaveLength(7);
    await page.keyboard.press("Delete");
    n = await network(page, id!);
    expect(n.vertices).toHaveLength(6);
    expect(JSON.stringify(n.segments.length)).toBe(before);
    expect(n.segments.find((s) => s.start === 0 || s.end === 0) !== undefined).toBe(true);
    // Paint bucket: unfill the face, then fill it again.
    await page.keyboard.press("b");
    expect((await session(page))?.subTool).toBe("bucket");
    await clickWorld(page, 200, 200);
    expect((await network(page, id!)).regions).toHaveLength(0);
    img = await frame(page);
    near(await worldPixel(page, img, 200, 200), BG, "unfilled face");
    await clickWorld(page, 200, 200);
    expect((await network(page, id!)).regions).toHaveLength(1);
    img = await frame(page);
    near(await worldPixel(page, img, 200, 200), GRAY, "filled again");
    await page.keyboard.press("Escape");
    expect(await session(page)).toBeNull();
    await page.evaluate(() => window.__figtree!.editor.select([]));
    img = await frame(page);
    expectGolden(`vector-pen-edit.${backend}`, crop(img, 0, 0, 480, 460));

    // ── Undo everything, then redo everything.
    const final = await snapshot(page);
    await undoAll(page);
    expect(await snapshot(page)).toEqual([]);
    img = await frame(page);
    near(await worldPixel(page, img, 200, 200), BG, "empty after undo");
    await redoAll(page);
    expect(await snapshot(page)).toEqual(final);
    img = await frame(page);
    near(await worldPixel(page, img, 200, 200), GRAY, "back after redo");
  });

  test(`booleans from the menus follow edits of a child; flatten; outline stroke (${backend})`, async ({ page }) => {
    await open(page, backend);
    const pageId = await page.evaluate(() => window.__figtree!.editor.page as string);
    const kids = (): Promise<string[]> => page.evaluate((p) => [...window.__figtree!.doc.tree.childrenOf(p)], pageId);
    // Two overlapping rectangles: union from the toolbar menu.
    await page.keyboard.press("r");
    await dragWorld(page, [100, 100], [200, 200]);
    const [a] = await sel(page);
    await page.keyboard.press("r");
    await dragWorld(page, [150, 150], [250, 250]);
    const [b] = await sel(page);
    await page.evaluate(([x, y]) => window.__figtree!.editor.select([x, y]), [a, b]);
    await page.getByTestId("boolean-menu").click();
    await page.locator('[data-anchor="menu.boolean.union"]').click();
    const [union] = await sel(page);
    expect(await page.evaluate((i) => [window.__figtree!.doc.typeOf(i), window.__figtree!.doc.get(i, "booleanOperation")], union!)).toEqual(["group", "union"]);
    let img = await frame(page);
    near(await worldPixel(page, img, 120, 120), GRAY, "union: first rectangle");
    near(await worldPixel(page, img, 240, 240), GRAY, "union: second rectangle");
    // Edit a child: select it in the layers panel and move it with the arrows (Shift: 10 px).
    await page.getByTestId(`layer-${b}`).click();
    for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+ArrowRight");
    expect(await page.evaluate((i) => window.__figtree!.doc.get(i, "x"), b!)).toBe(180);
    img = await frame(page);
    near(await worldPixel(page, img, 160, 240), BG, "union follows the moved child");
    near(await worldPixel(page, img, 270, 240), GRAY, "union includes the moved child");
    // Change the operation from the layers panel: intersect.
    await page.getByTestId(`layer-boolean-${union}`).click();
    await page.getByTestId("boolean-op-intersect").click();
    expect(await page.evaluate((i) => window.__figtree!.doc.get(i, "booleanOperation"), union!)).toBe("intersect");
    img = await frame(page);
    near(await worldPixel(page, img, 120, 120), BG, "intersect: outside the overlap");
    near(await worldPixel(page, img, 190, 175), GRAY, "intersect: the overlap");

    // Subtract from the context menu.
    await page.keyboard.press("r");
    await dragWorld(page, [400, 100], [550, 250]);
    const [c] = await sel(page);
    await page.keyboard.press("o");
    await dragWorld(page, [450, 150], [600, 300]);
    const [d] = await sel(page);
    await page.evaluate(([x, y]) => window.__figtree!.editor.select([x, y]), [c, d]);
    await page.mouse.click(...(await at(page, 420, 120)), { button: "right" });
    await page.getByTestId("menu-boolean.subtract").click();
    const [sub] = await sel(page);
    expect(await page.evaluate((i) => window.__figtree!.doc.get(i, "booleanOperation"), sub!)).toBe("subtract");
    img = await frame(page);
    near(await worldPixel(page, img, 420, 120), GRAY, "subtract keeps the bottom shape");
    near(await worldPixel(page, img, 530, 230), BG, "subtract removes the ellipse");

    // Flatten (Ctrl+E): one vector that looks the same.
    await page.keyboard.press("Control+e");
    const [flat] = await sel(page);
    expect(await page.evaluate((i) => window.__figtree!.doc.typeOf(i), flat!)).toBe("vector");
    expect(await kids()).not.toContain(sub);
    img = await frame(page);
    near(await worldPixel(page, img, 420, 120), GRAY, "flattened: kept area");
    near(await worldPixel(page, img, 530, 230), BG, "flattened: hole");
    // The flattened vector's points are editable.
    await page.keyboard.press("Enter");
    expect((await session(page))?.nodeId).toBe(flat);
    await page.keyboard.press("Escape");

    // Outline stroke (Shift+Ctrl+O): a line's stroke becomes a filled vector.
    await page.keyboard.press("l");
    await dragWorld(page, [100, 400], [400, 400]);
    const [line] = await sel(page);
    await page.locator('[data-anchor="design.strokes.weight"]').fill("12");
    await page.locator('[data-anchor="design.strokes.weight"]').press("Enter");
    await page.keyboard.press("Shift+Control+o");
    const [outlined] = await sel(page);
    expect(await page.evaluate((i) => [window.__figtree!.doc.typeOf(i), (window.__figtree!.doc.get(i, "strokes") as unknown[]).length, (window.__figtree!.doc.get(i, "fills") as unknown[]).length], outlined!)).toEqual(["vector", 0, 1]);
    expect(await kids()).not.toContain(line);
    img = await frame(page);
    near(await worldPixel(page, img, 250, 404), [0, 0, 0], "outlined stroke filled black");
    near(await worldPixel(page, img, 250, 410), BG, "outside the 12 px band");

    // Undo everything, redo everything.
    const final = await snapshot(page);
    await undoAll(page);
    expect(await snapshot(page)).toEqual([]);
    await redoAll(page);
    expect(await snapshot(page)).toEqual(final);
    img = await frame(page);
    near(await worldPixel(page, img, 190, 175), GRAY, "intersect after redo");
    near(await worldPixel(page, img, 250, 404), [0, 0, 0], "outline after redo");
  });

  test(`pencil; paste SVG and edit its points; copy as SVG (${backend})`, async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await open(page, backend);
    // A closed pencil stroke: a circle of radius 80 around (200, 200).
    await page.keyboard.press("Shift+P");
    expect(await page.evaluate(() => window.__figtree!.editor.tool.id)).toBe("pencil");
    await page.mouse.move(...(await at(page, 280, 200)));
    await page.mouse.down();
    for (let i = 1; i <= 64; i++) {
      const t = (i / 64) * Math.PI * 2;
      await page.mouse.move(...(await at(page, 200 + Math.cos(t) * 80, 200 + Math.sin(t) * 80)));
    }
    await page.mouse.up();
    const [pencil] = await sel(page);
    const pn = await network(page, pencil!);
    expect(pn.regions).toHaveLength(1);
    expect(pn.segments.length).toBeLessThan(16);
    let img = await frame(page);
    near(await worldPixel(page, img, 200, 200), GRAY, "pencil stroke filled");
    dark(await worldPixel(page, img, 280, 200), "pencil stroke");
    await page.keyboard.press("v");

    // Paste an SVG path: an editable vector.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><path d="M10 10 C 60 -20 140 40 190 10 L 190 90 L 10 90 Z" fill="#00aa00"/></svg>`;
    await page.evaluate((s) => {
      const dt = new DataTransfer();
      dt.setData("text/plain", s);
      document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
    }, svg);
    await expect.poll(() => sel(page).then((s) => s.length)).toBe(1);
    const [svgFrame] = await sel(page);
    const vec = await page.evaluate((f) => (window.__figtree!.doc.tree.subtree(f) as string[]).find((i) => window.__figtree!.doc.typeOf(i) === "vector")!, svgFrame!);
    const pts = await worldVertices(page, vec);
    await page.evaluate((v) => window.__figtree!.editor.select([v]), vec);
    await page.keyboard.press("Enter");
    expect((await session(page))?.nodeId).toBe(vec);
    // Drag the bottom-left point 40 px right and 30 px up (inside the pasted frame, which clips).
    const p3 = pts[3]!;
    img = await frame(page);
    near(await worldPixel(page, img, p3.x + 5, p3.y - 5), [0, 170, 0], "the corner before the edit");
    await clickWorld(page, p3.x, p3.y);
    await dragWorld(page, [p3.x, p3.y], [p3.x + 40, p3.y - 30]);
    expect((await worldVertices(page, vec))[3]).toEqual({ x: p3.x + 40, y: p3.y - 30 });
    await page.keyboard.press("Escape");
    img = await frame(page);
    near(await worldPixel(page, img, p3.x + 5, p3.y - 5), BG, "the corner after moving its point");
    near(await worldPixel(page, img, p3.x + 100, p3.y - 40), [0, 170, 0], "still filled above the new edge");

    // Copy as SVG from the context menu, then paste the markup back.
    await page.mouse.click(...(await at(page, 200, 200)), { button: "right" });
    await page.getByTestId("menu-edit.copyAsSvg").click();
    const copied = await page.evaluate(() => window.__figtree!.copiedSvg());
    expect(copied).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    const fromClipboard = await page.evaluate(() => navigator.clipboard.readText().catch(() => null));
    if (fromClipboard !== null) expect(fromClipboard).toBe(copied);
    await page.evaluate(() => window.__figtree!.editor.select([]));
    await page.evaluate((s) => {
      const dt = new DataTransfer();
      dt.setData("text/plain", s!);
      document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
    }, copied);
    await expect.poll(() => sel(page).then((s) => s.length)).toBe(1);
    const [pasted] = await sel(page);
    const bounds = await page.evaluate((i) => window.__figtree!.editor.geometry.bounds(i), pasted!);
    const orig = await page.evaluate((i) => window.__figtree!.editor.geometry.bounds(i), pencil!);
    expect(Math.abs(bounds.width - orig.width)).toBeLessThan(3);

    // Undo everything, redo everything.
    const final = await snapshot(page);
    await undoAll(page);
    expect(await snapshot(page)).toEqual([]);
    await redoAll(page);
    expect(await snapshot(page)).toEqual(final);
  });
}
