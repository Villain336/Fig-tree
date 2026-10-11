import { IDENTITY, type Mat2D } from "./matrix";
import { Verb, type Path } from "./path";

/**
 * Flattened contours. Contour `i` owns points `[contourStarts[i], contourStarts[i+1])`
 * (point indices; coordinates are interleaved x,y in `points`).
 */
export interface Polylines {
  readonly points: Float64Array;
  readonly contourStarts: Uint32Array;
  /** 1 when the contour was explicitly closed (matters for stroking; fills always close). */
  readonly closed: Uint8Array;
}

/** Upper bound on subdivisions of a single curve, guarding against absurd zoom levels. */
const MAX_CURVE_SEGMENTS = 4096;

/** Growable builder for {@link Polylines}. */
export class PolylineBuilder {
  private pts = new Float64Array(64);
  private len = 0;
  private starts: number[] = [];
  private closedFlags: number[] = [];

  get pointCount(): number {
    return this.len >> 1;
  }

  beginContour(): void {
    this.starts.push(this.pointCount);
    this.closedFlags.push(0);
  }

  markClosed(): void {
    if (this.closedFlags.length > 0) this.closedFlags[this.closedFlags.length - 1] = 1;
  }

  push(x: number, y: number): void {
    if (this.len + 2 > this.pts.length) {
      const next = new Float64Array(this.pts.length * 2);
      next.set(this.pts);
      this.pts = next;
    }
    this.pts[this.len++] = x;
    this.pts[this.len++] = y;
  }

  finish(): Polylines {
    const starts = new Uint32Array(this.starts.length + 1);
    starts.set(this.starts);
    starts[this.starts.length] = this.pointCount;
    return {
      points: this.pts.slice(0, this.len),
      contourStarts: starts,
      closed: Uint8Array.from(this.closedFlags),
    };
  }
}

/**
 * Number of uniform parameter steps that keep a Bézier of `degree` within
 * `tolerance` of its chords (Wang's formula). `dd` is the largest second
 * difference of the control polygon.
 */
export function wangSegmentCount(degree: 2 | 3, dd: number, tolerance: number): number {
  const k = degree === 2 ? 0.25 : 0.75; // n(n-1)/8
  const n = Math.ceil(Math.sqrt((k * dd) / tolerance));
  return Math.min(MAX_CURVE_SEGMENTS, Math.max(1, n));
}

/**
 * Flattens `path` (after applying `transform`) to polylines whose maximum
 * deviation from the true curves is at most `tolerance`, in output units.
 *
 * Callers pass a screen-space tolerance divided by the view scale, so the
 * error bound holds in device pixels. Segment counts are chosen per curve,
 * so tight curves receive more segments than gentle ones.
 */
export function flattenPath(path: Path, transform: Mat2D = IDENTITY, tolerance = 0.25): Polylines {
  if (!(tolerance > 0)) throw new RangeError(`flatten tolerance must be > 0, got ${tolerance}`);
  const out = new PolylineBuilder();
  const [a, b, c, d, e, f] = transform;
  const verbs = path.verbs;
  const coords = path.coords;
  let k = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < verbs.length; i++) {
    const verb = verbs[i] as Verb;
    switch (verb) {
      case Verb.MoveTo: {
        cx = a * coords[k]! + c * coords[k + 1]! + e;
        cy = b * coords[k]! + d * coords[k + 1]! + f;
        k += 2;
        out.beginContour();
        out.push(cx, cy);
        break;
      }
      case Verb.LineTo: {
        cx = a * coords[k]! + c * coords[k + 1]! + e;
        cy = b * coords[k]! + d * coords[k + 1]! + f;
        k += 2;
        out.push(cx, cy);
        break;
      }
      case Verb.QuadTo: {
        const x1 = a * coords[k]! + c * coords[k + 1]! + e;
        const y1 = b * coords[k]! + d * coords[k + 1]! + f;
        const x2 = a * coords[k + 2]! + c * coords[k + 3]! + e;
        const y2 = b * coords[k + 2]! + d * coords[k + 3]! + f;
        k += 4;
        flattenQuad(out, cx, cy, x1, y1, x2, y2, tolerance);
        cx = x2;
        cy = y2;
        break;
      }
      case Verb.CubicTo: {
        const x1 = a * coords[k]! + c * coords[k + 1]! + e;
        const y1 = b * coords[k]! + d * coords[k + 1]! + f;
        const x2 = a * coords[k + 2]! + c * coords[k + 3]! + e;
        const y2 = b * coords[k + 2]! + d * coords[k + 3]! + f;
        const x3 = a * coords[k + 4]! + c * coords[k + 5]! + e;
        const y3 = b * coords[k + 4]! + d * coords[k + 5]! + f;
        k += 6;
        flattenCubic(out, cx, cy, x1, y1, x2, y2, x3, y3, tolerance);
        cx = x3;
        cy = y3;
        break;
      }
      case Verb.Close:
        out.markClosed();
        break;
    }
  }
  return out.finish();
}

