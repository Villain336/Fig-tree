import { flattenPath, PolylineBuilder, transformPolylines, type Polylines } from "./flatten";
import { IDENTITY, maxScale, type Mat2D } from "./matrix";
import type { Path } from "./path";

export type LineJoin = "miter" | "round" | "bevel";
export type LineCap = "butt" | "round" | "square";

export interface StrokeStyle {
  readonly width: number;
  /** Defaults to `"miter"`. */
  readonly join?: LineJoin;
  /** Defaults to `"butt"`. */
  readonly cap?: LineCap;
  /** Ratio of miter length to stroke width beyond which miters become bevels. Defaults to 4. */
  readonly miterLimit?: number;
  /** Alternating on/off lengths in local units. Odd-length patterns repeat twice, as in SVG. */
  readonly dash?: readonly number[];
  readonly dashOffset?: number;
}

/**
 * Converts the outline of `path` stroked with `style` into closed polygons
 * that render correctly with the nonzero fill rule.
 *
 * Stroking happens in the path's local space (so non-uniform transforms
 * distort the pen exactly like canvas/SVG), then the polygons are mapped by
 * `transform`. `tolerance` is the maximum geometric error in output units.
 */
export function strokePath(path: Path, style: StrokeStyle, transform: Mat2D = IDENTITY, tolerance = 0.25): Polylines {
  const scale = maxScale(transform);
  if (!(scale > 0) || !(style.width > 0)) return new PolylineBuilder().finish();
  const localTolerance = tolerance / scale;
  let lines = flattenPath(path, IDENTITY, localTolerance);
  if (style.dash && style.dash.length > 0) lines = dashPolylines(lines, style.dash, style.dashOffset ?? 0);
  const outline = strokePolylines(lines, style, localTolerance);
  return transformPolylines(outline, transform);
}

/** Strokes already-flattened polylines. See {@link strokePath}. */
export function strokePolylines(lines: Polylines, style: StrokeStyle, tolerance: number): Polylines {
  const out = new PolylineBuilder();
  const h = style.width / 2;
  if (!(h > 0)) return out.finish();
  const stroker = new Stroker(out, h, style.join ?? "miter", style.cap ?? "butt", style.miterLimit ?? 4, tolerance);
  const pts = lines.points;
  for (let c = 0; c + 1 < lines.contourStarts.length; c++) {
    const start = lines.contourStarts[c]!;
    const end = lines.contourStarts[c + 1]!;
    if (end <= start) continue;
    const xs: number[] = [];
    const ys: number[] = [];
    // Drop near-duplicate points: their direction is numerically meaningless.
    const eps = tolerance * 1e-3;
    for (let i = start; i < end; i++) {
      const x = pts[i * 2]!;
      const y = pts[i * 2 + 1]!;
      const n = xs.length;
      if (n > 0 && Math.abs(x - xs[n - 1]!) <= eps && Math.abs(y - ys[n - 1]!) <= eps) continue;
      xs.push(x);
      ys.push(y);
    }
    const closed = lines.closed[c] === 1;
    if (closed && xs.length > 1) {
      const n = xs.length;
      if (Math.abs(xs[0]! - xs[n - 1]!) <= eps && Math.abs(ys[0]! - ys[n - 1]!) <= eps) {
        xs.pop();
        ys.pop();
      }
    }
    if (xs.length === 1) stroker.dot(xs[0]!, ys[0]!);
    else if (closed) stroker.closedContour(xs, ys);
    else stroker.openContour(xs, ys);
  }
  return out.finish();
}

class Stroker {
  /** Angular step for round joins/caps so chord error stays within tolerance. */
  private readonly arcStep: number;

  constructor(
    private readonly out: PolylineBuilder,
    private readonly h: number,
    private readonly join: LineJoin,
    private readonly cap: LineCap,
    private readonly miterLimit: number,
    tolerance: number,
  ) {
    const c = 1 - tolerance / h;
    this.arcStep = c <= 0 ? Math.PI / 2 : Math.min(Math.PI / 2, 2 * Math.acos(c));
  }

