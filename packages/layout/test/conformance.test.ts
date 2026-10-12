import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { caseHash, compare, engineRects, flatten, type Area, type LayoutCase, type Rect4 } from "../conformance/case";
import { readFixtures } from "../conformance/fixtures";
import { allCases } from "../conformance/index";
import { KNOWN_FAILURES } from "../conformance/known-failures";

/**
 * Chromium conformance without a browser: every case's boxes, as laid out
 * by our engine, against the Chromium reference stored in
 * conformance/fixtures/chromium.json (`npm run conformance:update`
 * regenerates it). A box passes within 1 px on x, y, width and height.
 * Cases in KNOWN_FAILURES must fail (with their reason recorded there);
 * every other case must pass.
 */

const fixtures = readFixtures();
const cases = allCases();

interface Tally {
  cases: number;
  passed: number;
  boxes: number;
  within1: number;
  within001: number;
}
const tallies = new Map<string, Tally>();
const tally = (key: string): Tally => {
  let t = tallies.get(key);
  if (!t) tallies.set(key, (t = { cases: 0, passed: 0, boxes: 0, within1: 0, within001: 0 }));
  return t;
};

describe("layout conformance (Chromium fixtures)", () => {
  it("has a fixture for every case, recorded from the current case definition", () => {
    const stale = cases.filter((c) => fixtures.cases[c.name]?.hash !== caseHash(c)).map((c) => c.name);
    expect(stale, "run `npm run conformance:update`").toEqual([]);
  });

  for (const c of cases) {
    const known = KNOWN_FAILURES[c.name];
    it(`${c.name}${known ? " (known failure)" : ""}`, () => {
      const ref = fixtures.cases[c.name];
      if (!ref) throw new Error(`no fixture for ${c.name}`);
      const actual = engineRects(c);
      const cmp = compare(c, ref.rects, actual);
      if (process.env.CONFORMANCE_DEBUG && c.name.includes(process.env.CONFORMANCE_DEBUG)) console.log(dump(c, ref.rects, actual));
      const pass = cmp.maxError <= 1;
      for (const key of [c.area, `${c.area}/${c.kind}`, "all"]) {
        const t = tally(key);
        t.cases++;
        t.passed += pass ? 1 : 0;
        t.boxes += cmp.boxes;
        t.within1 += cmp.within1;
        t.within001 += cmp.within001;
      }
      if (known) {
        expect(pass, `${c.name} passes now: remove it from KNOWN_FAILURES`).toBe(false);
      } else {
        const w = cmp.worst;
        expect(pass, w ? `box #${w.index}: expected ${JSON.stringify(w.expected)}, got ${JSON.stringify(w.actual.map((v) => Math.round(v * 1000) / 1000))} (max error ${cmp.maxError.toFixed(3)} px)` : "").toBe(true);
      }
    });
  }

  afterAll(() => {
    const areas: (Area | "all")[] = ["flex", "grid", "box", "block", "position", "all"];
    const rows: string[] = [];
    for (const area of areas) {
      for (const key of [area, `${area}/hand`, `${area}/random`]) {
        const t = tallies.get(key);
        if (!t || (key !== area && t.cases === tallies.get(area)?.cases)) continue;
        rows.push(`${key.padEnd(16)} ${String(t.passed).padStart(4)}/${String(t.cases).padEnd(4)} cases; boxes within 1px ${t.within1}/${t.boxes}, within 0.01px ${t.within001}/${t.boxes}`);
      }
    }
    console.log(`[layout conformance]\n${rows.join("\n")}`);
    if (process.env.CONFORMANCE_REPORT) {
      writeFileSync(join(process.cwd(), process.env.CONFORMANCE_REPORT), JSON.stringify(Object.fromEntries(tallies), null, 2) + "\n");
    }
  });
});

/** A case's tree with expected and actual boxes (CONFORMANCE_DEBUG=<name part>). */
function dump(c: LayoutCase, expected: readonly Rect4[], actual: readonly Rect4[]): string {
  const lines = [c.name];
  const nodes = flatten(c.root);
  const depth = new Map<unknown, number>([[c.root, 0]]);
  for (const n of nodes) for (const ch of n.children ?? []) depth.set(ch, depth.get(n)! + 1);
  const r = (v: readonly number[] | undefined): string => (v ? v.map((x) => Math.round(x * 100) / 100).join(",") : "-");
  nodes.forEach((n, i) => {
    const bad = expected[i]!.some((v, k) => Math.abs(v - actual[i]![k]!) > 1);
    const extra = n.text ? ` text=${JSON.stringify(n.text)}` : n.replaced ? ` replaced=${n.replaced}` : "";
    lines.push(`${bad ? "!!" : "  "} ${"  ".repeat(depth.get(n)!)}#${i} {${n.style ?? ""}}${extra}\n${" ".repeat(4 + 2 * depth.get(n)!)}chromium ${r(expected[i])}  engine ${r(actual[i])}`);
  });
  return lines.join("\n");
}
