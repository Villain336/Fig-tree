import { invert, multiply, type Mat2D } from "@fig-tree/geometry";
import type { Paint as RenderPaint, GradientStop as RenderStop, RenderImage, ShaderPaint as RenderShaderPaint } from "@fig-tree/renderer";
import type { GradientStop, Paint, ShaderPaint } from "../schema";

/** How an image is fitted into a box (the placement fields of an image paint). */
export interface ImageFit {
  readonly fit: "cover" | "contain" | "stretch" | "tile" | "crop";
  readonly transform?: readonly number[] | undefined;
  readonly tileScale?: number | undefined;
  readonly rotation?: number | undefined;
}

/** Decoded images by asset id: null while an image is loading or could not be decoded. */
export interface ImageLookup {
  get(asset: string): RenderImage | null;
}

/**
 * Maps a document paint to a renderer paint in the node's local space
 * (gradient handles are normalized to the node's box), or explains why it
 * cannot be drawn.
 */
export function toRenderPaint(paint: Paint, width: number, height: number, images: ImageLookup | null = null): { paint: RenderPaint } | { unsupported: string } {
  const opacity = paint.opacity ?? 1;
  const stops = (list: readonly GradientStop[]): RenderStop[] =>
    list.map((s) => ({ offset: s.position, color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a * opacity } }));
  switch (paint.type) {
    case "solid":
      return { paint: { type: "solid", color: { ...paint.color, a: paint.color.a * opacity } } };
    case "linear-gradient":
      return {
        paint: {
          type: "linear-gradient",
          start: { x: paint.start.x * width, y: paint.start.y * height },
          end: { x: paint.end.x * width, y: paint.end.y * height },
          stops: stops(paint.stops),
        },
      };
    case "radial-gradient":
    case "angular-gradient":
    case "diamond-gradient": {
      // Unit circle (or square) in gradient space → the frame spanned by the handles.
      const cx = paint.center.x * width, cy = paint.center.y * height;
      const transform: Mat2D = [paint.radiusX.x * width - cx, paint.radiusX.y * height - cy, paint.radiusY.x * width - cx, paint.radiusY.y * height - cy, cx, cy];
      const s = stops(paint.stops);
      if (paint.type === "angular-gradient") return { paint: { type: "angular-gradient", center: { x: 0, y: 0 }, stops: s, transform } };
      return { paint: { type: paint.type, center: { x: 0, y: 0 }, radius: 1, stops: s, transform } };
    }
    case "image": {
      const image = images?.get(paint.asset) ?? null;
      if (!image) return { unsupported: images ? `image-loading:${paint.asset.slice(0, 8)}` : "image" };
      const transform = imagePlacement(paint, image.width, image.height, width, height);
      return {
        paint: {
          type: "image",
          image,
          transform,
          repeat: paint.fit === "tile",
          opacity,
          ...(paint.filters ? { adjustments: paint.filters } : {}),
        },
      };
    }
    case "shader":
      return toRenderShader(paint, width, height, images);
  }
}

/**
 * Image pixel space → local space for an image paint, with CSS
 * `background-size` semantics: `cover` and `contain` scale uniformly and
 * center, `stretch` fills the box, `tile` repeats from the top-left at
 * `tileScale` × the natural size, `crop` places the unit square with
 * `transform` in the normalized box. `rotation` turns the image clockwise
 * in quarter turns before it is fitted.
 */
