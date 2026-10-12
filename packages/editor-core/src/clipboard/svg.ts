import type { Color, Paint } from "@fig-tree/document";
import { multiply, type Mat2D } from "@fig-tree/geometry";
import { CLIPBOARD_FORMAT, CLIPBOARD_VERSION, computeBounds, type ClipNode, type ClipPayload } from "./format";
import { parsePathData, subpathBounds, subpathsToNetwork, transformSubpaths, type Subpath } from "./svg-path";
import { elements, parseXml, textContent, type XmlElement } from "./xml";

/**
 * SVG to nodes, for pasting and dropping SVG markup: the `<svg>` becomes a
 * frame (its viewport, clipping, no fill) holding `<g>` groups, rectangles,
 * circles and ellipses (as boxes when their transform is a translation and
 * scale, otherwise as vectors), lines, polylines, polygons and paths
 * (vector networks with the path's fill rule), and `<text>`. Presentation
 * attributes and inline `style` declare fills, strokes and opacity;
 * gradients, patterns, masks, filters, `<use>` and CSS classes are not
 * imported. Coordinates are user units = px.
 */
export function svgToPayload(svg: string, at: { x: number; y: number } = { x: 0, y: 0 }): ClipPayload {
  const root = parseXml(svg);
  if (local(root.name) !== "svg") throw new Error("not an SVG document");
  const vb = (root.attrs.viewBox ?? root.attrs.viewbox ?? "").trim().split(/[\s,]+/).map(Number);
  const hasViewBox = vb.length === 4 && vb.every(Number.isFinite) && vb[2]! > 0 && vb[3]! > 0;
  const width = length(root.attrs.width) ?? (hasViewBox ? vb[2]! : 100);
  const height = length(root.attrs.height) ?? (hasViewBox ? vb[3]! : 100);
  // viewBox → viewport (preserveAspectRatio xMidYMid meet, the default).
  let view: Mat2D = [1, 0, 0, 1, 0, 0];
  if (hasViewBox) {
    const s = Math.min(width / vb[2]!, height / vb[3]!);
    const tx = (width - vb[2]! * s) / 2 - vb[0]! * s;
    const ty = (height - vb[3]! * s) / 2 - vb[1]! * s;
    view = [s, 0, 0, s, tx, ty];
  }
  const frameWorld: Mat2D = [1, 0, 0, 1, at.x, at.y];
  const ctx: Ctx = { space: multiply(frameWorld, view), style: { ...DEFAULT_STYLE, ...styleOf(root) }, counter: new Map() };
  const children = convertChildren(root, ctx);
  const frame: ClipNode = {
    type: "frame",
    props: { name: root.attrs["data-name"] ?? "SVG", width: round(width), height: round(height), fills: [], overflowX: "hidden", overflowY: "hidden" },
    children: children.map((c) => frameChild(c, frameWorld)),
    world: frameWorld,
  };
  return { format: CLIPBOARD_FORMAT, version: CLIPBOARD_VERSION, source: { page: "", parent: null }, roots: [frame], assets: {}, bounds: computeBounds([frame]) };
}

/** Whether text looks like SVG markup. */
export function looksLikeSvg(text: string): boolean {
  const t = text.trimStart();
  return /^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(t);
}

interface Style {
  fill: string;
  fillOpacity: number;
  fillRule: "nonzero" | "evenodd";
  stroke: string;
  strokeOpacity: number;
  strokeWidth: number;
  strokeLinecap: "butt" | "round" | "square";
  strokeLinejoin: "miter" | "round" | "bevel";
  strokeMiterlimit: number;
  strokeDasharray: number[];
  fontSize: number;
  fontFamily: string;
  fontWeight: number;
  display: boolean;
  visible: boolean;
}

const DEFAULT_STYLE: Style = {
  fill: "black",
  fillOpacity: 1,
  fillRule: "nonzero",
  stroke: "none",
  strokeOpacity: 1,
  strokeWidth: 1,
  strokeLinecap: "butt",
  strokeLinejoin: "miter",
  strokeMiterlimit: 4,
  strokeDasharray: [],
  fontSize: 16,
  fontFamily: "sans-serif",
  fontWeight: 400,
  display: true,
  visible: true,
};

interface Ctx {
  /** Matrix from the element's user space to world space. */
  readonly space: Mat2D;
  readonly style: Style;
  readonly counter: Map<string, number>;
}

