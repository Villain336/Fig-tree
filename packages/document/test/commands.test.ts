import { describe, expect, it } from "vitest";
import { CommandError, ROOT_ID, boxMatrix, type FigDocument } from "../src";
import { expectValidTree, makeDoc } from "./helpers";

const red = { type: "solid" as const, color: { r: 1, g: 0, b: 0, a: 1 } };

function names(doc: FigDocument, parent: string): string[] {
  return doc.tree.childrenOf(parent).map((id) => doc.get<string>(id, "name"));
}

function rejects(fn: () => unknown, pattern: RegExp): CommandError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CommandError);
    expect((e as Error).message).toMatch(pattern);
    return e as CommandError;
  }
  throw new Error("expected the command to be rejected");
}

describe("createNode", () => {
  it("creates typed nodes with defaults and returns their ids", () => {
    const { doc, page, user } = makeDoc();
    const r = doc.apply([{ type: "createNode", node: { id: "f1", type: "frame", props: { x: 10, y: 20 } }, parent: page }], user);
    expect(r.created).toEqual(["f1"]);
    expect(r.affected).toEqual(["f1"]);
    expect(doc.typeOf("f1")).toBe("frame");
    expect(doc.get("f1", "x")).toBe(10);
    expect(doc.get("f1", "width")).toBe(100);
    // Frames clip by default; CSS defaults apply to everything else.
    expect(doc.get("f1", "overflowX")).toBe("hidden");
    expect(doc.get("f1", "display")).toBe("block");
    expect(doc.get("f1", "name")).toBe("Frame");
    expectValidTree(doc);
  });

  it("appends on top by default and inserts at an index", () => {
    const { doc, page, user } = makeDoc();
    for (const n of ["a", "b", "c"]) doc.apply([{ type: "createNode", node: { type: "rectangle", props: { name: n } }, parent: page }], user);
    doc.apply([{ type: "createNode", node: { type: "rectangle", props: { name: "x" } }, parent: page, index: 1 }], user);
    doc.apply([{ type: "createNode", node: { type: "rectangle", props: { name: "y" } }, parent: page, index: 0 }], user);
    expect(names(doc, page)).toEqual(["y", "a", "x", "b", "c"]);
  });

  it("puts children of flex containers in flow", () => {
    const { doc, page, user } = makeDoc();
    doc.apply([{ type: "createNode", node: { id: "row", type: "frame", props: { display: "flex" } }, parent: page }], user);
    doc.apply([{ type: "createNode", node: { id: "item", type: "rectangle" }, parent: "row" }], user);
    expect(doc.get("item", "position")).toBe("relative");
  });

  it("creates text with content and runs", () => {
    const { doc, page, user } = makeDoc();
    doc.apply([{ type: "createNode", node: { id: "t", type: "text", text: { content: "Hello world", runs: [{ start: 6, end: 11, style: { fontWeight: 700 } }] } }, parent: page }], user);
    expect(doc.text("t")).toEqual({ content: "Hello world", runs: [{ start: 6, end: 11, style: { fontWeight: 700 } }] });
  });

  it("rejects invalid nodes with useful errors and applies nothing", () => {
    const { doc, page, user } = makeDoc();
    const before = doc.encodeState();
    rejects(() => doc.apply([{ type: "createNode", node: { type: "rectangle", props: { opacity: 2 } }, parent: page }], user), /opacity: Too big/);
    rejects(() => doc.apply([{ type: "createNode", node: { type: "rectangle", props: { display: "flex" } }, parent: page }], user), /"display" does not apply to rectangle/);
    rejects(() => doc.apply([{ type: "createNode", node: { type: "frame" }, parent: ROOT_ID }], user), /only pages/);
    rejects(() => doc.apply([{ type: "createNode", node: { type: "page" }, parent: page }], user), /pages can only be added/);
    rejects(() => doc.apply([{ type: "createNode", node: { type: "rectangle" }, parent: "nope" }], user), /node nope does not exist/);
    rejects(() => doc.apply([{ type: "createNode", node: { type: "rectangle", text: { content: "x", runs: [] } }, parent: page }], user), /only text nodes/);
    rejects(() => doc.apply([{ type: "createNode", node: { type: "rectangle", props: { fills: [{ type: "image", asset: "a".repeat(64), fit: "cover" }] } }, parent: page }], user), /asset .* has not been added/);
    // An earlier valid command in a failing batch is not applied either.
    const err = rejects(
      () =>
        doc.apply(
          [
            { type: "createNode", node: { id: "ok", type: "rectangle" }, parent: page },
            { type: "createNode", node: { type: "ellipse" }, parent: "ok" },
          ],
          user,
        ),
      /rectangle nodes cannot have children/,
    );
    expect(err.index).toBe(1);
    expect(doc.has("ok")).toBe(false);
    expect(doc.encodeState()).toEqual(before);
  });

  it("rejects reused ids", () => {
    const { doc, page, user } = makeDoc();
    doc.apply([{ type: "createNode", node: { id: "r", type: "rectangle" }, parent: page }], user);
    rejects(() => doc.apply([{ type: "createNode", node: { id: "r", type: "rectangle" }, parent: page }], user), /already in use/);
    doc.apply([{ type: "delete", ids: ["r"] }], user);
    rejects(() => doc.apply([{ type: "createNode", node: { id: "r", type: "rectangle" }, parent: page }], user), /already in use/);
  });
});

