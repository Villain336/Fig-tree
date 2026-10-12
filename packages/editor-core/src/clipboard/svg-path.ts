import type { Mat2D, Point } from "@fig-tree/geometry";
import type { VectorNetwork } from "@fig-tree/document";
import { transformPoint } from "../math";

/**
 * SVG path data to cubic Bézier subpaths (absolute coordinates), and
 * subpaths to a vector network. Lines become cubics with zero tangents,
 * quadratics are degree-elevated, and elliptical arcs are approximated by
 * cubics of at most 90° each (SVG 1.1 implementation notes F.6).
 */

export interface Cubic {
  readonly p0: Point;
  readonly c1: Point;
  readonly c2: Point;
  readonly p1: Point;
  /** A straight segment (its controls lie on the chord). */
  readonly line: boolean;
}

export interface Subpath {
  readonly start: Point;
  readonly segments: Cubic[];
  closed: boolean;
}

export class PathDataError extends Error {}

const ARGS: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };

function tokenize(d: string): (string | number)[] {
  const out: (string | number)[] = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)|([\s,]+)|(.)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d))) {
    if (m[1]) out.push(m[1]);
    else if (m[2]) out.push(Number(m[2]));
    else if (m[4]) throw new PathDataError(`unexpected "${m[4]}" in path data`);
  }
  return out;
}

/** Parses path data. Arc flags written without separators ("a1 1 0 011 1") are handled. */
export function parsePathData(d: string): Subpath[] {
  const tokens = tokenize(d.replace(/([aA])((?:[^MmLlHhVvCcSsQqTtZzAa])*)/g, (_m, cmd: string, rest: string) => cmd + splitArcFlags(rest)));
  const subpaths: Subpath[] = [];
  let cur: Subpath | null = null;
  let p: Point = { x: 0, y: 0 };
  let start: Point = { x: 0, y: 0 };
  let lastCtrl = null as Point | null;
  let lastCmd = "";
  let i = 0;
  const num = (): number => {
    const t = tokens[i++];
    if (typeof t !== "number") throw new PathDataError("expected a number in path data");
    return t;
  };
  const ensure = (): Subpath => {
    if (!cur) {
      cur = { start: p, segments: [], closed: false };
      subpaths.push(cur);
    }
    return cur;
  };
  const lineTo = (q: Point): void => {
    ensure().segments.push({ p0: p, c1: p, c2: q, p1: q, line: true });
    p = q;
  };
  let cmd = "";
  while (i < tokens.length) {
    const t = tokens[i];
    if (typeof t === "string") {
      cmd = t;
      i++;
    } else if (!cmd) {
      throw new PathDataError("path data must start with a command");
    } else if (cmd === "M") cmd = "L";
    else if (cmd === "m") cmd = "l";
    const rel = cmd === cmd.toLowerCase();
    const k = cmd.toLowerCase();
    if (!(k in ARGS)) throw new PathDataError(`unknown path command ${cmd}`);
    const o = rel ? p : { x: 0, y: 0 };
    switch (k) {
      case "m": {
        const q = { x: o.x + num(), y: o.y + num() };
        p = q;
        start = q;
        cur = { start: q, segments: [], closed: false };
        subpaths.push(cur);
        lastCtrl = null;
        break;
      }
      case "l":
        lineTo({ x: o.x + num(), y: o.y + num() });
        lastCtrl = null;
        break;
      case "h":
        lineTo({ x: (rel ? p.x : 0) + num(), y: p.y });
        lastCtrl = null;
        break;
      case "v":
        lineTo({ x: p.x, y: (rel ? p.y : 0) + num() });
        lastCtrl = null;
        break;
      case "c": {
        const c1 = { x: o.x + num(), y: o.y + num() };
        const c2 = { x: o.x + num(), y: o.y + num() };
        const q = { x: o.x + num(), y: o.y + num() };
        ensure().segments.push({ p0: p, c1, c2, p1: q, line: false });
        p = q;
        lastCtrl = c2;
        break;
      }
      case "s": {
        const c1: Point = lastCtrl && "cs".includes(lastCmd.toLowerCase()) ? { x: 2 * p.x - lastCtrl.x, y: 2 * p.y - lastCtrl.y } : p;
        const c2 = { x: o.x + num(), y: o.y + num() };
        const q = { x: o.x + num(), y: o.y + num() };
        ensure().segments.push({ p0: p, c1, c2, p1: q, line: false });
        p = q;
        lastCtrl = c2;
        break;
      }
      case "q": {
        const c = { x: o.x + num(), y: o.y + num() };
        const q = { x: o.x + num(), y: o.y + num() };
        ensure().segments.push(quadToCubic(p, c, q));
        p = q;
        lastCtrl = c;
        break;
      }
      case "t": {
        const c: Point = lastCtrl && "qt".includes(lastCmd.toLowerCase()) ? { x: 2 * p.x - lastCtrl.x, y: 2 * p.y - lastCtrl.y } : p;
        const q = { x: o.x + num(), y: o.y + num() };
        ensure().segments.push(quadToCubic(p, c, q));
        p = q;
        lastCtrl = c;
        break;
      }
      case "a": {
        const rx = num(), ry = num(), rot = num(), large = num(), sweep = num();
        const q = { x: o.x + num(), y: o.y + num() };
        for (const seg of arcToCubics(p, q, rx, ry, rot, large !== 0, sweep !== 0)) ensure().segments.push(seg);
        p = q;
        lastCtrl = null;
        break;
      }
      case "z": {
        if (cur) {
          const s = cur as Subpath;
          if (Math.hypot(p.x - start.x, p.y - start.y) > 1e-9) lineTo(start);
          s.closed = true;
        }
        p = start;
        cur = null;
        lastCtrl = null;
        break;
      }
    }
    lastCmd = cmd;
  }
  return subpaths.filter((s) => s.segments.length > 0);
}

