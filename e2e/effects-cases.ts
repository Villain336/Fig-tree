import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import { BLEND_MODES } from "../packages/renderer/src/types";
import { FigDocument, cssAppearance, cssDeclarations, cssMask, seededRandom, toFigtreeJson, type Command, type Effect, type Paint } from "../packages/document/src/index";

/**
 * Effects reference cases: small documents whose effects, blend modes,
 * gradients, image placements and masks all have an exact CSS form. Each
 * renders in our renderer (through the bridge) and, as the HTML our CSS
 * export produces for it, in Chromium. e2e/effects-reference.spec.ts
 * compares the two.
 */
export interface EffectCase {
  readonly name: string;
  /** What the case exercises (summary grouping). */
  readonly area: string;
  readonly width: number;
  readonly height: number;
  readonly doc: FigDocument;
  /** Asset bytes by id. */
  readonly assets: Record<string, Uint8Array>;
  /** HTML of the reference; by default generated from the document's CSS. */
  readonly html: string;
  /** Set when the case is known to miss the threshold, with the reason. */
  readonly known?: string;
}

const white = { r: 1, g: 1, b: 1, a: 1 };
const rgb = (hex: string, a = 1) => ({ r: parseInt(hex.slice(1, 3), 16) / 255, g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255, a });
const solid = (hex: string, a = 1): Paint => ({ type: "solid", color: rgb(hex, a) });

/** A PNG test image: a smooth color field with a translucent lower-right quadrant and a sharp diagonal. */
export function testPng(w: number, h: number): Uint8Array {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      png.data[i] = Math.round((255 * x) / (w - 1));
      png.data[i + 1] = Math.round((255 * y) / (h - 1));
      png.data[i + 2] = x > y * (w / h) ? 200 : 40;
      png.data[i + 3] = x > w / 2 && y > h / 2 ? 140 : 255;
    }
  }
  return new Uint8Array(PNG.sync.write(png));
}

