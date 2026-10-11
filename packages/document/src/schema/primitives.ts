import { z } from "zod";

/**
 * Shared value types. Every schema is strict (unknown keys are rejected) so
 * typos from agents or importers fail loudly instead of being dropped.
 */

/** Finite number (zod 4 already rejects NaN and ±Infinity). */
export const Num = z.number();
export const NonNegative = z.number().min(0);
/** A number in [0, 1]. */
export const Unit = z.number().min(0).max(1);

/** Id of the virtual document root that pages hang off. Never a stored node. */
export const ROOT_ID = "root";

/**
 * Node ids are short opaque strings, stable for the node's lifetime and
 * unique within a document (generated ids are 16 random base-62 digits).
 */
export const NodeId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, "ids are 1-64 characters of A-Z, a-z, 0-9, '_' or '-'")
  .refine((id) => id !== ROOT_ID, `"${ROOT_ID}" is reserved for the document root`);
export type NodeId = z.infer<typeof NodeId>;

/** Content address of an asset: lowercase hex SHA-256 of its bytes. */
export const AssetId = z.string().regex(/^[0-9a-f]{64}$/, "asset ids are lowercase hex SHA-256 digests").meta({ id: "AssetId" });
export type AssetId = z.infer<typeof AssetId>;

/** Non-premultiplied sRGB color, components in [0, 1]. */
export const Color = z.strictObject({ r: Unit, g: Unit, b: Unit, a: Unit }).meta({ id: "Color" });
export type Color = z.infer<typeof Color>;

export const Point = z.strictObject({ x: Num, y: Num }).meta({ id: "Point" });
export type Point = z.infer<typeof Point>;

/** CSS `mix-blend-mode` keywords. */
export const BlendMode = z.enum([
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
]).meta({ id: "BlendMode" });
export type BlendMode = z.infer<typeof BlendMode>;

/** Four values in CSS order: top, right, bottom, left. */
export function sides<T extends z.ZodType>(value: T) {
  return z.strictObject({ top: value, right: value, bottom: value, left: value });
}

/** Makes every schema in a shape optional (the shape of a partial update or a style override). */
export function optionalShape<S extends Record<string, z.ZodType>>(shape: S): { [K in keyof S]: z.ZodOptional<S[K]> } {
  const out: Record<string, z.ZodType> = {};
  for (const [k, v] of Object.entries(shape)) out[k] = v.optional();
  return out as { [K in keyof S]: z.ZodOptional<S[K]> };
}
