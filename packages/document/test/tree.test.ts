import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ROOT_ID, Tree, type NodeType, type Placement } from "../src";

type Raw = Map<string, { type: NodeType; placement: Placement | undefined }>;

function raw(entries: [string, NodeType, string, string, number, { parent: string; key: string }?][]): Raw {
  return new Map(entries.map(([id, type, parent, key, clock, prev]) => [id, { type, placement: { parent, key, clock, ...(prev ? { prev } : {}) } }]));
}

describe("Tree", () => {
  it("orders children by key, then id", () => {
    const t = new Tree(raw([
      ["p", "page", ROOT_ID, "V", 1],
      ["b", "rectangle", "p", "V", 2],
      ["a", "rectangle", "p", "V", 3],
      ["c", "rectangle", "p", "1", 4],
    ]));
    expect(t.childrenOf("p")).toEqual(["c", "a", "b"]);
    expect(t.pages).toEqual(["p"]);
    expect(t.maxClock).toBe(4);
  });

  it("sends a node whose parent is gone back to its previous parent, or drops it", () => {
    const t = new Tree(raw([
      ["p", "page", ROOT_ID, "V", 1],
      ["f", "frame", "p", "V", 2],
      ["moved", "rectangle", "gone", "V", 5, { parent: "f", key: "a" }],
      ["born", "rectangle", "gone", "V", 6],
      ["child", "rectangle", "born", "V", 7],
    ]));
    expect(t.parentOf("moved")).toBe("f");
    expect(t.repaired.get("moved")).toBe("previous-parent");
    expect(t.has("born")).toBe(false);
    expect(t.has("child")).toBe(false);
    expect([...t.dropped].sort()).toEqual(["born", "child"]);
  });

  it("breaks a cycle by undoing the latest move", () => {
    // Concurrently: x moved into y (clock 10) and y moved into x (clock 11).
    const t = new Tree(raw([
      ["p", "page", ROOT_ID, "V", 1],
      ["x", "frame", "y", "V", 10, { parent: "p", key: "a" }],
      ["y", "frame", "x", "V", 11, { parent: "p", key: "b" }],
    ]));
    expect(t.parentOf("x")).toBe("y");
    expect(t.parentOf("y")).toBe("p");
    expect(t.repaired.get("y")).toBe("previous-parent");
  });

  it("falls back to the first page when the previous placement is in the cycle too", () => {
    const t = new Tree(raw([
      ["p2", "page", ROOT_ID, "b", 1],
      ["p1", "page", ROOT_ID, "a", 1],
      ["x", "frame", "y", "V", 10],
      ["y", "frame", "x", "V", 11, { parent: "x", key: "c" }],
    ]));
    expect(t.parentOf("y")).toBe("p1");
    expect(t.repaired.get("y")).toBe("first-page");
    expect(t.parentOf("x")).toBe("y");
  });

  it("rejects children under leaves and layers at the root", () => {
    const t = new Tree(raw([
      ["p", "page", ROOT_ID, "V", 1],
      ["r", "rectangle", "p", "V", 2],
      ["bad", "ellipse", "r", "V", 3],
      ["top", "frame", ROOT_ID, "V", 4],
    ]));
    expect(t.has("bad")).toBe(false);
    expect(t.has("top")).toBe(false);
  });

  it("always produces a valid tree from arbitrary placements, independent of input order", () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g"];
    const types: NodeType[] = ["frame", "group", "rectangle", "frame", "group", "frame", "text"];
    const target = fc.constantFrom("p", "q", "zz", ...ids);
    const node = fc.record({ parent: target, prev: fc.option(target, { nil: undefined }), clock: fc.nat(20), key: fc.constantFrom("a", "b", "V") });
    fc.assert(
      fc.property(fc.array(node, { minLength: ids.length, maxLength: ids.length }), fc.boolean(), (nodes, reverse) => {
        const entries: [string, { type: NodeType; placement: Placement }][] = [
          ["p", { type: "page", placement: { parent: ROOT_ID, key: "a", clock: 0 } }],
          ["q", { type: "page", placement: { parent: ROOT_ID, key: "b", clock: 0 } }],
        ];
        nodes.forEach((n, i) => {
          entries.push([ids[i]!, { type: types[i]!, placement: { parent: n.parent, key: n.key, clock: n.clock, ...(n.prev ? { prev: { parent: n.prev, key: "a" } } : {}) } }]);
        });
        const t1 = new Tree(new Map(entries));
        const t2 = new Tree(new Map(reverse ? entries.reverse() : entries));
        for (const id of [...ids, "p", "q"]) {
          expect(t1.parentOf(id)).toBe(t2.parentOf(id));
          if (!t1.has(id)) continue;
          // Every node reaches the root.
          let cur: string | undefined = id;
          for (let steps = 0; cur !== ROOT_ID; steps++) {
            expect(steps).toBeLessThan(20);
            cur = t1.parentOf(cur!);
            expect(cur).toBeDefined();
          }
        }
        expect(t1.size + t1.dropped.size).toBe(ids.length + 2);
      }),
      { numRuns: 2000 },
    );
  });
});
