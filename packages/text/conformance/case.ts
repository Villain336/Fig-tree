import { LayoutNode, computeLayout, parseStyle } from "@fig-tree/layout";
import { TextBlock, firstStrongDirection, parseParagraphStyle, parseTextStyle, type FontRegistry, type ParagraphInput, type ParagraphStyle, type TextStyle } from "../src/index";
import { DEFAULT_PARAGRAPH_STYLE, DEFAULT_TEXT_STYLE } from "../src/style";
import { fontDigest, fontFaceCss } from "./fonts";

/**
 * A text conformance case: a tree of boxes described by CSS, where leaves
 * can hold text (plain, or style runs rendered as `<span>`s, optionally in
 * several `<p>` paragraphs). Chromium renders it as HTML with the fixture
 * fonts; the engine lays out the same CSS. Compared: every box's border
 * box, each line's break position and baseline, and the rectangle of every
 * grapheme (Range.getBoundingClientRect).
 */

/** A style run: plain text, or [css, text] rendered as a span. */
export type Run = string | readonly [css: string, text: string];

/** A paragraph of a text leaf: a `<p>` (margins zero) holding runs. */
export interface Paragraph {
  readonly runs: readonly Run[];
  /** Space above the paragraph (CSS margin-top), px. */
  readonly spaceBefore?: number;
  /** A list item: content inset (margin-inline-start) and an outside string marker. */
  readonly list?: { readonly inset: number; readonly marker: string };
}

export interface TextNode {
  readonly style?: string;
  readonly children?: readonly TextNode[];
  /** Text content: the node is a block container of these inline runs. */
  readonly text?: readonly Run[];
  /** Text content as paragraphs (each a block). */
  readonly paragraphs?: readonly Paragraph[];
  /** HTML `lang` of the node. */
  readonly lang?: string;
  /** HTML `dir` of the node (`auto`: the direction of the first strong character of its text). */
  readonly dir?: "ltr" | "rtl" | "auto";
}

export type TextArea =
  | "basic"
  | "white-space"
  | "breaking"
  | "spacing"
  | "line-height"
  | "align"
  | "fonts"
  | "features"
  | "bidi"
  | "arabic"
  | "devanagari"
  | "cjk"
  | "transform"
  | "truncation"
  | "wrap-style"
  | "sizing"
  | "document";

export interface TextCase {
  readonly name: string;
  readonly area: TextArea;
  readonly root: TextNode;
  readonly viewport?: readonly [number, number];
}

export const TEXT_VIEWPORT: readonly [number, number] = [800, 400];

export type Rect4 = [number, number, number, number];

/** What Chromium reports for a case. */
export interface TextReference {
  /** Border boxes of all nodes, pre-order. */
  readonly boxes: Rect4[];
  /**
   * Per text leaf (pre-order): for each source grapheme, `[start, run, x, y, w, h]`
   * (the rect is null when the grapheme has no box), and each run's ascent.
   * Sources and runs count the leaf's DOM text nodes in order.
   */
  readonly texts: { readonly graphemes: readonly (readonly (number | null)[])[]; readonly ascents: readonly number[] }[];
}

/** The paragraphs of a text leaf. */
export function paragraphsOf(n: TextNode): Paragraph[] {
  if (n.paragraphs) return [...n.paragraphs];
  return n.text ? [{ runs: n.text }] : [];
}

// ── HTML ─────────────────────────────────────────────────────────────────

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function blockStyle(n: TextNode): string {
  const style = (n.style ?? "").trim().replace(/;\s*$/, "");
  const display = /(?:^|;)\s*display\s*:\s*([^;]+)/i.exec(style)?.[1]?.trim();
  const extra: string[] = [];
  // Block containers are independent formatting contexts in the engine.
  if (!display || display === "block") extra.push("display:flow-root");
  return [style, ...extra].filter(Boolean).join(";");
}

function runsHtml(runs: readonly Run[]): string {
  return runs.map((r, i) => (typeof r === "string" ? escapeText(r) : `<span data-run="${i}" style="${escapeAttr(r[0])}">${escapeText(r[1])}</span>`)).join("");
}

