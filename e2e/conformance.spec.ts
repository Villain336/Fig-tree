import { expect, test } from "@playwright/test";
import { caseHash, caseHtml, compare, engineRects, MEASURE_SCRIPT, pageHtml, type Rect4 } from "../packages/layout/conformance/case";
import { readFixtures, writeFixtures, type Fixtures } from "../packages/layout/conformance/fixtures";
import { allCases } from "../packages/layout/conformance/index";
import { KNOWN_FAILURES } from "../packages/layout/conformance/known-failures";

/**
 * The layout conformance suite, live in Chromium. Every case is rendered as
 * HTML and every box's border box (getBoundingClientRect, DPR 1) is
 * recorded. With UPDATE_CONFORMANCE=1 (`npm run conformance:update`) the
 * results are written to packages/layout/conformance/fixtures/chromium.json,
 * which `npm test` compares against without a browser. Without it, this
 * test re-verifies the engine against the live browser and checks that the
 * stored fixtures are still what this Chromium renders.
 */

test.use({ viewport: { width: 1000, height: 800 }, deviceScaleFactor: 1 });

test("layout conformance against Chromium", async ({ page, browser }) => {
  const update = process.env.UPDATE_CONFORMANCE === "1";
  const fixtures = readFixtures();
  const out: Fixtures = { browser: `Chromium ${browser.version()}`, cases: {} };
  const failures: string[] = [];
  const drift: string[] = [];
  const only = process.env.CONFORMANCE_FILTER;
  for (const c of allCases()) {
    if (only && !c.name.includes(only)) continue;
    await page.setContent(pageHtml(caseHtml(c)));
    const rects = (await page.evaluate(MEASURE_SCRIPT)) as Rect4[];
    out.cases[c.name] = { hash: caseHash(c), rects };
    const stored = fixtures.cases[c.name];
    if (!update && (!stored || stored.hash !== caseHash(c) || JSON.stringify(stored.rects) !== JSON.stringify(rects))) drift.push(c.name);
    const cmp = compare(c, rects, engineRects(c));
    const pass = cmp.maxError <= 1;
    if (pass === c.name in KNOWN_FAILURES) failures.push(`${c.name}: ${pass ? "passes but is listed as a known failure" : `box ${cmp.worst?.index} expected ${JSON.stringify(cmp.worst?.expected)} got ${JSON.stringify(cmp.worst?.actual)}`}`);
  }
  if (update) {
    // Keep fixtures of cases outside the filter; drop those of cases that no longer exist.
    const names = new Set(allCases().map((c) => c.name));
    const merged = only ? { ...fixtures.cases, ...out.cases } : out.cases;
    writeFixtures({ browser: out.browser, cases: Object.fromEntries(Object.entries(merged).filter(([k]) => names.has(k))) });
    return;
  }
  expect(drift, "fixtures are stale: run `npm run conformance:update`").toEqual([]);
  expect(failures).toEqual([]);
});
