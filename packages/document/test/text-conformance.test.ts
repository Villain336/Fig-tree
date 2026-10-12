import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadHarfBuzz, type FontRegistry } from "@fig-tree/text";
import { caseHash, compareText } from "../../text/conformance/case";
import { fixtureRegistry } from "../../text/conformance/fonts";
import { readTextFixtures } from "../../text/conformance/fixtures";
import { documentTextCases, documentTextResult } from "./conformance/text-cases";

/**
 * Documents with text against Chromium: each document is rendered in
 * Chromium from the CSS it states (`cssDeclarations` for nodes,
 * `textStyleDeclarations` for runs, `<p>`s for paragraphs), with the fixture
 * fonts (test/conformance/text-chromium.json, from `npm run
 * conformance:update`). The bridge's DocumentLayout, measuring text with the
 * text engine, must produce the same boxes, line breaks, baselines and
 * grapheme rects within 1 px.
 */

export const DOCUMENT_TEXT_FIXTURES = join(process.cwd(), "packages", "document", "test", "conformance", "text-chromium.json");
const fixtures = readTextFixtures(DOCUMENT_TEXT_FIXTURES);
const cases = documentTextCases();
let fonts: FontRegistry;

describe("document text conformance (Chromium fixtures)", () => {
  beforeAll(async () => {
    await loadHarfBuzz();
    fonts = fixtureRegistry();
  });

  it("has a fixture for every case", () => {
    expect(cases.filter((c) => fixtures.cases[c.case.name]?.hash !== caseHash(c.case)).map((c) => c.case.name), "run `npm run conformance:update`").toEqual([]);
  });

  const totals = { cases: 0, passed: 0, boxes: 0, boxes1: 0, boxes001: 0, graphemes: 0, graphemes1: 0, graphemesUnit: 0, lines: 0, maxError: 0 };
  for (const dc of cases) {
    it(dc.case.name, () => {
      const ref = fixtures.cases[dc.case.name]!.result;
      const { result, sources } = documentTextResult(dc, fonts);
      const cmp = compareText(sources, ref, result);
      totals.cases++;
      totals.passed += cmp.pass ? 1 : 0;
      totals.boxes += cmp.boxes;
      totals.boxes1 += cmp.boxesWithin1;
      totals.graphemes += cmp.graphemes;
      totals.graphemes1 += cmp.graphemesWithin1;
      totals.graphemesUnit += cmp.graphemesWithinUnit;
      totals.boxes001 += cmp.boxesWithin001;
      totals.lines += cmp.lines;
      totals.maxError = Math.max(totals.maxError, cmp.maxError);
      expect(cmp.pass, cmp.message).toBe(true);
    });
  }

  it("reports", () => {
    console.log(`[document text conformance] ${totals.passed}/${totals.cases} documents; boxes ${totals.boxes1}/${totals.boxes} (0.01px ${totals.boxes001}); graphemes ${totals.graphemes1}/${totals.graphemes} (1/64px ${totals.graphemesUnit}); lines ${totals.lines}; max error ${totals.maxError.toFixed(4)} px`);
  });
});