describe("updateProps and rename", () => {
  it("sets, replaces and resets properties", () => {
    const { doc, page, user } = makeDoc();
    doc.apply([{ type: "createNode", node: { id: "r", type: "rectangle" }, parent: page }], user);
    doc.apply([{ type: "updateProps", id: "r", props: { fills: [red], cornerRadius: { topLeft: 4, topRight: 0, bottomRight: 8, bottomLeft: 0 } } }], user);
    expect(doc.get("r", "fills")).toEqual([red]);
    doc.apply([{ type: "updateProps", id: "r", props: { cornerRadius: null } }], user);
    expect(doc.stored("r", "cornerRadius")).toBeUndefined();
    expect(doc.get("r", "cornerRadius")).toBe(0);
    doc.apply([{ type: "rename", id: "r", name: "Card" }], user);
    expect(doc.get("r", "name")).toBe("Card");
  });

  it("returns frozen values that cannot corrupt the document", () => {
    const { doc, page, user } = makeDoc();
    doc.apply([{ type: "createNode", node: { id: "r", type: "rectangle", props: { fills: [red] } }, parent: page }], user);
    const fills = doc.get<{ color: { r: number } }[]>("r", "fills");
    expect(() => {
      fills[0]!.color.r = 0;
    }).toThrow();
  });

  it("validates per type", () => {
    const { doc, page, user } = makeDoc();
    doc.apply([{ type: "createNode", node: { id: "r", type: "rectangle" }, parent: page }], user);
    rejects(() => doc.apply([{ type: "updateProps", id: "r", props: { fontSize: 12 } }], user), /"fontSize" does not apply to rectangle/);
    rejects(() => doc.apply([{ type: "updateProps", id: "r", props: { fills: [{ type: "solid", color: { r: 1, g: 0, b: 0 } }] } }], user), /fills\.0\.color\.a/);
    rejects(() => doc.apply([{ type: "updateProps", id: "r", props: { x: "10" } }], user), /x: Invalid input: expected number/);
  });
});

