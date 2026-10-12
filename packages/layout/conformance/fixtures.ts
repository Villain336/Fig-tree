import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Rect4 } from "./case";

/** Chromium reference boxes, one entry per case. */
export interface Fixtures {
  readonly browser: string;
  readonly cases: Record<string, { readonly hash: string; readonly rects: Rect4[] }>;
}

/** Fixture file, relative to the repository root (tests run from there). */
export const FIXTURE_PATH = join(process.cwd(), "packages", "layout", "conformance", "fixtures", "chromium.json");

export function readFixtures(): Fixtures {
  if (!existsSync(FIXTURE_PATH)) return { browser: "", cases: {} };
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixtures;
}

/** Writes fixtures with one case per line, so diffs stay readable. */
export function writeFixtures(f: Fixtures): void {
  const names = Object.keys(f.cases).sort();
  const lines = names.map((n) => `    ${JSON.stringify(n)}: ${JSON.stringify(f.cases[n])}`);
  writeFileSync(FIXTURE_PATH, `{\n  "browser": ${JSON.stringify(f.browser)},\n  "cases": {\n${lines.join(",\n")}\n  }\n}\n`);
}
