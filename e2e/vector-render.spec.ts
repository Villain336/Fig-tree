import { expect, test, type Page } from "@playwright/test";
import { backends, diff, expectGolden, pixel, type BackendName, type Image } from "./pixels";

/**
 * Vector networks and boolean groups drawn through the document bridge on
 * both backends. The nodes are added to the editor's sample page through the
 * command API, far from the sample's own content, and the view is moved
 * there. Colors are checked at points whose expected coverage is known
 * exactly (well inside or outside every edge), plus a golden per backend.
 */

const ORIGIN = 6000;
const SCALE = 1.25;
const RED = { type: "solid", color: { r: 1, g: 0, b: 0, a: 1 } };
const BLUE = { type: "solid", color: { r: 0, g: 0, b: 1, a: 1 } };
const GREEN = { type: "solid", color: { r: 0, g: 0.6, b: 0, a: 1 } };
const INK = { type: "solid", color: { r: 0, g: 0, b: 0, a: 1 } };
const BG = [238, 238, 234];

async function openEditor(page: Page, backend: BackendName): Promise<string> {
  await page.goto(`/?renderer=${backend}`);
  await page.waitForFunction(() => window.__figtree !== undefined, null, { timeout: 90_000 });
  expect(await page.evaluate(() => window.__figtree!.backend)).toBe(backend);
  await page.evaluate(() => window.__figtree!.fontsReady());
  return page.evaluate(() => (window.__figtree!.doc as unknown as { pages: string[] }).pages[0]!);
}

async function apply(page: Page, commands: unknown[]): Promise<void> {
  const r = await page.evaluate((c) => window.__figtree!.apply(c), commands);
  expect(r, JSON.stringify(r)).not.toHaveProperty("error");
}

async function frame(page: Page): Promise<Image> {
  await page.evaluate(([s, o]) => window.__figtree!.setView(s!, -o! * s! + 20, -o! * s! + 20), [SCALE, ORIGIN]);
  const r = await page.evaluate(() => window.__figtree!.renderPixels());
  return { width: r.width, height: r.height, data: new Uint8Array(Buffer.from(r.pixels, "base64")) };
}

/** The color at a point given relative to ORIGIN, in world units. */
function at(img: Image, x: number, y: number): number[] {
  return pixel(img, Math.floor(20 + x * SCALE), Math.floor(20 + y * SCALE)).slice(0, 3);
}

function expectColor(got: number[], want: readonly number[], label: string, tolerance = 3): void {
  for (let k = 0; k < 3; k++) expect(Math.abs(got[k]! - want[k]!), `${label}: got ${got}, want ${want}`).toBeLessThanOrEqual(tolerance);
}

const v = (x: number, y: number) => ({ x, y });

function scene(page: string): unknown[] {
  const at0 = (dx: number, dy: number) => ({ x: ORIGIN + dx, y: ORIGIN + dy });
  return [
    // 1. A network with branches: a square split by a diagonal, a dangling spur, one triangle filled.
    {
      type: "createNode",
      node: {
        id: "net",
        type: "vector",
        props: {
          ...at0(0, 0),
          width: 100,
          height: 100,
          vectorNetwork: {
            vertices: [v(0, 0), v(100, 0), v(100, 100), v(0, 100), v(130, 50)],
            segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 0 }, { start: 0, end: 2 }, { start: 1, end: 4, tangentStart: { x: 20, y: 0 }, tangentEnd: { x: 0, y: -20 } }],
            regions: [{ loops: [[0, 1, 4]], fillRule: "nonzero", fills: [GREEN] }],
          },
          strokes: [INK],
          strokeWeight: 4,
          strokeJoin: "round",
          strokeCap: "round",
        },
      },
      parent: page,
    },
    // 2. A region with a hole (even-odd), and rounded vertex corners.
    {
      type: "createNode",
      node: {
        id: "holed",
        type: "vector",
        props: {
          ...at0(180, 0),
          width: 100,
          height: 100,
          cornerRadius: 20,
          vectorNetwork: {
            vertices: [v(0, 0), v(100, 0), v(100, 100), v(0, 100), v(30, 30), v(70, 30), v(70, 70), v(30, 70)],
            segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 0 }, { start: 4, end: 5 }, { start: 5, end: 6 }, { start: 6, end: 7 }, { start: 7, end: 4 }],
            regions: [{ loops: [[0, 1, 2, 3], [4, 5, 6, 7]], fillRule: "evenodd" }],
          },
          fills: [BLUE],
        },
      },
      parent: page,
    },
    // 3. Each boolean operation on two overlapping circles (left red, right blue; the group takes red).
    ...(["union", "subtract", "intersect", "exclude"] as const).flatMap((op, i) => [
      { type: "createNode", node: { id: `${op}-a`, type: "ellipse", props: { ...at0(i * 130, 160), width: 80, height: 80, fills: [RED] } }, parent: page },
      { type: "createNode", node: { id: `${op}-b`, type: "ellipse", props: { ...at0(i * 130 + 40, 160), width: 80, height: 80, fills: [BLUE] } }, parent: page },
      { type: "group", ids: [`${op}-a`, `${op}-b`], id: `${op}-g`, booleanOperation: op },
    ]),
  ];
}