  dot(x: number, y: number): void {
    const h = this.h;
    if (this.cap === "round") {
      this.out.beginContour();
      this.arc(x, y, 0, 2 * Math.PI, true);
      this.out.markClosed();
    } else if (this.cap === "square") {
      this.out.beginContour();
      this.out.push(x - h, y - h);
      this.out.push(x + h, y - h);
      this.out.push(x + h, y + h);
      this.out.push(x - h, y + h);
      this.out.markClosed();
    }
  }

  openContour(xs: number[], ys: number[], butt = false): void {
    const n = xs.length;
    const { dx, dy, len } = directions(xs, ys, false);
    const h = this.h;
    const out = this.out;
    out.beginContour();
    out.push(xs[0]! - dy[0]! * h, ys[0]! + dx[0]! * h);
    for (let i = 1; i < n - 1; i++) {
      this.joinLeft(xs[i]!, ys[i]!, dx[i - 1]!, dy[i - 1]!, dx[i]!, dy[i]!, len[i - 1]!, len[i]!);
    }
    const ex = xs[n - 1]!, ey = ys[n - 1]!, edx = dx[n - 2]!, edy = dy[n - 2]!;
    out.push(ex - edy * h, ey + edx * h);
    if (!butt) this.capInterior(ex, ey, edx, edy);
    out.push(ex + edy * h, ey - edx * h);
    for (let i = n - 2; i >= 1; i--) {
      this.joinLeft(xs[i]!, ys[i]!, -dx[i]!, -dy[i]!, -dx[i - 1]!, -dy[i - 1]!, len[i]!, len[i - 1]!);
    }
    out.push(xs[0]! + dy[0]! * h, ys[0]! - dx[0]! * h);
    if (!butt) this.capInterior(xs[0]!, ys[0]!, -dx[0]!, -dy[0]!);
    out.markClosed();
  }

  closedContour(xs: number[], ys: number[]): void {
    const n = xs.length;
    const { dx, dy, len } = directions(xs, ys, true);
    if (this.innerSideCollapses(dx, dy, len)) {
      this.closedContourPieces(xs, ys);
      return;
    }
    const out = this.out;
    out.beginContour();
    for (let i = 0; i < n; i++) {
      const p = (i + n - 1) % n;
      this.joinLeft(xs[i]!, ys[i]!, dx[p]!, dy[p]!, dx[i]!, dy[i]!, len[p]!, len[i]!);
    }
    out.markClosed();
    // The other side, traversed backwards so both loops wind the same way.
    out.beginContour();
    for (let i = n - 1; i >= 0; i--) {
      const p = (i + n - 1) % n;
      this.joinLeft(xs[i]!, ys[i]!, -dx[i]!, -dy[i]!, -dx[p]!, -dy[p]!, len[i]!, len[p]!);
    }
    out.markClosed();
  }

