import type { TextCase } from "./case";
import { basicCases } from "./cases/basic";
import { layoutCases } from "./cases/layout";
import { lineCases } from "./cases/lines";
import { scriptCases } from "./cases/scripts";

/** Every text conformance case, in a stable order. */
export function allTextCases(): TextCase[] {
  const cases = [...basicCases, ...lineCases, ...scriptCases, ...layoutCases];
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.name)) throw new Error(`duplicate text conformance case ${c.name}`);
    seen.add(c.name);
  }
  return cases;
}
