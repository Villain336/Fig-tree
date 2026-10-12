import type { Mat2D } from "@fig-tree/geometry";
import type { Color, RenderImage } from "../types";

/**
 * The shader fill library: procedural paints evaluated per pixel on the GPU,
 * with one WGSL and one GLSL ES 3.0 implementation each (`wgsl.ts`,
 * `glsl.ts`) that compute the same function. Every shader is a pure
 * function of the pixel's position in the node's box, its parameters, a
 * seed and a time, so a given (parameters, seed, time) always renders the
 * same image. Parameters are packed into vec4s in the layout below, which
 * both implementations read.
 *
 * These are our own implementations (no third-party shader code).
 */
export const SHADER_KINDS = ["mesh-gradient", "grain", "halftone", "fluted-glass", "liquid", "dithering"] as const;
export type ShaderKind = (typeof SHADER_KINDS)[number];

/** Where halftone and dithering read their tone (0 = paper, 1 = full ink). */
export const TONE_SOURCES = ["linear", "radial", "noise", "image"] as const;
export type ToneSource = (typeof TONE_SOURCES)[number];

export interface MeshPoint {
  /** Position in the box, normalized (0..1); points may leave the box. */
  readonly x: number;
  readonly y: number;
  readonly color: Color;
}

/**
 * A grid of `columns` × `rows` control points (row-major). Positions and
 * colors are interpolated by a C1-continuous Catmull-Rom surface; each pixel
 * finds its surface parameter by Newton iteration, so moved points bend the
 * gradient smoothly. `motion` (in box units) lets the points drift on seeded
 * Lissajous paths over time.
 */
export interface MeshGradientParams {
  readonly columns: number;
  readonly rows: number;
  readonly points: readonly MeshPoint[];
  readonly motion?: number | undefined;
}

/** Film grain: seeded value noise in cells of `size` px, mixing two colors. */
export interface GrainParams {
  readonly colorBack: Color;
  readonly colorFront: Color;
  /** Grain cell size in px (local units). */
  readonly size: number;
  /** Share of cells that take the front color, 0..1. */
  readonly density: number;
  /** 0: hard grains; 1: smooth. */
  readonly softness?: number | undefined;
}

/** Halftone screen of a tone source: dots or lines, one ink or four CMYK screens. */
export interface HalftoneParams {
  readonly style: "dots" | "lines";
  readonly cmyk: boolean;
  readonly colorBack: Color;
  readonly colorFront: Color;
  /** Screen cell size in px. */
  readonly cellSize: number;
  /** Screen angle in degrees. */
  readonly angle: number;
  readonly source: ToneSource;
  /** Direction of the linear source, degrees. */
  readonly sourceAngle?: number | undefined;
  /** Tone contrast, -1..1. */
  readonly contrast?: number | undefined;
}

/**
 * Ribbed glass over what is behind the node: each flute is a cylindrical
 * lens that shifts the backdrop across it; `frost` blurs the backdrop
 * first (a radius, like background blur), `shading` adds the flutes'
 * highlights and shadows, `tint` is laid over.
 */
export interface FlutedGlassParams {
  readonly fluteWidth: number;
  readonly angle: number;
  readonly distortion: number;
  readonly shading: number;
  readonly frost: number;
  readonly tint: Color;
}

/** Liquid: domain-warped simplex noise mapped onto a ramp of 2 to 5 colors. */
export interface LiquidParams {
  readonly colors: readonly Color[];
  /** Feature size in px. */
  readonly scale: number;
  /** Strength of the domain warp, 0..2. */
  readonly warp: number;
  /** Octaves of noise, 1..6. */
  readonly detail: number;
}

/** Ordered (Bayer) or noise dithering of a tone source into two colors. */
export interface DitheringParams {
  readonly pattern: "bayer2" | "bayer4" | "bayer8" | "noise";
  /** Size of a dither pixel in px. */
  readonly pixelSize: number;
  readonly colorBack: Color;
  readonly colorFront: Color;
  readonly source: ToneSource;
  readonly sourceAngle?: number | undefined;
  readonly contrast?: number | undefined;
}

export interface ShaderParamsByKind {
  "mesh-gradient": MeshGradientParams;
  grain: GrainParams;
  halftone: HalftoneParams;
  "fluted-glass": FlutedGlassParams;
  liquid: LiquidParams;
  dithering: DitheringParams;
}

interface ShaderPaintBase {
  readonly type: "shader";
  /** The node's box: the shader's (0, 0)..(1, 1) maps to (0, 0)..(width, height) in local space. */
  readonly size: { readonly width: number; readonly height: number };
  /** Integer seed (0..2^24) for the shader's random choices. */
  readonly seed?: number | undefined;
  /** Time in seconds at which the shader is evaluated when the clock is 0. */
  readonly time?: number | undefined;
  /** How fast the renderer's clock advances this shader's time. 0 (the default) is static. */
  readonly speed?: number | undefined;
  /** Multiplies the result's alpha. Default 1. */
  readonly opacity?: number | undefined;
  /** The image an `image` tone source reads. */
  readonly image?: RenderImage | null;
  /** Image pixel space → local space for `image`. */
  readonly imageTransform?: Mat2D | undefined;
}

