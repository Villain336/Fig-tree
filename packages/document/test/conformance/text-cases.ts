import type { FontRegistry } from "@fig-tree/text";
import { engineText, textGraphemes, type Paragraph, type Rect4, type Run, type TextCase, type TextNode, type TextReference } from "../../../text/conformance/case";
import { DocumentLayout, FigDocument, cssDeclarations, seededRandom, type Command, type Paint, type TextContent } from "../../src";
import { textStyleDeclarations } from "../../src/css";

/**
 * Documents with text as conformance cases. Every node becomes a `div`
 * with the CSS `cssDeclarations` states for it; a text node's paragraphs
 * become `<p>`s (list paragraphs list items with an outside marker) and
 * its style runs `<span>`s with `textStyleDeclarations`. Chromium's
 * rendering of that HTML is the reference for the bridge's DocumentLayout:
 * text in the editor wraps and sizes exactly like the exported code.
 */

export interface DocumentTextCase {
  readonly case: TextCase;
  readonly doc: FigDocument;
  readonly page: string;
  /** Document node ids in the case's pre-order, after the page root. */
  readonly ids: readonly string[];
  /** Text node ids in pre-order (the case's text leaves). */
  readonly textIds: readonly string[];
}

const css = (decls: Record<string, string>): string =>
  Object.entries(decls)
    .map(([k, v]) => `${k}:${v}`)
    .join(";");

/** A text node's paragraphs as the harness's `<p>`s. */
function paragraphs(doc: FigDocument, id: string): Paragraph[] {
  const content: TextContent = doc.text(id);
  const text = content.content;
  const fontSize = doc.get<number>(id, "fontSize");
  const spacing = doc.get<number>(id, "paragraphSpacing");
  const out: Paragraph[] = [];
  const counters: number[] = [];
  let start = 0;
  while (start <= text.length) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    const runs: Run[] = [];
    let at = start;
    let first: Record<string, unknown> = {};
    for (const r of content.runs) {
      if (r.end <= at || r.start >= end) continue;
      if (r.start > at) runs.push(text.slice(at, r.start));
      if (Math.max(r.start, at) === start) first = r.style;
      const e = Math.min(r.end, end);
      runs.push([css(textStyleDeclarations(r.style)), text.slice(Math.max(r.start, at), e)]);
      at = e;
    }
    if (at < end) runs.push(text.slice(at, end));
    if (runs.length === 0) runs.push("");
    const listStyle = (first.listStyle as string | undefined) ?? doc.get<string>(id, "listStyle");
    const level = (first.listLevel as number | undefined) ?? doc.get<number>(id, "listLevel");
    let list: Paragraph["list"];
    if (listStyle !== "none") {
      counters.length = level + 1;
      let marker = "• ";
      if (listStyle === "ordered") {
        counters[level] = (counters[level] ?? 0) + 1;
        marker = `${counters[level]}. `;
      }
      list = { inset: (level + 1) * 1.5 * fontSize, marker };
    } else counters.length = 0;
    out.push({ runs, ...(out.length > 0 && spacing ? { spaceBefore: spacing } : {}), ...(list ? { list } : {}) });
    start = end + 1;
  }
  return out;
}

export function toTextCase(name: string, doc: FigDocument): DocumentTextCase {
  const page = doc.pages[0]!;
  const ids: string[] = [];
  const textIds: string[] = [];
  const node = (id: string): TextNode => {
    ids.push(id);
    const decls = cssDeclarations(doc, id);
    delete decls.transform;
    if (doc.typeOf(id) === "text") {
      textIds.push(id);
      // Direction `auto` is HTML `dir="auto"` (see textBlockInput).
      return { style: css(decls), paragraphs: paragraphs(doc, id), ...(doc.get<string>(id, "direction") === "auto" ? { dir: "auto" as const } : {}) };
    }
    const children = doc.tree.childrenOf(id).map(node);
    return children.length ? { style: css(decls), children } : { style: css(decls) };
  };
  const root: TextNode = { style: "position:relative;width:0px;height:0px", children: doc.tree.childrenOf(page).map(node) };
  return { case: { name: `document/${name}`, area: "document", root }, doc, page, ids, textIds };
}

const solid = (r: number, g: number, b: number): Paint => ({ type: "solid", color: { r: r / 255, g: g / 255, b: b / 255, a: 1 } });
const ink = solid(24, 24, 27);
const pad = (v: number, h = v) => ({ top: v, right: h, bottom: v, left: h });