/** Converts a world-placed node into a child of the frame: children of frames carry frame-relative boxes. */
function frameChild(n: ClipNode, frameWorld: Mat2D): ClipNode {
  if (n.type === "group") return { ...n, children: (n.children ?? []).map((c) => frameChild(c, frameWorld)) };
  if (!n.world) return n;
  const w = n.world;
  // Box placement relative to the frame (a translation plus the node's own rotation).
  const props = { ...n.props };
  const rel: Mat2D = [w[0], w[1], w[2], w[3], w[4] - frameWorld[4], w[5] - frameWorld[5]];
  const wd = Number(props.width ?? 0);
  const ht = Number(props.height ?? 0);
  const rotation = (Math.atan2(rel[1], rel[0]) * 180) / Math.PI;
  const cx = rel[0] * (wd / 2) + rel[2] * (ht / 2) + rel[4];
  const cy = rel[1] * (wd / 2) + rel[3] * (ht / 2) + rel[5];
  props.x = round(cx - wd / 2);
  props.y = round(cy - ht / 2);
  if (Math.abs(rotation) > 1e-6) props.rotation = round(rotation);
  const { world: _w, ...rest } = n;
  void _w;
  return { ...rest, props };
}

function local(name: string): string {
  const i = name.indexOf(":");
  return (i >= 0 ? name.slice(i + 1) : name).toLowerCase();
}

function convertChildren(e: XmlElement, ctx: Ctx): ClipNode[] {
  const out: ClipNode[] = [];
  for (const c of elements(e)) {
    const n = convert(c, ctx);
    if (n) out.push(n);
  }
  return out;
}

function nameFor(ctx: Ctx, el: XmlElement, base: string): string {
  const id = el.attrs.id ?? el.attrs["data-name"];
  if (id) return id;
  const k = (ctx.counter.get(base) ?? 0) + 1;
  ctx.counter.set(base, k);
  return `${base} ${k}`;
}

function convert(el: XmlElement, parent: Ctx): ClipNode | null {
  const tag = local(el.name);
  if (["defs", "title", "desc", "metadata", "style", "script", "clippath", "mask", "pattern", "lineargradient", "radialgradient", "filter", "symbol", "marker"].includes(tag)) return null;
  const style = { ...parent.style, ...styleOf(el) };
  if (!style.display) return null;
  const transform = parseTransform(el.attrs.transform ?? "");
  const ctx: Ctx = { space: multiply(parent.space, transform), style, counter: parent.counter };
  const opacity = num(el.attrs.opacity ?? styleDecl(el).opacity, 1);
  const common: Record<string, unknown> = {};
  if (opacity < 1) common.opacity = clamp01(opacity);
  if (!style.visible) common.visible = false;
  const a = (k: string, d = 0): number => num(el.attrs[k], d);
  switch (tag) {
    case "g":
    case "svg":
    case "a":
    case "switch": {
      const children = convertChildren(el, ctx);
      if (children.length === 0) return null;
      return { type: "group", props: { name: nameFor(ctx, el, "Group"), ...common }, children };
    }
    case "rect": {
      const w = length(el.attrs.width) ?? 0;
      const h = length(el.attrs.height) ?? 0;
      if (w <= 0 || h <= 0) return null;
      const rx = length(el.attrs.rx) ?? length(el.attrs.ry) ?? 0;
      return boxShape(ctx, "rectangle", a("x"), a("y"), w, h, { name: nameFor(ctx, el, "Rectangle"), ...common, ...(rx > 0 ? { cornerRadius: rx } : {}) }, () => rectPath(a("x"), a("y"), w, h));
    }
    case "circle": {
      const r = length(el.attrs.r) ?? 0;
      if (r <= 0) return null;
      return boxShape(ctx, "ellipse", a("cx") - r, a("cy") - r, 2 * r, 2 * r, { name: nameFor(ctx, el, "Ellipse"), ...common }, () => ellipsePath(a("cx"), a("cy"), r, r));
    }
    case "ellipse": {
      const rx = length(el.attrs.rx) ?? 0;
      const ry = length(el.attrs.ry) ?? 0;
      if (rx <= 0 || ry <= 0) return null;
      return boxShape(ctx, "ellipse", a("cx") - rx, a("cy") - ry, 2 * rx, 2 * ry, { name: nameFor(ctx, el, "Ellipse"), ...common }, () => ellipsePath(a("cx"), a("cy"), rx, ry));
    }
    case "line":
      return vectorNode(ctx, parsePathData(`M${a("x1")} ${a("y1")}L${a("x2")} ${a("y2")}`), { name: nameFor(ctx, el, "Line"), ...common }, false);
    case "polyline":
    case "polygon": {
      const pts = (el.attrs.points ?? "").trim().split(/[\s,]+/).filter(Boolean).map(Number);
      if (pts.length < 4 || pts.some((v) => !Number.isFinite(v))) return null;
      let d = `M${pts[0]} ${pts[1]}`;
      for (let i = 2; i + 1 < pts.length; i += 2) d += `L${pts[i]} ${pts[i + 1]}`;
      if (tag === "polygon") d += "Z";
      return vectorNode(ctx, parsePathData(d), { name: nameFor(ctx, el, tag === "polygon" ? "Polygon" : "Polyline"), ...common }, true);
    }
    case "path": {
      let subpaths: Subpath[];
      try {
        subpaths = parsePathData(el.attrs.d ?? "");
      } catch {
        return null;
      }
      return vectorNode(ctx, subpaths, { name: nameFor(ctx, el, "Vector"), ...common }, true);
    }
    case "text": {
      const content = textContent(el).replace(/\s+/g, " ").trim();
      if (!content) return null;
      const x = a("x");
      const y = a("y");
      const scale = Math.hypot(ctx.space[0], ctx.space[1]);
      const size = style.fontSize * scale;
      const fills = paintFor(style.fill, style.fillOpacity);
      // SVG places text by its baseline; a box's top is about one ascent above it.
      const world: Mat2D = [ctx.space[0] / scale, ctx.space[1] / scale, ctx.space[2] / scale, ctx.space[3] / scale, 0, 0];
      const p = { x: ctx.space[0] * x + ctx.space[2] * y + ctx.space[4], y: ctx.space[1] * x + ctx.space[3] * y + ctx.space[5] };
      const top: Mat2D = [world[0], world[1], world[2], world[3], p.x - world[2] * size * 0.9, p.y - world[3] * size * 0.9];
      return {
        type: "text",
        props: { name: content.slice(0, 40), fontSize: round(size), fontFamily: style.fontFamily, fontWeight: style.fontWeight, fills, ...common },
        text: { content, runs: [] },
        world: top,
      };
    }
    default:
      return null;
  }
}

