import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TextReference } from "./case";

/** Chromium reference results, one entry per case. */
export interface TextFixtures {
  readonly browser: string;
  readonly cases: Record<string, { readonly hash: string; readonly result: TextReference }>;
}

export const TEXT_FIXTURE_PATH = join(process.cwd(), "packages", "text", "conformance", "fixtures", "chromium.json");

export function readTextFixtures(path = TEXT_FIXTURE_PATH): TextFixtures {
  if (!existsSync(path)) return { browser: "", cases: {} };
  return JSON.parse(readFileSync(path, "utf8")) as TextFixtures;
}

/** One case per line, so diffs stay readable. */
export function writeTextFixtures(f: TextFixtures, path = TEXT_FIXTURE_PATH): void {
  const names = Object.keys(f.cases).sort();
  const round = (v: unknown): unknown => (typeof v === "number" ? Math.round(v * 1e4) / 1e4 : Array.isArray(v) ? v.map(round) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x)])) : v);
  const lines = names.map((n) => `    ${JSON.stringify(n)}: ${JSON.stringify(round(f.cases[n]))}`);
  writeFileSync(path, `{\n  "browser": ${JSON.stringify(f.browser)},\n  "cases": {\n${lines.join(",\n")}\n  }\n}\n`);
}