/** Arc flags may be written as single digits without separators ("0 011 1"). */
function splitArcFlags(args: string): string {
  const nums = args.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  // Re-split: positions 3 and 4 of each 7-number group are single-digit flags.
  const out: string[] = [];
  let k = 0;
  for (const n of nums) {
    let s = n;
    while (s.length > 0) {
      const slot = k % 7;
      if ((slot === 3 || slot === 4) && /^[01]/.test(s) && s.length > 1 && !s.startsWith("0.") && !s.startsWith("1.")) {
        out.push(s[0]!);
        s = s.slice(1);
      } else {
        out.push(s);
        s = "";
      }
      k++;
    }
  }
  return ` ${out.join(" ")} `;
}

function quadToCubic(p0: Point, c: Point, p1: Point): Cubic {
  return {
    p0,
    c1: { x: p0.x + (2 / 3) * (c.x - p0.x), y: p0.y + (2 / 3) * (c.y - p0.y) },
    c2: { x: p1.x + (2 / 3) * (c.x - p1.x), y: p1.y + (2 / 3) * (c.y - p1.y) },
    p1,
    line: false,
  };
}

/** SVG elliptical arc (endpoint parameterization) as cubic segments. */
export function arcToCubics(p0: Point, p1: Point, rxIn: number, ryIn: number, angleDeg: number, large: boolean, sweep: boolean): Cubic[] {
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0 || (p0.x === p1.x && p0.y === p1.y)) return p0.x === p1.x && p0.y === p1.y ? [] : [{ p0, c1: p0, c2: p1, p1, line: true }];
  const phi = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (p0.x - p1.x) / 2;
  const dy = (p0.y - p1.y) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  let coef = Math.sqrt(Math.max(0, num / den));
  if (large === sweep) coef = -coef;
  const cx1 = (coef * rx * y1) / ry;
  const cy1 = (-coef * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (p0.x + p1.x) / 2;
  const cy = sin * cx1 + cos * cy1 + (p0.y + p1.y) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number): number => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const theta1 = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
  const step = delta / n;
  const k = (4 / 3) * Math.tan(step / 4);
  const out: Cubic[] = [];
  const point = (t: number): Point => ({ x: cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, y: cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos });
  const deriv = (t: number): Point => ({ x: -rx * Math.sin(t) * cos - ry * Math.cos(t) * sin, y: -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos });
  let t = theta1;
  let a = p0;
  for (let i = 0; i < n; i++) {
    const t2 = t + step;
    const b = i === n - 1 ? p1 : point(t2);
    const d1 = deriv(t);
    const d2 = deriv(t2);
    out.push({ p0: a, c1: { x: a.x + k * d1.x, y: a.y + k * d1.y }, c2: { x: b.x - k * d2.x, y: b.y - k * d2.y }, p1: b, line: false });
    a = b;
    t = t2;
  }
  return out;
}