/** A rectangle or ellipse: a box when the transform is translation and positive scale, else a vector. */
function boxShape(ctx: Ctx, type: "rectangle" | "ellipse", x: number, y: number, w: number, h: number, props: Record<string, unknown>, path: () => string): ClipNode | null {
  const m = ctx.space;
  if (Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9 && m[0] > 0 && m[3] > 0) {
    const wx = m[0] * x + m[4];
    const wy = m[3] * y + m[5];
    const out: Record<string, unknown> = { ...props, width: round(w * m[0]), height: round(h * m[3]), ...paints(ctx.style, Math.sqrt(m[0] * m[3])) };
    if (typeof out.cornerRadius === "number") out.cornerRadius = round((out.cornerRadius as number) * Math.min(m[0], m[3]));
    return { type, props: out, world: [1, 0, 0, 1, round(wx), round(wy)] };
  }
  return vectorNode(ctx, parsePathData(path()), props, true);
}

function vectorNode(ctx: Ctx, subpaths: Subpath[], props: Record<string, unknown>, fillable: boolean): ClipNode | null {
  if (subpaths.length === 0) return null;
  const world = transformSubpaths(subpaths, ctx.space);
  const b = subpathBounds(world);
  const scale = Math.sqrt(Math.abs(ctx.space[0] * ctx.space[3] - ctx.space[1] * ctx.space[2]));
  const p = paints(ctx.style, scale);
  const fills = fillable ? (p.fills as Paint[]) : [];
  const network = subpathsToNetwork(world, { x: b.x, y: b.y }, ctx.style.fillRule, fills.length > 0);
  if (network.segments.length === 0) return null;
  return {
    type: "vector",
    props: { ...props, ...p, fills, width: round(b.width), height: round(b.height), vectorNetwork: network },
    world: [1, 0, 0, 1, b.x, b.y],
  };
}

function paints(style: Style, scale: number): Record<string, unknown> {
  const out: Record<string, unknown> = { fills: paintFor(style.fill, style.fillOpacity) };
  const strokes = paintFor(style.stroke, style.strokeOpacity);
  if (strokes.length > 0 && style.strokeWidth > 0) {
    out.strokes = strokes;
    out.strokeWeight = round(style.strokeWidth * scale);
    out.strokeAlign = "center";
    if (style.strokeLinecap !== "butt") out.strokeCap = style.strokeLinecap;
    if (style.strokeLinejoin !== "miter") out.strokeJoin = style.strokeLinejoin;
    if (style.strokeMiterlimit !== 4) out.strokeMiterLimit = Math.max(1, style.strokeMiterlimit);
    if (style.strokeDasharray.length > 0) out.strokeDashes = style.strokeDasharray.map((d) => round(d * scale));
  }
  return out;
}