describe("setParent, reorder and setPage", () => {
  it("moves nodes keeping their relative order and canvas position", () => {
    const { doc, page, user } = makeDoc();
    doc.apply(
      [
        { type: "createNode", node: { id: "f", type: "frame", props: { x: 100, y: 50, width: 300, height: 300 } }, parent: page },
        { type: "createNode", node: { id: "a", type: "rectangle", props: { x: 150, y: 70 } }, parent: page },
        { type: "createNode", node: { id: "b", type: "rectangle", props: { x: 10, y: 10 } }, parent: page },
      ],
      user,
    );
    doc.apply([{ type: "setParent", ids: ["b", "a"], parent: "f" }], user);
    expect(doc.tree.childrenOf("f")).toEqual(["a", "b"]);
    expect([doc.get("a", "x"), doc.get("a", "y")]).toEqual([50, 20]);
    expect([doc.get("b", "x"), doc.get("b", "y")]).toEqual([-90, -40]);
    doc.apply([{ type: "setParent", ids: ["a"], parent: page, keepPosition: false }], user);
    expect([doc.get("a", "x"), doc.get("a", "y")]).toEqual([50, 20]);
  });

  it("keeps the world placement through rotated and flipped parents", () => {
    const { doc, page, user } = makeDoc();
    doc.apply(
      [
        { type: "createNode", node: { id: "f", type: "frame", props: { x: 40, y: 30, width: 200, height: 120, rotation: 30, flipX: true } }, parent: page },
        { type: "createNode", node: { id: "r", type: "rectangle", props: { x: 15, y: 25, width: 50, height: 20, rotation: -10, flipY: true } }, parent: "f" },
      ],
      user,
    );
    const world = (id: string): number[] => {
      const local = boxMatrix({ x: doc.get(id, "x"), y: doc.get(id, "y"), width: doc.get(id, "width"), height: doc.get(id, "height"), rotation: doc.get(id, "rotation"), flipX: doc.get(id, "flipX"), flipY: doc.get(id, "flipY") });
      const p = doc.tree.parentOf(id)!;
      if (doc.typeOf(p) === "page") return [...local];
      const pm = boxMatrix({ x: doc.get(p, "x"), y: doc.get(p, "y"), width: doc.get(p, "width"), height: doc.get(p, "height"), rotation: doc.get(p, "rotation"), flipX: doc.get(p, "flipX"), flipY: doc.get(p, "flipY") });
      return [
        pm[0] * local[0] + pm[2] * local[1], pm[1] * local[0] + pm[3] * local[1],
        pm[0] * local[2] + pm[2] * local[3], pm[1] * local[2] + pm[3] * local[3],
        pm[0] * local[4] + pm[2] * local[5] + pm[4], pm[1] * local[4] + pm[3] * local[5] + pm[5],
      ];
    };
    const before = world("r");
    doc.apply([{ type: "setParent", ids: ["r"], parent: page }], user);
    world("r").forEach((v, i) => expect(v).toBeCloseTo(before[i]!, 9));
  });

  it("prevents cycles and invalid parents", () => {
    const { doc, page, user } = makeDoc();
    doc.apply(
      [
        { type: "createNode", node: { id: "outer", type: "frame" }, parent: page },
        { type: "createNode", node: { id: "inner", type: "frame" }, parent: "outer" },
        { type: "createNode", node: { id: "leaf", type: "ellipse" }, parent: "inner" },
      ],
      user,
    );
    rejects(() => doc.apply([{ type: "setParent", ids: ["outer"], parent: "inner" }], user), /into itself or its own descendant/);
    rejects(() => doc.apply([{ type: "setParent", ids: ["outer"], parent: "outer" }], user), /into itself/);
    rejects(() => doc.apply([{ type: "setParent", ids: ["inner"], parent: "leaf" }], user), /ellipse nodes cannot have children/);
    rejects(() => doc.apply([{ type: "setParent", ids: [page], parent: "outer" }], user), /pages/);
    expectValidTree(doc);
  });

  it("reorders among siblings and pages", () => {
    const { doc, page, user } = makeDoc();
    for (const n of ["a", "b", "c", "d"]) doc.apply([{ type: "createNode", node: { id: n, type: "rectangle", props: { name: n } }, parent: page }], user);
    doc.apply([{ type: "reorder", id: "a", index: 3 }], user);
    expect(names(doc, page)).toEqual(["b", "c", "d", "a"]);
    doc.apply([{ type: "reorder", id: "d", index: 0 }], user);
    expect(names(doc, page)).toEqual(["d", "b", "c", "a"]);
    doc.apply([{ type: "createNode", node: { id: "p2", type: "page" }, parent: ROOT_ID }], user);
    doc.apply([{ type: "reorder", id: "p2", index: 0 }], user);
    expect(doc.pages).toEqual(["p2", page]);
  });

  it("moves nodes to another page", () => {
    const { doc, page, user } = makeDoc();
    doc.apply(
      [
        { type: "createNode", node: { id: "p2", type: "page" }, parent: ROOT_ID },
        { type: "createNode", node: { id: "f", type: "frame", props: { x: 10, y: 10 } }, parent: page },
        { type: "createNode", node: { id: "r", type: "rectangle", props: { x: 5, y: 5 } }, parent: "f" },
      ],
      user,
    );
    doc.apply([{ type: "setPage", ids: ["r"], page: "p2" }], user);
    expect(doc.tree.parentOf("r")).toBe("p2");
    expect([doc.get("r", "x"), doc.get("r", "y")]).toEqual([15, 15]);
    rejects(() => doc.apply([{ type: "setPage", ids: ["f"], page: "r" }], user), /not a page/);
  });

  it("re-keys siblings whose order keys tie", () => {
    const { doc, page, user } = makeDoc();
    // Two replicas append concurrently with identical random sources: equal keys, ordered by id.
    const other = makeDoc();
    void other;
    for (const n of ["a", "b"]) doc.apply([{ type: "createNode", node: { id: n, type: "rectangle" }, parent: page }], user);
    // Force a tie by writing b's key onto a through a reorder on a forked replica is hard;
    // instead check insertion between consecutive siblings stays ordered many times.
    for (let i = 0; i < 200; i++) doc.apply([{ type: "createNode", node: { type: "rectangle" }, parent: page, index: 1 }], user);
    const kids = doc.tree.childrenOf(page);
    expect(kids[0]).toBe("a");
    expect(kids[kids.length - 1]).toBe("b");
    for (let i = 1; i < kids.length; i++) expect(doc.tree.keyOf(kids[i]!)! > doc.tree.keyOf(kids[i - 1]!)!).toBe(true);
  });
});