export type ShaderPaint = { [K in ShaderKind]: ShaderPaintBase & { readonly shader: K; readonly params: ShaderParamsByKind[K] } }[ShaderKind];

/** Shaders that read what is behind the node (the renderer captures a backdrop for them). */
export function shaderUsesBackdrop(paint: ShaderPaint): boolean {
  return paint.shader === "fluted-glass";
}

/** Whether the paint changes with the renderer's clock. */
export function shaderAnimated(paint: ShaderPaint): boolean {
  return (paint.speed ?? 0) !== 0;
}

/** Whether the shader samples `paint.image`. */
export function shaderUsesImage(paint: ShaderPaint): boolean {
  return (paint.shader === "halftone" || paint.shader === "dithering") && paint.params.source === "image" && !!paint.image;
}

export const MAX_MESH_SIDE = 6;

/** Index of each shader in the GPU code's switch. */
export function shaderCode(kind: ShaderKind): number {
  return SHADER_KINDS.indexOf(kind);
}

/**
 * Packs a shader paint into vec4s (flat floats, length a multiple of 4):
 *
 *     [0] kind, seed, time, speed
 *     [1] width, height, opacity, 0
 *     [2…] the shader's own parameters (see each case)
 *
 * The time slot holds the paint's own time; the GPU adds clock × speed.
 */
export function packShader(paint: ShaderPaint): Float32Array {
  const out: number[] = [shaderCode(paint.shader), clampSeed(paint.seed ?? 0), paint.time ?? 0, paint.speed ?? 0, paint.size.width, paint.size.height, clamp01(paint.opacity ?? 1), 0];
  const color = (c: Color): void => {
    out.push(clamp01(c.r), clamp01(c.g), clamp01(c.b), clamp01(c.a));
  };
  switch (paint.shader) {
    case "mesh-gradient": {
      const p = paint.params;
      const cols = clampInt(p.columns, 2, MAX_MESH_SIDE);
      const rows = clampInt(p.rows, 2, MAX_MESH_SIDE);
      // [2] columns, rows, motion, 0; then per point: (x, y, 0, 0), color.
      out.push(cols, rows, p.motion ?? 0, 0);
      for (let i = 0; i < cols * rows; i++) {
        const pt = p.points[i] ?? { x: (i % cols) / (cols - 1), y: Math.floor(i / cols) / (rows - 1), color: { r: 0, g: 0, b: 0, a: 1 } };
        out.push(pt.x, pt.y, 0, 0);
        color(pt.color);
      }
      break;
    }
    case "grain": {
      const p = paint.params;
      // [2] back, [3] front, [4] size, density, softness, 0
      color(p.colorBack);
      color(p.colorFront);
      out.push(Math.max(0.25, p.size), clamp01(p.density), clamp01(p.softness ?? 0), 0);
      break;
    }
    case "halftone": {
      const p = paint.params;
      // [2] back, [3] front, [4] style, cmyk, cellSize, angle, [5] source, sourceAngle, contrast, image
      color(p.colorBack);
      color(p.colorFront);
      out.push(p.style === "lines" ? 1 : 0, p.cmyk ? 1 : 0, Math.max(1, p.cellSize), p.angle);
      out.push(TONE_SOURCES.indexOf(p.source), p.sourceAngle ?? 0, clamp(p.contrast ?? 0, -1, 1), shaderUsesImage(paint) ? 1 : 0);
      break;
    }
    case "fluted-glass": {
      const p = paint.params;
      // [2] fluteWidth, angle, distortion, shading, [3] tint, [4] frost, 0, 0, 0
      out.push(Math.max(1, p.fluteWidth), p.angle, clamp(p.distortion, 0, 1), clamp01(p.shading));
      color(p.tint);
      out.push(Math.max(0, p.frost), 0, 0, 0);
      break;
    }
    case "liquid": {
      const p = paint.params;
      const colors = p.colors.slice(0, 5);
      while (colors.length < 2) colors.push(colors[0] ?? { r: 0, g: 0, b: 0, a: 1 });
      // [2] scale, warp, detail, count; [3..7] colors
      out.push(Math.max(1, p.scale), clamp(p.warp, 0, 2), clampInt(p.detail, 1, 6), colors.length);
      for (let i = 0; i < 5; i++) color(colors[Math.min(i, colors.length - 1)]!);
      break;
    }
    case "dithering": {
      const p = paint.params;
      // [2] back, [3] front, [4] pattern, pixelSize, source, sourceAngle, [5] contrast, image, 0, 0
      color(p.colorBack);
      color(p.colorFront);
      out.push(["bayer2", "bayer4", "bayer8", "noise"].indexOf(p.pattern), Math.max(1, p.pixelSize), TONE_SOURCES.indexOf(p.source), p.sourceAngle ?? 0);
      out.push(clamp(p.contrast ?? 0, -1, 1), shaderUsesImage(paint) ? 1 : 0, 0, 0);
      break;
    }
  }
  while (out.length % 4 !== 0) out.push(0);
  return Float32Array.from(out);
}

function clampSeed(seed: number): number {
  return Math.max(0, Math.min(0xffffff, Math.floor(Number.isFinite(seed) ? seed : 0)));
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
}

function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.round(clamp(v, lo, hi));
}
