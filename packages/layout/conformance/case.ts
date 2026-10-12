import { computeLayout } from "../src/compute";
import { parseStyle } from "../src/css";
import { WordsMeasurer } from "../src/measure";
import { LayoutNode } from "../src/node";

/**
 * A conformance case: a tree of boxes described by plain CSS declarations.
 * The same tree is rendered as HTML in Chromium (the reference) and laid
 * out by our engine; every box's border box must match.
 *
 * Leaves can be:
 * - empty `div`s;
 * - text-like measured leaves (`text`): "words" of fixed sizes, rendered as
 *   inline-block spans in a `font-size: 0; line-height: 0` block, which
 *   {@link WordsMeasurer} mirrors exactly (line breaks, heights, baselines);
 * - replaced leaves (`replaced`): a `<canvas>` with a natural size.
 */
export interface CaseNode {
  readonly style?: string;
  readonly children?: readonly CaseNode[];
  readonly text?: readonly (readonly [number, number])[];
  readonly replaced?: readonly [number, number];
}

export type Area = "flex" | "grid" | "box" | "position" | "block";

export interface LayoutCase {
  readonly name: string;
  readonly area: Area;
  /** Hand-written or seeded random. */
  readonly kind: "hand" | "random";
  readonly root: CaseNode;
  /** Initial containing block (viewport) size, default 800 × 600. */
  readonly viewport?: readonly [number, number];
}

export const VIEWPORT: readonly [number, number] = [800, 600];

/** Rect of a box relative to the viewport: x, y, width, height. */
export type Rect4 = [number, number, number, number];

