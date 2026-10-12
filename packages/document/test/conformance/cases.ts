import type { CaseNode, LayoutCase } from "../../../layout/conformance/case";
import { Gen } from "../../../layout/conformance/random";
import { FigDocument, cssDeclarations, seededRandom, type Command, type TrackListEntry, type TrackSize } from "../../src";

/**
 * Documents as conformance cases: each node becomes a `div` carrying the
 * CSS `cssDeclarations` states for it (minus `transform`, which does not
 * affect layout but would rotate the measured rectangles). Chromium's boxes
 * for that HTML are the reference for both the layout engine (run on the
 * same CSS) and the bridge's DocumentLayout: what the editor renders is
 * what the exported CSS renders in a browser.
 */

export interface DocumentCase {
  readonly case: LayoutCase;
  readonly doc: FigDocument;
  readonly page: string;
  /** Document node ids in the case's pre-order, after the page root. */
  readonly ids: readonly string[];
}

export function toCase(name: string, doc: FigDocument, kind: "hand" | "random"): DocumentCase {
  const page = doc.pages[0]!;
  const ids: string[] = [];
  const node = (id: string): CaseNode => {
    ids.push(id);
    const css = cssDeclarations(doc, id);
    delete css.transform;
    const style = Object.entries(css)
      .map(([k, v]) => `${k}:${v}`)
      .join(";");
    const children = doc.tree.childrenOf(id).map(node);
    return children.length ? { style, children } : { style };
  };
  const root: CaseNode = { style: "position:relative;width:0px;height:0px", children: doc.tree.childrenOf(page).map(node) };
  return { case: { name: `document/${name}`, area: "document", kind, root }, doc, page, ids };
}

const solid = { type: "solid" as const, color: { r: 0.2, g: 0.4, b: 0.8, a: 1 } };

function make(seed: number, commands: (page: string) => Command[]): FigDocument {
  const doc = FigDocument.create({ random: seededRandom(seed), clientId: 1 });
  doc.apply(commands(doc.pages[0]!), doc.actor("author"));
  return doc;
}

const frame = (id: string, parent: string, props: Record<string, unknown>): Command => ({ type: "createNode", node: { id, type: "frame", props: { fills: [solid], ...props } }, parent });
const rect = (id: string, parent: string, props: Record<string, unknown> = {}): Command => ({ type: "createNode", node: { id, type: "rectangle", props: { fills: [solid], ...props } }, parent });
const pad = (v: number) => ({ top: v, right: v, bottom: v, left: v });