for (const backend of backends) {
  test.describe(`vector networks and booleans on ${backend}`, () => {
    test("draws networks with branches, holes, rounded corners and each boolean operation", async ({ page }) => {
      const pageId = await openEditor(page, backend);
      await apply(page, scene(pageId));
      const img = await frame(page);
      // 1. The filled triangle (0,0)-(100,0)-(100,100); the other triangle is empty; strokes on every segment and the spur.
      expectColor(at(img, 75, 25), [0, 153, 0], "filled face");
      expectColor(at(img, 25, 75), BG, "unfilled face");
      expectColor(at(img, 50, 50), [0, 0, 0], "diagonal stroke");
      expectColor(at(img, 0, 50), [0, 0, 0], "left edge stroke");
      // The spur curves from (100,0) to (130,50): its middle is near (122, 19) (Bézier midpoint).
      expectColor(at(img, 122.5, 18.75), [0, 0, 0], "branch stroke", 40);
      // 2. Hole and ring, and rounded corners cut off.
      expectColor(at(img, 180 + 50, 50), BG, "hole");
      expectColor(at(img, 180 + 15, 50), [0, 0, 255], "ring");
      expectColor(at(img, 180 + 2, 2), BG, "rounded corner");
      expectColor(at(img, 180 + 50, 2), [0, 0, 255], "straight edge next to the corner");
      // 3. Booleans. Left-only point (x 15), lens point (x 60), right-only point (x 105), at y 200.
      const y = 200;
      const check = (i: number, left: readonly number[], lens: readonly number[], right: readonly number[], name: string): void => {
        expectColor(at(img, i * 130 + 15, y), left, `${name}: left only`);
        expectColor(at(img, i * 130 + 60, y), lens, `${name}: overlap`);
        expectColor(at(img, i * 130 + 105, y), right, `${name}: right only`);
      };
      check(0, [255, 0, 0], [255, 0, 0], [255, 0, 0], "union");
      check(1, [255, 0, 0], BG, BG, "subtract");
      check(2, BG, [255, 0, 0], BG, "intersect");
      check(3, [255, 0, 0], BG, [255, 0, 0], "exclude");
      // Crop the region of interest for the golden.
      expectGolden(`vector-booleans.${backend}`, crop(img, 0, 0, Math.ceil(40 + 520 * SCALE), Math.ceil(40 + 260 * SCALE)));
    });

    test("redraws a boolean group when an operand moves, and when the operation changes", async ({ page }) => {
      const pageId = await openEditor(page, backend);
      await apply(page, scene(pageId));
      let img = await frame(page);
      expectColor(at(img, 130 + 60, 200), BG, "subtract overlap before");
      // Move the subtracted circle away: the whole red circle shows.
      await apply(page, [{ type: "updateProps", id: "subtract-b", props: { x: ORIGIN + 130 + 300 } }]);
      img = await frame(page);
      expectColor(at(img, 130 + 60, 200), [255, 0, 0], "subtract overlap after the move");
      // Union → intersect on the first group.
      await apply(page, [{ type: "updateProps", id: "union-g", props: { booleanOperation: "intersect" } }]);
      img = await frame(page);
      expectColor(at(img, 15, 200), BG, "intersect left");
      expectColor(at(img, 60, 200), [255, 0, 0], "intersect lens");
      // Back to a plain group: both circles drawn with their own fills.
      await apply(page, [{ type: "updateProps", id: "union-g", props: { booleanOperation: "none" } }]);
      img = await frame(page);
      expectColor(at(img, 15, 200), [255, 0, 0], "plain group: red circle");
      expectColor(at(img, 105, 200), [0, 0, 255], "plain group: blue circle on top");
    });
  });
}

test("both backends agree on vector networks and booleans", async ({ browser }) => {
  const images: Image[] = [];
  for (const backend of backends) {
    const page = await browser.newPage();
    const pageId = await openEditor(page, backend);
    await apply(page, scene(pageId));
    images.push(crop(await frame(page), 0, 0, 1080, 560));
    await page.close();
  }
  const d = diff(images[0]!, images[1]!, 64);
  // Edge pixels differ (exact area vs 4x MSAA); interiors must match.
  expect(d.fractionOver).toBeLessThan(0.01);
});

function crop(img: Image, x0: number, y0: number, w: number, h: number): Image {
  const width = Math.min(w, img.width - x0), height = Math.min(h, img.height - y0);
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) data.set(img.data.subarray(((y + y0) * img.width + x0) * 4, ((y + y0) * img.width + x0 + width) * 4), y * width * 4);
  return { width, height, data };
}