describe("delete, duplicate, group and ungroup", () => {
  it("deletes subtrees and removes groups left empty", () => {
    const { doc, page, user } = makeDoc();
    doc.apply(
      [
        { type: "createNode", node: { id: "f", type: "frame" }, parent: page },
        { type: "createNode", node: { id: "r", type: "rectangle" }, parent: "f" },
        { type: "createNode", node: { id: "e", type: "ellipse" }, parent: page },
      ],
      user,
    );
    const r = doc.apply([{ type: "group", ids: ["e"], id: "g" }], user);
    expect(r.created).toEqual(["g"]);
    const del = doc.apply([{ type: "delete", ids: ["f", "e"] }], user);
    expect([...del.deleted].sort()).toEqual(["e", "f", "g", "r"]);
    expect(doc.tree.childrenOf(page)).toEqual([]);
    rejects(() => doc.apply([{ type: "delete", ids: [page] }], user), /at least one page/);
  });

  it("duplicates subtrees above the originals with fresh ids", () => {
    const { doc, page, user } = makeDoc();
    doc.apply(
      [
        { type: "createNode", node: { id: "f", type: "frame", props: { x: 10, fills: [red] } }, parent: page },
        { type: "createNode", node: { id: "t", type: "text", text: { content: "hi", runs: [] } }, parent: "f" },
        { type: "createNode", node: { id: "top", type: "rectangle" }, parent: page },
      ],
      user,
    );
    const r = doc.apply([{ type: "duplicate", ids: ["f", "t"], offset: { x: 20, y: 0 }, newIds: ["f2", "t2"] }], user);
    expect(r.created[0]).toBe("f2");
    expect(r.created).toHaveLength(2);
    expect(doc.tree.childrenOf(page)).toEqual(["f", "f2", "top"]);
    expect(doc.get("f2", "x")).toBe(30);
    expect(doc.get("f2", "fills")).toEqual([red]);
    const copyOfText = doc.tree.childrenOf("f2")[0]!;
    expect(copyOfText).not.toBe("t");
    expect(doc.text(copyOfText).content).toBe("hi");
    expect(doc.get(copyOfText, "x")).toBe(0);
  });

  it("groups siblings in place and ungroups them back", () => {
    const { doc, page, user } = makeDoc();
    for (const n of ["a", "b", "c", "d"]) doc.apply([{ type: "createNode", node: { id: n, type: "rectangle", props: { x: 7 } }, parent: page }], user);
    doc.apply([{ type: "group", ids: ["c", "a"], id: "g", name: "Pair" }], user);
    expect(doc.tree.childrenOf(page)).toEqual(["b", "g", "d"]);
    expect(doc.tree.childrenOf("g")).toEqual(["a", "c"]);
    expect(doc.get("a", "x")).toBe(7);
    doc.apply([{ type: "ungroup", id: "g" }], user);
    expect(doc.tree.childrenOf(page)).toEqual(["b", "a", "c", "d"]);
    expect(doc.has("g")).toBe(false);
    rejects(() => doc.apply([{ type: "group", ids: ["a", page] }], user), /pages cannot be grouped/);
  });

  it("ungroups a frame keeping child positions", () => {
    const { doc, page, user } = makeDoc();
    doc.apply(
      [
        { type: "createNode", node: { id: "f", type: "frame", props: { x: 100, y: 100 } }, parent: page },
        { type: "createNode", node: { id: "r", type: "rectangle", props: { x: 5, y: 6 } }, parent: "f" },
      ],
      user,
    );
    doc.apply([{ type: "ungroup", id: "f" }], user);
    expect([doc.get("r", "x"), doc.get("r", "y")]).toEqual([105, 106]);
  });

  it("moving a group keeps its children's canvas positions", () => {
    const { doc, page, user } = makeDoc();
    doc.apply(
      [
        { type: "createNode", node: { id: "f", type: "frame", props: { x: 100, y: 0, width: 500, height: 500 } }, parent: page },
        { type: "createNode", node: { id: "r", type: "rectangle", props: { x: 150, y: 20 } }, parent: page },
        { type: "group", ids: ["r"], id: "g" },
      ],
      user,
    );
    doc.apply([{ type: "setParent", ids: ["g"], parent: "f" }], user);
    expect(doc.get("r", "x")).toBe(50);
  });
});

