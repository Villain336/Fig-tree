import type { LayoutCase } from "./case";
import { flexCases } from "./cases/flex";
import { gridCases } from "./cases/grid";
import { positionCases } from "./cases/position";
import { randomFlexCases, randomGridCases } from "./random";

/** Every conformance case, in a stable order. */
export function allCases(): LayoutCase[] {
  const cases = [...flexCases, ...randomFlexCases(200), ...randomFlexCases(200, 5000), ...gridCases, ...randomGridCases(250), ...randomGridCases(250, 7000), ...positionCases];
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.name)) throw new Error(`duplicate conformance case ${c.name}`);
    seen.add(c.name);
  }
  return cases;
}