export function caseHtml(c: TextCase): string {
  const [vw, vh] = c.viewport ?? TEXT_VIEWPORT;
  let id = 0;
  let textId = 0;
  const render = (n: TextNode): string => {
    const attrs = [`data-id="${id++}"`, `style="${escapeAttr(blockStyle(n))}"`];
    if (n.lang) attrs.push(`lang="${n.lang}"`);
    if (n.dir) attrs.push(`dir="${n.dir}"`);
    if (n.paragraphs) {
      attrs.push(`data-text="${textId++}"`);
      const inner = n.paragraphs
        .map((p) => {
          const styles = ["margin:0", `margin-top:${p.spaceBefore ?? 0}px`];
          if (p.list) styles.push("display:list-item", `list-style:${JSON.stringify(p.list.marker).replace(/"/g, "'")} outside`, `margin-inline-start:${p.list.inset}px`);
          const content = p.runs.every((r) => (typeof r === "string" ? r : r[1]) === "") ? "<br>" : runsHtml(p.runs);
          return `<p style="${escapeAttr(styles.join(";"))}">${content}</p>`;
        })
        .join("");
      return `<div ${attrs.join(" ")}>${inner}</div>`;
    }
    if (n.text) {
      attrs.push(`data-text="${textId++}"`);
      return `<div ${attrs.join(" ")}>${runsHtml(n.text)}</div>`;
    }
    return `<div ${attrs.join(" ")}>${(n.children ?? []).map(render).join("")}</div>`;
  };
  return `<div id="vp" style="position:relative;display:flow-root;width:${vw}px;height:${vh}px">${render(c.root)}</div>`;
}

