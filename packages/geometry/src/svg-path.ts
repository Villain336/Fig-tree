import { Path, Verb } from "./path";

/**
 * SVG path data (the `d` attribute), written from the SVG 2 path grammar
 * (§9.3) and the arc implementation notes (SVG 1.1 Appendix F.6):
 *
 * - every command, absolute and relative, with implicit repetition (pairs
 *   after a moveto are linetos), the reflected control points of S and T,
 *   and compact number syntax (`0.5.5`, `1e-3`, arc flags without separators);
 * - arcs converted from endpoint to center parameterization (F.6.5), radii
 *   scaled up when too small (F.6.6), zero radii drawn as lines, then split
 *   into cubics of at most 90° each, with handles `4/3·tan(θ/4)`;
 * - quadratics kept as quadratics (the `Path` stores them; vector networks
 *   elevate them to cubics exactly);
 * - errors: as the spec requires, everything up to the first error is
 *   kept, and the error is reported.
 */

export interface SvgParseResult {
  readonly path: Path;
  /** The first syntax error, if any (the path holds what came before it). */
  readonly error: string | null;
}

export function parseSvgPath(d: string): SvgParseResult {
  const path = new Path();
  const s = new Scanner(d);
  let cx = 0, cy = 0; // current point
  let sx = 0, sy = 0; // subpath start
  let lastCmd = "";
  let lastCtrlX = 0, lastCtrlY = 0; // last cubic/quad control point for S/T
  let hasPoint = false;
  try {
    s.skipSpace();
    while (!s.done()) {
      let cmd = s.command();
      if (cmd === null) {
        // Implicit repetition of the previous command.
        if (!lastCmd || lastCmd === "z" || lastCmd === "Z") throw new SyntaxError(`expected a command at ${s.pos}`);
        cmd = lastCmd === "M" ? "L" : lastCmd === "m" ? "l" : lastCmd;
      }
      if (!hasPoint && cmd !== "M" && cmd !== "m") throw new SyntaxError(`path must start with a moveto, found "${cmd}"`);
      const rel = cmd === cmd.toLowerCase();
      const ox = rel ? cx : 0, oy = rel ? cy : 0;
      switch (cmd.toUpperCase()) {
        case "M": {
          const x = s.number() + ox, y = s.number() + oy;
          path.moveTo(x, y);
          cx = sx = x;
          cy = sy = y;
          hasPoint = true;
          break;
        }
        case "L": {
          const x = s.number() + ox, y = s.number() + oy;
          path.lineTo(x, y);
          cx = x;
          cy = y;
          break;
        }
        case "H": {
          const x = s.number() + ox;
          path.lineTo(x, cy);
          cx = x;
          break;
        }
        case "V": {
          const y = s.number() + oy;
          path.lineTo(cx, y);
          cy = y;
          break;
        }
        case "C": {
          const x1 = s.number() + ox, y1 = s.number() + oy, x2 = s.number() + ox, y2 = s.number() + oy, x = s.number() + ox, y = s.number() + oy;
          path.cubicTo(x1, y1, x2, y2, x, y);
          lastCtrlX = x2;
          lastCtrlY = y2;
          cx = x;
          cy = y;
          break;
        }
        case "S": {
          const prevCubic = /^[CcSs]$/.test(lastCmd);
          const x1 = prevCubic ? 2 * cx - lastCtrlX : cx, y1 = prevCubic ? 2 * cy - lastCtrlY : cy;
          const x2 = s.number() + ox, y2 = s.number() + oy, x = s.number() + ox, y = s.number() + oy;
          path.cubicTo(x1, y1, x2, y2, x, y);
          lastCtrlX = x2;
          lastCtrlY = y2;
          cx = x;
          cy = y;
          break;
        }
        case "Q": {
          const x1 = s.number() + ox, y1 = s.number() + oy, x = s.number() + ox, y = s.number() + oy;
          path.quadTo(x1, y1, x, y);
          lastCtrlX = x1;
          lastCtrlY = y1;
          cx = x;
          cy = y;
          break;
        }
        case "T": {
          const prevQuad = /^[QqTt]$/.test(lastCmd);
          const x1 = prevQuad ? 2 * cx - lastCtrlX : cx, y1 = prevQuad ? 2 * cy - lastCtrlY : cy;
          const x = s.number() + ox, y = s.number() + oy;
          path.quadTo(x1, y1, x, y);
          lastCtrlX = x1;
          lastCtrlY = y1;
          cx = x;
          cy = y;
          break;
        }
        case "A": {
          const rx = s.number(), ry = s.number(), rot = s.number();
          const large = s.flag(), sweep = s.flag();
          const x = s.number() + ox, y = s.number() + oy;
          appendSvgArc(path, cx, cy, rx, ry, rot, large, sweep, x, y);
          cx = x;
          cy = y;
          break;
        }
        case "Z": {
          path.close();
          cx = sx;
          cy = sy;
          break;
        }
        default:
          throw new SyntaxError(`unknown command "${cmd}" at ${s.pos}`);
      }
      lastCmd = cmd;
      s.skipSpaceAndComma();
    }
  } catch (e) {
    if (e instanceof SyntaxError) return { path, error: e.message };
    throw e;
  }
  return { path, error: null };
}

class Scanner {
  pos = 0;
  constructor(private readonly src: string) {}

  done(): boolean {
    return this.pos >= this.src.length;
  }

