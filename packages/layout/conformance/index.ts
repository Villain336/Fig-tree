import type { LayoutCase } from "./case";
import { flexCases } from "./cases/flex";
import { randomFlexCases } from "./random";

/** Every conformance case, in a stable order. */
export function allCases(): LayoutCase[] {
  const cases = [...flexCases, ...randomFlexCases(200), ...randomFlexCases(200, 5000)];
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.name)) throw new Error(`duplicate conformance case ${c.name}`);
    seen.add(c.name);
  }
  return cases;
}
