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

export const GradientStop = z.strictObject({ position: Unit, color: Color });
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
 * Reserved: a custom GPU paint. `shader` names a shader asset or built-in;
 * uniforms are plain numbers or vectors. Rendering arrives with the shader
 * fill module; the field shape is fixed now so files stay forward compatible.
 */
export const ShaderPaint = z.strictObject({
  type: z.literal("shader"),
  shader: z.string().min(1),
  uniforms: z.record(z.string(), z.union([Num, z.array(Num).max(16)])).optional(),
  ...paintBase,
});

export const Paint = z.discriminatedUnion("type", [
  SolidPaint,
  LinearGradientPaint,
  RadialGradientPaint,
  AngularGradientPaint,
  DiamondGradientPaint,
  ImagePaint,
  ShaderPaint,
]);
export type Paint = z.infer<typeof Paint>;
export type PaintType = Paint["type"];

export const PaintStack = z.array(Paint).max(64);

/** Per-side stroke weights for rectangles and frames (CSS border widths). */
export const StrokeWeight = z.union([
  NonNegative,
  z.strictObject({ top: NonNegative, right: NonNegative, bottom: NonNegative, left: NonNegative }),
]);
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

export const Effect = z.discriminatedUnion("type", [DropShadowEffect, InnerShadowEffect, LayerBlurEffect, BackgroundBlurEffect]);
export type Effect = z.infer<typeof Effect>;
export const EffectStack = z.array(Effect).max(32);
