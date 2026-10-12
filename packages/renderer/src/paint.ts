import { IDENTITY, invert, multiply, type Mat2D } from "@fig-tree/geometry";
import { packShader, shaderUsesImage } from "./shaders/library";
import type { Color, GradientStop, ImageAdjustments, Paint, RenderImage } from "./types";

export const PaintKind = { Solid: 0, Linear: 1, Radial: 2, Angular: 3, Diamond: 4, Image: 5, Shader: 6 } as const;
export type PaintKind = (typeof PaintKind)[keyof typeof PaintKind];

/**
 * Backend-neutral paint encoding. Gradients are evaluated by mapping a local
 * point through `matrix` into "parameter space": a linear gradient's
 * parameter is `x`, a radial gradient's is `length(x, y)`, an angular
 * gradient's the angle of (x, y) in turns, a diamond's |x| + |y|. Images map
 * local points to image pixels; shaders map them to the unit box.
 */
export interface EncodedPaint {
  readonly kind: PaintKind;
  /** Premultiplied color for solid paints; unused otherwise. */
  readonly color: readonly [number, number, number, number];
  /** Local space to parameter space (gradients), image pixels (images) or the unit box (shaders). */
  readonly matrix: Mat2D;
  /** Stops as (offset, r, g, b, a) tuples, non-premultiplied, sorted by offset. */
  readonly stops: Float32Array;
  /** Images and shaders: their parameters as vec4s (see `imageParams` and `packShader`). */
  readonly params: Float32Array;
  /** The bitmap the paint samples (images, image-sourced shaders). */
  readonly image: RenderImage | null;
  /** Local space to image pixels for `image`. */
  readonly imageMatrix: Mat2D;
  /** Whether the paint changes with the renderer's clock. */
  readonly animated: boolean;
}

export function premultiply(c: Color): [number, number, number, number] {
  const a = clamp01(c.a);
  return [clamp01(c.r) * a, clamp01(c.g) * a, clamp01(c.b) * a, a];
}

const NONE = new Float32Array(0);

function encoded(kind: PaintKind, rest: Partial<EncodedPaint>): EncodedPaint {
  return { kind, color: [0, 0, 0, 0], matrix: IDENTITY, stops: NONE, params: NONE, image: null, imageMatrix: IDENTITY, animated: false, ...rest };
}

export function encodePaint(paint: Paint): EncodedPaint {
  if (paint.type === "solid") return encoded(PaintKind.Solid, { color: premultiply(paint.color) });
  if (paint.type === "image") {
    const toImage = invert(paint.transform);
    if (!toImage || paint.image.width <= 0 || paint.image.height <= 0) return encoded(PaintKind.Solid, {});
    return encoded(PaintKind.Image, { matrix: toImage, params: imageParams(paint.image, paint.repeat ?? false, paint.opacity ?? 1, paint.adjustments), image: paint.image, imageMatrix: toImage });
  }
  if (paint.type === "shader") {
    const { width, height } = paint.size;
    if (!(width > 0) || !(height > 0)) return encoded(PaintKind.Solid, {});
    const image = shaderUsesImage(paint) ? paint.image! : null;
    const toImage = image && paint.imageTransform ? invert(paint.imageTransform) : null;
    return encoded(PaintKind.Shader, {
      matrix: [1 / width, 0, 0, 1 / height, 0, 0],
      params: packShader(paint),
      image: toImage ? image : null,
      imageMatrix: toImage ?? IDENTITY,
      animated: (paint.speed ?? 0) !== 0,
    });
  }
  const stops = encodeStops(paint.stops);
  // A degenerate gradient (zero length or radius) renders as its last stop, like canvas.
  const toGradient = paint.transform ? invert(paint.transform) : IDENTITY;
  if (paint.type === "linear-gradient") {
    const vx = paint.end.x - paint.start.x;
    const vy = paint.end.y - paint.start.y;
    const l2 = vx * vx + vy * vy;
    if (l2 === 0 || !toGradient) return solidFromLastStop(paint.stops);
    const param: Mat2D = [vx / l2, 0, vy / l2, 0, -(paint.start.x * vx + paint.start.y * vy) / l2, 0];
    return encoded(PaintKind.Linear, { matrix: multiply(param, toGradient), stops });
  }
  if (paint.type === "angular-gradient") {
    if (!toGradient) return solidFromLastStop(paint.stops);
    const param: Mat2D = [1, 0, 0, 1, -paint.center.x, -paint.center.y];
    return encoded(PaintKind.Angular, { matrix: multiply(param, toGradient), stops });
  }
  const r = paint.radius;
  if (!(r > 0) || !toGradient) return solidFromLastStop(paint.stops);
  const param: Mat2D = [1 / r, 0, 0, 1 / r, -paint.center.x / r, -paint.center.y / r];
  return encoded(paint.type === "radial-gradient" ? PaintKind.Radial : PaintKind.Diamond, { matrix: multiply(param, toGradient), stops });
}

