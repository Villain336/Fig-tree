import type { Command, FigDocument } from "@fig-tree/document";
import { AssetStore } from "@fig-tree/document";
import { describe, expect, it } from "vitest";
import { addPage, copySelection, cutSelection, looksLikeSvg, parseColor, parsePathData, paste, payloadFromHtml, subpathsToNetwork, svgToPayload } from "../src";
import { frame, rect, setup, text } from "./helpers";

/** Stored properties of a subtree without ids, for comparing copies. */
function shape(doc: FigDocument, id: string): unknown {
  const kids = doc.tree.childrenOf(id).map((c) => shape(doc, c));
  return { type: doc.typeOf(id), props: doc.storedProps(id), ...(doc.typeOf(id) === "text" ? { text: doc.text(id) } : {}), ...(kids.length ? { children: kids } : {}) };
}

const scene = (page: string): Command[] => [
  frame("card", page, 50, 50, 200, 120, { cornerRadius: 12, name: "Card" }),
  rect("bar", "card", 10, 30, 100, 8, { rotation: 15, name: "Bar" }),
  text("label", "card", "Hello", { x: 10, y: 40 }),
  { type: "createNode", node: { id: "g", type: "group", props: { name: "Pair" } }, parent: page },
  rect("g1", "g", 400, 50, 20, 20),
  rect("g2", "g", 430, 50, 20, 20),
];

describe("clipboard", () => {
  it("round-trips nodes through the HTML format, pasting in place over the originals", async () => {
    const s = setup(scene);
    s.editor.select(["card", "g"]);
    const out = copySelection(s.editor)!;
    expect(out.text).toBe("Hello");
    expect(payloadFromHtml(out.html!)).not.toBeNull();
    s.editor.select([]);
    const ids = await paste(s.editor, { html: out.html!, text: out.text });
    expect(ids.length).toBe(2);
    expect(shape(s.doc, ids[0]!)).toEqual(shape(s.doc, "card"));
    expect(shape(s.doc, ids[1]!)).toEqual(shape(s.doc, "g"));
    expect(s.editor.geometry.bounds(ids[1]!)).toEqual(s.editor.geometry.bounds("g"));
    expect(s.editor.selection).toEqual(ids);
    // One undo step removes the paste.
    s.editor.run("edit.undo");
    expect(ids.some((id) => s.doc.has(id))).toBe(false);
  });

  it("pastes on another page at the same position, and into a selected frame", async () => {
    const s = setup(scene);
    s.editor.viewport.set(1, 0, 0);
    s.editor.select(["bar"]);
    const out = copySelection(s.editor)!;
    const before = s.editor.geometry.bounds("bar");
    addPage(s.editor);
    const [onPage] = await paste(s.editor, { html: out.html! });
    expect(s.doc.tree.parentOf(onPage!)).toBe(s.editor.page);
    const after = s.editor.geometry.bounds(onPage!);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(s.doc.get(onPage!, "rotation")).toBe(15);
    // Into a selected frame: kept in place when it fits inside it.
    s.editor.setPage(s.page);
    s.editor.select(["card"]);
    const [inCard] = await paste(s.editor, { html: out.html! });
    expect(s.doc.tree.parentOf(inCard!)).toBe("card");
    expect(s.editor.geometry.bounds(inCard!).x).toBeCloseTo(before.x, 6);
  });

  it("falls back to the internal clipboard and cuts", async () => {
    const s = setup(scene);
    s.editor.select(["g"]);
    cutSelection(s.editor);
    expect(s.doc.has("g")).toBe(false);
    const ids = await paste(s.editor, {});
    expect(ids.length).toBe(1);
    expect(s.doc.tree.childrenOf(ids[0]!).length).toBe(2);
  });

  it("carries image assets between documents", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 4, 0, 0, 0, 3, 8, 6, 0, 0, 0, 0, 0, 0, 0]);
    const a = setup();
    const id = (await import("../src")).placeImage(a.editor, png, "dot.png");
    const node = (await id)!;
    expect(a.doc.typeOf(node)).toBe("image");
    expect(a.doc.get(node, "width")).toBe(4);
    a.editor.select([node]);
    const out = copySelection(a.editor)!;
    const b = setup();
    expect(b.editor.assets).toBeInstanceOf(AssetStore);
    const [pasted] = await paste(b.editor, { html: out.html! });
    const asset = b.doc.get<string>(pasted!, "asset");
    expect(b.doc.assets().get(asset)?.mimeType).toBe("image/png");
    expect(b.editor.assets.get(asset)).toEqual(png);
  });

  it("pastes plain text as a text node", async () => {
    const s = setup();
    const [id] = await paste(s.editor, { text: "Line one\r\nLine two" });
    expect(s.doc.typeOf(id!)).toBe("text");
    expect(s.doc.text(id!).content).toBe("Line one\nLine two");
    expect(s.doc.get(id!, "name")).toBe("Line one");
  });

  it("ignores HTML that is not ours", () => {
    expect(payloadFromHtml("<b>hi</b>")).toBeNull();
    expect(payloadFromHtml('<div data-fig-tree="bm90IGpzb24="></div>')).toBeNull();
  });
});