function paintFor(value: string, opacity: number): Paint[] {
  const c = parseColor(value);
  if (!c) return [];
  return [{ type: "solid", color: { ...c, a: clamp01(c.a * opacity) } }];
}

function styleDecl(el: XmlElement): Record<string, string> {
  const out: Record<string, string> = {};
  for (const decl of (el.attrs.style ?? "").split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    out[decl.slice(0, i).trim().toLowerCase()] = decl.slice(i + 1).trim();
  }
  return out;
}

/** Presentation attributes and inline style (style wins), as overrides of the inherited style. */
function styleOf(el: XmlElement): Partial<Style> {
  const decl = { ...pick(el.attrs), ...styleDecl(el) };
  const out: Partial<Style> = {};
  if (decl.fill !== undefined) out.fill = decl.fill;
  if (decl["fill-opacity"] !== undefined) out.fillOpacity = clamp01(num(decl["fill-opacity"], 1));
  if (decl["fill-rule"] !== undefined) out.fillRule = decl["fill-rule"] === "evenodd" ? "evenodd" : "nonzero";
  if (decl.stroke !== undefined) out.stroke = decl.stroke;
  if (decl["stroke-opacity"] !== undefined) out.strokeOpacity = clamp01(num(decl["stroke-opacity"], 1));
  if (decl["stroke-width"] !== undefined) out.strokeWidth = Math.max(0, length(decl["stroke-width"]) ?? 1);
  if (decl["stroke-linecap"] !== undefined && ["butt", "round", "square"].includes(decl["stroke-linecap"])) out.strokeLinecap = decl["stroke-linecap"] as Style["strokeLinecap"];
  if (decl["stroke-linejoin"] !== undefined && ["miter", "round", "bevel"].includes(decl["stroke-linejoin"])) out.strokeLinejoin = decl["stroke-linejoin"] as Style["strokeLinejoin"];
  if (decl["stroke-miterlimit"] !== undefined) out.strokeMiterlimit = num(decl["stroke-miterlimit"], 4);
  if (decl["stroke-dasharray"] !== undefined) {
    const d = decl["stroke-dasharray"] === "none" ? [] : decl["stroke-dasharray"].split(/[\s,]+/).map(Number).filter((v) => Number.isFinite(v) && v >= 0);
    out.strokeDasharray = d.length % 2 === 1 ? [...d, ...d] : d;
  }
  if (decl["font-size"] !== undefined) out.fontSize = length(decl["font-size"]) ?? 16;
  if (decl["font-family"] !== undefined) out.fontFamily = decl["font-family"].split(",")[0]!.trim().replace(/^["']|["']$/g, "") || "sans-serif";
  if (decl["font-weight"] !== undefined) out.fontWeight = decl["font-weight"] === "bold" ? 700 : decl["font-weight"] === "normal" ? 400 : Math.min(1000, Math.max(1, num(decl["font-weight"], 400)));
  if (decl.display !== undefined) out.display = decl.display !== "none";
  if (decl.visibility !== undefined) out.visible = decl.visibility !== "hidden" && decl.visibility !== "collapse";
  return out;
}

const PRESENTATION = ["fill", "fill-opacity", "fill-rule", "stroke", "stroke-opacity", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "font-size", "font-family", "font-weight", "display", "visibility"];

function pick(attrs: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of PRESENTATION) if (attrs[k] !== undefined) out[k] = attrs[k]!;
  return out;
}

/** SVG transform lists. */
export function parseTransform(s: string): Mat2D {
  let m: Mat2D = [1, 0, 0, 1, 0, 0];
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/gi;
  let t: RegExpExecArray | null;
  while ((t = re.exec(s))) {
    const args = t[2]!.trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (args.some((v) => !Number.isFinite(v))) continue;
    const [p0 = 0, p1, p2, p3 = 0, p4 = 0, p5 = 0] = args;
    let n: Mat2D;
    switch (t[1]!.toLowerCase()) {
      case "matrix":
        n = [p0, p1 ?? 0, p2 ?? 0, p3, p4, p5];
        break;
      case "translate":
        n = [1, 0, 0, 1, p0, p1 ?? 0];
        break;
      case "scale":
        n = [p0, 0, 0, p1 ?? p0, 0, 0];
        break;
      case "rotate": {
        const r = (p0 * Math.PI) / 180;
        const c = Math.cos(r), sn = Math.sin(r);
        const cx = p1 ?? 0, cy = p2 ?? 0;
        n = [c, sn, -sn, c, cx - c * cx + sn * cy, cy - sn * cx - c * cy];
        break;
      }
      case "skewx":
        n = [1, 0, Math.tan((p0 * Math.PI) / 180), 1, 0, 0];
        break;
      default:
        n = [1, Math.tan((p0 * Math.PI) / 180), 0, 1, 0, 0];
    }
    m = multiply(m, n);
  }
  return m;
}

function rectPath(x: number, y: number, w: number, h: number): string {
  return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
}

function ellipsePath(cx: number, cy: number, rx: number, ry: number): string {
  return `M${cx + rx} ${cy}A${rx} ${ry} 0 1 1 ${cx - rx} ${cy}A${rx} ${ry} 0 1 1 ${cx + rx} ${cy}Z`;
}

function num(v: string | undefined, d: number): number {
  if (v === undefined) return d;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : d;
}

/** A length in px (unitless, px, pt, pc, in, cm, mm); percentages and em are not resolved (null). */
function length(v: string | undefined): number | null {
  if (v === undefined) return null;
  const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*(px|pt|pc|in|cm|mm)?\s*$/i.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? "px").toLowerCase();
  const f = { px: 1, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4 }[unit] ?? 1;
  return n * f;
}

