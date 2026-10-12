import type { FillRule, Mat2D, Path, Point, StrokeStyle } from "@fig-tree/geometry";
import type { ShaderPaint } from "./shaders/library";

/** Non-premultiplied sRGB color with components in [0, 1]. */
export interface Color {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

export interface GradientStop {
  /** Position along the gradient in [0, 1]. */
  readonly offset: number;
  readonly color: Color;
}

export interface SolidPaint {
  readonly type: "solid";
  readonly color: Color;
}

/** Linear gradient between two points in the node's local space. Colors pad beyond the ends. */
export interface LinearGradientPaint {
  readonly type: "linear-gradient";
  readonly start: Point;
  readonly end: Point;
  readonly stops: readonly GradientStop[];
  /** Optional extra mapping from gradient space into local space (e.g. skew). */
  readonly transform?: Mat2D;
}

/**
 * Radial gradient centered in the node's local space. Use `transform` for
 * elliptical or rotated gradients.
 */
export interface RadialGradientPaint {
  readonly type: "radial-gradient";
  readonly center: Point;
  readonly radius: number;
  readonly stops: readonly GradientStop[];
  readonly transform?: Mat2D;
}

/**
 * Angular (CSS `conic-gradient`) gradient: the parameter is the angle around
 * `center` in gradient space, starting along +x and turning towards +y (that
 * is clockwise on screen), one full turn from 0 to 1. Use `transform` to map
 * gradient space into local space (rotation, ellipses, skew).
 */
export interface AngularGradientPaint {
  readonly type: "angular-gradient";
  readonly center: Point;
  readonly stops: readonly GradientStop[];
  readonly transform?: Mat2D;
}

/**
 * Diamond gradient: the parameter is the L1 distance from `center` in
 * gradient space divided by `radius` (|x| + |y| = radius is the last stop).
 */
export interface DiamondGradientPaint {
  readonly type: "diamond-gradient";
  readonly center: Point;
  readonly radius: number;
  readonly stops: readonly GradientStop[];
  readonly transform?: Mat2D;
}

/**
 * A decoded bitmap. `data` is RGBA8 with premultiplied alpha, rows top to
 * bottom. `key` identifies the pixels: two images with the same key must be
 * identical (the renderer caches uploads and mipmaps by key).
 */
export interface RenderImage {
  readonly key: string;
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/**
 * Image adjustments, each in [-1, 1] with 0 leaving the image unchanged.
 * Applied in this order on unpremultiplied sRGB values (see `docs/architecture.md`).
 */
export interface ImageAdjustments {
  readonly exposure?: number | undefined;
  readonly contrast?: number | undefined;
  readonly saturation?: number | undefined;
  readonly temperature?: number | undefined;
  readonly tint?: number | undefined;
  readonly highlights?: number | undefined;
  readonly shadows?: number | undefined;
}

/**
 * A bitmap paint. `transform` maps image pixel space (0..width, 0..height)
 * into the node's local space. Outside the image the paint is transparent,
 * unless `repeat` tiles it in both directions.
 */
export interface ImagePaint {
  readonly type: "image";
  readonly image: RenderImage;
  readonly transform: Mat2D;
  readonly repeat?: boolean;
  readonly adjustments?: ImageAdjustments;
  /** Multiplies the image's alpha. Default 1. */
  readonly opacity?: number;
}

export type Paint = SolidPaint | LinearGradientPaint | RadialGradientPaint | AngularGradientPaint | DiamondGradientPaint | ImagePaint | ShaderPaint;

/** CSS `mix-blend-mode` keywords (W3C Compositing and Blending), in their GPU code order. */
export const BLEND_MODES = [
  "normal",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
  "plus-darker",
  "plus-lighter",
] as const;
export type BlendMode = (typeof BLEND_MODES)[number];

export function blendCode(mode: BlendMode | undefined): number {
  const i = mode ? BLEND_MODES.indexOf(mode) : 0;
  return i < 0 ? 0 : i;
}

/**
 * Shadows, in the node's local space (they scale and rotate with it).
 * `radius` is the CSS blur radius: the Gaussian's standard deviation is
 * radius / 2 (CSS Backgrounds 3 §7.1.1). The source is the node's shape:
 * the coverage of its fills, strokes and children, where solid and gradient
 * paints count as opaque and images and shaders by their alpha (so a
 * cut-out image casts a shaped shadow, and a translucent fill casts a full
 * one, like CSS `box-shadow`).
 */
export interface ShadowEffect {
  readonly type: "drop-shadow" | "inner-shadow";
  readonly color: Color;
  readonly offset: Point;
  readonly radius: number;
  /** Grows (drop) or shrinks (inner) the shape before blurring. */
  readonly spread: number;
  /** Drop shadows: also draw the shadow under the node itself. Default false (CSS `box-shadow` clips it away). */
  readonly showBehind?: boolean;
  readonly blendMode?: BlendMode;
  /**
   * The spread shape in local space, when it has an exact form (a rounded
   * rectangle per CSS Backgrounds 3 §7.1.1); otherwise the shape is dilated
   * (or eroded) by `spread` on the GPU.
   */
  readonly spreadPath?: Path | null;
}

/**
 * `layer-blur`: CSS `filter: blur(radius / 2)` on the node. `background-blur`:
 * CSS `backdrop-filter: blur(radius / 2)`: what is behind the node (within
 * its backdrop root) is blurred and shown through its shape.
 */
export interface LayerBlurEffect {
  readonly type: "layer-blur";
  readonly radius: number;
}

export interface BackgroundBlurEffect {
  readonly type: "background-blur";
  readonly radius: number;
}

export type BlurEffect = LayerBlurEffect | BackgroundBlurEffect;

export type Effect = ShadowEffect | BlurEffect;

/**
 * A mask node masks its following siblings: `alpha` by its rendered alpha,
 * `luminance` by its luminance times alpha, `vector` by its shape (coverage
 * of its geometry, ignoring paint). The mask node itself is not drawn.
 */
export type MaskType = "alpha" | "luminance" | "vector";

export interface Stroke extends StrokeStyle {
  readonly paint: Paint;
}

export type { FillRule };

/**
 * Maps world coordinates to CSS pixels of the canvas. The renderer applies
 * the device pixel ratio on top, so callers never deal with device pixels.
 */
export interface Viewport {
  readonly transform: Mat2D;
}

export type BackendKind = "webgpu" | "webgl2";

export function rgba(r: number, g: number, b: number, a = 1): Color {
  return { r, g, b, a };
}

/** Parses `#rgb`, `#rrggbb` or `#rrggbbaa`. */
export function hexColor(hex: string): Color {
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(full)) throw new Error(`invalid hex color: ${hex}`);
  const n = (i: number): number => parseInt(full.slice(i, i + 2), 16) / 255;
  return { r: n(0), g: n(2), b: n(4), a: full.length === 8 ? n(6) : 1 };
}

export function solid(color: Color): SolidPaint {
  return { type: "solid", color };
}
