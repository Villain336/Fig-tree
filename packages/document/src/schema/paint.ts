import { z } from "zod";
import { AssetId, BlendMode, Color, Num, NonNegative, Point, Unit } from "./primitives";

/**
 * Paints are stacked in paint order: index 0 is painted first (bottom), the
 * last entry ends up on top, like children. CSS `background` lists layers
 * top-first, so code export reverses the stack.
 *
 * Gradient handles are normalized to the node's box: (0, 0) is the top-left
 * corner and (1, 1) the bottom-right, so gradients stretch with the node.
 * Values outside [0, 1] are allowed (handles may sit outside the box).
 */
const paintBase = {
  /** Hidden paints stay in the stack but are not drawn. Default true. */
  visible: z.boolean().optional(),
  /** Multiplies the paint's alpha. Default 1. */
  opacity: Unit.optional(),
  /** How this paint blends with the paints below it in the same stack. Default "normal". */
  blendMode: BlendMode.optional(),
};

export const GradientStop = z.strictObject({ position: Unit, color: Color }).meta({ id: "GradientStop" });
export type GradientStop = z.infer<typeof GradientStop>;

const stops = z.array(GradientStop).min(2, "a gradient needs at least two stops");

export const SolidPaint = z.strictObject({ type: z.literal("solid"), color: Color, ...paintBase });

/** CSS `linear-gradient` between two handles. */
export const LinearGradientPaint = z.strictObject({
  type: z.literal("linear-gradient"),
  start: Point,
  end: Point,
  stops,
  ...paintBase,
});

/**
 * Radial, angular (CSS `conic-gradient`) and diamond gradients share three
 * handles that span an affine frame: `center`, the end of the first axis
 * (`radiusX`) and the end of the second (`radiusY`). Angular gradients start
 * along `radiusX` and sweep towards `radiusY`.
 */
const centered = { center: Point, radiusX: Point, radiusY: Point, stops };
export const RadialGradientPaint = z.strictObject({ type: z.literal("radial-gradient"), ...centered, ...paintBase });
export const AngularGradientPaint = z.strictObject({ type: z.literal("angular-gradient"), ...centered, ...paintBase });
export const DiamondGradientPaint = z.strictObject({ type: z.literal("diamond-gradient"), ...centered, ...paintBase });

/** Adjustments in [-1, 1]; 0 leaves the image unchanged. */
export const ImageFilters = z.strictObject({
  exposure: z.number().min(-1).max(1).optional(),
  contrast: z.number().min(-1).max(1).optional(),
  saturation: z.number().min(-1).max(1).optional(),
  temperature: z.number().min(-1).max(1).optional(),
  tint: z.number().min(-1).max(1).optional(),
  highlights: z.number().min(-1).max(1).optional(),
  shadows: z.number().min(-1).max(1).optional(),
});

/**
 * Bitmap paint referencing an asset. `fit` uses CSS `background-size`
 * semantics: cover, contain, stretch (`100% 100%`), tile (repeat at
 * `tileScale`) or crop (explicit `transform` from the unit square to the
 * image's placement in normalized box space).
 */
export const ImagePaint = z.strictObject({
  type: z.literal("image"),
  asset: AssetId,
  fit: z.enum(["cover", "contain", "stretch", "tile", "crop"]),
  /** Affine `[a, b, c, d, e, f]` used by `crop`. */
  transform: z.tuple([Num, Num, Num, Num, Num, Num]).optional(),
  /** Scale of one tile relative to the image's natural size. Default 1. */
  tileScale: z.number().positive().optional(),
  /** Clockwise rotation in quarter turns. */
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
  filters: ImageFilters.optional(),
  ...paintBase,
});

/**
 * Shader paints: procedural fills drawn on the GPU (see `docs/architecture.md`,
 * "Shader fills"). Each built-in shader has typed parameters; `seed` makes
 * its random choices repeatable, `time` is the moment it shows and `speed`
 * how fast it moves when the canvas animates (0, the default, is static).
 * Positions and sizes are in the node's local px, except mesh points
 * (normalized to the box).
 */
const shaderBase = {
  type: z.literal("shader"),
  /** Integer seed, 0 to 2^24 − 1. Default 0. */
  seed: z.number().int().min(0).max(0xffffff).optional(),
  /** Seconds. Default 0. */
  time: Num.optional(),
  /** Time scale while animating. Default 0 (static). */
  speed: z.number().min(-100).max(100).optional(),
  ...paintBase,
};

/** Where halftone and dithering read their tone: a linear ramp, a radial falloff, noise or an image asset. */
export const ToneSource = z.enum(["linear", "radial", "noise", "image"]);

export const MeshPoint = z.strictObject({ x: Num, y: Num, color: Color }).meta({ id: "MeshPoint" });

export const MeshGradientShader = z.strictObject({
  ...shaderBase,
  shader: z.literal("mesh-gradient"),
  params: z.strictObject({
    columns: z.number().int().min(2).max(6),
    rows: z.number().int().min(2).max(6),
    /** columns × rows control points, row by row, positions normalized to the box. */
    points: z.array(MeshPoint).min(4).max(36),
    /** Drift of the points while animating, in box units. */
    motion: z.number().min(0).max(0.5).optional(),
  }).refine((p) => p.points.length === p.columns * p.rows, { message: "a mesh gradient needs columns × rows points" }),
});