  /**
   * Whether the stroke is wider than the contour on the inner side of some
   * corner (the offset lines meet beyond an adjacent segment). Then the
   * inner loop of the two-loop construction turns inside out and cancels
   * the outer one under the nonzero rule, leaving holes in pixels the
   * stroke covers.
   */
  private innerSideCollapses(dx: Float64Array, dy: Float64Array, len: Float64Array): boolean {
    const n = dx.length;
    // How far the inner offset of each corner reaches along its segments, per side.
    const left = new Float64Array(n), right = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const p = (i + n - 1) % n;
      const cross = dx[p]! * dy[i]! - dy[p]! * dx[i]!;
      const denom = 1 + dx[p]! * dx[i]! + dy[p]! * dy[i]!;
      if (Math.abs(cross) < 1e-12) continue;
      const along = denom > 1e-9 ? (this.h * Math.abs(cross)) / denom : Infinity;
      left[i] = cross > 0 ? along : 0;
      right[i] = cross < 0 ? along : 0;
    }
    // A segment's offset on one side inverts when the corners at its two ends eat more than its length.
    for (let i = 0; i < n; i++) {
      const q = (i + 1) % n;
      if (left[i]! + left[q]! > len[i]! || right[i]! + right[q]! > len[i]!) return true;
    }
    return false;
  }

  /**
   * A closed contour stroked as overlapping open pieces, one per vertex
   * (from the middle of the incoming segment, through the vertex's join, to
   * the middle of the outgoing one, with butt ends). Every piece winds the
   * same way, so their union is right under the nonzero rule however wide
   * the stroke, and neighbouring butt ends cancel exactly.
   */
  private closedContourPieces(xs: number[], ys: number[]): void {
    const n = xs.length;
    for (let i = 0; i < n; i++) {
      const p = (i + n - 1) % n, q = (i + 1) % n;
      this.openContour(
        [(xs[p]! + xs[i]!) / 2, xs[i]!, (xs[i]! + xs[q]!) / 2],
        [(ys[p]! + ys[i]!) / 2, ys[i]!, (ys[i]! + ys[q]!) / 2],
        true,
      );
    }
  }

  /**
   * Emits the join at vertex (x, y) on the left side of travel, between the
   * incoming direction d0 and the outgoing direction d1 (both unit vectors).
   * The left normal of d is (-dy, dx).
   */
  private joinLeft(
    x: number, y: number,
    d0x: number, d0y: number, d1x: number, d1y: number,
    len0: number, len1: number,
  ): void {
    const h = this.h;
    const out = this.out;
    const n0x = -d0y, n0y = d0x, n1x = -d1y, n1y = d1x;
    const cross = d0x * d1y - d0y * d1x;
    const dot = d0x * d1x + d0y * d1y;
    if (Math.abs(cross) < 1e-12 && dot > 0) {
      out.push(x + n0x * h, y + n0y * h);
      return;
    }
    // Miter point: intersection of the two offset lines.
    const denom = 1 + dot;
    const miterValid = denom > 1e-9;
    const mx = miterValid ? x + ((n0x + n1x) * h) / denom : 0;
    const my = miterValid ? y + ((n0y + n1y) * h) / denom : 0;
    if (cross > 0) {
      // Inner side. Use the offset-line intersection when it lies on both
      // segments; otherwise route through the vertex so the winding stays
      // positive (the loop is covered by the stroke body under nonzero).
      const along = miterValid ? (h * Math.abs(cross)) / denom : Infinity;
      if (along <= len0 && along <= len1) {
        out.push(mx, my);
      } else {
        out.push(x + n0x * h, y + n0y * h);
        out.push(x, y);
        out.push(x + n1x * h, y + n1y * h);
      }
      return;
    }
    switch (this.join) {
      case "miter":
        if (miterValid && Math.sqrt(2 / denom) <= this.miterLimit) {
          out.push(mx, my);
          return;
        }
        out.push(x + n0x * h, y + n0y * h);
        out.push(x + n1x * h, y + n1y * h);
        return;
      case "bevel":
        out.push(x + n0x * h, y + n0y * h);
        out.push(x + n1x * h, y + n1y * h);
        return;
      case "round": {
        const a0 = Math.atan2(n0y, n0x);
        let sweep = Math.atan2(n1y, n1x) - a0;
        // Outer side of a right turn sweeps clockwise (negative angle).
        if (sweep > 0) sweep -= 2 * Math.PI;
        out.push(x + n0x * h, y + n0y * h);
        this.arc(x, y, a0, sweep, false);
        out.push(x + n1x * h, y + n1y * h);
        return;
      }
    }
  }

  /**
   * Emits the cap points strictly between p + h·n(d) and p − h·n(d), where d
   * is the direction pointing out of the stroke end.
   */
  private capInterior(x: number, y: number, dx: number, dy: number): void {
    const h = this.h;
    const nx = -dy, ny = dx;
    if (this.cap === "square") {
      this.out.push(x + (nx + dx) * h, y + (ny + dy) * h);
      this.out.push(x + (-nx + dx) * h, y + (-ny + dy) * h);
    } else if (this.cap === "round") {
      this.arc(x, y, Math.atan2(ny, nx), -Math.PI, false);
    }
  }

  /** Arc points around (cx, cy) at radius h; endpoints are emitted only when `inclusive`. */
  private arc(cx: number, cy: number, start: number, sweep: number, inclusive: boolean): void {
    const steps = Math.max(1, Math.ceil(Math.abs(sweep) / this.arcStep));
    const h = this.h;
    for (let i = inclusive ? 0 : 1; i < steps; i++) {
      const a = start + (sweep * i) / steps;
      this.out.push(cx + Math.cos(a) * h, cy + Math.sin(a) * h);
    }
  }
}

