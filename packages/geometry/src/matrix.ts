/**
 * 2D affine matrices in the canvas/SVG convention:
 *
 *   | a c e |     x' = a*x + c*y + e
 *   | b d f |     y' = b*x + d*y + f
 *   | 0 0 1 |
 *
 * Matrices are immutable tuples so they can be shared freely between scene
 * nodes and cached GPU data without defensive copies.
 */
export type Mat2D = readonly [a: number, b: number, c: number, d: number, e: number, f: number];

export interface Point {
  readonly x: number;
  readonly y: number;
}

export const IDENTITY: Mat2D = [1, 0, 0, 1, 0, 0];

export function translation(tx: number, ty: number): Mat2D {
  return [1, 0, 0, 1, tx, ty];
}

export function scaling(sx: number, sy: number = sx): Mat2D {
  return [sx, 0, 0, sy, 0, 0];
}

export function rotation(radians: number): Mat2D {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return [c, s, -s, c, 0, 0];
}

/** Returns `m * n`: the transform that applies `n` first, then `m`. */
export function multiply(m: Mat2D, n: Mat2D): Mat2D {
  const [a1, b1, c1, d1, e1, f1] = m;
  const [a2, b2, c2, d2, e2, f2] = n;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

export function determinant(m: Mat2D): number {
  return m[0] * m[3] - m[1] * m[2];
}

/** Inverse of `m`, or `null` when `m` is singular (or numerically so). */
export function invert(m: Mat2D): Mat2D | null {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-14) return null;
  const id = 1 / det;
  return [d * id, -b * id, -c * id, a * id, (c * f - d * e) * id, (b * e - a * f) * id];
}

export function transformPoint(m: Mat2D, x: number, y: number): Point {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/**
 * Largest singular value of the linear part: the maximum factor by which the
 * transform stretches any vector. Used to convert screen-space tolerances to
 * local space conservatively.
 */
export function maxScale(m: Mat2D): number {
  const [a, b, c, d] = m;
  // Singular values of [[a c][b d]] are sqrt of eigenvalues of M^T M.
  const p = a * a + b * b;
  const q = a * c + b * d;
  const r = c * c + d * d;
  const mean = (p + r) / 2;
  const diff = Math.sqrt(((p - r) / 2) ** 2 + q * q);
  return Math.sqrt(mean + diff);
}
