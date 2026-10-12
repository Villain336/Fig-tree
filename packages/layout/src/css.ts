import {
  makeStyle,
  type ContentAlignment,
  type FlexBasis,
  type GridLine,
  type ItemAlignment,
  type LengthPercentage,
  type LineNames,
  type MaxSize,
  type Repeat,
  type SelfAlignment,
  type Size,
  type Style,
  type TrackBreadth,
  type TrackListEntry,
  type TrackSize,
} from "./style";

/**
 * Parses CSS declarations (`"display: flex; gap: 8px"` or a property map)
 * into a {@link Style}. Supports the geometry-affecting properties of the
 * specs the engine implements, their shorthands, `calc()` sums of `px` and
 * `%`, and the grid template syntax (line names, `repeat()`, `minmax()`,
 * `fit-content()`, areas). Properties that do not affect layout (colors,
 * backgrounds, `border-style`…) are ignored; unsupported values of layout
 * properties throw {@link CssError}, so nothing is approximated silently.
 */
export function parseStyle(css: string | Readonly<Record<string, string>>): Style {
  return makeStyle(parseDeclarations(css));
}

export class CssError extends Error {}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export function parseDeclarations(css: string | Readonly<Record<string, string>>): Partial<Style> {
  const out: Mutable<Partial<Style>> = {};
  const entries = typeof css === "string" ? splitDeclarations(css) : Object.entries(css);
  for (const [rawName, rawValue] of entries) {
    const name = rawName.trim().toLowerCase();
    const value = rawValue.trim().replace(/\s*!important$/, "");
    try {
      apply(out, name, value);
    } catch (e) {
      if (e instanceof CssError) throw new CssError(`${name}: ${value}: ${e.message}`);
      throw e;
    }
  }
  return out;
}

function splitDeclarations(css: string): [string, string][] {
  const out: [string, string][] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  const push = (end: number): void => {
    const decl = css.slice(start, end).trim();
    start = end + 1;
    if (!decl) return;
    const colon = decl.indexOf(":");
    if (colon < 0) throw new CssError(`not a declaration: ${decl}`);
    out.push([decl.slice(0, colon), decl.slice(colon + 1)]);
  };
  for (let i = 0; i < css.length; i++) {
    const c = css[i]!;
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === ";" && depth === 0) push(i);
  }
  push(css.length);
  return out;
}

// ── Tokens ───────────────────────────────────────────────────────────────

/** Splits a value on top-level whitespace; `/` is its own token; brackets, functions and strings stay whole. */
export function tokens(value: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  let quote = "";
  const flush = (): void => {
    if (cur) out.push(cur);
    cur = "";
  };
  for (const c of value) {
    if (quote) {
      cur += c;
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") {
      if (depth === 0) flush();
      quote = c;
      cur += c;
    } else if (c === "(" || c === "[") {
      depth++;
      cur += c;
    } else if (c === ")" || c === "]") {
      depth--;
      cur += c;
      if (depth === 0 && c === "]") flush();
    } else if (depth === 0 && /\s/.test(c)) {
      flush();
    } else if (depth === 0 && c === "/") {
      flush();
      out.push("/");
    } else {
      if (depth === 0 && c === "[") flush();
      cur += c;
    }
  }
  flush();
  return out;
}

