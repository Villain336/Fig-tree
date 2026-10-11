import type { Mat2D } from "./matrix";
import { emptyRect, includePoint, type Rect } from "./rect";

export const Verb = {
  MoveTo: 0,
  LineTo: 1,
  QuadTo: 2,
  CubicTo: 3,
  Close: 4,
} as const;
export type Verb = (typeof Verb)[keyof typeof Verb];

/** Number of coordinate pairs each verb consumes. */
const VERB_POINTS = [1, 1, 2, 3, 0] as const;

export type PathCommand =
  | { readonly verb: typeof Verb.MoveTo; readonly x: number; readonly y: number }
  | { readonly verb: typeof Verb.LineTo; readonly x: number; readonly y: number }
  | { readonly verb: typeof Verb.QuadTo; readonly x1: number; readonly y1: number; readonly x: number; readonly y: number }
  | {
      readonly verb: typeof Verb.CubicTo;
      readonly x1: number;
      readonly y1: number;
      readonly x2: number;
      readonly y2: number;
      readonly x: number;
      readonly y: number;
    }
  | { readonly verb: typeof Verb.Close };

/**
 * A 2D path made of contours of lines, quadratic and cubic Béziers.
 *
 * Storage is two packed arrays (verbs and coordinates) so paths with
 * thousands of segments stay cheap to build, copy and flatten. A drawing
 * command issued without a current contour starts one at the current point,
 * which matches the canvas behaviour after `close()`.
 */
export class Path {
  private verbData = new Uint8Array(16);
  private coordData = new Float64Array(32);
  private verbLen = 0;
  private coordLen = 0;
  private contourOpen = false;
  private startX = 0;
  private startY = 0;
  private lastX = 0;
  private lastY = 0;

  get verbCount(): number {
    return this.verbLen;
  }

  /** Packed verbs; only the first `verbCount` entries are meaningful. */
  get verbs(): Uint8Array {
    return this.verbData.subarray(0, this.verbLen);
  }

  /** Packed x,y pairs consumed by the verbs in order. */
  get coords(): Float64Array {
    return this.coordData.subarray(0, this.coordLen);
  }

  isEmpty(): boolean {
    return this.verbLen === 0;
  }

  moveTo(x: number, y: number): this {
    this.pushVerb(Verb.MoveTo);
    this.pushPoint(x, y);
    this.contourOpen = true;
    this.startX = x;
    this.startY = y;
    return this;
  }

  lineTo(x: number, y: number): this {
    this.ensureContour();
    this.pushVerb(Verb.LineTo);
    this.pushPoint(x, y);
    return this;
  }

  quadTo(x1: number, y1: number, x: number, y: number): this {
    this.ensureContour();
    this.pushVerb(Verb.QuadTo);
    this.pushPoint(x1, y1);
    this.pushPoint(x, y);
    return this;
  }

  cubicTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): this {
    this.ensureContour();
    this.pushVerb(Verb.CubicTo);
    this.pushPoint(x1, y1);
    this.pushPoint(x2, y2);
    this.pushPoint(x, y);
    return this;
  }

  close(): this {
    if (!this.contourOpen) return this;
    this.pushVerb(Verb.Close);
    this.contourOpen = false;
    this.lastX = this.startX;
    this.lastY = this.startY;
    return this;
  }

  /** Appends all contours of `other`. */
  append(other: Path): this {
    for (const cmd of other.commands()) {
      switch (cmd.verb) {
        case Verb.MoveTo: this.moveTo(cmd.x, cmd.y); break;
        case Verb.LineTo: this.lineTo(cmd.x, cmd.y); break;
        case Verb.QuadTo: this.quadTo(cmd.x1, cmd.y1, cmd.x, cmd.y); break;
        case Verb.CubicTo: this.cubicTo(cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y); break;
        case Verb.Close: this.close(); break;
      }
    }
    return this;
  }

  /** Returns a new path with every point mapped through `m`. Béziers are affine-invariant. */
  transform(m: Mat2D): Path {
    const out = new Path();
    out.verbData = this.verbData.slice(0, Math.max(16, this.verbLen));
    out.verbLen = this.verbLen;
    out.coordData = new Float64Array(Math.max(32, this.coordLen));
    out.coordLen = this.coordLen;
    const [a, b, c, d, e, f] = m;
    const src = this.coordData;
    const dst = out.coordData;
    for (let i = 0; i < this.coordLen; i += 2) {
      const x = src[i]!;
      const y = src[i + 1]!;
      dst[i] = a * x + c * y + e;
      dst[i + 1] = b * x + d * y + f;
    }
    out.contourOpen = this.contourOpen;
    const s = { x: a * this.startX + c * this.startY + e, y: b * this.startX + d * this.startY + f };
    const l = { x: a * this.lastX + c * this.lastY + e, y: b * this.lastX + d * this.lastY + f };
    out.startX = s.x;
    out.startY = s.y;
    out.lastX = l.x;
    out.lastY = l.y;
    return out;
  }

  /** Tight bounds: includes curve extrema, not just control points. */
  bounds(): Rect {
    const r = emptyRect();
    let cx = 0;
    let cy = 0;
    for (const cmd of this.commands()) {
      switch (cmd.verb) {
        case Verb.MoveTo:
        case Verb.LineTo:
          includePoint(r, cmd.x, cmd.y);
          cx = cmd.x;
          cy = cmd.y;
          break;
        case Verb.QuadTo:
          includeQuadExtrema(r, cx, cy, cmd.x1, cmd.y1, cmd.x, cmd.y);
          cx = cmd.x;
          cy = cmd.y;
          break;
        case Verb.CubicTo:
          includeCubicExtrema(r, cx, cy, cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y);
          cx = cmd.x;
          cy = cmd.y;
          break;
        case Verb.Close:
          break;
      }
    }
    return r;
  }

  *commands(): IterableIterator<PathCommand> {
    const c = this.coordData;
    let k = 0;
    for (let i = 0; i < this.verbLen; i++) {
      const verb = this.verbData[i] as Verb;
      switch (verb) {
        case Verb.MoveTo:
          yield { verb, x: c[k]!, y: c[k + 1]! };
          break;
        case Verb.LineTo:
          yield { verb, x: c[k]!, y: c[k + 1]! };
          break;
        case Verb.QuadTo:
          yield { verb, x1: c[k]!, y1: c[k + 1]!, x: c[k + 2]!, y: c[k + 3]! };
          break;
        case Verb.CubicTo:
          yield { verb, x1: c[k]!, y1: c[k + 1]!, x2: c[k + 2]!, y2: c[k + 3]!, x: c[k + 4]!, y: c[k + 5]! };
          break;
        case Verb.Close:
          yield { verb };
          break;
      }
      k += VERB_POINTS[verb] * 2;
    }
  }

  private ensureContour(): void {
    if (!this.contourOpen) this.moveTo(this.lastX, this.lastY);
  }

  private pushVerb(v: Verb): void {
    if (this.verbLen === this.verbData.length) {
      const next = new Uint8Array(this.verbData.length * 2);
      next.set(this.verbData);
      this.verbData = next;
    }
    this.verbData[this.verbLen++] = v;
  }

  private pushPoint(x: number, y: number): void {
    if (this.coordLen + 2 > this.coordData.length) {
      const next = new Float64Array(this.coordData.length * 2);
      next.set(this.coordData);
      this.coordData = next;
    }
    this.coordData[this.coordLen++] = x;
    this.coordData[this.coordLen++] = y;
    this.lastX = x;
    this.lastY = y;
  }
}

function includeQuadExtrema(r: Rect, x0: number, y0: number, x1: number, y1: number, x2: number, y2: number): void {
  includePoint(r, x2, y2);
  // B'(t) = 0  =>  t = (p0 - p1) / (p0 - 2p1 + p2), per axis.
  const tx = solveQuadExtremum(x0, x1, x2);
  const ty = solveQuadExtremum(y0, y1, y2);
  for (const t of [tx, ty]) {
    if (t === null) continue;
    const mt = 1 - t;
    includePoint(r, mt * mt * x0 + 2 * mt * t * x1 + t * t * x2, mt * mt * y0 + 2 * mt * t * y1 + t * t * y2);
  }
}

function solveQuadExtremum(p0: number, p1: number, p2: number): number | null {
  const denom = p0 - 2 * p1 + p2;
  if (denom === 0) return null;
  const t = (p0 - p1) / denom;
  return t > 0 && t < 1 ? t : null;
}

function includeCubicExtrema(
  r: Rect,
  x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number,
): void {
  includePoint(r, x3, y3);
  const ts: number[] = [];
  cubicExtrema(x0, x1, x2, x3, ts);
  cubicExtrema(y0, y1, y2, y3, ts);
  for (const t of ts) {
    const mt = 1 - t;
    const w0 = mt * mt * mt, w1 = 3 * mt * mt * t, w2 = 3 * mt * t * t, w3 = t * t * t;
    includePoint(r, w0 * x0 + w1 * x1 + w2 * x2 + w3 * x3, w0 * y0 + w1 * y1 + w2 * y2 + w3 * y3);
  }
}

/** Roots in (0,1) of the derivative of a 1D cubic Bézier. */
function cubicExtrema(p0: number, p1: number, p2: number, p3: number, out: number[]): void {
  // B'(t)/3 = a t^2 + b t + c
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const push = (t: number): void => {
    if (t > 0 && t < 1) out.push(t);
  };
  if (Math.abs(a) < 1e-12) {
    if (b !== 0) push(-c / b);
    return;
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return;
  const sq = Math.sqrt(disc);
  // Numerically stable quadratic roots.
  const q = -0.5 * (b + (b < 0 ? -sq : sq));
  push(q / a);
  if (q !== 0) push(c / q);
}