export function imagePlacement(paint: ImageFit, iw: number, ih: number, width: number, height: number): Mat2D {
  const turns = ((paint.rotation ?? 0) / 90) % 4;
  // Rotation about the image's own box: image px → rotated px (size rw × rh).
  const swap = turns % 2 === 1;
  const rw = swap ? ih : iw;
  const rh = swap ? iw : ih;
  const rotations: Mat2D[] = [
    [1, 0, 0, 1, 0, 0],
    [0, 1, -1, 0, ih, 0],
    [-1, 0, 0, -1, iw, ih],
    [0, -1, 1, 0, 0, iw],
  ];
  const rot = rotations[turns]!;
  let place: Mat2D;
  switch (paint.fit) {
    case "cover":
    case "contain": {
      const s = paint.fit === "cover" ? Math.max(width / rw, height / rh) : Math.min(width / rw, height / rh);
      place = [s, 0, 0, s, (width - rw * s) / 2, (height - rh * s) / 2];
      break;
    }
    case "stretch":
      place = [width / rw, 0, 0, height / rh, 0, 0];
      break;
    case "tile": {
      const s = paint.tileScale ?? 1;
      place = [s, 0, 0, s, 0, 0];
      break;
    }
    default: {
      const t = paint.transform ?? [1, 0, 0, 1, 0, 0];
      // unit square → normalized box → local; rotated px → unit square.
      place = multiply(multiply([width, 0, 0, height, 0, 0], t as unknown as Mat2D), [1 / rw, 0, 0, 1 / rh, 0, 0]);
      break;
    }
  }
  return multiply(place, rot);
}

/** `object-fit` of an image node, as an image placement (`none` and `scale-down` keep the natural size, centered). */
export function objectFitPlacement(fit: string, iw: number, ih: number, width: number, height: number): Mat2D {
  if (fit === "cover" || fit === "contain") return imagePlacement({ fit: fit as "cover" }, iw, ih, width, height);
  if (fit === "fill") return imagePlacement({ fit: "stretch" }, iw, ih, width, height);
  const s = fit === "scale-down" ? Math.min(1, width / iw, height / ih) : 1;
  return [s, 0, 0, s, (width - iw * s) / 2, (height - ih * s) / 2];
}

function toRenderShader(paint: ShaderPaint, width: number, height: number, images: ImageLookup | null): { paint: RenderPaint } | { unsupported: string } {
  const base = { type: "shader" as const, size: { width, height }, seed: paint.seed ?? 0, time: paint.time ?? 0, speed: paint.speed ?? 0, opacity: paint.opacity ?? 1 };
  let out: RenderShaderPaint;
  switch (paint.shader) {
    case "mesh-gradient": {
      const p = paint.params;
      out = { ...base, shader: "mesh-gradient", params: { columns: p.columns, rows: p.rows, points: p.points, motion: p.motion ?? 0 } };
      break;
    }
    case "grain":
      out = { ...base, shader: "grain", params: { ...paint.params } };
      break;
    case "fluted-glass":
      out = { ...base, shader: "fluted-glass", params: { ...paint.params } };
      break;
    case "liquid":
      out = { ...base, shader: "liquid", params: { ...paint.params } };
      break;
    case "halftone": {
      const { asset, ...params } = paint.params;
      const src = toneImage(params.source, asset, width, height, images);
      if ("unsupported" in src) return src;
      out = { ...base, ...src.extra, shader: "halftone", params };
      break;
    }
    case "dithering": {
      const { asset, ...params } = paint.params;
      const src = toneImage(params.source, asset, width, height, images);
      if ("unsupported" in src) return src;
      out = { ...base, ...src.extra, shader: "dithering", params };
      break;
    }
  }
  return { paint: out };
}

/** The image a halftone or dithering `image` source reads, covering the box. */
function toneImage(source: string, asset: string | undefined, width: number, height: number, images: ImageLookup | null): { extra: { image?: RenderImage; imageTransform?: Mat2D } } | { unsupported: string } {
  if (source !== "image") return { extra: {} };
  if (!asset) return { unsupported: "shader-image-missing" };
  const image = images?.get(asset) ?? null;
  if (!image) return { unsupported: images ? `image-loading:${asset.slice(0, 8)}` : "image" };
  return { extra: { image, imageTransform: imagePlacement({ fit: "cover" }, image.width, image.height, width, height) } };
}

/** Local → image pixel space of a placement (exported for hit-testing and the crop UI). */
export function inversePlacement(m: Mat2D): Mat2D | null {
  return invert(m);
}
