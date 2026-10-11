import type { FillRule, Mat2D, Point, StrokeStyle } from "@fig-tree/geometry";

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

export type Paint = SolidPaint | LinearGradientPaint | RadialGradientPaint;

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
