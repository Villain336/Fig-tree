import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CommandError, FigDocument, diffDocuments, isEmptyDiff, propose, seededRandom, type Command } from "../src";
import { serializeFigtreeJson, toFigtreeJson } from "../src/format/json";
import { randomCommand } from "./convergence-harness";
import { expectValidTree, makeDoc } from "./helpers";

const json = (doc: FigDocument): string => serializeFigtreeJson(toFigtreeJson(doc));
const BLUE = [{ type: "solid" as const, color: { r: 0, g: 0, b: 1, a: 1 } }];

function sampleDoc() {
  const { doc, page, user } = makeDoc(5);
  doc.apply(
    [
      { type: "createNode", node: { id: "card", type: "frame", props: { name: "Card", x: 0, y: 0, width: 320, height: 200 } }, parent: page },
      { type: "createNode", node: { id: "title", type: "text", text: { content: "Hello", runs: [] } }, parent: "card" },
      { type: "createNode", node: { id: "badge", type: "ellipse", props: { name: "Badge" } }, parent: "card" },
      { type: "createNode", node: { id: "old", type: "rectangle", props: { name: "Old" } }, parent: page },
    ],
    user,
  );
  return { doc, page, user, agent: doc.actor("sprout", "agent") };
}

describe("proposals", () => {
  it("apply a batch to a fork and describe it as a structured diff, leaving the document untouched", () => {
    const { doc, page, agent } = sampleDoc();
    const before = doc.encodeState();
    const p = propose(
      doc,
      [
        { type: "updateProps", id: "card", props: { fills: BLUE, cornerRadius: 12 } },
        { type: "insertText", id: "title", index: 5, text: ", world" },
        { type: "createNode", node: { id: "cta", type: "frame", props: { name: "Button" } }, parent: "card" },
        { type: "createNode", node: { id: "label", type: "text", text: { content: "Go", runs: [] } }, parent: "cta" },
        { type: "setParent", ids: ["badge"], parent: page, keepPosition: false },
        { type: "delete", ids: ["old"] },
        { type: "setDocumentName", name: "Proposed" },
      ],
      agent,
    );
    expect(doc.encodeState()).toEqual(before);
    expect(p.status).toBe("open");
    const d = p.diff;
    expect(d.created.map((c) => [c.id, c.type, c.at.parent])).toEqual([["cta", "frame", "card"], ["label", "text", "cta"]]);
    expect(d.created[1]!.text).toEqual({ content: "Go", runs: [] });
    expect(d.deleted).toEqual([{ id: "old", type: "rectangle", at: { parent: page, index: 1 }, name: "Old" }]);
    expect(d.moved).toEqual([{ id: "badge", type: "ellipse", from: { parent: "card", index: 1 }, to: { parent: page, index: 1 } }]);
    const card = d.updated.find((u) => u.id === "card")!;
    expect(card.changes).toEqual([
      { key: "cornerRadius", before: undefined, after: 12 },
      { key: "fills", before: undefined, after: BLUE },
    ]);
    expect(d.updated.find((u) => u.id === "title")!.text).toEqual({ before: { content: "Hello", runs: [] }, after: { content: "Hello, world", runs: [] } });
    expect(d.name).toEqual({ before: "Untitled", after: "Proposed" });
    // The diff restricted to written nodes equals a full comparison of both documents.
    expect(diffDocuments(doc, p.fork)).toEqual(d);
  });

  it("accept merges exactly the proposed state, as one undo step of the acceptor", () => {
    const { doc, user, agent } = sampleDoc();
    const before = json(doc);
    const p = propose(doc, [{ type: "updateProps", id: "card", props: { fills: BLUE } }, { type: "delete", ids: ["badge"] }], agent);
    const expected = json(p.fork);
    const r = p.accept(user);
    expect(p.status).toBe("accepted");
    expect(r.affected).toContain("card");
    expect(json(doc)).toBe(expected);
    expect(doc.undo(user)).toBe(true);
    expect(json(doc)).toBe(before);
    expect(() => p.accept()).toThrow(/already accepted/);
  });

  it("reject leaves the document byte-for-byte unchanged", () => {
    const { doc, agent } = sampleDoc();
    const state = doc.encodeState();
    const vector = doc.stateVector();
    let transactions = 0;
    doc.ydoc.on("afterTransaction", () => transactions++);
    const p = propose(doc, [{ type: "delete", ids: ["card"] }], agent);
    p.reject();
    expect(p.status).toBe("rejected");
    expect(transactions).toBe(0);
    expect(doc.encodeState()).toEqual(state);
    expect(doc.stateVector()).toEqual(vector);
    expect(() => p.accept()).toThrow(/already rejected/);
  });

  it("rejects invalid batches before forking state can leak", () => {
    const { doc, agent } = sampleDoc();
    const state = doc.encodeState();
    expect(() => propose(doc, [{ type: "updateProps", id: "card", props: { opacity: 3 } }], agent)).toThrow(CommandError);
    expect(doc.encodeState()).toEqual(state);
  });

  it("merges a stale proposal with concurrent edits, or rebases it", () => {
    const { doc, user, agent } = sampleDoc();
    const p = propose(doc, [{ type: "updateProps", id: "card", props: { fills: BLUE } }, { type: "setParent", ids: ["badge"], parent: doc.pages[0]! }], agent);
    doc.apply([{ type: "updateProps", id: "card", props: { opacity: 0.5 } }, { type: "delete", ids: ["title"] }], user);
    expect(p.isStale()).toBe(true);
    const fresh = p.rebase();
    expect(p.status).toBe("rejected");
    expect(fresh.isStale()).toBe(false);
    fresh.accept();
    expect(doc.get("card", "opacity")).toBe(0.5);
    expect(doc.get("card", "fills")).toEqual(BLUE);
    expect(doc.tree.parentOf("badge")).toBe(doc.pages[0]);
    expectValidTree(doc);
    // Accepting a stale proposal directly is a CRDT merge too.
    const q = propose(doc, [{ type: "rename", id: "card", name: "Merged" }], agent);
    doc.apply([{ type: "updateProps", id: "card", props: { x: 40 } }], user);
    q.accept();
    expect([doc.get("card", "name"), doc.get("card", "x")]).toEqual(["Merged", 40]);
  });

  it("diffs of random batches match full document comparisons, and accepting reproduces the fork", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000 }), fc.integer({ min: 1, max: 8 }), (seed, count) => {
        const doc = FigDocument.create({ random: seededRandom(seed), clientId: 1 });
        const user = doc.actor("u");
        const random = seededRandom(seed + 1);
        for (let i = 0; i < 25; i++) {
          try {
            doc.apply([randomCommand(doc, random)], user);
          } catch (e) {
            if (!(e instanceof CommandError)) throw e;
          }
        }
        const batch: Command[] = [];
        for (let i = 0; i < count; i++) batch.push(randomCommand(doc, random));
        let p;
        try {
          p = propose(doc, batch, doc.actor("agent", "agent"));
        } catch (e) {
          if (e instanceof CommandError) return;
          throw e;
        }
        expect(p.diff).toEqual(diffDocuments(doc, p.fork));
        const expected = json(p.fork);
        if (isEmptyDiff(p.diff)) expect(json(doc)).toBe(expected);
        p.accept();
        expect(json(doc)).toBe(expected);
      }),
      { numRuns: 150 },
    );
  });
});
