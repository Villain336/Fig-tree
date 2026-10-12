import type { FigDocument } from "./document";
import {
  hasProp,
  type AssetMeta,
  type Color,
  type Effect,
  type GradientStop,
  type Paint,
} from "./schema";

/**
 * The CSS of a node's appearance: paints (`background`), effects
 * (`box-shadow`, `filter`, `backdrop-filter`), `opacity`, `mix-blend-mode`
 * and `isolation`, with the exact CSS equivalents of the document's
 * semantics (gradient handles become gradient lines, radii become CSS
 * `box-shadow`/`blur()` lengths: a blur radius r is a Gaussian of
 * deviation r/2 in both, so `filter: blur(r/2)`).
 *
 * What CSS cannot state exactly is listed in `inexact` instead of being
 * approximated: diamond gradients, rotated or elliptical angular
 * gradients, shader paints (exported as WebGL by `exportShaderPaint`),
 * image adjustments other than contrast and saturation, and spread on
 * non-box shadows.
 */
export interface CssAppearance {
  readonly css: Record<string, string>;
  readonly inexact: readonly string[];
}

export interface CssOptions {
  /** The node's box (defaults to its stored width and height). */
  readonly width?: number;
  readonly height?: number;
  /** URL of an asset in exported code (default `assets/<id>.<ext>`). */
  readonly assetUrl?: (id: string, meta: AssetMeta | undefined) => string;
}

const BOX_TYPES = new Set(["frame", "component", "instance", "rectangle", "image", "ellipse"]);

export function cssAppearance(doc: FigDocument, id: string, options: CssOptions = {}): CssAppearance {
  const type = doc.typeOf(id);
  const css: Record<string, string> = {};
  const inexact: string[] = [];
  if (!type || type === "page") return { css, inexact };
  const get = <T>(k: string): T => doc.get<T>(id, k);
  const width = options.width ?? (hasProp(type, "width") ? get<number>("width") : 0);
  const height = options.height ?? (hasProp(type, "height") ? get<number>("height") : 0);
  const assetUrl = options.assetUrl ?? defaultAssetUrl;

  const opacity = get<number>("opacity");
  if (opacity < 1) css.opacity = num(opacity);
  const blend = get<string>("blendMode");
  if (blend !== "normal") css["mix-blend-mode"] = blend;
  if (get<string>("isolation") === "isolate") css.isolation = "isolate";

  if (hasProp(type, "fills") && type !== "text") {
    const fills = get<Paint[]>("fills").filter((p) => p.visible !== false);
    const layers: string[] = [];
    const sizes: string[] = [];
    const positions: string[] = [];
    const repeats: string[] = [];
    const blends: string[] = [];
    // CSS lists background layers top first.
    for (const p of [...fills].reverse()) {
      const layer = cssPaintLayer(doc, p, width, height, assetUrl);
      if (!layer) {
        inexact.push(`fill:${p.type === "shader" ? `shader:${p.shader}` : p.type}`);
        continue;
      }
      layers.push(layer.image);
      sizes.push(layer.size ?? "auto");
      positions.push(layer.position ?? "0% 0%");
      repeats.push(layer.repeat ?? "repeat");
      blends.push(p.blendMode ?? "normal");
    }
    if (layers.length > 0) {
      css["background-image"] = layers.join(", ");
      if (sizes.some((s) => s !== "auto")) css["background-size"] = sizes.join(", ");
      if (positions.some((s) => s !== "0% 0%")) css["background-position"] = positions.join(", ");
      if (repeats.some((s) => s !== "repeat")) css["background-repeat"] = repeats.join(", ");
      if (blends.some((b) => b !== "normal")) css["background-blend-mode"] = blends.join(", ");
    }
  }

  const effects = get<Effect[]>("effects").filter((e) => e.visible !== false);
  const shadows: string[] = [];
  const dropFilters: string[] = [];
  const boxLike = BOX_TYPES.has(type) && !(type === "ellipse" && (get<number>("arcSweep") !== 360 || get<number>("innerRadius") !== 0));
  for (const e of [...effects].reverse()) {
    if (e.type === "drop-shadow" || e.type === "inner-shadow") {
      if ((e.blendMode ?? "normal") !== "normal") inexact.push(`effect:${e.type}:blend-mode`);
      const len = `${px(e.offset.x)} ${px(e.offset.y)} ${px(e.blur)}`;
      if (boxLike) {
        // box-shadow draws under transparent backgrounds only with "show behind" off (CSS clips it to outside the box).
        if (e.type === "drop-shadow" && e.showBehindNode) inexact.push("effect:drop-shadow:show-behind");
        shadows.push(`${e.type === "inner-shadow" ? "inset " : ""}${len} ${px(e.spread)} ${rgbaCss(e.color)}`);
      } else if (e.type === "drop-shadow") {
        if (e.spread !== 0) inexact.push("effect:drop-shadow:spread");
        dropFilters.push(`drop-shadow(${len} ${rgbaCss(e.color)})`);
      } else {
        inexact.push("effect:inner-shadow");
      }
    }
  }
  if (shadows.length) css["box-shadow"] = shadows.join(", ");
  const blur = effects.find((e) => e.type === "layer-blur");
  const filters = [...dropFilters.reverse(), ...(blur ? [`blur(${px(blur.radius / 2)})`] : [])];
  if (filters.length) css.filter = filters.join(" ");
  const backdrop = effects.find((e) => e.type === "background-blur");
  if (backdrop) css["backdrop-filter"] = `blur(${px(backdrop.radius / 2)})`;
  const mask = get<string>("mask");
  if (mask !== "none") inexact.push("mask-node");
  return { css, inexact };
}