describe("SVG import", () => {
  const icon = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="48" height="24" viewBox="0 0 24 12">
  <!-- a comment -->
  <rect x="1" y="1" width="10" height="10" rx="2" fill="#ff0000"/>
  <g transform="translate(12 0)" stroke="blue" stroke-width="2" fill="none">
    <circle cx="6" cy="6" r="5"/>
    <path d="M0 0 L 4 4 h2 v-2 z"/>
  </g>
  <polygon points="0,12 2,10 4,12" style="fill: rgb(0, 128, 0); opacity: 0.5"/>
  <text x="0" y="11" font-size="4">Hi &amp; bye</text>
</svg>`;

  it("detects SVG text", () => {
    expect(looksLikeSvg(icon)).toBe(true);
    expect(looksLikeSvg("<svg>")).toBe(true);
    expect(looksLikeSvg("hello <svg>")).toBe(false);
  });

  it("converts shapes, groups, paths, styles and the viewBox", async () => {
    const p = svgToPayload(icon);
    const root = p.roots[0]!;
    expect(root.type).toBe("frame");
    expect(root.props).toMatchObject({ width: 48, height: 24, fills: [] });
    const [r, g, poly, t] = root.children!;
    // viewBox scales by 2.
    expect(r).toMatchObject({ type: "rectangle", props: { x: 2, y: 2, width: 20, height: 20, cornerRadius: 4, fills: [{ type: "solid", color: { r: 1, g: 0, b: 0, a: 1 } }] } });
    expect(g!.type).toBe("group");
    const [circle, path] = g!.children!;
    expect(circle).toMatchObject({ type: "ellipse", props: { x: 26, y: 2, width: 20, height: 20, fills: [], strokeWeight: 4, strokes: [{ type: "solid", color: { r: 0, g: 0, b: 1, a: 1 } }] } });
    expect(path!.type).toBe("vector");
    // A closed path is a region; with fill="none" it has no paint.
    expect(path!.props).toMatchObject({ fills: [], vectorNetwork: { regions: [{ fillRule: "nonzero", loops: [[0, 1, 2, 3]] }] } });
    expect(poly).toMatchObject({ type: "vector", props: { opacity: 0.5 } });
    expect((poly!.props.vectorNetwork as { regions: unknown[] }).regions.length).toBe(1);
    expect(t).toMatchObject({ type: "text", text: { content: "Hi & bye" }, props: { fontSize: 8 } });
    // The document accepts it (schemas validate every property).
    const s = setup();
    s.editor.viewport.set(1, 0, 0);
    const ids = await paste(s.editor, { text: icon });
    expect(ids.length).toBe(1);
    expect(s.doc.tree.subtree(ids[0]!).length).toBe(7);
    expect(s.editor.geometry.size(ids[0]!)).toEqual({ width: 48, height: 24 });
  });

  it("parses path data: relative commands, curves, arcs and compact flags", () => {
    const sub = parsePathData("m10 10 c 0 10 10 10 10 0 s 10 -10 10 0 q5 5 10 0 t 10 0 a5 5 0 01 10 0Z M0 0 H5V5");
    expect(sub.length).toBe(2);
    expect(sub[0]!.closed).toBe(true);
    const last = sub[0]!.segments[sub[0]!.segments.length - 2]!;
    expect(last.p1.x).toBeCloseTo(60, 9);
    expect(sub[1]!.segments.map((s) => s.p1)).toEqual([{ x: 5, y: 0 }, { x: 5, y: 5 }]);
    const net = subpathsToNetwork(sub, { x: 0, y: 0 }, "evenodd", true);
    expect(net.regions[0]!.loops.length).toBe(2);
    expect(net.regions[0]!.fillRule).toBe("evenodd");
    expect(() => parsePathData("M0 0 L x")).toThrow();
  });

  it("parses colors", () => {
    expect(parseColor("#0f0")).toEqual({ r: 0, g: 1, b: 0, a: 1 });
    expect(parseColor("rgba(255, 0, 0, 0.5)")).toEqual({ r: 1, g: 0, b: 0, a: 0.5 });
    expect(parseColor("hsl(240, 100%, 50%)")).toEqual({ r: 0, g: 0, b: 1, a: 1 });
    expect(parseColor("teal")).toEqual({ r: 0, g: 128 / 255, b: 128 / 255, a: 1 });
    expect(parseColor("none")).toBeNull();
    expect(parseColor("url(#grad)")).toBeNull();
  });

  it("rejects malformed SVG without touching the document", async () => {
    const s = setup();
    expect(await paste(s.editor, { text: "<svg><rect></svg>" })).toEqual([]);
    expect(s.doc.tree.childrenOf(s.page)).toEqual([]);
  });
});