export function assetId(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface Spec {
  name: string;
  area: string;
  width: number;
  height: number;
  build: (page: string) => Command[];
  assets?: Uint8Array[];
  known?: string;
}

/** Four color bands and a gray ramp (as two rows of layers) for blend and backdrop cases. */
function bands(page: string, w: number, h: number): Command[] {
  const colors = ["#e53935", "#43a047", "#1e88e5", "#fdd835"];
  const out: Command[] = colors.map((c, i) => node(page, `band${i}`, "rectangle", { x: (i * w) / 4, y: 0, width: w / 4, height: Math.round(h * 0.6), fills: [solid(c)] }));
  out.push(node(page, "ramp", "rectangle", {
    x: 0, y: Math.round(h * 0.6), width: w, height: h - Math.round(h * 0.6),
    fills: [{ type: "linear-gradient", start: { x: 0, y: 0.5 }, end: { x: 1, y: 0.5 }, stops: [{ position: 0, color: rgb("#000000") }, { position: 1, color: white }] }],
  }));
  return out;
}

function node(parent: string, id: string, type: string, props: Record<string, unknown>): Command {
  return { type: "createNode", node: { id, type, props } as never, parent };
}

const shadow = (x: number, y: number, blur: number, spread: number, color = rgb("#000000", 0.4), extra: Partial<Effect> = {}): Effect => ({ type: "drop-shadow", color, offset: { x, y }, blur, spread, ...extra } as Effect);
const inner = (x: number, y: number, blur: number, spread: number, color = rgb("#000000", 0.5)): Effect => ({ type: "inner-shadow", color, offset: { x, y }, blur, spread });
const card = (fills: Paint[] = [solid("#ffffff")]) => ({ fills });

const SPECS: Spec[] = [
  // ── box-shadow ─────────────────────────────────────────────────────────
  { name: "box-shadow", area: "box-shadow", width: 200, height: 140, build: (p) => [node(p, "c", "rectangle", { x: 40, y: 30, width: 110, height: 70, cornerRadius: 10, ...card(), effects: [shadow(6, 8, 16, 0)] })] },
  { name: "box-shadow-spread", area: "box-shadow", width: 200, height: 140, build: (p) => [node(p, "c", "rectangle", { x: 50, y: 40, width: 100, height: 60, ...card(), effects: [shadow(0, 4, 4, 8)] })] },
  { name: "box-shadow-negative-spread", area: "box-shadow", width: 200, height: 140, build: (p) => [node(p, "c", "rectangle", { x: 50, y: 30, width: 100, height: 60, ...card(), effects: [shadow(0, 14, 10, -6, rgb("#000000", 0.6))] })] },
  { name: "box-shadow-rounded-spread", area: "box-shadow", width: 200, height: 140, build: (p) => [node(p, "c", "rectangle", { x: 50, y: 40, width: 100, height: 60, cornerRadius: { topLeft: 4, topRight: 20, bottomRight: 0, bottomLeft: 12 }, ...card(), effects: [shadow(0, 0, 0, 10, rgb("#3949ab", 0.8))] })] },
  { name: "box-shadow-sharp", area: "box-shadow", width: 200, height: 140, build: (p) => [node(p, "c", "rectangle", { x: 50, y: 40, width: 100, height: 60, ...card(), effects: [shadow(10, 10, 0, 0, rgb("#e53935"))] })] },
  { name: "box-shadow-multiple", area: "box-shadow", width: 220, height: 150, build: (p) => [node(p, "c", "rectangle", { x: 50, y: 40, width: 110, height: 60, cornerRadius: 8, ...card(), effects: [shadow(0, 1, 3, 0, rgb("#000000", 0.3)), shadow(0, 12, 28, 4, rgb("#1a237e", 0.35)), shadow(-20, -10, 6, 0, rgb("#ff6f00", 0.7))] })] },
  { name: "box-shadow-translucent", area: "box-shadow", width: 200, height: 140, build: (p) => [node(p, "c", "rectangle", { x: 50, y: 35, width: 100, height: 60, cornerRadius: 6, ...card([solid("#2196f3", 0.35)]), effects: [shadow(8, 10, 12, 2, rgb("#000000", 0.6))] })] },
  { name: "box-shadow-large-blur", area: "box-shadow", width: 260, height: 200, build: (p) => [node(p, "c", "rectangle", { x: 80, y: 60, width: 100, height: 70, ...card(), effects: [shadow(0, 20, 60, 0, rgb("#000000", 0.5))] })] },
  { name: "box-shadow-ellipse", area: "box-shadow", width: 200, height: 140, build: (p) => [node(p, "c", "ellipse", { x: 50, y: 30, width: 100, height: 70, ...card([solid("#ffb300")]), effects: [shadow(4, 8, 12, 3)] })] },
  { name: "box-shadow-rotated", area: "box-shadow", width: 200, height: 160, build: (p) => [node(p, "c", "rectangle", { x: 50, y: 45, width: 100, height: 60, rotation: 20, ...card(), effects: [shadow(6, 8, 10, 2)] })] },
  { name: "inset-shadow", area: "inset box-shadow", width: 200, height: 140, build: (p) => [node(p, "c", "rectangle", { x: 40, y: 30, width: 120, height: 80, cornerRadius: 14, ...card([solid("#ffe0b2")]), effects: [inner(4, 6, 10, 0)] })] },
  { name: "inset-shadow-spread", area: "inset box-shadow", width: 200, height: 140, build: (p) => [node(p, "c", "rectangle", { x: 40, y: 30, width: 120, height: 80, cornerRadius: 20, ...card([solid("#b3e5fc")]), effects: [inner(0, 0, 4, 10, rgb("#01579b", 0.8))] })] },
  { name: "inset-shadow-sharp", area: "inset box-shadow", width: 200, height: 140, build: (p) => [node(p, "c", "rectangle", { x: 40, y: 30, width: 120, height: 80, ...card([solid("#c8e6c9")]), effects: [inner(8, 8, 0, 0, rgb("#1b5e20"))] })] },
  // ── filter: blur and backdrop-filter ────────────────────────────────────
  {
    name: "filter-blur", area: "filter: blur", width: 200, height: 160,
    build: (p) => [
      node(p, "f", "frame", { x: 40, y: 30, width: 120, height: 90, fills: [solid("#5e35b1")], overflowX: "visible", overflowY: "visible", effects: [{ type: "layer-blur", radius: 12 }] }),
      node("f", "a", "rectangle", { x: 20, y: 20, width: 40, height: 50, fills: [solid("#ffffff")] }),
      node("f", "b", "ellipse", { x: 70, y: 30, width: 40, height: 40, fills: [solid("#ffca28")] }),
    ],
  },
  { name: "filter-blur-large", area: "filter: blur", width: 280, height: 240, build: (p) => [node(p, "c", "rectangle", { x: 90, y: 70, width: 100, height: 100, cornerRadius: 20, fills: [solid("#00897b")], effects: [{ type: "layer-blur", radius: 64 }] })] },
  { name: "filter-blur-small", area: "filter: blur", width: 160, height: 120, build: (p) => [node(p, "c", "rectangle", { x: 40, y: 30, width: 80, height: 60, fills: [solid("#e91e63")], effects: [{ type: "layer-blur", radius: 3 }] })] },
  {
    name: "backdrop-blur", area: "backdrop-filter: blur", width: 240, height: 160,
    build: (p) => [...bands(p, 240, 160), node(p, "g", "rectangle", { x: 40, y: 30, width: 160, height: 100, cornerRadius: 16, fills: [solid("#ffffff", 0.25)], effects: [{ type: "background-blur", radius: 20 }] })],
  },
  {
    name: "backdrop-blur-large", area: "backdrop-filter: blur", width: 300, height: 200,
    build: (p) => [...bands(p, 300, 200), node(p, "g", "rectangle", { x: 30, y: 30, width: 240, height: 140, fills: [solid("#000000", 0.1)], effects: [{ type: "background-blur", radius: 80 }] })],
  },
  // ── mix-blend-mode, opacity groups, isolation ──────────────────────────
  ...BLEND_MODES.filter((m) => m !== "plus-darker").map((mode): Spec => ({
    name: `blend-${mode}`, area: "mix-blend-mode", width: 200, height: 120,
    build: (p) => [
      ...bands(p, 200, 120),
      node(p, "top", "ellipse", {
        x: 30, y: 15, width: 140, height: 90, blendMode: mode,
        fills: [{ type: "linear-gradient", start: { x: 0, y: 0.5 }, end: { x: 1, y: 0.5 }, stops: [{ position: 0, color: rgb("#ff4081") }, { position: 0.5, color: rgb("#7c4dff", 0.7) }, { position: 1, color: rgb("#64ffda") }] }],
      }),
    ],
  })),
  {
    name: "opacity-group", area: "opacity", width: 200, height: 120,
    build: (p) => [
      ...bands(p, 200, 120),
      node(p, "g", "frame", { x: 20, y: 10, width: 160, height: 100, opacity: 0.5, fills: [] }),
      node("g", "a", "rectangle", { x: 10, y: 10, width: 80, height: 60, fills: [solid("#ffffff")] }),
      node("g", "b", "ellipse", { x: 60, y: 30, width: 80, height: 60, fills: [solid("#000000")] }),
    ],
  },
  {
    name: "blend-in-group-isolated", area: "isolation", width: 200, height: 120,
    build: (p) => [
      ...bands(p, 200, 120),
      node(p, "g", "frame", { x: 20, y: 10, width: 160, height: 100, isolation: "isolate", fills: [] }),
      node("g", "a", "ellipse", { x: 10, y: 10, width: 80, height: 80, fills: [solid("#ff9800")], blendMode: "multiply" }),
      node("g", "b", "ellipse", { x: 60, y: 10, width: 80, height: 80, fills: [solid("#9c27b0")], blendMode: "screen" }),
    ],
  },
  {
    name: "blend-in-group-pass-through", area: "isolation", width: 200, height: 120,
    build: (p) => [
      ...bands(p, 200, 120),
      node(p, "g", "frame", { x: 20, y: 10, width: 160, height: 100, fills: [] }),
      node("g", "a", "ellipse", { x: 10, y: 10, width: 80, height: 80, fills: [solid("#ff9800")], blendMode: "multiply" }),
      node("g", "b", "ellipse", { x: 60, y: 10, width: 80, height: 80, fills: [solid("#9c27b0")], blendMode: "screen" }),
    ],
  },
  {
    name: "blend-in-clipping-frame", area: "isolation", width: 200, height: 120,
    build: (p) => [
      ...bands(p, 200, 120),
      node(p, "g", "frame", { x: 20, y: 10, width: 160, height: 100, cornerRadius: 18, overflowX: "hidden", overflowY: "hidden", fills: [solid("#ffffff", 0.5)] }),
      node("g", "a", "ellipse", { x: 30, y: 20, width: 120, height: 100, fills: [solid("#00bcd4")], blendMode: "difference" }),
    ],
  },
  // ── conic-gradient ──────────────────────────────────────────────────────
  {
    name: "conic-gradient", area: "conic-gradient", width: 200, height: 140,
    build: (p) => [node(p, "c", "rectangle", {
      x: 30, y: 20, width: 140, height: 100,
      fills: [{ type: "angular-gradient", center: { x: 0.5, y: 0.5 }, radiusX: { x: 0.5, y: 0 }, radiusY: { x: 0.5 + 50 / 140, y: 0.5 }, stops: [{ position: 0, color: rgb("#f44336") }, { position: 0.3, color: rgb("#ffeb3b") }, { position: 0.65, color: rgb("#2196f3") }, { position: 1, color: rgb("#f44336") }] }],
    })],
  },
  {
    name: "conic-gradient-rotated", area: "conic-gradient", width: 200, height: 140,
    build: (p) => {
      // From 35° (clockwise from up), centered off-center.
      const a = (35 * Math.PI) / 180;
      const cx = 0.4, cy = 0.6;
      const r = 30;
      return [node(p, "c", "rectangle", {
        x: 30, y: 20, width: 140, height: 100,
        fills: [{ type: "angular-gradient", center: { x: cx, y: cy }, radiusX: { x: cx + (r * Math.sin(a)) / 140, y: cy - (r * Math.cos(a)) / 100 }, radiusY: { x: cx + (r * Math.cos(a)) / 140, y: cy + (r * Math.sin(a)) / 100 }, stops: [{ position: 0, color: rgb("#000000") }, { position: 0.5, color: rgb("#ffffff") }, { position: 0.75, color: rgb("#4caf50") }, { position: 1, color: rgb("#000000") }] }],
      })];
    },
  },
  // ── background-size / background-position image modes ────────────────
  ...(["cover", "contain", "stretch"] as const).map((fit): Spec => ({
    name: `image-${fit}`, area: "background-size", width: 200, height: 140, assets: [testPng(40, 30)],
    build: (p) => [node(p, "c", "rectangle", { x: 30, y: 20, width: 140, height: 100, fills: [solid("#eceff1"), { type: "image", asset: assetId(testPng(40, 30)), fit }] })],
  })),
  {
    name: "image-tile", area: "background-size", width: 200, height: 140, assets: [testPng(40, 30)],
    build: (p) => [node(p, "c", "rectangle", { x: 20, y: 20, width: 160, height: 100, fills: [{ type: "image", asset: assetId(testPng(40, 30)), fit: "tile", tileScale: 1 }] })],
  },
  {
    name: "image-crop", area: "background-position", width: 200, height: 140, assets: [testPng(40, 30)],
    build: (p) => [node(p, "c", "rectangle", { x: 30, y: 20, width: 140, height: 100, fills: [{ type: "image", asset: assetId(testPng(40, 30)), fit: "crop", transform: [1.5, 0, 0, 1.2, -0.25, -0.1] }] })],
  },
  {
    name: "image-node", area: "background-size", width: 200, height: 140, assets: [testPng(40, 30)],
    build: (p) => [node(p, "c", "rectangle", { x: 30, y: 20, width: 140, height: 100, cornerRadius: 12, fills: [{ type: "image", asset: assetId(testPng(40, 30)), fit: "cover" }], effects: [shadow(0, 6, 12, 0)] })],
  },
  // ── mask-image and clip-path ───────────────────────────────────────────
  {
    name: "mask-image-gradient", area: "mask-image", width: 200, height: 140,
    build: (p) => [
      ...bands(p, 200, 140),
      node(p, "g", "frame", { x: 20, y: 20, width: 160, height: 100, fills: [] }),
      node("g", "m", "rectangle", { x: 0, y: 0, width: 160, height: 100, mask: "alpha", fills: [{ type: "linear-gradient", start: { x: 0, y: 0.5 }, end: { x: 1, y: 0.5 }, stops: [{ position: 0, color: rgb("#000000", 1) }, { position: 1, color: rgb("#000000", 0) }] }] }),
      node("g", "a", "rectangle", { x: 0, y: 0, width: 160, height: 100, fills: [solid("#212121")] }),
      node("g", "b", "ellipse", { x: 40, y: 20, width: 80, height: 60, fills: [solid("#ff4081")] }),
    ],
  },
  {
    name: "mask-image-luminance", area: "mask-image", width: 200, height: 140,
    build: (p) => [
      ...bands(p, 200, 140),
      node(p, "g", "frame", { x: 20, y: 20, width: 160, height: 100, fills: [] }),
      node("g", "m", "rectangle", { x: 0, y: 0, width: 160, height: 100, mask: "luminance", fills: [{ type: "radial-gradient", center: { x: 0.5, y: 0.5 }, radiusX: { x: 1, y: 0.5 }, radiusY: { x: 0.5, y: 1 }, stops: [{ position: 0, color: white }, { position: 1, color: rgb("#000000") }] }] }),
      node("g", "a", "rectangle", { x: 0, y: 0, width: 160, height: 100, fills: [solid("#3f51b5")] }),
    ],
  },
  {
    name: "clip-path-ellipse", area: "clip-path", width: 200, height: 140,
    build: (p) => [
      ...bands(p, 200, 140),
      node(p, "g", "frame", { x: 20, y: 20, width: 160, height: 100, fills: [] }),
      node("g", "m", "ellipse", { x: 20, y: 10, width: 120, height: 80, mask: "vector", fills: [solid("#000000", 0.2)] }),
      node("g", "a", "rectangle", { x: 0, y: 0, width: 160, height: 100, fills: [{ type: "linear-gradient", start: { x: 0, y: 0 }, end: { x: 1, y: 1 }, stops: [{ position: 0, color: rgb("#311b92") }, { position: 1, color: rgb("#00e5ff") }] }] }),
    ],
  },
  {
    name: "clip-path-inset-round", area: "clip-path", width: 200, height: 140,
    build: (p) => [
      ...bands(p, 200, 140),
      node(p, "g", "frame", { x: 20, y: 20, width: 160, height: 100, fills: [] }),
      node("g", "m", "rectangle", { x: 15, y: 12, width: 130, height: 76, cornerRadius: 22, mask: "vector", fills: [solid("#000000")] }),
      node("g", "a", "rectangle", { x: 0, y: 0, width: 160, height: 100, fills: [solid("#263238")] }),
      node("g", "b", "ellipse", { x: 100, y: 40, width: 80, height: 80, fills: [solid("#ffd54f")] }),
    ],
  },
];

/** The reference HTML of a document: absolutely positioned boxes with the CSS our export states. */
export function documentHtml(doc: FigDocument, width: number, height: number, assets: Record<string, Uint8Array>): string {
  const page = doc.pages[0]!;
  const bg = doc.get<{ r: number; g: number; b: number }>(page, "backgroundColor");
  const assetUrl = (id: string): string => `data:image/png;base64,${Buffer.from(assets[id]!).toString("base64")}`;
  const style = (css: Record<string, string>): string => Object.entries(css).map(([k, v]) => `${k}:${v}`).join(";").replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const element = (id: string): string => {
    const type = doc.typeOf(id)!;
    const css: Record<string, string> = { ...cssDeclarations(doc, id), ...cssAppearance(doc, id, { assetUrl }).css };
    if (type === "ellipse") css["border-radius"] = "50%";
    return `<div style="${style(css)}">${children(id)}</div>`;
  };
  const children = (id: string): string => {
    const kids = doc.tree.childrenOf(id);
    let out = "";
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i]!;
      if (doc.get<string>(k, "mask") !== "none") {
        // A mask applies to the siblings after it: one wrapper element with the mask's CSS.
        const mask = cssMask(doc, k, { assetUrl })!;
        out += `<div style="position:absolute;left:0;top:0;width:100%;height:100%;${style(mask)}">${kids.slice(i + 1).map(element).join("")}</div>`;
        break;
      }
      out += element(k);
    }
    return out;
  };
  const rgbBg = `rgb(${Math.round(bg.r * 255)}, ${Math.round(bg.g * 255)}, ${Math.round(bg.b * 255)})`;
  return `<!doctype html><html><head><style>html,body{margin:0;background:${rgbBg}}</style></head><body><div id="vp" style="position:relative;width:${width}px;height:${height}px;overflow:hidden;background:${rgbBg}">${children(page)}</div></body></html>`;
}

export function effectCases(): EffectCase[] {
  return SPECS.map((spec, n) => {
    const doc = FigDocument.create({ random: seededRandom(1000 + n), clientId: 1 });
    const page = doc.pages[0]!;
    const author = doc.actor("author");
    const assets: Record<string, Uint8Array> = {};
    const commands: Command[] = [{ type: "updateProps", id: page, props: { backgroundColor: white } }];
    for (const bytes of spec.assets ?? []) {
      const id = assetId(bytes);
      assets[id] = bytes;
      const png = PNG.sync.read(Buffer.from(bytes));
      commands.push({ type: "addAsset", id, meta: { mimeType: "image/png", byteLength: bytes.length, width: png.width, height: png.height } });
    }
    doc.apply([...commands, ...spec.build(page)], author);
    return { name: spec.name, area: spec.area, width: spec.width, height: spec.height, doc, assets, html: documentHtml(doc, spec.width, spec.height, assets), ...(spec.known ? { known: spec.known } : {}) };
  });
}

export function caseJson(c: EffectCase): unknown {
  return toFigtreeJson(c.doc);
}