/** Nodes in depth-first pre-order (the order rects are recorded in). */
export function flatten(root: CaseNode): CaseNode[] {
  const out: CaseNode[] = [];
  const walk = (n: CaseNode): void => {
    out.push(n);
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return out;
}

// ── HTML ─────────────────────────────────────────────────────────────────

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** Our block containers are always independent formatting contexts: say so to Chromium. */
function htmlStyle(n: CaseNode): string {
  const style = (n.style ?? "").trim().replace(/;\s*$/, "");
  const display = /(?:^|;)\s*display\s*:\s*([^;]+)/i.exec(style)?.[1]?.trim();
  const extra: string[] = [];
  if (!display || display === "block") extra.push("display:flow-root");
  if (n.text) extra.push("font-size:0", "line-height:0");
  // Scroll containers get no scrollbar gutter in the engine.
  if (/overflow[^:]*:\s*[^;]*(scroll|auto)/i.test(style)) extra.push("scrollbar-width:none");
  return [style, ...extra].filter(Boolean).join(";");
}

/** The case as an HTML document fragment (the viewport and its content). */
export function caseHtml(c: LayoutCase): string {
  const [vw, vh] = c.viewport ?? VIEWPORT;
  let id = 0;
  const render = (n: CaseNode): string => {
    const attrs = `data-id="${id++}" style="${escapeAttr(htmlStyle(n))}"`;
    if (n.replaced) return `<canvas ${attrs} width="${n.replaced[0]}" height="${n.replaced[1]}"></canvas>`;
    let inner = "";
    if (n.text) inner = n.text.map(([w, h]) => `<span style="display:inline-block;width:${w}px;height:${h}px"></span>`).join(" ");
    else inner = (n.children ?? []).map(render).join("");
    return `<div ${attrs}>${inner}</div>`;
  };
  return `<div id="vp" style="position:relative;display:flow-root;width:${vw}px;height:${vh}px">${render(c.root)}</div>`;
}

export function pageHtml(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}canvas{display:block}</style></head><body>${body}</body></html>`;
}

/** Runs in the browser: rects of every `[data-id]` element relative to `#vp`, in id order. */
export const MEASURE_SCRIPT = `(() => {
  const vp = document.getElementById("vp").getBoundingClientRect();
  const els = [...document.querySelectorAll("#vp [data-id]")];
  els.sort((a, b) => Number(a.dataset.id) - Number(b.dataset.id));
  return els.map((e) => { const r = e.getBoundingClientRect(); return [r.x - vp.x, r.y - vp.y, r.width, r.height]; });
})()`;

// ── Engine ───────────────────────────────────────────────────────────────

export interface EngineTree {
  readonly root: LayoutNode;
  readonly nodes: LayoutNode[];
}

export function buildEngineTree(c: LayoutCase): EngineTree {
  const nodes: LayoutNode[] = [];
  const build = (n: CaseNode): LayoutNode => {
    const node = new LayoutNode(parseStyle(n.style ?? ""));
    nodes.push(node);
    if (n.text) node.setMeasure(new WordsMeasurer(n.text));
    if (n.replaced) node.setReplaced({ width: n.replaced[0], height: n.replaced[1] });
    for (const child of n.children ?? []) node.appendChild(build(child));
    return node;
  };
  return { root: build(c.root), nodes };
}

/** Lays the case out with our engine and returns each box's viewport-relative rect (pre-order). */
export function engineRects(c: LayoutCase, tree: EngineTree = buildEngineTree(c)): Rect4[] {
  const [vw, vh] = c.viewport ?? VIEWPORT;
  computeLayout(tree.root, vw, vh);
  return tree.nodes.map((n) => {
    let x = 0;
    let y = 0;
    for (let p: LayoutNode | null = n; p; p = p.parent) {
      x += p.out.x;
      y += p.out.y;
    }
    return [x, y, n.out.width, n.out.height];
  });
}

/** Whether a node (or an ancestor) is `display: none` in the case. */
export function hiddenMask(c: LayoutCase): boolean[] {
  const out: boolean[] = [];
  const walk = (n: CaseNode, hidden: boolean): void => {
    const h = hidden || /(?:^|;)\s*display\s*:\s*none/i.test(n.style ?? "");
    out.push(h);
    for (const ch of n.children ?? []) walk(ch, h);
  };
  walk(c.root, false);
  return out;
}

export interface Comparison {
  /** Largest absolute difference over all boxes and coordinates. */
  readonly maxError: number;
  readonly boxes: number;
  /** Boxes within 1 px on every coordinate, and within 0.01 px. */
  readonly within1: number;
  readonly within001: number;
  /** First mismatching box, for messages. */
  readonly worst: { index: number; expected: Rect4; actual: Rect4 } | null;
}

export function compare(c: LayoutCase, expected: readonly Rect4[], actual: readonly Rect4[]): Comparison {
  const hidden = hiddenMask(c);
  let maxError = 0;
  let within1 = 0;
  let within001 = 0;
  let worst: Comparison["worst"] = null;
  let worstErr = -1;
  for (let i = 0; i < expected.length; i++) {
    const e = expected[i]!;
    const a = actual[i] ?? [NaN, NaN, NaN, NaN];
    // Boxes inside display: none have no geometry; Chromium reports zeros.
    const idx = hidden[i] ? [2, 3] : [0, 1, 2, 3];
    let err = 0;
    for (const k of idx) {
      const d = Math.abs(e[k]! - a[k]!);
      err = Number.isNaN(d) ? Infinity : Math.max(err, d);
    }
    if (err <= 1) within1++;
    if (err <= 0.01) within001++;
    if (err > worstErr) {
      worstErr = err;
      worst = { index: i, expected: e, actual: a as Rect4 };
    }
    maxError = Math.max(maxError, err);
  }
  return { maxError, boxes: expected.length, within1, within001, worst: maxError > 1 ? worst : null };
}

/** A short stable hash of the case's HTML, stored with fixtures to detect stale references. */
export function caseHash(c: LayoutCase): string {
  const s = caseHtml(c) + JSON.stringify(c.viewport ?? VIEWPORT);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ch, 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

// ── Builders for hand-written cases ──────────────────────────────────────

export function div(style = "", ...children: CaseNode[]): CaseNode {
  return children.length ? { style, children } : { style };
}

export function text(style: string, words: readonly (readonly [number, number])[]): CaseNode {
  return { style, text: words };
}

/** `n` words of `w`×`h`. */
export function words(n: number, w: number, h: number): [number, number][] {
  return Array.from({ length: n }, () => [w, h] as [number, number]);
}

export function canvas(style: string, width: number, height: number): CaseNode {
  return { style, replaced: [width, height] };
}
