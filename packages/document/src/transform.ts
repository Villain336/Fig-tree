import { IDENTITY, multiply, invert, type Mat2D } from "@fig-tree/geometry";

/** The box placement properties that make up a node's local transform. */
export interface BoxTransform {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly rotation: number;
  readonly flipX: boolean;
  readonly flipY: boolean;
}

const DEG = Math.PI / 180;

/**
 * Local-to-parent matrix of a box: CSS `left`/`top` translation, then
 * `rotate(rotation) scale(±1, ±1)` about the box center
 * (`transform-origin: center`).
 */
export function boxMatrix(b: BoxTransform): Mat2D {
  const cx = b.width / 2;
  const cy = b.height / 2;
  if (b.rotation === 0 && !b.flipX && !b.flipY) return [1, 0, 0, 1, b.x, b.y];
  const c = Math.cos(b.rotation * DEG);
  const s = Math.sin(b.rotation * DEG);
  const fx = b.flipX ? -1 : 1;
  const fy = b.flipY ? -1 : 1;
  // R · F
  const a = c * fx, bb = s * fx, cc = -s * fy, d = c * fy;
  // T(x + cx, y + cy) · R·F · T(-cx, -cy)
  return [a, bb, cc, d, b.x + cx - (a * cx + cc * cy), b.y + cy - (bb * cx + d * cy)];
}

/**
 * Inverse of {@link boxMatrix}: the x, y, rotation and flips that place a box
 * of the given size at `m`, which must be a rotation, optional reflection
 * and translation. The box keeps its own flips when the reflection allows.
 */
export function boxFromMatrix(m: Mat2D, width: number, height: number, flipX: boolean, flipY: boolean): BoxTransform {
  let fx = flipX ? -1 : 1;
  let fy = flipY ? -1 : 1;
  const det = m[0] * m[3] - m[1] * m[2];
  // A reflection in m that the box's own flips do not account for toggles flipX.
  if (Math.sign(det) !== fx * fy) fx = -fx;
  // R = A · F⁻¹ (F is diagonal ±1, its own inverse): first column of R is (m0·fx, m1·fx).
  const rotation = normalizeDegrees(Math.atan2(m[1] * fx, m[0] * fx) / DEG);
  const cx = width / 2;
  const cy = height / 2;
  const centerX = m[0] * cx + m[2] * cy + m[4];
  const centerY = m[1] * cx + m[3] * cy + m[5];
  return { x: clean(centerX - cx), y: clean(centerY - cy), width, height, rotation, flipX: fx < 0, flipY: fy < 0 };
}

/** Maps degrees to (-180, 180], rounding away float noise near whole degrees. */
export function normalizeDegrees(deg: number): number {
  let r = deg % 360;
  if (r <= -180) r += 360;
  if (r > 180) r -= 360;
  return clean(r);
}

function clean(v: number): number {
  const rounded = Math.round(v * 1e9) / 1e9;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export { IDENTITY, invert, multiply };
