import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadHarfBuzz, type FontRegistry } from "../src/index";
import { buildEngineTree, caseHash, compareText, engineResult, type TextArea } from "../conformance/case";
import { fixtureRegistry } from "../conformance/fonts";
import { readTextFixtures } from "../conformance/fixtures";
import { allTextCases } from "../conformance/index";
import { KNOWN_TEXT_FAILURES } from "../conformance/known-failures";

/**
 * Text conformance without a browser: every case laid out by the engine
 * against the Chromium reference in conformance/fixtures/chromium.json
 * (`npm run conformance:update` regenerates it). A case passes when every
 * box is within 1 px, every line starts at the same character with its
 * baseline within 1 px, and every grapheme's rect is within 1 px.
 */

const fixtures = readTextFixtures();
const cases = allTextCases();
let fonts: FontRegistry;

interface Tally {
  cases: number;
  passed: number;
  boxes: number;
  boxes1: number;
  boxes001: number;
  graphemes: number;
  graphemes1: number;
  graphemes001: number;
  words: number;
  words1: number;
  lines: number;
  breaks: number;
}
const tallies = new Map<string, Tally>();
const tally = (key: string): Tally => {
  let t = tallies.get(key);
  if (!t) tallies.set(key, (t = { cases: 0, passed: 0, boxes: 0, boxes1: 0, boxes001: 0, graphemes: 0, graphemes1: 0, graphemes001: 0, words: 0, words1: 0, lines: 0, breaks: 0 }));
  return t;
};

describe("text conformance (Chromium fixtures)", () => {
  beforeAll(async () => {
    await loadHarfBuzz();
    fonts = fixtureRegistry();
  });

  it("has a fixture for every case, recorded from the current case definition", () => {
    const stale = cases.filter((c) => fixtures.cases[c.name]?.hash !== caseHash(c)).map((c) => c.name);
    expect(stale, "run `npm run conformance:update`").toEqual([]);
  });

  for (const c of cases) {
    const known = KNOWN_TEXT_FAILURES[c.name];
    it(`${c.name}${known ? " (known failure)" : ""}`, () => {
      const ref = fixtures.cases[c.name];
      if (!ref) throw new Error(`no fixture for ${c.name}`);
      const tree = buildEngineTree(c, fonts);
      const actual = engineResult(c, tree);
      const cmp = compareText(c, tree, ref.result, actual);
      if (process.env.CONFORMANCE_DEBUG && c.name.includes(process.env.CONFORMANCE_DEBUG)) console.log(c.name, JSON.stringify(cmp), "\n", cmp.message);
      for (const key of [c.area, "all"]) {
        const t = tally(key);
        t.cases++;
        t.passed += cmp.pass ? 1 : 0;
        t.boxes += cmp.boxes;
        t.boxes1 += cmp.boxesWithin1;
        t.boxes001 += cmp.boxesWithin001;
        t.graphemes += cmp.graphemes;
        t.graphemes1 += cmp.graphemesWithin1;
        t.graphemes001 += cmp.graphemesWithin001;
        t.words += cmp.words;
        t.words1 += cmp.wordsWithin1;
        t.lines += cmp.lines;
        t.breaks += cmp.breaksMatch ? 1 : 0;
      }
      if (known) expect(cmp.pass, `${c.name} passes now: remove it from KNOWN_TEXT_FAILURES`).toBe(false);
      else expect(cmp.pass, cmp.message).toBe(true);
    });
  }

  afterAll(() => {
    const areas: (TextArea | "all")[] = ["basic", "white-space", "breaking", "spacing", "line-height", "align", "fonts", "features", "bidi", "arabic", "devanagari", "cjk", "transform", "truncation", "wrap-style", "sizing", "all"];
    const rows: string[] = [];
    for (const a of areas) {
      const t = tallies.get(a);
      if (!t) continue;
      rows.push(`${a.padEnd(12)} ${String(t.passed).padStart(3)}/${String(t.cases).padEnd(3)} cases; breaks ${t.breaks}/${t.cases}; boxes ${t.boxes1}/${t.boxes} (0.01px ${t.boxes001}); graphemes ${t.graphemes1}/${t.graphemes} (0.01px ${t.graphemes001}); words ${t.words1}/${t.words}; lines ${t.lines}`);
    }
    console.log(`[text conformance]\n${rows.join("\n")}`);
    if (process.env.CONFORMANCE_REPORT) writeFileSync(join(process.cwd(), process.env.CONFORMANCE_REPORT), JSON.stringify(Object.fromEntries(tallies), null, 2) + "\n");
  });
});