/**
 * Image paint parameters (3 vec4s):
 *
 *     [0] width, height, repeat (0/1), opacity
 *     [1] exposure, contrast, saturation, temperature
 *     [2] tint, highlights, shadows, adjusted (0/1)
 */
export function imageParams(image: RenderImage, repeat: boolean, opacity: number, adj: ImageAdjustments | undefined): Float32Array {
  const a = (v: number | undefined): number => (Number.isFinite(v) ? Math.max(-1, Math.min(1, v!)) : 0);
  const values = [a(adj?.exposure), a(adj?.contrast), a(adj?.saturation), a(adj?.temperature), a(adj?.tint), a(adj?.highlights), a(adj?.shadows)];
  const adjusted = values.some((v) => v !== 0) ? 1 : 0;
  return Float32Array.from([image.width, image.height, repeat ? 1 : 0, clamp01(opacity), ...values, adjusted]);
}

function encodeStops(stops: readonly GradientStop[]): Float32Array {
  const sorted = [...stops].sort((a, b) => a.offset - b.offset);
  const out = new Float32Array(Math.max(1, sorted.length) * 5);
  if (sorted.length === 0) return out; // transparent
  sorted.forEach((s, i) => {
    out.set([clamp01(s.offset), clamp01(s.color.r), clamp01(s.color.g), clamp01(s.color.b), clamp01(s.color.a)], i * 5);
  });
  return out;
}

function solidFromLastStop(stops: readonly GradientStop[]): EncodedPaint {
  const last = [...stops].sort((a, b) => a.offset - b.offset).at(-1);
  return encoded(PaintKind.Solid, { color: last ? premultiply(last.color) : [0, 0, 0, 0] });
}

/** Gradient parameter of a point already mapped into parameter space (the shaders implement the same). */
export function gradientParameter(kind: PaintKind, gx: number, gy: number): number {
  switch (kind) {
    case PaintKind.Linear:
      return gx;
    case PaintKind.Radial:
      return Math.hypot(gx, gy);
    case PaintKind.Angular: {
      const t = Math.atan2(gy, gx) / (2 * Math.PI);
      return t < 0 ? t + 1 : t;
    }
    case PaintKind.Diamond:
      return Math.abs(gx) + Math.abs(gy);
    default:
      return 0;
  }
}

/**
 * Reference gradient evaluation (premultiplied colors, interpolated premultiplied like CSS gradients). Shaders implement the same
 * math; this version backs tests and keeps the semantics in one readable place.
 */
export function sampleStops(stops: Float32Array, t: number): [number, number, number, number] {
  const n = stops.length / 5;
  const tt = clamp01(t);
  let i = 0;
  while (i + 1 < n && stops[(i + 1) * 5]! < tt) i++;
  const read = (k: number): number[] => Array.from(stops.subarray(k * 5, k * 5 + 5));
  const a = read(i);
  const b = read(Math.min(i + 1, n - 1));
  const span = b[0]! - a[0]!;
  const u = span > 0 ? clamp01((tt - a[0]!) / span) : tt >= b[0]! ? 1 : 0;
  // CSS Images 4 §3.5.2: stops interpolate in premultiplied space.
  const pre = (s: number[], k: number): number => (k === 4 ? s[4]! : s[k]! * s[4]!);
  const mix = (k: number): number => pre(a, k) + (pre(b, k) - pre(a, k)) * u;
  return [mix(1), mix(2), mix(3), mix(4)];
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