  skipSpace(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos]!)) this.pos++;
  }

  skipSpaceAndComma(): void {
    this.skipSpace();
    if (this.src[this.pos] === ",") {
      this.pos++;
      this.skipSpace();
    }
  }

  command(): string | null {
    this.skipSpace();
    const c = this.src[this.pos];
    if (c !== undefined && /[MmLlHhVvCcSsQqTtAaZz]/.test(c)) {
      this.pos++;
      this.skipSpace();
      return c;
    }
    return null;
  }

  number(): number {
    this.skipSpaceAndComma();
    const m = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(this.src.slice(this.pos, this.pos + 64));
    if (!m) throw new SyntaxError(`expected a number at ${this.pos}`);
    this.pos += m[0].length;
    const v = Number(m[0]);
    if (!Number.isFinite(v)) throw new SyntaxError(`number out of range at ${this.pos}`);
    this.skipSpace();
    if (this.src[this.pos] === ",") this.pos++;
    return v;
  }

  flag(): boolean {
    this.skipSpaceAndComma();
    const c = this.src[this.pos];
    if (c !== "0" && c !== "1") throw new SyntaxError(`expected an arc flag at ${this.pos}`);
    this.pos++;
    this.skipSpace();
    if (this.src[this.pos] === ",") this.pos++;
    return c === "1";
  }
}

/**
 * Appends an SVG elliptical arc from (x1, y1) to (x2, y2) as cubics
 * (SVG 1.1 F.6.5 and F.6.6). The current point must be (x1, y1).
 */
export function appendSvgArc(
  path: Path,
  x1: number, y1: number,
  rxIn: number, ryIn: number, rotationDeg: number,
  largeArc: boolean, sweep: boolean,
  x2: number, y2: number,
): void {
  // F.6.2: an arc to the current point is omitted; a zero radius is a line.
  if (x1 === x2 && y1 === y2) return;
  let rx = Math.abs(rxIn), ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0) {
    path.lineTo(x2, y2);
    return;
  }
  const phi = ((rotationDeg % 360) * Math.PI) / 180;
  const cos = Math.cos(phi), sin = Math.sin(phi);
  // Step 1: (x1', y1').
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  // F.6.6: scale the radii up when no ellipse fits.
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const k = Math.sqrt(lambda);
    rx *= k;
    ry *= k;
  }
  // Step 2: (cx', cy').
  const rx2 = rx * rx, ry2 = ry * ry;
  const num = rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p;
  const den = rx2 * y1p * y1p + ry2 * x1p * x1p;
  let coef = den === 0 ? 0 : Math.sqrt(Math.max(0, num / den));
  if (largeArc === sweep) coef = -coef;
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  // Step 3: (cx, cy).
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  // Step 4: start angle and sweep.
  const ux = (x1p - cxp) / rx, uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx, vy = (-y1p - cyp) / ry;
  const theta1 = vectorAngle(1, 0, ux, uy);
  let dtheta = vectorAngle(ux, uy, vx, vy);
  if (!sweep && dtheta > 0) dtheta -= 2 * Math.PI;
  else if (sweep && dtheta < 0) dtheta += 2 * Math.PI;
  // Split into arcs of at most 90°, each one cubic.
  const n = Math.max(1, Math.ceil(Math.abs(dtheta) / (Math.PI / 2) - 1e-9));
  const step = dtheta / n;
  const k = (4 / 3) * Math.tan(step / 4);
  let a0 = theta1;
  const map = (ex: number, ey: number): [number, number] => [cos * rx * ex - sin * ry * ey + cx, sin * rx * ex + cos * ry * ey + cy];
  for (let i = 0; i < n; i++) {
    const a1 = a0 + step;
    const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
    const [p1x, p1y] = map(c0 - k * s0, s0 + k * c0);
    const [p2x, p2y] = map(c1 + k * s1, s1 - k * c1);
    // The last piece ends exactly at the requested endpoint.
    const [ex, ey] = i === n - 1 ? [x2, y2] : map(c1, s1);
    path.cubicTo(p1x, p1y, p2x, p2y, ex, ey);
    a0 = a1;
  }
}

/** Signed angle from u to v (F.6.5.4). */
function vectorAngle(ux: number, uy: number, vx: number, vy: number): number {
  return Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
}

export interface SvgFormatOptions {
  /** Decimal places; omitted, numbers are written exactly (shortest round-trip form). */
  readonly precision?: number;
}

/** Path data with absolute commands. */
export function formatSvgPath(path: Path, options: SvgFormatOptions = {}): string {
  const f = (n: number): string => formatNumber(n, options.precision);
  const parts: string[] = [];
  for (const c of path.commands()) {
    switch (c.verb) {
      case Verb.MoveTo: parts.push(`M${f(c.x)} ${f(c.y)}`); break;
      case Verb.LineTo: parts.push(`L${f(c.x)} ${f(c.y)}`); break;
      case Verb.QuadTo: parts.push(`Q${f(c.x1)} ${f(c.y1)} ${f(c.x)} ${f(c.y)}`); break;
      case Verb.CubicTo: parts.push(`C${f(c.x1)} ${f(c.y1)} ${f(c.x2)} ${f(c.y2)} ${f(c.x)} ${f(c.y)}`); break;
      case Verb.Close: parts.push("Z"); break;
    }
  }
  return parts.join("");
}

function formatNumber(n: number, precision: number | undefined): string {
  if (Object.is(n, -0)) n = 0;
  if (precision === undefined) return String(n);
  const s = n.toFixed(precision);
  // Trim trailing zeros, and the point.
  const t = s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
  return t === "-0" ? "0" : t;
}