function make(seed: number, commands: (page: string) => Command[]): FigDocument {
  const doc = FigDocument.create({ random: seededRandom(seed), clientId: 1 });
  doc.apply(commands(doc.pages[0]!), doc.actor("author"));
  return doc;
}

const frame = (id: string, parent: string, props: Record<string, unknown>): Command => ({ type: "createNode", node: { id, type: "frame", props: { fills: [solid(255, 255, 255)], ...props } }, parent });
const text = (id: string, parent: string, content: string, props: Record<string, unknown> = {}, runs: TextContent["runs"] = []): Command => ({
  type: "createNode",
  node: { id, type: "text", props: { fontFamily: "Inter", fontSize: 16, fills: [ink], ...props }, text: { content, runs } },
  parent,
});

/** Content and runs from styled parts (unstyled parts use the node's style). */
function styled(parts: readonly (readonly [string, Record<string, unknown>?])[]): [string, TextContent["runs"]] {
  let content = "";
  const runs: TextContent["runs"] = [];
  for (const [t, style] of parts) {
    if (style) runs.push({ start: content.length, end: content.length + t.length, style });
    content += t;
  }
  return [content, runs];
}

const textRuns = (id: string, parent: string, parts: readonly (readonly [string, Record<string, unknown>?])[], props: Record<string, unknown> = {}): Command => {
  const [content, runs] = styled(parts);
  return text(id, parent, content, props, runs);
};

const BODY = "Fig Tree lays text out like the browser does, so the code you export renders exactly what you designed.";
const ARABIC = "مرحبا بالعالم، هذا نص عربي يلتف عبر عدة أسطر.";