/**
 * CSS that applies a mask node to the layers it masks (its following
 * siblings, wrapped in one element): a vector mask of a rectangle, ellipse,
 * polygon, star or vector becomes `clip-path`; alpha and luminance masks
 * whose paint CSS can state become `mask-image` (with `mask-mode`). Null when
 * the mask has no exact CSS form.
 */
export function cssMask(doc: FigDocument, maskId: string, options: CssOptions & { readonly clipPath?: string } = {}): Record<string, string> | null {
  const type = doc.typeOf(maskId);
  if (!type || !hasProp(type, "mask")) return null;
  const mode = doc.get<string>(maskId, "mask");
  if (mode === "none") return null;
  const get = <T>(k: string): T => doc.get<T>(maskId, k);
  const x = hasProp(type, "x") ? get<number>("x") : 0;
  const y = hasProp(type, "y") ? get<number>("y") : 0;
  const w = options.width ?? (hasProp(type, "width") ? get<number>("width") : 0);
  const h = options.height ?? (hasProp(type, "height") ? get<number>("height") : 0);
  if (mode === "vector") {
    if (options.clipPath) return { "clip-path": options.clipPath };
    if (type === "ellipse" && get<number>("arcSweep") === 360 && get<number>("innerRadius") === 0) {
      return { "clip-path": `ellipse(${px(w / 2)} ${px(h / 2)} at ${px(x + w / 2)} ${px(y + h / 2)})` };
    }
    if (type === "rectangle" || type === "frame") {
      const r = get<number | Record<string, number>>("cornerRadius");
      const rr = typeof r === "number" ? (r > 0 ? ` round ${px(r)}` : "") : ` round ${px(r.topLeft!)} ${px(r.topRight!)} ${px(r.bottomRight!)} ${px(r.bottomLeft!)}`;
      return { "clip-path": `inset(${px(y)} calc(100% - ${px(x + w)}) calc(100% - ${px(y + h)}) ${px(x)}${rr})` };
    }
    return null;
  }
  const fills = hasProp(type, "fills") ? get<Paint[]>("fills").filter((p) => p.visible !== false) : [];
  if (fills.length !== 1 || get<number>("opacity") < 1) return null;
  if (type !== "rectangle" && type !== "frame") return null;
  if (typeof get<unknown>("cornerRadius") !== "number" || get<number>("cornerRadius") !== 0) return null;
  const layer = cssPaintLayer(doc, fills[0]!, w, h, options.assetUrl ?? defaultAssetUrl);
  if (!layer) return null;
  return {
    "mask-image": layer.image,
    "mask-size": `${px(w)} ${px(h)}`,
    "mask-position": `${px(x)} ${px(y)}`,
    "mask-repeat": "no-repeat",
    ...(mode === "luminance" ? { "mask-mode": "luminance" } : {}),
  };
}

interface Layer {
  image: string;
  size?: string;
  position?: string;
  repeat?: string;
}