export function pageHtml(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${fontFaceCss()}\nhtml,body{margin:0;padding:0}body{font-family:Inter;font-size:16px}</style></head><body>${body}</body></html>`;
}

/**
 * Runs in the browser after fonts loaded: border boxes of every
 * `[data-id]`, and for every `[data-text]` leaf the rect of each grapheme
 * of its text (in source order) plus the ascent of each run's first
 * available font (to turn rect tops into baselines).
 */
export const MEASURE_SCRIPT = `(async () => {
  await Promise.all([...document.fonts].map((f) => f.load().catch(() => null)));
  await document.fonts.ready;
  const vp = document.getElementById("vp").getBoundingClientRect();
  const r4 = (r) => [r.x - vp.x, r.y - vp.y, r.width, r.height];
  const els = [...document.querySelectorAll("#vp [data-id]")].sort((a, b) => Number(a.dataset.id) - Number(b.dataset.id));
  const boxes = els.map((e) => r4(e.getBoundingClientRect()));
  const leaves = [...document.querySelectorAll("#vp [data-text]")].sort((a, b) => Number(a.dataset.text) - Number(b.dataset.text));
  const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const probeHost = document.createElement("div");
  probeHost.style.cssText = "position:absolute;left:-10000px;top:0;visibility:hidden";
  document.body.appendChild(probeHost);
  const ascentOf = (el) => {
    const cs = getComputedStyle(el);
    const d = document.createElement("div");
    for (const p of ["font-family", "font-size", "font-weight", "font-style", "font-stretch", "font-variation-settings", "font-optical-sizing", "font-feature-settings"]) d.style.setProperty(p, cs.getPropertyValue(p));
    d.style.lineHeight = "normal";
    d.innerHTML = '<span style="display:inline-block;width:0;height:0"></span>x';
    probeHost.appendChild(d);
    const marker = d.firstChild.getBoundingClientRect().top;
    const rg = document.createRange(); rg.selectNodeContents(d.lastChild);
    const a = marker - rg.getBoundingClientRect().top;
    d.remove();
    return a;
  };
  const texts = leaves.map((leaf) => {
    const nodes = [];
    const walk = (n) => { for (const c of n.childNodes) { if (c.nodeType === 3) nodes.push(c); else walk(c); } };
    walk(leaf);
    let full = "";
    const starts = nodes.map((n) => { const s = full.length; full += n.data; return s; });
    const ascents = nodes.map((n) => ascentOf(n.parentElement));
    const graphemes = [];
    for (let k = 0; k < nodes.length; k++) {
      const node = nodes[k];
      for (const g of seg.segment(node.data)) {
        const rg = document.createRange();
        rg.setStart(node, g.index);
        rg.setEnd(node, g.index + g.segment.length);
        const s = starts[k] + g.index;
        if (rg.getClientRects().length === 0) { graphemes.push([s, k, null]); continue; }
        graphemes.push([s, k, ...r4(rg.getBoundingClientRect())]);
      }
    }
    return { graphemes, ascents };
  });
  probeHost.remove();
  return { boxes, texts };
})()`;

// ── Engine ───────────────────────────────────────────────────────────────

/** A laid-out text leaf, and how its source maps to the DOM's text nodes. */
export interface EngineText {
  readonly node: LayoutNode;
  readonly block: TextBlock;
  /** The leaf's DOM text: every paragraph's text, concatenated. */
  readonly source: string;
  /** Start of each paragraph in `source`. */
  readonly paragraphStarts: readonly number[];
  /** DOM text node (run) index of each source index. */
  readonly runOf: readonly number[];
  /** For each DOM text node: its paragraph and span. */
  readonly runs: readonly (readonly [paragraph: number, span: number])[];
}

export interface EngineTree {
  readonly root: LayoutNode;
  readonly nodes: LayoutNode[];
  readonly texts: EngineText[];
}

/** Maps a text block's paragraphs to the DOM text node numbering (one per non-empty run). */
export function engineText(node: LayoutNode, block: TextBlock): EngineText {
  let source = "";
  const paragraphStarts: number[] = [];
  const runOf: number[] = [];
  const runs: [number, number][] = [];
  block.input.paragraphs.forEach((p: ParagraphInput, pi) => {
    paragraphStarts.push(source.length);
    p.spans.forEach((s, si) => {
      if (s.end <= s.start) return;
      runs.push([pi, si]);
      for (let k = s.start; k < s.end; k++) runOf.push(runs.length - 1);
    });
    source += p.text;
  });
  return { node, block, source, paragraphStarts, runOf, runs };
}

/** Builds the layout tree with text measurers. CSS text properties inherit down the tree. */
export function buildEngineTree(c: TextCase, fonts: FontRegistry): EngineTree {
  const nodes: LayoutNode[] = [];
  const texts: EngineText[] = [];
  const build = (n: TextNode, inherited: TextStyle, inheritedPara: ParagraphStyle): LayoutNode => {
    const css = n.style ?? "";
    // -webkit-line-clamp needs `display: -webkit-box`, which lays out like a block here.
    const node = new LayoutNode(parseStyle(css.replace(/display\s*:\s*-webkit-box/i, "display: block")));
    nodes.push(node);
    const textStyle0 = parseTextStyle(css, inherited);
    const textStyle = n.lang ? { ...textStyle0, language: n.lang } : textStyle0;
    let para = parseParagraphStyle(css, inheritedPara);
    const paragraphs = paragraphsOf(n);
    if (n.dir) {
      const all = paragraphs.map((p) => p.runs.map((r) => (typeof r === "string" ? r : r[1])).join("")).join("\n");
      para = { ...para, direction: n.dir === "auto" ? (firstStrongDirection(all) ?? "ltr") : n.dir };
    }
    if (paragraphs.length > 0) {
      const inputs: ParagraphInput[] = paragraphs.map((p) => {
        let text = "";
        const spans: { start: number; end: number; style: TextStyle }[] = [];
        for (const r of p.runs) {
          const [runCss, t] = typeof r === "string" ? ["", r] : r;
          spans.push({ start: text.length, end: text.length + t.length, style: typeof r === "string" ? textStyle : parseTextStyle(runCss, textStyle) });
          text += t;
        }
        return { text, spans, style: para, root: textStyle, emptyLine: n.paragraphs !== undefined, ...(p.list ? { inlineStart: p.list.inset, marker: p.list.marker } : {}) };
      });
      const spacing = paragraphs[1]?.spaceBefore ?? 0;
      const block = new TextBlock(fonts, { paragraphs: inputs, paragraphSpacing: spacing, lineClamp: para.lineClamp });
      node.setMeasure(block);
      texts.push(engineText(node, block));
    }
    for (const child of n.children ?? []) node.appendChild(build(child, textStyle, para));
    return node;
  };
  const root = build(c.root, { ...DEFAULT_TEXT_STYLE, fontFamily: ["Inter"] }, DEFAULT_PARAGRAPH_STYLE);
  return { root, nodes, texts };
}

function absolute(n: LayoutNode): [number, number] {
  let x = 0;
  let y = 0;
  for (let p: LayoutNode | null = n; p; p = p.parent) {
    x += p.out.x;
    y += p.out.y;
  }
  return [x, y];
}

/**
 * Grapheme rects of a laid-out text leaf whose content box starts at
 * (cx, cy), in the {@link TextReference} format.
 */
export function textGraphemes(t: EngineText, cx: number, cy: number, contentWidth: number, offsetY = 0): TextReference["texts"][number] {
  const layout = t.block.layout(contentWidth);
  const shaped = t.block.shaped;
  const bySource = new Map<number, { l: number; r: number; top: number; bottom: number }>();
  for (const p of layout.paragraphs) {
    const sp = shaped[p.index]!;
    const base = t.paragraphStarts[p.index]!;
    for (const line of p.layout.lines) {
      for (const ch of line.chars) {
        const box = sp.spanBoxes[ch.span]!;
        const top = cy + offsetY + p.top + line.baseline - box.ascent;
        const bottom = top + box.ascent + box.descent;
        const src = base + sp.prepared.source[ch.index]!;
        const prev = bySource.get(src);
        if (prev) {
          prev.l = Math.min(prev.l, cx + ch.left);
          prev.r = Math.max(prev.r, cx + ch.right);
        } else bySource.set(src, { l: cx + ch.left, r: cx + ch.right, top, bottom });
      }
    }
  }
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const graphemes: (number | null)[][] = [];
  // Graphemes per DOM text node, like the browser script.
  let at = 0;
  t.runs.forEach(([pi, si], k) => {
    const span = t.block.input.paragraphs[pi]!.spans[si]!;
    const nodeText = t.block.input.paragraphs[pi]!.text.slice(span.start, span.end);
    for (const g of segmenter.segment(nodeText)) {
      const start = at + g.index;
      let box: { l: number; r: number; top: number; bottom: number } | undefined;
      for (let i = start; i < start + g.segment.length; i++) {
        const b = bySource.get(i);
        if (!b) continue;
        if (!box) box = { ...b };
        else {
          box.l = Math.min(box.l, b.l);
          box.r = Math.max(box.r, b.r);
        }
      }
      if (box) {
        // DOM rects are in layout units (1/64 px): Chromium snaps a range's edges outwards.
        const l = Math.floor(box.l * 64 + 1e-6) / 64;
        const r = Math.ceil(box.r * 64 - 1e-6) / 64;
        graphemes.push([start, k, l, box.top, r - l, box.bottom - box.top]);
      } else graphemes.push([start, k, null]);
    }
    at += nodeText.length;
  });
  const ascents = t.runs.map(([pi, si]) => shaped[pi]!.spanBoxes[si]?.ascent ?? 0);
  return { graphemes, ascents };
}

/** The engine's equivalent of {@link TextReference}. */
export function engineResult(c: TextCase, tree: EngineTree): TextReference {
  const [vw, vh] = c.viewport ?? TEXT_VIEWPORT;
  computeLayout(tree.root, vw, vh);
  const boxes = tree.nodes.map((n) => {
    const [x, y] = absolute(n);
    return [x, y, n.out.width, n.out.height] as Rect4;
  });
  const texts = tree.texts.map((t) => {
    const n = t.node;
    const [x0, y0] = absolute(n);
    const cx = x0 + n.out.border.left + n.out.padding.left;
    const cy = y0 + n.out.border.top + n.out.padding.top;
    const contentWidth = n.out.width - n.out.border.left - n.out.border.right - n.out.padding.left - n.out.padding.right;
    return textGraphemes(t, cx, cy, contentWidth);
  });
  return { boxes, texts };
}

// ── Comparison ───────────────────────────────────────────────────────────

export interface TextComparison {
  readonly boxes: number;
  readonly boxesWithin1: number;
  readonly boxesWithin001: number;
  readonly graphemes: number;
  readonly graphemesWithin1: number;
  readonly graphemesWithin001: number;
  /** Within one layout unit (1/64 px). */
  readonly graphemesWithinUnit: number;
  readonly words: number;
  readonly wordsWithin1: number;
  readonly lines: number;
  /** Line break positions (source index of each line's first grapheme) agree exactly. */
  readonly breaksMatch: boolean;
  readonly baselinesWithin1: boolean;
  readonly maxError: number;
  readonly pass: boolean;
  readonly message: string;
}

interface RefGrapheme {
  index: number;
  run: number;
  rect: Rect4 | null;
}

function refGraphemes(t: TextReference["texts"][number]): RefGrapheme[] {
  return t.graphemes.map((g) => {
    const [index, run, ...rest] = g as unknown as [number, number, ...(number | null)[]];
    return { index, run, rect: rest[0] === null || rest.length < 4 ? null : (rest as Rect4) };
  });
}

/** Groups graphemes with a box into lines by baseline (rect top + its run's ascent). */
function linesOf(gs: { index: number; rect: Rect4; baseline: number }[]): { baseline: number; start: number; members: typeof gs }[] {
  const lines: { baseline: number; start: number; members: typeof gs }[] = [];
  for (const g of gs) {
    let line = lines.find((l) => Math.abs(l.baseline - g.baseline) < 0.5);
    if (!line) lines.push((line = { baseline: g.baseline, start: g.index, members: [] }));
    line.members.push(g);
    line.start = Math.min(line.start, g.index);
  }
  return lines.sort((a, b) => a.baseline - b.baseline);
}

/**
 * Compares Chromium's reference with the engine's result: boxes, line
 * starts and baselines, and grapheme and word rects. `sources` holds each
 * text leaf's DOM text (for word splitting and messages).
 */
export function compareText(sources: readonly string[], ref: TextReference, actual: TextReference): TextComparison {
  let maxError = 0;
  let boxesWithin1 = 0;
  let boxesWithin001 = 0;
  const msgs: string[] = [];
  ref.boxes.forEach((e, i) => {
    const a = actual.boxes[i] ?? [NaN, NaN, NaN, NaN];
    const err = Math.max(...e.map((v, k) => Math.abs(v - a[k]!)));
    maxError = Math.max(maxError, Number.isNaN(err) ? Infinity : err);
    if (err <= 1) boxesWithin1++;
    else if (msgs.length < 3) msgs.push(`box #${i}: chromium ${fmt(e)} engine ${fmt(a)}`);
    if (err <= 0.01) boxesWithin001++;
  });
  let graphemes = 0;
  let graphemesWithin1 = 0;
  let graphemesWithin001 = 0;
  let graphemesWithinUnit = 0;
  let words = 0;
  let wordsWithin1 = 0;
  let lines = 0;
  let breaksMatch = true;
  let baselinesWithin1 = true;
  ref.texts.forEach((t, ti) => {
    const source = sources[ti] ?? "";
    const refG = refGraphemes(t);
    const actG = actual.texts[ti] ? refGraphemes(actual.texts[ti]!) : [];
    const act = new Map(actG.filter((g) => g.rect).map((g) => [g.index, g.rect!]));
    const actRun = new Map(actG.map((g) => [g.index, g.run]));
    // A removed (collapsed) space reports a zero-width rect: it has no box.
    const refWithBox = refG.filter((g): g is RefGrapheme & { rect: Rect4 } => g.rect !== null && g.rect[2] > 0.05);
    const refLines = linesOf(refWithBox.map((g) => ({ index: g.index, rect: g.rect, baseline: g.rect[1] + t.ascents[g.run]! })));
    const actAscents = actual.texts[ti]?.ascents ?? [];
    const shown = new Set(refWithBox.map((g) => g.index));
    const actWithBox = [...act]
      .filter(([index, r]) => r[2] > 0.05 && shown.has(index))
      .map(([index, rect]) => ({ index, rect, baseline: rect[1] + actAscents[actRun.get(index) ?? 0]! }));
    const actLines = linesOf(actWithBox);
    lines += refLines.length;
    const refStarts = refLines.map((l) => l.start).join(",");
    const actStarts = actLines.map((l) => l.start).join(",");
    if (refStarts !== actStarts) {
      breaksMatch = false;
      if (msgs.length < 3) msgs.push(`text ${ti} line starts: chromium [${refStarts}] engine [${actStarts}] in ${JSON.stringify(source.slice(0, 60))}`);
    }
    refLines.forEach((l, i) => {
      const a = actLines[i];
      if (!a || Math.abs(a.baseline - l.baseline) > 1) {
        baselinesWithin1 = false;
        if (msgs.length < 3) msgs.push(`text ${ti} line ${i} baseline: chromium ${l.baseline} engine ${a?.baseline}`);
      }
    });
    for (const g of refWithBox) {
      graphemes++;
      const a = act.get(g.index);
      const err = a ? Math.max(...g.rect.map((v, k) => Math.abs(v - a[k]!))) : Infinity;
      maxError = Math.max(maxError, err);
      if (err <= 1) graphemesWithin1++;
      else if (msgs.length < 3) msgs.push(`text ${ti} grapheme @${g.index} ${JSON.stringify(source.slice(g.index, g.index + 2))}: chromium ${fmt(g.rect)} engine ${a ? fmt(a) : "none"}`);
      if (err <= 0.01) graphemesWithin001++;
      if (err <= 1 / 64 + 1e-3) graphemesWithinUnit++;
    }
    // Words: maximal runs of non-space graphemes on one line, compared as unions.
    for (const l of refLines) {
      const members = [...l.members].sort((a, b) => a.index - b.index);
      let word: typeof members = [];
      const flush = (): void => {
        if (word.length === 0) return;
        words++;
        const u = union(word.map((w) => w.rect));
        const ar = word.map((w) => act.get(w.index)).filter((r): r is Rect4 => !!r);
        if (ar.length === word.length) {
          const ua = union(ar);
          if (Math.max(...u.map((v, k) => Math.abs(v - ua[k]!))) <= 1) wordsWithin1++;
        }
        word = [];
      };
      for (const m of members) {
        if (/\s/.test(source[m.index] ?? "")) flush();
        else word.push(m);
      }
      flush();
    }
  });
  const pass = boxesWithin1 === ref.boxes.length && breaksMatch && baselinesWithin1 && graphemesWithin1 === graphemes;
  return {
    boxes: ref.boxes.length,
    boxesWithin1,
    boxesWithin001,
    graphemes,
    graphemesWithin1,
    graphemesWithin001,
    graphemesWithinUnit,
    words,
    wordsWithin1,
    lines,
    breaksMatch,
    baselinesWithin1,
    maxError,
    pass,
    message: msgs.join("; "),
  };
}

function union(rs: Rect4[]): Rect4 {
  const x0 = Math.min(...rs.map((r) => r[0]));
  const y0 = Math.min(...rs.map((r) => r[1]));
  const x1 = Math.max(...rs.map((r) => r[0] + r[2]));
  const y1 = Math.max(...rs.map((r) => r[1] + r[3]));
  return [x0, y0, x1 - x0, y1 - y0];
}

function fmt(r: readonly number[]): string {
  return `[${r.map((v) => Math.round(v * 100) / 100).join(",")}]`;
}

/** A short stable hash of the case's HTML and the fonts, stored with fixtures to detect stale references. */
export function caseHash(c: TextCase): string {
  const s = caseHtml(c) + JSON.stringify(c.viewport ?? TEXT_VIEWPORT) + fontFaceCss() + fontDigest();
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ch, 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

// ── Builders ─────────────────────────────────────────────────────────────

export function textBox(style: string, ...runs: Run[]): TextNode {
  return { style, text: runs };
}

export function box(style: string, ...children: TextNode[]): TextNode {
  return { style, children };
}