/** Applies a matrix to every point of subpaths. */
export function transformSubpaths(subpaths: readonly Subpath[], m: Mat2D): Subpath[] {
  const tp = (p: Point): Point => transformPoint(m, p.x, p.y);
  return subpaths.map((s) => ({
    start: tp(s.start),
    closed: s.closed,
    segments: s.segments.map((c) => ({ p0: tp(c.p0), c1: tp(c.c1), c2: tp(c.c2), p1: tp(c.p1), line: c.line })),
  }));
}

/** Bounds of subpaths' end and control points (a conservative box; curves stay inside their hull). */
export function subpathBounds(subpaths: readonly Subpath[]): { x: number; y: number; width: number; height: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of subpaths) {
    for (const c of s.segments) {
      for (const p of c.line ? [c.p0, c.p1] : [c.p0, c.c1, c.c2, c.p1]) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    }
  }
  if (minX > maxX) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * A vector network from subpaths, with coordinates relative to `origin`.
 * Closed subpaths (and open ones when `fillOpen`, closed by a straight
 * segment as SVG fills them) form the loops of one region with the given
 * fill rule.
 */
export function subpathsToNetwork(subpaths: readonly Subpath[], origin: Point, fillRule: "nonzero" | "evenodd", fillOpen: boolean): VectorNetwork {
  const vertices: { x: number; y: number }[] = [];
  const segments: { start: number; end: number; tangentStart?: { x: number; y: number }; tangentEnd?: { x: number; y: number } }[] = [];
  const loops: number[][] = [];
  const r = (v: number): number => Math.round(v * 1e4) / 1e4;
  const vertex = (p: Point): number => {
    vertices.push({ x: r(p.x - origin.x), y: r(p.y - origin.y) });
    return vertices.length - 1;
  };
  const same = (a: Point, b: Point): boolean => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
  for (const s of subpaths) {
    const segs = s.segments.filter((c) => !(same(c.p0, c.p1) && (c.line || (same(c.c1, c.p0) && same(c.c2, c.p1)))));
    if (segs.length === 0) continue;
    const first = vertex(segs[0]!.p0);
    let prev = first;
    const loop: number[] = [];
    const closes = s.closed || (fillOpen && segs.length > 1);
    segs.forEach((c, i) => {
      const last = i === segs.length - 1;
      const endsAtStart = last && same(c.p1, segs[0]!.p0);
      const end = endsAtStart ? first : vertex(c.p1);
      const seg: (typeof segments)[number] = { start: prev, end };
      if (!c.line) {
        const ts = { x: r(c.c1.x - c.p0.x), y: r(c.c1.y - c.p0.y) };
        const te = { x: r(c.c2.x - c.p1.x), y: r(c.c2.y - c.p1.y) };
        if (ts.x !== 0 || ts.y !== 0) seg.tangentStart = ts;
        if (te.x !== 0 || te.y !== 0) seg.tangentEnd = te;
      }
      segments.push(seg);
      loop.push(segments.length - 1);
      prev = end;
    });
    if (closes) {
      if (prev !== first) {
        segments.push({ start: prev, end: first });
        loop.push(segments.length - 1);
      }
      if (loop.length >= 1 && (loop.length > 1 || segments[loop[0]!]!.start === segments[loop[0]!]!.end)) loops.push(loop);
    }
  }
  return { vertices, segments, regions: loops.length > 0 ? [{ loops, fillRule }] : [] };
}