export const GrainShader = z.strictObject({
  ...shaderBase,
  shader: z.literal("grain"),
  params: z.strictObject({
    colorBack: Color,
    colorFront: Color,
    /** Grain size in px. */
    size: z.number().min(0.25).max(256),
    /** Share of grains in the front color. */
    density: Unit,
    softness: Unit.optional(),
  }),
});

export const HalftoneShader = z.strictObject({
  ...shaderBase,
  shader: z.literal("halftone"),
  params: z.strictObject({
    style: z.enum(["dots", "lines"]),
    /** Four screens (cyan, magenta, yellow, black) at the classic angles instead of one ink. */
    cmyk: z.boolean(),
    colorBack: Color,
    colorFront: Color,
    cellSize: z.number().min(1).max(256),
    /** Screen angle in degrees. */
    angle: Num,
    source: ToneSource,
    sourceAngle: Num.optional(),
    contrast: z.number().min(-1).max(1).optional(),
    /** The image of an `image` source (covering the box). */
    asset: AssetId.optional(),
  }),
});

export const FlutedGlassShader = z.strictObject({
  ...shaderBase,
  shader: z.literal("fluted-glass"),
  params: z.strictObject({
    fluteWidth: z.number().min(1).max(512),
    angle: Num,
    distortion: Unit,
    shading: Unit,
    /** Blur radius of what is seen through the glass (like background blur). */
    frost: z.number().min(0).max(256),
    tint: Color,
  }),
});

export const LiquidShader = z.strictObject({
  ...shaderBase,
  shader: z.literal("liquid"),
  params: z.strictObject({
    colors: z.array(Color).min(2).max(5),
    /** Feature size in px. */
    scale: z.number().min(1).max(4096),
    warp: z.number().min(0).max(2),
    detail: z.number().int().min(1).max(6),
  }),
});

export const DitheringShader = z.strictObject({
  ...shaderBase,
  shader: z.literal("dithering"),
  params: z.strictObject({
    pattern: z.enum(["bayer2", "bayer4", "bayer8", "noise"]),
    pixelSize: z.number().min(1).max(256),
    colorBack: Color,
    colorFront: Color,
    source: ToneSource,
    sourceAngle: Num.optional(),
    contrast: z.number().min(-1).max(1).optional(),
    asset: AssetId.optional(),
  }),
});

export const ShaderPaint = z.discriminatedUnion("shader", [MeshGradientShader, GrainShader, HalftoneShader, FlutedGlassShader, LiquidShader, DitheringShader]).meta({ id: "ShaderPaint" });
export type ShaderPaint = z.infer<typeof ShaderPaint>;
export type ShaderName = ShaderPaint["shader"];
export const SHADER_NAMES = ["mesh-gradient", "grain", "halftone", "fluted-glass", "liquid", "dithering"] as const satisfies readonly ShaderName[];

export const Paint = z.discriminatedUnion("type", [
  SolidPaint,
  LinearGradientPaint,
  RadialGradientPaint,
  AngularGradientPaint,
  DiamondGradientPaint,
  ImagePaint,
  ShaderPaint,
]).meta({ id: "Paint" });
export type Paint = z.infer<typeof Paint>;
export type PaintType = Paint["type"];

export const PaintStack = z.array(Paint).max(64).meta({ id: "PaintStack" });

/** Per-side stroke weights for rectangles and frames (CSS border widths). */
export const StrokeWeight = z.union([
  NonNegative,
  z.strictObject({ top: NonNegative, right: NonNegative, bottom: NonNegative, left: NonNegative }),
]).meta({ id: "StrokeWeight" });
export type StrokeWeight = z.infer<typeof StrokeWeight>;

export const StrokeAlign = z.enum(["inside", "center", "outside"]);
export const StrokeCap = z.enum(["butt", "round", "square"]);
export const StrokeJoin = z.enum(["miter", "round", "bevel"]);
export const StrokeDashes = z.array(NonNegative).max(32);
export const MiterLimit = z.number().min(1);

export const Shadow = {
  color: Color,
  offset: Point,
  blur: NonNegative,
  spread: Num,
  visible: z.boolean().optional(),
  blendMode: BlendMode.optional(),
};

/** CSS `box-shadow` / `filter: drop-shadow()`. */
export const DropShadowEffect = z.strictObject({
  type: z.literal("drop-shadow"),
  ...Shadow,
  /** Draw the shadow under transparent parts of the node too. Default false. */
  showBehindNode: z.boolean().optional(),
});
/** CSS `box-shadow: inset`. */
export const InnerShadowEffect = z.strictObject({ type: z.literal("inner-shadow"), ...Shadow });
/** CSS `filter: blur()`. */
export const LayerBlurEffect = z.strictObject({ type: z.literal("layer-blur"), radius: NonNegative, visible: z.boolean().optional() });
/** CSS `backdrop-filter: blur()`. */
export const BackgroundBlurEffect = z.strictObject({
  type: z.literal("background-blur"),
  radius: NonNegative,
  visible: z.boolean().optional(),
});

export const Effect = z.discriminatedUnion("type", [DropShadowEffect, InnerShadowEffect, LayerBlurEffect, BackgroundBlurEffect]).meta({ id: "Effect" });
export type Effect = z.infer<typeof Effect>;
export const EffectStack = z.array(Effect).max(32).meta({ id: "EffectStack" });