const HAND: [string, (page: string) => Command[]][] = [
  ["toolbar", (p) => [
    frame("bar", p, { x: 20, y: 20, width: 360, height: 56, display: "flex", alignItems: "center", columnGap: 8, padding: pad(12) }),
    rect("a", "bar", { width: 32, height: 32 }),
    rect("b", "bar", { width: 40, height: 32, widthMode: "fill" }),
    rect("c", "bar", { width: 72, height: 24 }),
  ]],
  ["hug-column", (p) => [
    frame("list", p, { x: 20, y: 20, width: 100, height: 100, widthMode: "hug", heightMode: "hug", display: "flex", flexDirection: "column", rowGap: 10, padding: pad(12) }),
    rect("r0", "list", { width: 120, height: 40 }),
    rect("r1", "list", { width: 80, height: 50, widthMode: "fill" }),
    rect("r2", "list", { width: 60, height: 60 }),
  ]],
  ["grid-spans", (p) => [
    frame("g", p, { x: 10, y: 10, width: 360, height: 260, display: "grid", gridTemplateColumns: [{ type: "repeat", count: 3, tracks: [{ type: "fr", value: 1 }] }], gridTemplateRows: [{ type: "fr", value: 1 }, { type: "fr", value: 1 }], rowGap: 8, columnGap: 8, padding: pad(12) }),
    rect("w", "g", { width: 10, height: 10, widthMode: "fill", heightMode: "fill", gridColumn: { start: { span: 2 }, end: "auto" } }),
    rect("t", "g", { width: 10, height: 10, widthMode: "fill", heightMode: "fill", gridRow: { start: { span: 2 }, end: "auto" } }),
    rect("a", "g", { width: 10, height: 10, widthMode: "fill", heightMode: "fill" }),
    rect("b", "g", { width: 50, height: 30, justifySelf: "center", alignSelf: "end" }),
  ]],
  ["grid-areas", (p) => [
    frame("g", p, { x: 0, y: 0, width: 400, height: 300, display: "grid", gridTemplateColumns: [{ type: "px", value: 100 }, { type: "fr", value: 1 }], gridTemplateRows: [{ type: "px", value: 50 }, { type: "fr", value: 1 }, { type: "px", value: 40 }], gridTemplateAreas: ["head head", "side main", "foot foot"] }),
    rect("h", "g", { width: 10, height: 10, widthMode: "fill", heightMode: "fill", gridColumn: { start: { name: "head" }, end: { name: "head" } }, gridRow: { start: { name: "head" }, end: { name: "head" } } }),
    rect("s", "g", { width: 10, height: 10, widthMode: "fill", heightMode: "fill", gridColumn: { start: { name: "side" }, end: { name: "side" } }, gridRow: { start: { name: "side" }, end: { name: "side" } } }),
    rect("m", "g", { width: 10, height: 10, widthMode: "fill", heightMode: "fill", gridColumn: { start: { name: "main" }, end: { name: "main" } }, gridRow: { start: { name: "main" }, end: { name: "main" } } }),
  ]],
  ["constraints-in-fill-frame", (p) => [
    frame("outer", p, { x: 0, y: 0, width: 300, height: 160, display: "flex" }),
    frame("f", "outer", { width: 200, height: 100, widthMode: "fill", heightMode: "fill" }),
    rect("start", "f", { x: 10, y: 10, width: 40, height: 20 }),
    rect("end", "f", { x: 150, y: 70, width: 40, height: 20, constraints: { horizontal: "end", vertical: "end" } }),
    rect("both", "f", { x: 20, y: 40, width: 100, height: 20, constraints: { horizontal: "start-end", vertical: "start" } }),
    rect("center", "f", { x: 80, y: 30, width: 40, height: 40, constraints: { horizontal: "center", vertical: "center" } }),
    rect("scale", "f", { x: 20, y: 10, width: 100, height: 50, constraints: { horizontal: "scale", vertical: "scale" } }),
  ]],
  ["borders-in-layout", (p) => [
    frame("b", p, { x: 0, y: 0, width: 200, height: 120, strokes: [solid], strokeWeight: { top: 4, right: 6, bottom: 8, left: 10 }, strokesInLayout: true, display: "flex", padding: pad(5), columnGap: 5 }),
    rect("x", "b", { width: 30, height: 30 }),
    rect("y", "b", { width: 30, height: 30, widthMode: "fill", heightMode: "fill" }),
    { type: "createNode", node: { id: "abs", type: "rectangle", props: { position: "absolute", x: 150, y: 80, width: 30, height: 20, constraints: { horizontal: "end", vertical: "end" } } }, parent: "b" },
  ]],
  ["min-max-and-shrink", (p) => [
    frame("row", p, { x: 0, y: 0, width: 300, height: 80, display: "flex", columnGap: 10 }),
    rect("a", "row", { width: 200, height: 20, minWidth: 150 }),
    rect("b", "row", { width: 200, height: 20, flexShrink: 1 }),
    rect("c", "row", { width: 50, height: 20, widthMode: "fill", maxWidth: 40 }),
  ]],
  ["nested-auto-layout", (p) => [
    frame("page", p, { x: 0, y: 0, width: 500, height: 300, display: "flex", flexDirection: "column", rowGap: 12, padding: pad(16) }),
    frame("head", "page", { width: 100, height: 48, widthMode: "fill", display: "flex", justifyContent: "space-between", alignItems: "center", padding: pad(8) }),
    rect("logo", "head", { width: 32, height: 32 }),
    rect("menu", "head", { width: 80, height: 24 }),
    frame("body", "page", { width: 100, height: 100, widthMode: "fill", heightMode: "fill", display: "grid", gridTemplateColumns: [{ type: "minmax", min: { type: "px", value: 80 }, max: { type: "fr", value: 1 } }, { type: "fr", value: 2 }], columnGap: 12 }),
    rect("side", "body", { width: 10, height: 10, widthMode: "fill", heightMode: "fill" }),
    rect("main", "body", { width: 10, height: 10, widthMode: "fill", heightMode: "fill" }),
  ]],
];

// ── Random documents ─────────────────────────────────────────────────────

function trackSize(g: Gen): TrackSize {
  return g.weighted<TrackSize>([
    [{ type: "px", value: g.int(20, 120) }, 3],
    [{ type: "fr", value: g.pick([1, 1, 2, 0.5]) }, 3],
    [{ type: "auto" }, 2],
    [{ type: "percent", value: g.int(10, 40) }, 1],
    [{ type: "min-content" }, 1],
    [{ type: "max-content" }, 1],
    [{ type: "minmax", min: { type: "px", value: g.int(10, 60) }, max: { type: "fr", value: 1 } }, 2],
    [{ type: "fit-content", value: g.int(20, 100) }, 1],
  ]);
}

