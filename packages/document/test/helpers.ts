import { expect } from "vitest";
import { FigDocument, ROOT_ID, canContain, seededRandom, type Actor } from "../src";

/** A fresh document with one page, reproducible from `seed`. */
export function makeDoc(seed = 1, clientId = 1): { doc: FigDocument; page: string; user: Actor } {
  const doc = FigDocument.create({ random: seededRandom(seed), clientId });
  return { doc, page: doc.pages[0]!, user: doc.actor("alice") };
}

/** Asserts the effective tree invariants: rooted, acyclic, typed correctly, consistent child lists. */
export function expectValidTree(doc: FigDocument): void {
  const tree = doc.tree;
  let count = 0;
  const seen = new Set<string>();
  const walk = (id: string, depth: number): void => {
    expect(depth).toBeLessThan(10_000);
    for (const c of tree.childrenOf(id)) {
      expect(seen.has(c), `${c} appears twice`).toBe(false);
      seen.add(c);
      count++;
      expect(tree.parentOf(c)).toBe(id);
      const parentType = id === ROOT_ID ? null : doc.typeOf(id)!;
      expect(canContain(parentType, doc.typeOf(c)!), `${doc.typeOf(c)} under ${parentType}`).toBe(true);
      walk(c, depth + 1);
    }
  };
  walk(ROOT_ID, 0);
  // Every node in the tree is reachable from the root.
  expect(count).toBe(tree.size);
  for (const id of tree.ids()) expect(seen.has(id)).toBe(true);
}
