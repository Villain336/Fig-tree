/**
 * How synthesized styles are drawn when a family has no bold or italic face
 * (CSS Fonts 4 §5.2 `font-synthesis`): the renderer emboldens or shears the
 * regular outlines.
 */

/**
 * Synthetic bold strength in em (the outline grows by this much in total):
 * 1/24 em at 9 px and below, 1/32 em at 36 px and above, linear between,
 * like browsers' fake bold.
 */
export function syntheticBoldStrength(size: number): number {
  const t = Math.min(1, Math.max(0, (size - 9) / 27));
  return 1 / 24 + (1 / 32 - 1 / 24) * t;
}

/** Synthetic oblique shear (x += 0.25 · height above the baseline). */
export const SYNTHETIC_OBLIQUE_SKEW = 0.25;
