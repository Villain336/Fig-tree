import { IDENTITY, invert, multiply, type Mat2D } from "@fig-tree/geometry";
import type { Color, GradientStop, Paint } from "./types";

export const PaintKind = { Solid: 0, Linear: 1, Radial: 2 } as const;
export type PaintKind = (typeof PaintKind)[keyof typeof PaintKind];

/**
 * Backend-neutral paint encoding. Gradients are evaluated by mapping a local
 * point through `matrix` into "parameter space": a linear gradient's
 * parameter is `x`, a radial gradient's is `length(x, y)`.
 */
export interface EncodedPaint {
  readonly kind: PaintKind;
  /** Premultiplied color for solid paints; unused for gradients. */
  readonly color: readonly [number, number, number, number];
  /** Local space to gradient parameter space. */
  readonly matrix: Mat2D;
  /** Stops as (offset, r, g, b, a) tuples, non-premultiplied, sorted by offset. */
  readonly stops: Float32Array;
}

export function premultiply(c: Color): [number, number, number, number] {
  const a = clamp01(c.a);
  return [clamp01(c.r) * a, clamp01(c.g) * a, clamp01(c.b) * a, a];
}

export function encodePaint(paint: Paint): EncodedPaint {
  if (paint.type === "solid") {
    return { kind: PaintKind.Solid, color: premultiply(paint.color), matrix: IDENTITY, stops: new Float32Array(0) };
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
    return { kind: PaintKind.Linear, color: [0, 0, 0, 0], matrix: multiply(param, toGradient), stops };
  }
  const r = paint.radius;
  if (!(r > 0) || !toGradient) return solidFromLastStop(paint.stops);
  const param: Mat2D = [1 / r, 0, 0, 1 / r, -paint.center.x / r, -paint.center.y / r];
  return { kind: PaintKind.Radial, color: [0, 0, 0, 0], matrix: multiply(param, toGradient), stops };
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
  const color = last ? premultiply(last.color) : ([0, 0, 0, 0] as [number, number, number, number]);
  return { kind: PaintKind.Solid, color, matrix: IDENTITY, stops: new Float32Array(0) };
}

/**
 * Reference gradient evaluation (premultiplied). Shaders implement the same
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
  const mix = (k: number): number => a[k]! + (b[k]! - a[k]!) * u;
  const alpha = mix(4);
  return [mix(1) * alpha, mix(2) * alpha, mix(3) * alpha, alpha];
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