/** One `background` layer for a paint in a w × h box, or null when CSS has no exact form. */
export function cssPaintLayer(doc: FigDocument | null, p: Paint, w: number, h: number, assetUrl: CssOptions["assetUrl"] = defaultAssetUrl): Layer | null {
  const o = p.opacity ?? 1;
  switch (p.type) {
    case "solid": {
      const c = rgbaCss(p.color, o);
      return { image: `linear-gradient(${c}, ${c})` };
    }
    case "linear-gradient": {
      const sx = p.start.x * w, sy = p.start.y * h, ex = p.end.x * w, ey = p.end.y * h;
      const dx = ex - sx, dy = ey - sy;
      const len = Math.hypot(dx, dy);
      if (len === 0) return null;
      // CSS: the gradient line runs through the box's center at `angle`, of length |w sin| + |h cos|.
      const angle = Math.atan2(dx, -dy);
      const ux = Math.sin(angle), uy = -Math.cos(angle);
      const L = Math.abs(w * ux) + Math.abs(h * uy);
      if (L === 0) return null;
      const p0 = (w / 2) * ux + (h / 2) * uy - L / 2;
      const along = sx * ux + sy * uy;
      const stops = p.stops.map((s) => ({ ...s, position: (along + s.position * len - p0) / L }));
      return { image: `linear-gradient(${num((angle * 180) / Math.PI)}deg, ${stopList(stops, o)})` };
    }
    case "radial-gradient": {
      const cx = p.center.x * w, cy = p.center.y * h;
      const rx = { x: p.radiusX.x * w - cx, y: p.radiusX.y * h - cy };
      const ry = { x: p.radiusY.x * w - cx, y: p.radiusY.y * h - cy };
      // Only axis-aligned ellipses have a CSS form.
      if (Math.abs(rx.y) > 1e-9 || Math.abs(ry.x) > 1e-9) return null;
      return { image: `radial-gradient(${px(Math.abs(rx.x))} ${px(Math.abs(ry.y))} at ${px(cx)} ${px(cy)}, ${stopList(p.stops, o)})` };
    }
    case "angular-gradient": {
      const cx = p.center.x * w, cy = p.center.y * h;
      const ax = p.radiusX.x * w - cx, ay = p.radiusX.y * h - cy;
      const bx = p.radiusY.x * w - cx, by = p.radiusY.y * h - cy;
      // Exact when the frame is a rotation: equal axes, the second 90° clockwise of the first (y down).
      const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
      if (la === 0 || Math.abs(la - lb) > 1e-6 * la || Math.abs(ax * bx + ay * by) > 1e-6 * la * lb || ax * by - ay * bx <= 0) return null;
      const from = (Math.atan2(ax, -ay) * 180) / Math.PI;
      return { image: `conic-gradient(from ${num(from)}deg at ${px(cx)} ${px(cy)}, ${stopList(p.stops, o, "%")})` };
    }
    case "image":
      return imageLayer(doc, p, w, h, assetUrl);
    default:
      return null;
  }
}

function imageLayer(doc: FigDocument | null, p: Extract<Paint, { type: "image" }>, w: number, h: number, assetUrl: NonNullable<CssOptions["assetUrl"]>): Layer | null {
  if ((p.rotation ?? 0) !== 0 || (p.opacity ?? 1) < 1) return null;
  const f = p.filters;
  if (f && Object.values(f).some((v) => v !== 0 && v !== undefined)) return null;
  const meta = doc?.assets().get(p.asset);
  const url = `url("${assetUrl(p.asset, meta)}")`;
  switch (p.fit) {
    case "cover":
    case "contain":
      return { image: url, size: p.fit, position: "50% 50%", repeat: "no-repeat" };
    case "stretch":
      return { image: url, size: "100% 100%", repeat: "no-repeat" };
    case "tile": {
      if (!meta?.width || !meta.height) return null;
      const s = p.tileScale ?? 1;
      return { image: url, size: `${px(meta.width * s)} ${px(meta.height * s)}`, repeat: "repeat" };
    }
    case "crop": {
      const t = p.transform ?? [1, 0, 0, 1, 0, 0];
      if (t[1] !== 0 || t[2] !== 0 || t[0] <= 0 || t[3] <= 0) return null;
      return { image: url, size: `${px(t[0] * w)} ${px(t[3] * h)}`, position: `${px(t[4] * w)} ${px(t[5] * h)}`, repeat: "no-repeat" };
    }
    default:
      return null;
  }
}

const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg" };

function defaultAssetUrl(id: string, meta: AssetMeta | undefined): string {
  return `assets/${id}.${(meta && EXTENSIONS[meta.mimeType]) ?? "bin"}`;
}

function stopList(stops: readonly GradientStop[], opacity: number, unit: "%" = "%"): string {
  return [...stops]
    .sort((a, b) => a.position - b.position)
    .map((s) => `${rgbaCss(s.color, opacity)} ${num(s.position * 100)}${unit}`)
    .join(", ");
}

function num(v: number): string {
  const r = Math.round(v * 1e4) / 1e4;
  return String(Object.is(r, -0) ? 0 : r);
}

function px(v: number): string {
  return v === 0 ? "0" : `${num(v)}px`;
}

function rgbaCss(c: Color, opacity = 1): string {
  const ch = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 255);
  const a = Math.round(c.a * opacity * 1000) / 1000;
  return a >= 1 ? `rgb(${ch(c.r)}, ${ch(c.g)}, ${ch(c.b)})` : `rgba(${ch(c.r)}, ${ch(c.g)}, ${ch(c.b)}, ${a})`;
}