function flattenQuad(
  out: PolylineBuilder,
  x0: number, y0: number, x1: number, y1: number, x2: number, y2: number,
  tolerance: number,
): void {
  const dd = Math.hypot(x0 - 2 * x1 + x2, y0 - 2 * y1 + y2);
  const n = wangSegmentCount(2, dd, tolerance);
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const mt = 1 - t;
    out.push(mt * mt * x0 + 2 * mt * t * x1 + t * t * x2, mt * mt * y0 + 2 * mt * t * y1 + t * t * y2);
  }
  out.push(x2, y2);
}

function flattenCubic(
  out: PolylineBuilder,
  x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number,
  tolerance: number,
): void {
  const dd = Math.max(
    Math.hypot(x0 - 2 * x1 + x2, y0 - 2 * y1 + y2),
    Math.hypot(x1 - 2 * x2 + x3, y1 - 2 * y2 + y3),
  );
  const n = wangSegmentCount(3, dd, tolerance);
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const mt = 1 - t;
    const w0 = mt * mt * mt, w1 = 3 * mt * mt * t, w2 = 3 * mt * t * t, w3 = t * t * t;
    out.push(w0 * x0 + w1 * x1 + w2 * x2 + w3 * x3, w0 * y0 + w1 * y1 + w2 * y2 + w3 * y3);
  }
  out.push(x3, y3);
}

/** Maps every point of `p` through `m` (used after stroking in local space). */
export function transformPolylines(p: Polylines, m: Mat2D): Polylines {
  const [a, b, c, d, e, f] = m;
  const src = p.points;
  const pts = new Float64Array(src.length);
  for (let i = 0; i < src.length; i += 2) {
    const x = src[i]!;
    const y = src[i + 1]!;
    pts[i] = a * x + c * y + e;
    pts[i + 1] = b * x + d * y + f;
  }
  return { points: pts, contourStarts: p.contourStarts, closed: p.closed };
}

/**
 * Winding number of the closed polylines around (x, y). Every contour is
 * treated as closed, as for filling.
 */
export function windingNumber(p: Polylines, x: number, y: number): number {
  let w = 0;
  const pts = p.points;
  for (let ci = 0; ci + 1 < p.contourStarts.length; ci++) {
    const s = p.contourStarts[ci]!;
    const end = p.contourStarts[ci + 1]!;
    if (end - s < 2) continue;
    let px = pts[(end - 1) * 2]!;
    let py = pts[(end - 1) * 2 + 1]!;
    for (let i = s; i < end; i++) {
      const qx = pts[i * 2]!;
      const qy = pts[i * 2 + 1]!;
      if (py <= y) {
        if (qy > y && (qx - px) * (y - py) - (x - px) * (qy - py) > 0) w++;
      } else if (qy <= y && (qx - px) * (y - py) - (x - px) * (qy - py) < 0) {
        w--;
      }
      px = qx;
      py = qy;
    }
  }
  return w;
}

export type FillRule = "nonzero" | "evenodd";

export function containsPoint(p: Polylines, x: number, y: number, rule: FillRule): boolean {
  const w = windingNumber(p, x, y);
  return rule === "nonzero" ? w !== 0 : (w & 1) === 1;
}