function directions(xs: number[], ys: number[], closed: boolean): { dx: Float64Array; dy: Float64Array; len: Float64Array } {
  const n = xs.length;
  const count = closed ? n : n - 1;
  const dx = new Float64Array(count);
  const dy = new Float64Array(count);
  const len = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % n;
    const vx = xs[j]! - xs[i]!;
    const vy = ys[j]! - ys[i]!;
    const l = Math.hypot(vx, vy);
    len[i] = l;
    dx[i] = vx / l;
    dy[i] = vy / l;
  }
  return { dx, dy, len };
}

/**
 * Splits polylines into open dash polylines following an SVG-style dash
 * pattern. Invalid patterns (negative, non-finite or all-zero) leave the
 * input unchanged. On closed contours a dash running through the start point
 * is joined with the first dash so the corner gets a join rather than caps.
 */
export function dashPolylines(lines: Polylines, dash: readonly number[], offset = 0): Polylines {
  const pattern = dash.length % 2 === 1 ? [...dash, ...dash] : [...dash];
  const total = pattern.reduce((s, v) => s + v, 0);
  if (pattern.some((v) => !(v >= 0) || !Number.isFinite(v)) || !(total > 0)) return lines;
  const out = new PolylineBuilder();
  const pts = lines.points;
  for (let c = 0; c + 1 < lines.contourStarts.length; c++) {
    const start = lines.contourStarts[c]!;
    const end = lines.contourStarts[c + 1]!;
    if (end - start < 2) continue;
    const closed = lines.closed[c] === 1;
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = start; i < end; i++) {
      xs.push(pts[i * 2]!);
      ys.push(pts[i * 2 + 1]!);
    }
    if (closed) {
      xs.push(xs[0]!);
      ys.push(ys[0]!);
    }
    dashContour(xs, ys, closed, pattern, total, offset, out);
  }
  return out.finish();
}

function dashContour(
  xs: number[], ys: number[], closed: boolean,
  pattern: number[], total: number, offset: number,
  out: PolylineBuilder,
): void {
  let phase = ((offset % total) + total) % total;
  let index = 0;
  while (phase >= pattern[index]! && phase > 0) {
    phase -= pattern[index]!;
    index = (index + 1) % pattern.length;
  }
  let remaining = pattern[index]! - phase;
  let on = index % 2 === 0;
  const dashes: { xs: number[]; ys: number[] }[] = [];
  let current: { xs: number[]; ys: number[] } | null = null;
  const startsOn = on;
  let toggled = false;
  if (on) {
    current = { xs: [xs[0]!], ys: [ys[0]!] };
  }
  for (let i = 0; i + 1 < xs.length; i++) {
    const ax = xs[i]!, ay = ys[i]!, bx = xs[i + 1]!, by = ys[i + 1]!;
    const segLen = Math.hypot(bx - ax, by - ay);
    let t = 0;
    while (segLen - t > remaining) {
      t += remaining;
      const u = segLen > 0 ? t / segLen : 0;
      const px = ax + (bx - ax) * u;
      const py = ay + (by - ay) * u;
      if (on) {
        current!.xs.push(px);
        current!.ys.push(py);
        dashes.push(current!);
        current = null;
      } else {
        current = { xs: [px], ys: [py] };
      }
      on = !on;
      toggled = true;
      index = (index + 1) % pattern.length;
      remaining = pattern[index]!;
    }
    remaining -= segLen - t;
    if (on) {
      current!.xs.push(bx);
      current!.ys.push(by);
    }
  }
  if (closed && !toggled && startsOn) {
    // The whole contour is one dash: keep it closed so it gets a join, not caps.
    out.beginContour();
    for (let i = 0; i + 1 < xs.length; i++) out.push(xs[i]!, ys[i]!);
    out.markClosed();
    return;
  }
  if (current) {
    if (closed && startsOn && dashes.length > 0) {
      const first = dashes.shift()!;
      for (let i = 1; i < first.xs.length; i++) {
        current.xs.push(first.xs[i]!);
        current.ys.push(first.ys[i]!);
      }
    }
    dashes.push(current);
  }
  for (const d of dashes) {
    out.beginContour();
    for (let i = 0; i < d.xs.length; i++) out.push(d.xs[i]!, d.ys[i]!);
  }
}
