import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadHarfBuzz } from "../packages/text/src/index";
import { buildEngineTree, caseHash, caseHtml, compareText, engineResult, MEASURE_SCRIPT, pageHtml, type TextReference } from "../packages/text/conformance/case";
import { FONT_DIR, FONT_ORIGIN, fixtureRegistry } from "../packages/text/conformance/fonts";
import { readTextFixtures, writeTextFixtures, type TextFixtures } from "../packages/text/conformance/fixtures";
import { allTextCases } from "../packages/text/conformance/index";
import { KNOWN_TEXT_FAILURES } from "../packages/text/conformance/known-failures";
import { documentTextCases, documentTextResult } from "../packages/document/test/conformance/text-cases";
import type { FontRegistry } from "../packages/text/src/index";
import type { TextCase } from "../packages/text/conformance/case";

/** A suite: its cases, fixture file, and how the engine side is computed. */
interface Suite {
  readonly name: string;
  readonly path: string;
  readonly cases: () => { case: TextCase; engine: (fonts: FontRegistry) => { result: TextReference; sources: string[] } }[];
}

const SUITES: Suite[] = [
  {
    name: "text",
    path: join(process.cwd(), "packages", "text", "conformance", "fixtures", "chromium.json"),
    cases: () =>
      allTextCases().map((c) => ({
        case: c,
        engine: (fonts) => {
          const tree = buildEngineTree(c, fonts);
          return { result: engineResult(c, tree), sources: tree.texts.map((t) => t.source) };
        },
      })),
  },
  {
    name: "document text",
    path: join(process.cwd(), "packages", "document", "test", "conformance", "text-chromium.json"),
    cases: () => documentTextCases().map((dc) => ({ case: dc.case, engine: (fonts) => documentTextResult(dc, fonts) })),
  },
];

/**
 * The text conformance suite, live in Chromium: each case is rendered as
 * HTML with the fixture fonts (served from fixtures/fonts by a route), and
 * its boxes, line breaks and grapheme rects are recorded. With
 * UPDATE_CONFORMANCE=1 the results are written to
 * packages/text/conformance/fixtures/chromium.json, which `npm test`
 * compares against without a browser. Otherwise this re-verifies the
 * engine against the live browser and checks the stored fixtures.
 */

test.use({ viewport: { width: 1000, height: 800 }, deviceScaleFactor: 1 });

for (const suite of SUITES) {
  test(`${suite.name} conformance against Chromium`, async ({ page, browser }) => {
    await loadHarfBuzz();
    await page.route(`${FONT_ORIGIN}**`, (route) => {
      const file = decodeURI(new URL(route.request().url()).pathname.slice(1));
      route.fulfill({ body: readFileSync(join(FONT_DIR, file)), contentType: file.endsWith(".woff2") ? "font/woff2" : "font/ttf", headers: { "access-control-allow-origin": "*" } });
    });
    const update = process.env.UPDATE_CONFORMANCE === "1";
    const fixtures = readTextFixtures(suite.path);
    const out: TextFixtures = { browser: `Chromium ${browser.version()}`, cases: {} };
    const failures: string[] = [];
    const drift: string[] = [];
    const only = process.env.CONFORMANCE_FILTER;
    const fonts = fixtureRegistry();
    const cases = suite.cases();
    for (const { case: c, engine } of cases) {
      if (only && !c.name.includes(only)) continue;
      await page.setContent(pageHtml(caseHtml(c)));
      const result = (await page.evaluate(MEASURE_SCRIPT)) as TextReference;
      out.cases[c.name] = { hash: caseHash(c), result };
      const stored = fixtures.cases[c.name];
      if (!update && (!stored || stored.hash !== caseHash(c) || JSON.stringify(roundAll(stored.result)) !== JSON.stringify(roundAll(result)))) drift.push(c.name);
      const mine = engine(fonts);
      const cmp = compareText(mine.sources, result, mine.result);
      if (cmp.pass === c.name in KNOWN_TEXT_FAILURES) failures.push(`${c.name}: ${cmp.pass ? "passes but is listed as a known failure" : cmp.message}`);
    }
    if (update) {
      const names = new Set(cases.map((c) => c.case.name));
      const merged = only ? { ...fixtures.cases, ...out.cases } : out.cases;
      writeTextFixtures({ browser: out.browser, cases: Object.fromEntries(Object.entries(merged).filter(([k]) => names.has(k))) }, suite.path);
      return;
    }
    expect(drift, "fixtures are stale: run `npm run conformance:update`").toEqual([]);
    expect(failures).toEqual([]);
  });
}

function roundAll(v: unknown): unknown {
  return typeof v === "number" ? Math.round(v * 1e4) / 1e4 : Array.isArray(v) ? v.map(roundAll) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, roundAll(x)])) : v;
}