/** Splits a function's argument list on top-level commas. */
function args(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of inner) {
    if (c === "(" || c === "[") depth++;
    if (c === ")" || c === "]") depth--;
    if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

function fn(token: string): { name: string; inner: string } | null {
  const m = /^([a-z-]+)\((.*)\)$/is.exec(token.trim());
  return m ? { name: m[1]!.toLowerCase(), inner: m[2]! } : null;
}

// ── Lengths ──────────────────────────────────────────────────────────────

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

export function parseNumber(t: string): number {
  if (!NUMBER.test(t)) throw new CssError(`expected a number, got "${t}"`);
  return Number(t);
}

/** A `<length-percentage>`: `12px`, `0`, `50%` or `calc()` of those. */
export function parseLP(t: string): LengthPercentage {
  t = t.trim();
  const f = fn(t);
  if (f?.name === "calc") return lin(parseCalc(f.inner));
  if (t.endsWith("%")) return { pct: parseNumber(t.slice(0, -1)), px: 0 };
  if (t.endsWith("px")) return parseNumber(t.slice(0, -2));
  const n = parseNumber(t);
  if (n !== 0) throw new CssError(`unitless length "${t}"`);
  return 0;
}

function lin(v: { pct: number; px: number }): LengthPercentage {
  return v.pct === 0 ? v.px : v;
}

/** `calc()` contents: sums and differences of terms, terms scaled by plain numbers. */
function parseCalc(src: string): { pct: number; px: number } {
  let i = 0;
  const ws = (): void => {
    while (i < src.length && /\s/.test(src[i]!)) i++;
  };
  type V = { pct: number; px: number; num: boolean };
  const factor = (): V => {
    ws();
    if (src[i] === "(") {
      i++;
      const v = sum();
      ws();
      if (src[i] !== ")") throw new CssError("unbalanced calc()");
      i++;
      return v;
    }
    if (src.startsWith("calc(", i)) {
      i += 4;
      return factor();
    }
    const m = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(px|%)?/i.exec(src.slice(i));
    if (!m) throw new CssError(`bad calc() term at "${src.slice(i)}"`);
    i += m[0].length;
    const n = parseFloat(m[0]);
    if (m[1] === "%") return { pct: n, px: 0, num: false };
    if (m[1]) return { pct: 0, px: n, num: false };
    return { pct: 0, px: n, num: true };
  };
  const term = (): V => {
    let v = factor();
    for (;;) {
      ws();
      const op = src[i];
      if (op !== "*" && op !== "/") return v;
      i++;
      const r = factor();
      if (op === "*") {
        if (v.num) v = { pct: r.pct * v.px, px: r.px * v.px, num: r.num };
        else if (r.num) v = { pct: v.pct * r.px, px: v.px * r.px, num: false };
        else throw new CssError("calc() cannot multiply two lengths");
      } else {
        if (!r.num || r.px === 0) throw new CssError("calc() can only divide by a non-zero number");
        v = { pct: v.pct / r.px, px: v.px / r.px, num: v.num };
      }
    }
  };
  const sum = (): V => {
    let v = term();
    for (;;) {
      ws();
      const op = src[i];
      if (op !== "+" && op !== "-") return v;
      i++;
      const r = term();
      const s = op === "+" ? 1 : -1;
      v = { pct: v.pct + s * r.pct, px: v.px + s * r.px, num: v.num && r.num };
    }
  };
  const v = sum();
  ws();
  if (i !== src.length) throw new CssError(`trailing calc() input "${src.slice(i)}"`);
  return { pct: v.pct, px: v.px };
}

function parseSize(t: string): Size {
  if (t === "auto" || t === "min-content" || t === "max-content" || t === "fit-content") return t;
  if (t === "-webkit-fit-content") return "fit-content";
  return nonNegative(parseLP(t));
}

function parseMaxSize(t: string): MaxSize {
  if (t === "none" || t === "min-content" || t === "max-content" || t === "fit-content") return t;
  return nonNegative(parseLP(t));
}

function nonNegative(v: LengthPercentage): LengthPercentage {
  if (typeof v === "number" && v < 0) throw new CssError("negative size");
  return v;
}

/** Expands 1–4 values to top, right, bottom, left. */
function boxSides<T>(vals: T[]): { top: T; right: T; bottom: T; left: T } {
  const [a, b = a, c = a, d = b] = vals as [T, T?, T?, T?];
  if (vals.length < 1 || vals.length > 4) throw new CssError("expected 1 to 4 values");
  return { top: a, right: b!, bottom: c!, left: d! };
}

const SIDES = ["top", "right", "bottom", "left"] as const;

// ── Alignment ────────────────────────────────────────────────────────────

const POSITIONS = new Set(["start", "end", "center", "flex-start", "flex-end", "left", "right", "self-start", "self-end"]);
const CONTENT_POSITIONS = new Set(["start", "end", "center", "flex-start", "flex-end", "left", "right"]);

function contentAlignment(v: string): ContentAlignment {
  const t = v.split(/\s+/).join(" ");
  if (["normal", "space-between", "space-around", "space-evenly", "stretch"].includes(t)) return t as ContentAlignment;
  const parts = t.split(" ");
  const last = parts[parts.length - 1]!;
  if (!CONTENT_POSITIONS.has(last)) throw new CssError("unsupported content alignment");
  if (parts.length === 2 && (parts[0] === "safe" || parts[0] === "unsafe")) return t as ContentAlignment;
  if (parts.length === 1) return t as ContentAlignment;
  throw new CssError("unsupported content alignment");
}

function itemAlignment(v: string, allowAuto: boolean): SelfAlignment {
  const t = v.split(/\s+/).join(" ");
  if (allowAuto && t === "auto") return "auto";
  if (["normal", "stretch", "baseline", "first baseline", "last baseline"].includes(t)) return t as ItemAlignment;
  if (t === "legacy" || t.startsWith("legacy ") || t.endsWith(" legacy")) return "normal";
  const parts = t.split(" ");
  const last = parts[parts.length - 1]!;
  if (!POSITIONS.has(last)) throw new CssError("unsupported self alignment");
  if (parts.length === 1 || (parts.length === 2 && (parts[0] === "safe" || parts[0] === "unsafe"))) return t as ItemAlignment;
  throw new CssError("unsupported self alignment");
}

/** Splits `place-*` values into the align and justify halves. */
function placeHalves(v: string): [string, string] {
  const t = v.trim().split(/\s+/);
  // Values can be two words ("safe center", "first baseline").
  const groups: string[] = [];
  for (let i = 0; i < t.length; i++) {
    const w = t[i]!;
    if ((w === "safe" || w === "unsafe" || w === "first" || w === "last") && i + 1 < t.length) {
      groups.push(`${w} ${t[i + 1]}`);
      i++;
    } else groups.push(w);
  }
  if (groups.length === 1) return [groups[0]!, groups[0]!];
  if (groups.length === 2) return [groups[0]!, groups[1]!];
  throw new CssError("expected one or two alignment values");
}

// ── Grid ─────────────────────────────────────────────────────────────────

const IDENT = /^-?[A-Za-z_][\w-]*$/;

function parseBreadth(t: string): TrackBreadth {
  if (t === "auto" || t === "min-content" || t === "max-content") return t;
  if (t.endsWith("fr")) {
    const fr = parseNumber(t.slice(0, -2));
    if (fr < 0) throw new CssError("negative fr");
    return { fr };
  }
  return nonNegative(parseLP(t));
}

export function parseTrackSize(t: string): TrackSize {
  const f = fn(t);
  if (f?.name === "minmax") {
    const [a, b, ...rest] = args(f.inner);
    if (a === undefined || b === undefined || rest.length) throw new CssError("minmax() takes two arguments");
    const min = parseBreadth(a);
    if (typeof min === "object" && "fr" in min) throw new CssError("minmax() minimum cannot be flexible");
    return { min, max: parseBreadth(b) };
  }
  if (f?.name === "fit-content") return { fitContent: nonNegative(parseLP(f.inner)) };
  return parseBreadth(t);
}

function lineNames(t: string): LineNames {
  const names = t.slice(1, -1).trim().split(/\s+/).filter(Boolean);
  for (const n of names) if (!IDENT.test(n) || n === "span" || n === "auto") throw new CssError(`bad line name "${n}"`);
  return { names };
}

export function parseTrackList(value: string): TrackListEntry[] {
  if (value.trim() === "none") return [];
  const out: TrackListEntry[] = [];
  for (const t of tokens(value)) {
    if (t.startsWith("[")) {
      out.push(lineNames(t));
      continue;
    }
    const f = fn(t);
    if (f?.name === "repeat") {
      const [count, ...rest] = args(f.inner);
      const inner = rest.join(",");
      const entries: (TrackSize | LineNames)[] = tokens(inner).map((x) => (x.startsWith("[") ? lineNames(x) : parseTrackSize(x)));
      if (!entries.some((e) => !(typeof e === "object" && "names" in e))) throw new CssError("repeat() needs a track");
      const c = count!.trim();
      const repeat: Repeat["repeat"] = c === "auto-fill" || c === "auto-fit" ? c : parseNumber(c);
      if (typeof repeat === "number" && (!Number.isInteger(repeat) || repeat < 1)) throw new CssError("repeat() count must be a positive integer");
      out.push({ repeat, entries });
      continue;
    }
    out.push(parseTrackSize(t));
  }
  return out;
}

export function parseAreas(value: string): string[][] {
  if (value.trim() === "none") return [];
  const rows = tokens(value).map((t) => {
    if (!/^["'].*["']$/s.test(t)) throw new CssError("areas are quoted strings");
    // Runs of dots are one null cell token.
    return t
      .slice(1, -1)
      .trim()
      .split(/\s+/)
      .map((c) => (/^\.+$/.test(c) ? "." : c));
  });
  const width = rows[0]?.length ?? 0;
  if (rows.some((r) => r.length !== width)) throw new CssError("area rows must have the same number of cells");
  return rows;
}

export function parseGridLine(value: string): GridLine {
  const t = value.trim().split(/\s+/);
  if (t.length === 1 && t[0] === "auto") return "auto";
  let span = false;
  let n: number | undefined;
  let name: string | undefined;
  for (const w of t) {
    if (w === "span") {
      if (span) throw new CssError("span twice");
      span = true;
    } else if (/^[+-]?\d+$/.test(w)) {
      if (n !== undefined) throw new CssError("two line numbers");
      n = Number(w);
    } else if (IDENT.test(w) && w !== "auto") {
      if (name !== undefined) throw new CssError("two line names");
      name = w;
    } else throw new CssError(`bad grid line token "${w}"`);
  }
  if (span) {
    const count = n ?? 1;
    if (count < 1) throw new CssError("span must be positive");
    return name !== undefined ? { span: count, name } : { span: count };
  }
  if (n !== undefined) {
    if (n === 0) throw new CssError("line 0 does not exist");
    return name !== undefined ? { line: n, name } : { line: n };
  }
  if (name !== undefined) return { name };
  throw new CssError("empty grid line");
}

function isIdentLine(g: GridLine): boolean {
  return typeof g === "object" && "name" in g && !("line" in g) && !("span" in g);
}

function parseFlexBasis(t: string): FlexBasis {
  if (t === "content") return "content";
  return parseSize(t);
}

// ── Properties ───────────────────────────────────────────────────────────

function apply(out: Mutable<Partial<Style>>, name: string, value: string): void {
  const kw = value.toLowerCase();
  switch (name) {
    case "display":
      switch (kw) {
        case "none":
          out.display = "none";
          return;
        case "block":
        case "flow-root":
          out.display = "block";
          return;
        case "flex":
        case "inline-flex":
          out.display = "flex";
          return;
        case "grid":
        case "inline-grid":
          out.display = "grid";
          return;
        default:
          throw new CssError("unsupported display");
      }
    case "position":
      if (kw === "static" || kw === "relative" || kw === "absolute" || kw === "fixed") out.position = kw;
      else throw new CssError("unsupported position");
      return;
    case "box-sizing":
      if (kw === "content-box" || kw === "border-box") out.boxSizing = kw;
      else throw new CssError("unsupported box-sizing");
      return;
    case "width":
    case "height":
    case "min-width":
    case "min-height": {
      const key = ({ width: "width", height: "height", "min-width": "minWidth", "min-height": "minHeight" } as const)[name];
      out[key] = parseSize(kw);
      return;
    }
    case "max-width":
      out.maxWidth = parseMaxSize(kw);
      return;
    case "max-height":
      out.maxHeight = parseMaxSize(kw);
      return;
    case "aspect-ratio": {
      const t = tokens(kw);
      let auto = false;
      const rest: string[] = [];
      for (const x of t) {
        if (x === "auto") auto = true;
        else rest.push(x);
      }
      if (rest.length === 0) {
        out.aspectRatio = null;
        out.aspectRatioAuto = false;
        return;
      }
      const w = parseNumber(rest[0]!);
      const h = rest.length === 3 && rest[1] === "/" ? parseNumber(rest[2]!) : rest.length === 1 ? 1 : NaN;
      if (!(w > 0 && h > 0)) throw new CssError("bad ratio");
      out.aspectRatio = w / h;
      out.aspectRatioAuto = auto;
      return;
    }
    case "margin":
      out.margin = boxSides(tokens(kw).map(marginValue));
      return;
    case "padding":
      out.padding = boxSides(tokens(kw).map((t) => nonNegative(parseLP(t))));
      return;
    case "inset":
      out.inset = boxSides(tokens(kw).map(insetValue));
      return;
    case "overflow": {
      const t = tokens(kw);
      out.overflowX = overflow(t[0]!);
      out.overflowY = overflow(t[1] ?? t[0]!);
      return;
    }
    case "overflow-x":
      out.overflowX = overflow(kw);
      return;
    case "overflow-y":
      out.overflowY = overflow(kw);
      return;
    case "border":
      out.border = boxSides([borderWidthOf(kw)]);
      return;
    case "border-width":
      out.border = boxSides(tokens(kw).map(borderWidth));
      return;
    case "flex-direction":
      if (kw === "row" || kw === "row-reverse" || kw === "column" || kw === "column-reverse") out.flexDirection = kw;
      else throw new CssError("bad flex-direction");
      return;
    case "flex-wrap":
      if (kw === "nowrap" || kw === "wrap" || kw === "wrap-reverse") out.flexWrap = kw;
      else throw new CssError("bad flex-wrap");
      return;
    case "flex-flow":
      for (const t of tokens(kw)) {
        if (t === "row" || t === "row-reverse" || t === "column" || t === "column-reverse") out.flexDirection = t;
        else if (t === "nowrap" || t === "wrap" || t === "wrap-reverse") out.flexWrap = t;
        else throw new CssError("bad flex-flow");
      }
      return;
    case "flex": {
      const t = tokens(kw);
      if (t.length === 1 && t[0] === "none") return void Object.assign(out, { flexGrow: 0, flexShrink: 0, flexBasis: "auto" });
      if (t.length === 1 && t[0] === "auto") return void Object.assign(out, { flexGrow: 1, flexShrink: 1, flexBasis: "auto" });
      if (t.length === 1 && t[0] === "initial") return void Object.assign(out, { flexGrow: 0, flexShrink: 1, flexBasis: "auto" });
      const nums: number[] = [];
      let basis: FlexBasis | undefined;
      for (const x of t) {
        if (NUMBER.test(x) && !(basis === undefined && nums.length >= 2)) nums.push(parseNumber(x));
        else basis = parseFlexBasis(x);
      }
      if (nums.length > 2 || (nums.length === 0 && basis === undefined)) throw new CssError("bad flex");
      out.flexGrow = nums[0] ?? 1;
      out.flexShrink = nums[1] ?? 1;
      // `flex: <number>` sets the basis to 0%.
      out.flexBasis = basis ?? { pct: 0, px: 0 };
      return;
    }
    case "flex-grow":
      out.flexGrow = nonNegativeNumber(kw);
      return;
    case "flex-shrink":
      out.flexShrink = nonNegativeNumber(kw);
      return;
    case "flex-basis":
      out.flexBasis = parseFlexBasis(kw);
      return;
    case "order":
      if (!/^[+-]?\d+$/.test(kw)) throw new CssError("order is an integer");
      out.order = Number(kw);
      return;
    case "justify-content":
      out.justifyContent = contentAlignment(kw);
      return;
    case "align-content":
      out.alignContent = contentAlignment(kw);
      return;
    case "place-content": {
      const [a, j] = placeHalves(kw);
      out.alignContent = contentAlignment(a);
      out.justifyContent = contentAlignment(j);
      return;
    }
    case "justify-items":
      out.justifyItems = itemAlignment(kw, false) as ItemAlignment;
      return;
    case "align-items":
      out.alignItems = itemAlignment(kw, false) as ItemAlignment;
      return;
    case "place-items": {
      const [a, j] = placeHalves(kw);
      out.alignItems = itemAlignment(a, false) as ItemAlignment;
      out.justifyItems = itemAlignment(j, false) as ItemAlignment;
      return;
    }
    case "justify-self":
      out.justifySelf = itemAlignment(kw, true);
      return;
    case "align-self":
      out.alignSelf = itemAlignment(kw, true);
      return;
    case "place-self": {
      const [a, j] = placeHalves(kw);
      out.alignSelf = itemAlignment(a, true);
      out.justifySelf = itemAlignment(j, true);
      return;
    }
    case "gap":
    case "grid-gap": {
      const t = tokens(kw);
      out.rowGap = gapValue(t[0]!);
      out.columnGap = gapValue(t[1] ?? t[0]!);
      return;
    }
    case "row-gap":
    case "grid-row-gap":
      out.rowGap = gapValue(kw);
      return;
    case "column-gap":
    case "grid-column-gap":
      out.columnGap = gapValue(kw);
      return;
    case "grid-template-columns":
      out.gridTemplateColumns = parseTrackList(value);
      return;
    case "grid-template-rows":
      out.gridTemplateRows = parseTrackList(value);
      return;
    case "grid-template-areas":
      out.gridTemplateAreas = parseAreas(value);
      return;
    case "grid-template": {
      if (kw === "none") {
        out.gridTemplateRows = [];
        out.gridTemplateColumns = [];
        out.gridTemplateAreas = [];
        return;
      }
      const slash = splitSlash(value);
      if (slash.length !== 2 || /["']/.test(value)) throw new CssError("only the `rows / columns` form is supported");
      out.gridTemplateRows = parseTrackList(slash[0]!);
      out.gridTemplateColumns = parseTrackList(slash[1]!);
      out.gridTemplateAreas = [];
      return;
    }
    case "grid-auto-columns":
      out.gridAutoColumns = tokens(value).map(parseTrackSize);
      return;
    case "grid-auto-rows":
      out.gridAutoRows = tokens(value).map(parseTrackSize);
      return;
    case "grid-auto-flow": {
      const t = tokens(kw);
      const dense = t.includes("dense");
      const dir = t.find((x) => x !== "dense") ?? "row";
      if ((dir !== "row" && dir !== "column") || t.length > 2) throw new CssError("bad grid-auto-flow");
      out.gridAutoFlow = (dense ? `${dir} dense` : dir) as Style["gridAutoFlow"];
      return;
    }
    case "grid-row-start":
      out.gridRowStart = parseGridLine(value);
      return;
    case "grid-row-end":
      out.gridRowEnd = parseGridLine(value);
      return;
    case "grid-column-start":
      out.gridColumnStart = parseGridLine(value);
      return;
    case "grid-column-end":
      out.gridColumnEnd = parseGridLine(value);
      return;
    case "grid-row":
    case "grid-column": {
      const parts = splitSlash(value);
      const start = parseGridLine(parts[0]!);
      const end = parts[1] !== undefined ? parseGridLine(parts[1]) : isIdentLine(start) ? start : "auto";
      if (name === "grid-row") {
        out.gridRowStart = start;
        out.gridRowEnd = end;
      } else {
        out.gridColumnStart = start;
        out.gridColumnEnd = end;
      }
      return;
    }
    case "grid-area": {
      const parts = splitSlash(value).map(parseGridLine);
      const rs = parts[0]!;
      const cs = parts[1] ?? (isIdentLine(rs) ? rs : "auto");
      const re = parts[2] ?? (isIdentLine(rs) ? rs : "auto");
      const ce = parts[3] ?? (isIdentLine(cs) ? cs : "auto");
      out.gridRowStart = rs;
      out.gridColumnStart = cs;
      out.gridRowEnd = re;
      out.gridColumnEnd = ce;
      return;
    }
    default:
      break;
  }
  // Longhands of box sides.
  const side = /^(margin|padding|border)-(top|right|bottom|left)(-width)?$/.exec(name);
  if (side) {
    const [, prop, s, width] = side as unknown as [string, "margin" | "padding" | "border", (typeof SIDES)[number], string | undefined];
    if (prop === "margin" && !width) out.margin = { ...(out.margin ?? zeroSides()), [s]: marginValue(kw) };
    else if (prop === "padding" && !width) out.padding = { ...(out.padding ?? zeroSides()), [s]: nonNegative(parseLP(kw)) };
    else if (prop === "border") out.border = { ...(out.border ?? zeroSides()), [s]: width ? borderWidth(kw) : borderWidthOf(kw) };
    else throw new CssError("unknown property");
    return;
  }
  if (name === "top" || name === "right" || name === "bottom" || name === "left") {
    out.inset = { ...(out.inset ?? { top: "auto", right: "auto", bottom: "auto", left: "auto" }), [name]: insetValue(kw) };
    return;
  }
  // Everything else (paint, typography…) does not affect box geometry here.
}

function zeroSides(): { top: 0; right: 0; bottom: 0; left: 0 } {
  return { top: 0, right: 0, bottom: 0, left: 0 };
}

function splitSlash(value: string): string[] {
  const out: string[][] = [[]];
  for (const t of tokens(value)) {
    if (t === "/") out.push([]);
    else out[out.length - 1]!.push(t);
  }
  return out.map((p) => p.join(" "));
}

function marginValue(t: string): LengthPercentage | "auto" {
  return t === "auto" ? "auto" : parseLP(t);
}

function insetValue(t: string): LengthPercentage | "auto" {
  return t === "auto" ? "auto" : parseLP(t);
}

function gapValue(t: string): LengthPercentage {
  return t === "normal" ? 0 : nonNegative(parseLP(t));
}

function nonNegativeNumber(t: string): number {
  const n = parseNumber(t);
  if (n < 0) throw new CssError("negative");
  return n;
}

function overflow(t: string): Style["overflowX"] {
  if (t === "visible" || t === "hidden" || t === "clip" || t === "scroll" || t === "auto") return t;
  throw new CssError("bad overflow");
}

const BORDER_KEYWORDS: Record<string, number> = { thin: 1, medium: 3, thick: 5 };

function borderWidth(t: string): number {
  if (t in BORDER_KEYWORDS) return BORDER_KEYWORDS[t]!;
  const v = parseLP(t);
  if (typeof v !== "number" || v < 0) throw new CssError("border widths are non-negative lengths");
  return v;
}

/** The width in a `border` shorthand (style and color are ignored; `none` is 0). */
function borderWidthOf(value: string): number {
  let width = 3; // medium
  let style = "none";
  for (const t of tokens(value)) {
    if (t in BORDER_KEYWORDS || /^[\d.]/.test(t)) width = borderWidth(t);
    else if (["none", "hidden", "solid", "dashed", "dotted", "double", "groove", "ridge", "inset", "outset"].includes(t)) style = t;
  }
  return style === "none" || style === "hidden" ? 0 : width;
}