const HAND: [string, (page: string) => Command[]][] = [
  ["auto-width", (p) => [text("t", p, "Auto width label", { x: 20, y: 20 })]],
  ["auto-height", (p) => [text("t", p, BODY, { x: 20, y: 20, width: 240, widthMode: "fixed" })]],
  ["fixed-size-center", (p) => [text("t", p, "Centered in a fixed box", { x: 20, y: 20, width: 200, height: 120, widthMode: "fixed", heightMode: "fixed", verticalAlign: "center", textAlign: "center" })]],
  ["fixed-size-bottom", (p) => [text("t", p, BODY, { x: 20, y: 20, width: 200, height: 160, widthMode: "fixed", heightMode: "fixed", verticalAlign: "bottom" })]],
  [
    "button-row",
    (p) => [
      frame("row", p, { x: 20, y: 20, width: 100, height: 40, widthMode: "hug", heightMode: "hug", display: "flex", columnGap: 8, alignItems: "center" }),
      ...["OK", "Cancel", "Save changes", "Delete account"].flatMap((label, i): Command[] => [
        frame(`b${i}`, "row", { width: 10, height: 10, widthMode: "hug", heightMode: "hug", display: "flex", padding: pad(8, 14), cornerRadius: 8, fills: [solid(24, 24, 27)] }),
        text(`l${i}`, `b${i}`, label, { fontWeight: 500, fontSize: 14, fills: [solid(255, 255, 255)] }),
      ]),
    ],
  ],
  [
    "card-column",
    (p) => [
      frame("card", p, { x: 20, y: 20, width: 300, height: 100, heightMode: "hug", display: "flex", flexDirection: "column", rowGap: 8, padding: pad(16) }),
      text("h", "card", "A heading that may wrap onto two lines", { fontSize: 24, fontWeight: 700, widthMode: "fill" }),
      text("b", "card", BODY, { fontSize: 14, lineHeight: { unit: "percent", value: 150 }, widthMode: "fill" }),
      text("m", "card", "Updated 2 hours ago", { fontSize: 12, fills: [solid(113, 113, 122)] }),
    ],
  ],
  [
    "runs",
    (p) => [
      textRuns("t", p, [["Regular, "], ["bold", { fontWeight: 700 }], [", "], ["italic", { fontStyle: "italic", fontFamily: "Noto Sans" }], [", "], ["large", { fontSize: 28 }], [" and "], ["small", { fontSize: 11 }], [" runs in one paragraph that wraps."]], { x: 10, y: 10, width: 260, widthMode: "fixed" }),
    ],
  ],
  [
    "paragraph-spacing",
    (p) => [text("t", p, `First paragraph of the text.\nSecond paragraph, longer, so that it wraps onto another line.\n\nFourth after an empty one.`, { x: 10, y: 10, width: 220, widthMode: "fixed", paragraphSpacing: 12 })],
  ],
  ["paragraph-indent", (p) => [text("t", p, `${BODY}\n${BODY}`, { x: 10, y: 10, width: 260, widthMode: "fixed", paragraphIndent: 24 })]],
  [
    "lists",
    (p) => [
      textRuns(
        "t",
        p,
        [
          ["Shopping list\n"],
          ["Apples and pears\nBread\nA longer item that wraps onto the next line here\n", { listStyle: "bullet" }],
          ["Nested item\n", { listStyle: "bullet", listLevel: 1 }],
          ["Back to the top", { listStyle: "ordered" }],
        ],
        { x: 10, y: 10, width: 260, widthMode: "fixed" },
      ),
    ],
  ],
  ["ordered-list", (p) => [text("t", p, "First step\nSecond step\nThird step that wraps around the end of the line", { x: 10, y: 10, width: 220, widthMode: "fixed", listStyle: "ordered" })]],
  ["rtl", (p) => [text("t", p, ARABIC, { x: 10, y: 10, width: 220, widthMode: "fixed", fontFamily: "Noto Sans Arabic", direction: "rtl" })]],
  ["rtl-auto-direction", (p) => [text("t", p, ARABIC, { x: 10, y: 10, width: 220, widthMode: "fixed", fontFamily: "Noto Sans Arabic" })]],
  ["auto-direction-latin-first", (p) => [textRuns("t", p, [["Fig Tree "], [ARABIC, { fontFamily: "Noto Sans Arabic" }]], { x: 10, y: 10, width: 220, widthMode: "fixed" })]],
  ["rtl-auto", (p) => [text("t", p, ARABIC, { x: 10, y: 10, width: 220, widthMode: "fixed", fontFamily: "Noto Sans Arabic", textAlign: "start" })]],
  ["variable-weight", (p) => [text("t", p, "Weight 650 via the wght axis", { x: 10, y: 10, fontWeight: 650, fontSize: 22 }), text("u", p, "Weight 250", { x: 10, y: 50, fontVariations: { wght: 250 }, fontSize: 22 })]],
  ["letter-spacing", (p) => [text("t", p, BODY, { x: 10, y: 10, width: 260, widthMode: "fixed", letterSpacing: { unit: "em", value: 0.05 } })]],
  ["line-height-px", (p) => [text("t", p, BODY, { x: 10, y: 10, width: 260, widthMode: "fixed", lineHeight: { unit: "px", value: 28 } })]],
  ["uppercase", (p) => [text("t", p, "small caps label", { x: 10, y: 10, textTransform: "uppercase", letterSpacing: { unit: "px", value: 1.5 }, fontSize: 12, fontWeight: 600 })]],
  ["truncate-lines", (p) => [text("t", p, `${BODY} ${BODY}`, { x: 10, y: 10, width: 200, widthMode: "fixed", maxLines: 2, textOverflow: "ellipsis" })]],
  ["white-space-normal", (p) => [text("t", p, "Spaces   collapse   here\tand\ttabs too", { x: 10, y: 10, width: 300, widthMode: "fixed", whiteSpace: "normal" })]],
  ["balance", (p) => [text("t", p, "Balanced headline text wraps evenly across lines", { x: 10, y: 10, width: 300, widthMode: "fixed", fontSize: 24, textWrap: "balance" })]],
  [
    "grid-labels",
    (p) => [
      frame("g", p, { x: 10, y: 10, width: 360, height: 100, heightMode: "hug", display: "grid", gridTemplateColumns: [{ type: "max-content" }, { type: "fr", value: 1 }], columnGap: 12, rowGap: 6, padding: pad(10) }),
      ...[["Name", "Ada Lovelace"], ["Role", "Analyst and writer of the first published algorithm"], ["Since", "1843"]].flatMap(([k, v], i): Command[] => [
        text(`k${i}`, "g", k!, { fontWeight: 600, position: "relative" }),
        text(`v${i}`, "g", v!, { position: "relative", widthMode: "fill" }),
      ]),
    ],
  ],
  [
    "fill-width",
    (p) => [
      frame("f", p, { x: 10, y: 10, width: 320, height: 60, heightMode: "hug", display: "flex", columnGap: 10, padding: pad(10), alignItems: "baseline" }),
      text("a", "f", "Title", { fontSize: 28, fontWeight: 700 }),
      text("b", "f", BODY, { fontSize: 13, widthMode: "fill" }),
    ],
  ],
  ["mixed-scripts", (p) => [textRuns("t", p, [["Design "], ["设计", { fontFamily: "Noto Sans SC" }], [" "], ["तत्व", { fontFamily: "Noto Sans Devanagari" }], [" "], ["تصميم", { fontFamily: "Noto Sans Arabic" }], [" together"]], { x: 10, y: 10, width: 300, widthMode: "fixed" })]],
  ["decoration", (p) => [textRuns("t", p, [["Underlined and "], ["struck", { textDecoration: "line-through" }], [" text keeps its layout"]], { x: 10, y: 10, width: 220, widthMode: "fixed", textDecoration: "underline" })]],
];