function randomDocument(seed: number): FigDocument {
  const g = new Gen(seed);
  let n = 0;
  return make(seed, (page) => {
    const out: Command[] = [];
    const container = (id: string, parent: string, depth: number, top: boolean): void => {
      const display = g.weighted<"flex" | "grid" | "block">([["flex", 5], ["grid", 3], ["block", depth > 0 ? 1 : 0]]);
      const props: Record<string, unknown> = { display };
      if (top) Object.assign(props, { x: g.int(0, 40), y: g.int(0, 40), width: g.int(200, 520), height: g.int(100, 400) });
      else {
        props.width = g.int(60, 220);
        props.height = g.int(40, 160);
        props.widthMode = g.pick(["fixed", "hug", "fill"]);
        props.heightMode = g.pick(["fixed", "hug", "fill"]);
      }
      if (top && g.chance(0.3)) props.heightMode = "hug";
      if (g.chance(0.5)) props.padding = { top: g.int(0, 16), right: g.int(0, 16), bottom: g.int(0, 16), left: g.int(0, 16) };
      if (g.chance(0.2)) Object.assign(props, { strokes: [solid], strokeWeight: g.int(1, 6), strokesInLayout: true });
      if (display === "flex") {
        Object.assign(props, {
          flexDirection: g.pick(["row", "row", "column", "row-reverse", "column-reverse"]),
          flexWrap: g.pick(["nowrap", "nowrap", "wrap"]),
          ...(g.chance(0.6) ? { justifyContent: g.pick(["flex-start", "center", "flex-end", "space-between", "space-around", "space-evenly"]) } : {}),
          ...(g.chance(0.6) ? { alignItems: g.pick(["flex-start", "center", "flex-end", "stretch"]) } : {}),
          ...(g.chance(0.3) ? { alignContent: g.pick(["flex-start", "center", "space-between", "stretch"]) } : {}),
        });
      }
      if (display === "grid") {
        const cols: TrackListEntry[] = Array.from({ length: g.int(1, 4) }, () => trackSize(g));
        props.gridTemplateColumns = cols;
        if (g.chance(0.6)) props.gridTemplateRows = Array.from({ length: g.int(1, 3) }, () => trackSize(g));
        if (g.chance(0.3)) props.gridAutoFlow = g.pick(["row", "column", "row dense"]);
        if (g.chance(0.3)) props.justifyItems = g.pick(["start", "center", "end", "stretch"]);
        if (g.chance(0.3)) props.alignItems = g.pick(["start", "center", "end", "stretch"]);
        if (g.chance(0.3)) props.justifyContent = g.pick(["start", "center", "space-between", "end"]);
      }
      if (display !== "block" && g.chance(0.6)) Object.assign(props, { rowGap: g.int(0, 16), columnGap: g.int(0, 16) });
      out.push(frame(id, parent, props));
      const count = g.int(1, depth === 0 ? 6 : 3);
      for (let i = 0; i < count; i++) {
        const cid = `n${n++}`;
        if (depth < 1 && g.chance(0.25)) {
          container(cid, id, depth + 1, false);
          continue;
        }
        const child: Record<string, unknown> = { width: g.int(10, 120), height: g.int(10, 80) };
        if (display === "block" || g.chance(0.1)) {
          child.position = "absolute";
          child.x = g.int(0, 100);
          child.y = g.int(0, 60);
          child.constraints = { horizontal: g.pick(["start", "end", "start-end", "center", "scale"]), vertical: g.pick(["start", "end", "start-end", "center", "scale"]) };
        } else {
          if (g.chance(0.3)) child.widthMode = g.pick(["fill", "fixed"]);
          if (g.chance(0.3)) child.heightMode = g.pick(["fill", "fixed"]);
          if (g.chance(0.2)) child.minWidth = g.int(10, 80);
          if (g.chance(0.15)) child.maxWidth = g.int(20, 120);
          if (g.chance(0.15)) child.minHeight = g.int(10, 60);
          if (g.chance(0.2)) child.flexGrow = g.pick([0, 1, 2]);
          if (g.chance(0.2)) child.flexShrink = g.pick([0, 1, 3]);
          if (g.chance(0.15)) child.flexBasis = g.pick(["auto", "content", g.int(0, 100)]);
          if (g.chance(0.2)) child.alignSelf = g.pick(["flex-start", "center", "flex-end", "stretch", "start", "end"]);
          if (g.chance(0.1)) child.order = g.int(-1, 2);
          if (g.chance(0.2)) child.margin = { top: g.int(0, 10), right: g.pick([0, 5, "auto"]), bottom: g.int(0, 10), left: g.int(-5, 10) };
          if (display === "grid" && g.chance(0.3)) child.gridColumn = { start: g.pick(["auto", 1, 2, -1]), end: g.pick(["auto", { span: 2 }, { span: 1 }]) };
          if (display === "grid" && g.chance(0.2)) child.gridRow = { start: g.pick(["auto", 1, 2]), end: g.pick(["auto", { span: 2 }]) };
          if (display === "grid" && g.chance(0.2)) child.justifySelf = g.pick(["start", "center", "end", "stretch"]);
          if (g.chance(0.08)) child.aspectRatio = g.pick([1, 2, 0.5]);
        }
        out.push({ type: "createNode", node: { id: cid, type: g.chance(0.3) ? "ellipse" : "rectangle", props: { fills: [solid], ...child } }, parent: id });
      }
    };
    container("top", page, 0, true);
    return out;
  });
}

export function documentCases(): DocumentCase[] {
  const hand = HAND.map(([name, cmds], i) => toCase(name, make(100 + i, cmds), "hand"));
  const random = Array.from({ length: 120 }, (_, i) => toCase(`random-${3000 + i}`, randomDocument(3000 + i), "random"));
  return [...hand, ...random];
}
