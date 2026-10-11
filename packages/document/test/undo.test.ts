import { describe, expect, it } from "vitest";
import { FigDocument, REMOTE, seededRandom, type Actor } from "../src";
import { serializeFigtreeJson, toFigtreeJson } from "../src/format/json";
import { expectValidTree, makeDoc } from "./helpers";

const color = (r: number, g: number, b: number) => [{ type: "solid" as const, color: { r, g, b, a: 1 } }];
const RED = color(1, 0, 0);
const BLUE = color(0, 0, 1);
const GREEN = color(0, 1, 0);

function snapshot(doc: FigDocument): string {
  return serializeFigtreeJson(toFigtreeJson(doc));
}

describe("undo and redo per actor", () => {
  it("undoes a whole command batch as one step, and redoes it", () => {
    const { doc, page, user } = makeDoc();
    const before = snapshot(doc);
    doc.apply(
      [
        { type: "createNode", node: { id: "f", type: "frame" }, parent: page },
        { type: "createNode", node: { id: "r", type: "rectangle", props: { fills: RED } }, parent: "f" },
      ],
      user,
    );
    const after = snapshot(doc);
    expect(doc.undo(user)).toBe(true);
    expect(snapshot(doc)).toBe(before);
    expect(doc.redo(user)).toBe(true);
    expect(snapshot(doc)).toBe(after);
    expect(doc.get("r", "fills")).toEqual(RED);
  });

  it("never reverts another actor's edits to other properties of the same node", () => {
    const { doc, page } = makeDoc();
    const a = doc.actor("a");
    const b = doc.actor("b");
    doc.apply([{ type: "createNode", node: { id: "r", type: "rectangle" }, parent: page }], a);
    doc.apply([{ type: "updateProps", id: "r", props: { x: 50 } }], a);
    doc.apply([{ type: "updateProps", id: "r", props: { fills: BLUE, opacity: 0.5 } }], b);
    doc.apply([{ type: "updateProps", id: "r", props: { y: 70 } }], a);
    doc.undo(a); // y
    doc.undo(a); // x
    expect([doc.get("r", "x"), doc.get("r", "y")]).toEqual([0, 0]);
    expect(doc.get("r", "fills")).toEqual(BLUE);
    expect(doc.get("r", "opacity")).toBe(0.5);
    expect(doc.canUndo(b)).toBe(true);
    doc.undo(b);
    expect(doc.get("r", "fills")).toEqual([]);
    expect(doc.has("r")).toBe(true);
  });

  it("keeps a later value from another actor when undoing an overwritten property", () => {
    const { doc, page } = makeDoc();
    const a = doc.actor("a");
    const b = doc.actor("b");
    doc.apply([{ type: "createNode", node: { id: "r", type: "rectangle", props: { fills: GREEN } }, parent: page }], b);
    doc.apply([{ type: "updateProps", id: "r", props: { fills: RED } }], a);
    doc.apply([{ type: "updateProps", id: "r", props: { fills: BLUE } }], b);
    // A's change was already overwritten by B: undoing it must not bring back green over B's blue.
    doc.undo(a);
    expect(doc.get("r", "fills")).toEqual(BLUE);
    // B's undo restores what B overwrote.
    doc.undo(b);
    expect(doc.get("r", "fills")).not.toEqual(BLUE);
  });

  it("interleaves edits of two actors and unwinds each independently", () => {
    const { doc, page } = makeDoc();
    const a = doc.actor("a");
    const b = doc.actor("b");
    doc.apply([{ type: "createNode", node: { id: "fa", type: "frame", props: { name: "A" } }, parent: page }], a);
    doc.apply([{ type: "createNode", node: { id: "fb", type: "frame", props: { name: "B" } }, parent: page }], b);
    doc.apply([{ type: "createNode", node: { id: "ra", type: "rectangle" }, parent: "fa" }], a);
    doc.apply([{ type: "createNode", node: { id: "rb", type: "rectangle" }, parent: "fb" }], b);
    doc.apply([{ type: "rename", id: "fb", name: "B2" }], b);
    doc.apply([{ type: "setParent", ids: ["ra"], parent: "fb" }], a);
    doc.apply([{ type: "rename", id: "fa", name: "A2" }], a);

    // Unwind A completely: everything A did disappears, B's work stays.
    while (doc.canUndo(a)) doc.undo(a);
    expect(doc.has("fa")).toBe(false);
    expect(doc.has("ra")).toBe(false);
    expect(doc.has("fb")).toBe(true);
    expect(doc.has("rb")).toBe(true);
    expect(doc.get("fb", "name")).toBe("B2");
    expect(doc.tree.childrenOf("fb")).toEqual(["rb"]);
    expectValidTree(doc);

    // Redo A fully: A's nodes come back where A left them.
    while (doc.canRedo(a)) doc.redo(a);
    expect(doc.get("fa", "name")).toBe("A2");
    expect(doc.tree.parentOf("ra")).toBe("fb");
    expect(doc.tree.childrenOf("fb")).toEqual(["rb", "ra"]);

    // Unwinding B leaves A's moved rectangle orphaned under B's deleted frame: it returns to its previous parent.
    while (doc.canUndo(b)) doc.undo(b);
    expect(doc.has("fb")).toBe(false);
    expect(doc.tree.parentOf("ra")).toBe("fa");
    expect(doc.get("fa", "name")).toBe("A2");
    expectValidTree(doc);
  });

  it("restores deleted subtrees with their text", () => {
    const { doc, page, user } = makeDoc();
    doc.apply(
      [
        { type: "createNode", node: { id: "f", type: "frame" }, parent: page },
        { type: "createNode", node: { id: "t", type: "text", text: { content: "Keep me", runs: [{ start: 0, end: 4, style: { fontWeight: 600 } }] } }, parent: "f" },
      ],
      user,
    );
    const before = snapshot(doc);
    doc.apply([{ type: "delete", ids: ["f"] }], user);
    expect(doc.has("t")).toBe(false);
    doc.undo(user);
    expect(snapshot(doc)).toBe(before);
    expect(doc.text("t").runs[0]?.style.fontWeight).toBe(600);
  });

  it("undoes moves and reorders", () => {
    const { doc, page, user } = makeDoc();
    doc.apply(
      [
        { type: "createNode", node: { id: "f", type: "frame", props: { x: 10, y: 10 } }, parent: page },
        { type: "createNode", node: { id: "a", type: "rectangle", props: { x: 20, y: 20 } }, parent: page },
        { type: "createNode", node: { id: "b", type: "rectangle" }, parent: page },
      ],
      user,
    );
    const before = snapshot(doc);
    doc.apply([{ type: "setParent", ids: ["a"], parent: "f" }], user);
    doc.apply([{ type: "reorder", id: "b", index: 0 }], user);
    doc.undo(user);
    doc.undo(user);
    expect(snapshot(doc)).toBe(before);
  });

  it("does not undo changes received from other replicas", () => {
    const one = makeDoc(1, 1);
    const two = FigDocument.fromUpdate(one.doc.encodeState(), { random: seededRandom(2), clientId: 2 });
    const a: Actor = one.doc.actor("a");
    const b: Actor = two.actor("b");
    const relay = (from: FigDocument, to: FigDocument) => from.ydoc.on("updateV2", (u: Uint8Array, origin: unknown) => origin !== REMOTE && to.applyUpdate(u));
    relay(one.doc, two);
    relay(two, one.doc);
    one.doc.apply([{ type: "createNode", node: { id: "r", type: "rectangle" }, parent: one.page }], a);
    two.apply([{ type: "updateProps", id: "r", props: { fills: BLUE } }], b);
    one.doc.apply([{ type: "updateProps", id: "r", props: { x: 99 } }], a);
    one.doc.undo(a);
    expect(one.doc.get("r", "x")).toBe(0);
    expect(one.doc.get("r", "fills")).toEqual(BLUE);
    expect(two.get("r", "fills")).toEqual(BLUE);
    expect(two.get("r", "x")).toBe(0);
    // B undoes on its own replica; A's creation stays.
    two.undo(b);
    expect(one.doc.get("r", "fills")).toEqual([]);
    expect(one.doc.has("r")).toBe(true);
    expect(two.canUndo(b)).toBe(false);
    expect(snapshot(one.doc)).toBe(snapshot(two));
  });

  it("undoes text edits per actor", () => {
    const { doc, page } = makeDoc();
    const a = doc.actor("a");
    const b = doc.actor("b");
    doc.apply([{ type: "createNode", node: { id: "t", type: "text", text: { content: "ab", runs: [] } }, parent: page }], a);
    doc.apply([{ type: "insertText", id: "t", index: 2, text: "B" }], b);
    doc.apply([{ type: "insertText", id: "t", index: 0, text: "A" }], a);
    doc.apply([{ type: "formatText", id: "t", index: 0, length: 4, style: { fontWeight: 700 } }], b);
    doc.undo(a);
    expect(doc.text("t").content).toBe("abB");
    expect(doc.text("t").runs).toEqual([{ start: 0, end: 3, style: { fontWeight: 700 } }]);
    doc.undo(b);
    doc.undo(b);
    expect(doc.text("t")).toEqual({ content: "ab", runs: [] });
  });
});