const WORDS = ["design", "type", "layout", "flex", "grid", "glyph", "kerning", "baseline", "wrap", "a", "of", "the", "inline", "paragraph", "variable", "font"];

/** Seeded random documents: flex frames of text items with random sizes, weights, widths and wrapping. */
function randomDocs(count: number, seed: number): [string, FigDocument][] {
  const out: [string, FigDocument][] = [];
  for (let n = 0; n < count; n++) {
    const rand = seededRandom(seed + n * 7919);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const doc = make(seed + n, (p) => {
      const cmds: Command[] = [];
      const column = rand() < 0.4;
      cmds.push(frame("f", p, { x: 10, y: 10, width: 200 + Math.floor(rand() * 260), height: 50, heightMode: "hug", display: "flex", flexDirection: column ? "column" : "row", flexWrap: rand() < 0.5 ? "wrap" : "nowrap", columnGap: Math.floor(rand() * 12), rowGap: Math.floor(rand() * 10), padding: pad(Math.floor(rand() * 12)), alignItems: pick(["flex-start", "center", "baseline", "stretch"]) }));
      const items = 2 + Math.floor(rand() * 4);
      for (let i = 0; i < items; i++) {
        const words = Array.from({ length: 1 + Math.floor(rand() * 9) }, () => pick(WORDS)).join(" ");
        const widthMode = pick(["hug", "hug", "fill", "fixed"]);
        cmds.push(
          text(`t${i}`, "f", words, {
            fontFamily: pick(["Inter", "Noto Sans"]),
            fontSize: pick([11, 12, 13, 14, 16, 18, 20, 24]),
            fontWeight: pick([300, 400, 500, 600, 700]),
            widthMode,
            ...(widthMode === "fixed" ? { width: 60 + Math.floor(rand() * 120) } : {}),
            ...(rand() < 0.3 ? { lineHeight: { unit: "percent", value: pick([100, 120, 140, 160]) } } : {}),
            ...(rand() < 0.2 ? { letterSpacing: { unit: "px", value: pick([-0.5, 0.5, 1]) } } : {}),
            ...(rand() < 0.2 ? { textAlign: pick(["center", "end", "justify"]) } : {}),
            position: "relative",
          }),
        );
      }
      return cmds;
    });
    out.push([`random-${n}`, doc]);
  }
  return out;
}

export function documentTextCases(): DocumentTextCase[] {
  const cases = HAND.map(([name, commands], i) => toTextCase(name, make(100 + i, commands)));
  for (const [name, doc] of randomDocs(30, 4000)) cases.push(toTextCase(name, doc));
  return cases;
}

/** The bridge's layout of a document text case, as a {@link TextReference} (boxes and grapheme rects). */
export function documentTextResult(dc: DocumentTextCase, fonts: FontRegistry): { result: TextReference; sources: string[] } {
  const layout = new DocumentLayout(dc.doc, dc.page, fonts);
  const abs = (id: string): [number, number] => {
    let x = 0;
    let y = 0;
    for (let p: string | undefined = id; p !== undefined && p !== dc.page; p = dc.doc.tree.parentOf(p)) {
      const b = layout.box(p);
      if (!b) continue;
      x += b.x;
      y += b.y;
    }
    return [x, y];
  };
  const boxes: Rect4[] = [[0, 0, 0, 0]];
  for (const id of dc.ids) {
    const [x, y] = abs(id);
    const b = layout.box(id)!;
    boxes.push([x, y, b.width, b.height]);
  }
  const sources: string[] = [];
  const texts = dc.textIds.map((id) => {
    const t = layout.text(id)!;
    const node = layout.layoutNode(id)!;
    const et = engineText(node, t.block);
    sources.push(et.source);
    const [x, y] = abs(id);
    const b = layout.box(id)!;
    const valign = dc.doc.get<string>(id, "verticalAlign");
    const free = b.height - t.layout.height;
    const dy = valign === "center" ? free / 2 : valign === "bottom" ? free : 0;
    return textGraphemes(et, x, y, b.width, dy);
  });
  return { result: { boxes, texts }, sources };
}