function round(v: number): number {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

const NAMED: Record<string, string> = {
  black: "000000", white: "ffffff", red: "ff0000", green: "008000", blue: "0000ff", yellow: "ffff00", cyan: "00ffff", aqua: "00ffff", magenta: "ff00ff", fuchsia: "ff00ff",
  gray: "808080", grey: "808080", silver: "c0c0c0", maroon: "800000", olive: "808000", lime: "00ff00", navy: "000080", purple: "800080", teal: "008080",
  orange: "ffa500", pink: "ffc0cb", brown: "a52a2a", gold: "ffd700", indigo: "4b0082", violet: "ee82ee", coral: "ff7f50", salmon: "fa8072", tomato: "ff6347",
  crimson: "dc143c", darkgray: "a9a9a9", darkgrey: "a9a9a9", lightgray: "d3d3d3", lightgrey: "d3d3d3", dimgray: "696969", whitesmoke: "f5f5f5", gainsboro: "dcdcdc",
  darkblue: "00008b", darkgreen: "006400", darkred: "8b0000", skyblue: "87ceeb", steelblue: "4682b4", royalblue: "4169e1", slategray: "708090", beige: "f5f5dc",
};

/** CSS/SVG color syntax to a color (null for none, transparent references and unknown values). */
export function parseColor(v: string): Color | null {
  const s = v.trim().toLowerCase();
  if (s === "" || s === "none" || s.startsWith("url(")) return null;
  if (s === "transparent") return null;
  if (s === "currentcolor") return { r: 0, g: 0, b: 0, a: 1 };
  const hex = (h: string): Color | null => {
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i: number): number => parseInt(h.slice(i, i + 2), 16) / 255;
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
  };
  if (s.startsWith("#")) return /^#[0-9a-f]+$/.test(s) ? hex(s.slice(1)) : null;
  if (NAMED[s]) return hex(NAMED[s]!);
  const fn = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(s);
  if (!fn) return null;
  const parts = fn[2]!.split(/[\s,/]+/).filter(Boolean);
  const comp = (p: string | undefined, scale: number): number => (p === undefined ? 1 : p.endsWith("%") ? parseFloat(p) / 100 : parseFloat(p) / scale);
  if (fn[1]!.startsWith("rgb")) {
    const c = { r: comp(parts[0], 255), g: comp(parts[1], 255), b: comp(parts[2], 255), a: comp(parts[3], 1) };
    return [c.r, c.g, c.b, c.a].every(Number.isFinite) ? { r: clamp01(c.r), g: clamp01(c.g), b: clamp01(c.b), a: clamp01(c.a) } : null;
  }
  const h = parseFloat(parts[0] ?? "0");
  const sat = comp(parts[1], 100);
  const l = comp(parts[2], 100);
  const a = comp(parts[3], 1);
  const k = (n: number): number => (n + h / 30) % 12;
  const f = (n: number): number => l - sat * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [h, sat, l, a].every(Number.isFinite) ? { r: clamp01(f(0)), g: clamp01(f(8)), b: clamp01(f(4)), a: clamp01(a) } : null;
}
