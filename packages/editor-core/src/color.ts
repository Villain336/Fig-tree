import type { Color } from "@fig-tree/document";

/** Color conversions for the color picker. All channels in [0, 1]; hue in degrees. */

export interface Hsv {
  readonly h: number;
  readonly s: number;
  readonly v: number;
}

export interface Hsl {
  readonly h: number;
  readonly s: number;
  readonly l: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** `#RRGGBB` (alpha omitted when 1, else `#RRGGBBAA`), uppercase. */
export function toHex(c: Color, withAlpha = false): string {
  const h = (v: number): string => Math.round(clamp01(v) * 255).toString(16).padStart(2, "0");
  const base = `${h(c.r)}${h(c.g)}${h(c.b)}`.toUpperCase();
  return withAlpha && c.a < 1 ? `${base}${h(c.a).toUpperCase()}` : base;
}

/**
 * Parses hex colors as typed into a field: `#RGB`, `RGB`, `RRGGBB`,
 * `RRGGBBAA`, `#RGBA`, and a single repeated digit or pair (`F` → `FFFFFF`,
 * `3A` → `3A3A3A`). Returns null when the text is not a color.
 */
export function parseHex(input: string, alpha = 1): Color | null {
  let s = input.trim().replace(/^#/, "");
  if (!/^[0-9a-f]+$/i.test(s)) return null;
  if (s.length === 1) s = s.repeat(6);
  else if (s.length === 2) s = s.repeat(3);
  else if (s.length === 3 || s.length === 4) s = [...s].map((ch) => ch + ch).join("");
  if (s.length !== 6 && s.length !== 8) return null;
  const n = (i: number): number => parseInt(s.slice(i, i + 2), 16) / 255;
  return { r: n(0), g: n(2), b: n(4), a: s.length === 8 ? n(6) : alpha };
}

export function rgbToHsv(c: Color): Hsv {
  const max = Math.max(c.r, c.g, c.b);
  const min = Math.min(c.r, c.g, c.b);
  const d = max - min;
  return { h: hue(c, max, d), s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToRgb(hsv: Hsv, a = 1): Color {
  const h = (((hsv.h % 360) + 360) % 360) / 60;
  const c = hsv.v * hsv.s;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = hsv.v - c;
  const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  return { r: clamp01(r + m), g: clamp01(g + m), b: clamp01(b + m), a };
}

export function rgbToHsl(c: Color): Hsl {
  const max = Math.max(c.r, c.g, c.b);
  const min = Math.min(c.r, c.g, c.b);
  const d = max - min;
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { h: hue(c, max, d), s: clamp01(s), l };
}

export function hslToRgb(hsl: Hsl, a = 1): Color {
  const c = (1 - Math.abs(2 * hsl.l - 1)) * hsl.s;
  const v = hsl.l + c / 2;
  return hsvToRgb({ h: hsl.h, s: v === 0 ? 0 : (2 * (v - hsl.l)) / v, v }, a);
}

function hue(c: Color, max: number, d: number): number {
  if (d === 0) return 0;
  let h: number;
  if (max === c.r) h = ((c.g - c.b) / d) % 6;
  else if (max === c.g) h = (c.b - c.r) / d + 2;
  else h = (c.r - c.g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

/** CSS color string for previews (premultiplication is the browser's business). */
export function cssColor(c: Color, opacity = 1): string {
  const to = (v: number): number => Math.round(clamp01(v) * 255);
  return `rgba(${to(c.r)}, ${to(c.g)}, ${to(c.b)}, ${Math.round(clamp01(c.a * opacity) * 1000) / 1000})`;
}

/** Linear interpolation of two colors in sRGB (the gradient math the renderer uses). */
export function mixColors(a: Color, b: Color, t: number): Color {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: a.a + (b.a - a.a) * t };
}

export function sameColor(a: Color, b: Color): boolean {
  return Math.abs(a.r - b.r) < 1e-6 && Math.abs(a.g - b.g) < 1e-6 && Math.abs(a.b - b.b) < 1e-6 && Math.abs(a.a - b.a) < 1e-6;
}