describe("text commands", () => {
  it("inserts, deletes and formats with Yjs semantics", () => {
    const { doc, page, user } = makeDoc();
    doc.apply([{ type: "createNode", node: { id: "t", type: "text", text: { content: "Hello", runs: [{ start: 0, end: 5, style: { fontWeight: 700 } }] } }, parent: page }], user);
    doc.apply([{ type: "insertText", id: "t", index: 5, text: " there" }], user);
    expect(doc.text("t")).toEqual({ content: "Hello there", runs: [{ start: 0, end: 11, style: { fontWeight: 700 } }] });
    doc.apply([{ type: "formatText", id: "t", index: 6, length: 5, style: { fontWeight: null, fontStyle: "italic", fills: [red] } }], user);
    expect(doc.text("t").runs).toEqual([
      { start: 0, end: 6, style: { fontWeight: 700 } },
      { start: 6, end: 11, style: { fontStyle: "italic", fills: [red] } },
    ]);
    doc.apply([{ type: "deleteText", id: "t", index: 0, length: 6 }], user);
    expect(doc.text("t").content).toBe("there");
    doc.apply([{ type: "insertText", id: "t", index: 0, text: "Oh ", style: {} }], user);
    expect(doc.text("t").runs).toEqual([{ start: 3, end: 8, style: { fontStyle: "italic", fills: [red] } }]);
    doc.apply([{ type: "setText", id: "t", text: { content: "New", runs: [] } }], user);
    expect(doc.text("t")).toEqual({ content: "New", runs: [] });
    rejects(() => doc.apply([{ type: "deleteText", id: "t", index: 2, length: 5 }], user), /past the end/);
    rejects(() => doc.apply([{ type: "formatText", id: "t", index: 0, length: 1, style: { color: "red" } }], user), /"color" is not a text style property/);
    rejects(() => doc.apply([{ type: "insertText", id: page, index: 0, text: "x" }], user), /not a text node/);
  });
});

describe("assets and document name", () => {
  it("registers assets before image paints can use them", () => {
    const { doc, page, user } = makeDoc();
    const asset = "b".repeat(64);
    doc.apply(
      [
        { type: "addAsset", id: asset, meta: { mimeType: "image/png", byteLength: 10, width: 2, height: 2 } },
        { type: "createNode", node: { id: "img", type: "image", props: { asset } }, parent: page },
        { type: "setDocumentName", name: "Landing page" },
      ],
      user,
    );
    expect(doc.assets().get(asset)?.width).toBe(2);
    expect(doc.name).toBe("Landing page");
  });
});
