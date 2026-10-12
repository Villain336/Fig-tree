import type { GridLine } from "../style";

/**
 * Grid item placement (CSS Grid 1 §8). Lines are 0-based indices in
 * explicit-grid coordinates: line 0 is the explicit grid's start line,
 * negative lines and lines past the explicit grid are implicit.
 */

/** Line names of one axis of the explicit grid (lines 0…count). */
export interface AxisLines {
  readonly count: number;
  readonly names: readonly (readonly string[])[];
}

/** One axis of an item's placement: definite lines, or auto with a span. */
export type AxisPlacement = { readonly start: number; readonly end: number } | { readonly span: number };

export function isDefinite(p: AxisPlacement): p is { start: number; end: number } {
  return "start" in p;
}

/** The nth line named `name` (negative: counting from the end); implicit lines all carry every name. */
function nthNamed(axis: AxisLines, name: string, n: number): number {
  let count = 0;
  if (n > 0) {
    for (let i = 0; i <= axis.count; i++) if (axis.names[i]?.includes(name) && ++count === n) return i;
    return axis.count + (n - count);
  }
  for (let i = axis.count; i >= 0; i--) if (axis.names[i]?.includes(name) && ++count === -n) return i;
  return -(-n - count);
}

/** A definite line (a number, a name, `<n> <name>`), or null for `auto` and spans. */
function definiteLine(axis: AxisLines, g: GridLine, side: "start" | "end"): number | null {
  if (g === "auto" || "span" in g) return null;
  if ("line" in g) {
    if (g.name !== undefined) return nthNamed(axis, g.name, g.line);
    return g.line > 0 ? g.line - 1 : axis.count + 1 + g.line;
  }
  // A bare name: an area's implicit `<name>-start`/`<name>-end` line, else the first line with the name.
  const implicit = `${g.name}-${side}`;
  for (let i = 0; i <= axis.count; i++) if (axis.names[i]?.includes(implicit)) return i;
  return nthNamed(axis, g.name, 1);
}

/** The line `span` named lines away from `from` (forward or backward), implicit lines counting for any name. */
function spanFrom(axis: AxisLines, from: number, span: { span: number; name?: string }, forward: boolean): number {
  if (span.name === undefined) return forward ? from + span.span : from - span.span;
  let count = 0;
  if (forward) {
    for (let i = from + 1; ; i++) {
      const named = i > axis.count || i < 0 || axis.names[i]?.includes(span.name);
      if (named && ++count === span.span) return i;
    }
  }
  for (let i = from - 1; ; i--) {
    const named = i < 0 || i > axis.count || axis.names[i]?.includes(span.name);
    if (named && ++count === span.span) return i;
  }
}

/** Resolves an item's placement in one axis (§8.3, with the conflict handling of §8.3.1). */
export function resolveAxis(axis: AxisLines, startSpec: GridLine, endSpec: GridLine): AxisPlacement {
  let start = definiteLine(axis, startSpec, "start");
  let end = definiteLine(axis, endSpec, "end");
  const startSpan = startSpec !== "auto" && "span" in startSpec ? startSpec : null;
  let endSpan = endSpec !== "auto" && "span" in endSpec ? endSpec : null;
  if (startSpan && endSpan) endSpan = null; // two spans: drop the end one
  if (start !== null && end !== null) {
    if (start > end) [start, end] = [end, start];
    if (start === end) end = start + 1;
    return { start, end };
  }
  if (start !== null) {
    if (endSpan) return { start, end: spanFrom(axis, start, endSpan, true) };
    return { start, end: start + 1 };
  }
  if (end !== null) {
    if (startSpan) return { start: spanFrom(axis, end, startSpan, false), end };
    return { start: end - 1, end };
  }
  const span = startSpan ?? endSpan;
  // A span for a named line alone becomes a span of 1.
  return { span: span && span.name === undefined ? span.span : 1 };
}

export interface PlacedArea {
  rowStart: number;
  rowEnd: number;
  colStart: number;
  colEnd: number;
}

/** Cells occupied so far, keyed by row; columns are bounded by the implicit grid. */
class Occupancy {
  private readonly rows = new Map<number, Set<number>>();
  /** Row-major for row flow; for column flow the caller swaps axes. */
  fits(r0: number, r1: number, c0: number, c1: number): boolean {
    for (let r = r0; r < r1; r++) {
      const row = this.rows.get(r);
      if (!row) continue;
      for (let c = c0; c < c1; c++) if (row.has(c)) return false;
    }
    return true;
  }
  occupy(r0: number, r1: number, c0: number, c1: number): void {
    for (let r = r0; r < r1; r++) {
      let row = this.rows.get(r);
      if (!row) this.rows.set(r, (row = new Set()));
      for (let c = c0; c < c1; c++) row.add(c);
    }
  }
}

export interface PlacementInput {
  readonly row: AxisPlacement;
  readonly col: AxisPlacement;
}

/**
 * The grid item placement algorithm (§8.5). Items are given in
 * order-modified document order. Returns every item's area in explicit-grid
 * line coordinates. `dense` packing backfills holes; `column` flow swaps
 * the roles of rows and columns.
 */
export function placeItems(items: readonly PlacementInput[], explicitRows: number, explicitCols: number, flow: "row" | "column", dense: boolean): PlacedArea[] {
  // Work in "major/minor" terms: for row flow the major axis (the one the cursor advances in) is rows.
  const major = (p: PlacementInput): AxisPlacement => (flow === "row" ? p.row : p.col);
  const minor = (p: PlacementInput): AxisPlacement => (flow === "row" ? p.col : p.row);
  const minorExplicit = flow === "row" ? explicitCols : explicitRows;
  const out: { m0: number; m1: number; n0: number; n1: number }[] = items.map(() => ({ m0: 0, m1: 0, n0: 0, n1: 0 }));
  const occ = new Occupancy();
  const done = new Array<boolean>(items.length).fill(false);

  // 1. Items with definite positions in both axes.
  items.forEach((it, i) => {
    const M = major(it);
    const N = minor(it);
    if (isDefinite(M) && isDefinite(N)) {
      out[i] = { m0: M.start, m1: M.end, n0: N.start, n1: N.end };
      occ.occupy(M.start, M.end, N.start, N.end);
      done[i] = true;
    }
  });

  // The implicit grid's start-most minor line comes from definite minor positions.
  let minorStart = 0;
  for (const it of items) {
    const N = minor(it);
    if (isDefinite(N)) minorStart = Math.min(minorStart, N.start);
  }

  // 2. Items locked to a major-axis position (definite major, auto minor).
  const rowCursor = new Map<number, number>();
  items.forEach((it, i) => {
    if (done[i]) return;
    const M = major(it);
    const N = minor(it);
    if (!isDefinite(M) || isDefinite(N)) return;
    const span = (N as { span: number }).span;
    let c = dense ? minorStart : (rowCursor.get(M.start) ?? minorStart);
    while (!occ.fits(M.start, M.end, c, c + span)) c++;
    out[i] = { m0: M.start, m1: M.end, n0: c, n1: c + span };
    occ.occupy(M.start, M.end, c, c + span);
    if (!dense) rowCursor.set(M.start, c + span);
    done[i] = true;
  });

  // 3. The minor axis of the implicit grid: explicit tracks, plus whatever definite minor positions and auto spans need.
  let minorEnd = minorExplicit;
  items.forEach((it, i) => {
    const N = minor(it);
    if (isDefinite(N)) {
      minorEnd = Math.max(minorEnd, N.end);
    } else if (done[i]) {
      minorEnd = Math.max(minorEnd, out[i]!.n1);
    }
  });
  items.forEach((it, i) => {
    const N = minor(it);
    if (!done[i] && !isDefinite(N)) minorEnd = Math.max(minorEnd, minorStart + (N as { span: number }).span);
  });

  // 4. Everything else, with the auto-placement cursor.
  let majorStart = 0;
  items.forEach((it, i) => {
    if (done[i]) majorStart = Math.min(majorStart, out[i]!.m0);
    const M = major(it);
    if (isDefinite(M)) majorStart = Math.min(majorStart, M.start);
  });
  let curM = majorStart;
  let curN = minorStart;
  items.forEach((it, i) => {
    if (done[i]) return;
    const M = major(it) as { span: number } | { start: number; end: number };
    const N = minor(it);
    const mspan = "span" in M ? M.span : M.end - M.start;
    if (isDefinite(N)) {
      // Definite minor position, auto major position.
      if (dense) curM = majorStart;
      else if (N.start < curN) curM++;
      curN = N.start;
      while (!occ.fits(curM, curM + mspan, N.start, N.end)) curM++;
      out[i] = { m0: curM, m1: curM + mspan, n0: N.start, n1: N.end };
      occ.occupy(curM, curM + mspan, N.start, N.end);
      return;
    }
    const nspan = (N as { span: number }).span;
    if (dense) {
      curM = majorStart;
      curN = minorStart;
    }
    for (;;) {
      let placed = false;
      while (curN + nspan <= minorEnd) {
        if (occ.fits(curM, curM + mspan, curN, curN + nspan)) {
          placed = true;
          break;
        }
        curN++;
      }
      if (placed) break;
      curM++;
      curN = minorStart;
    }
    out[i] = { m0: curM, m1: curM + mspan, n0: curN, n1: curN + nspan };
    occ.occupy(curM, curM + mspan, curN, curN + nspan);
    // The cursor moves past the item in the minor axis.
    curN += nspan;
  });

  return out.map((o) => (flow === "row" ? { rowStart: o.m0, rowEnd: o.m1, colStart: o.n0, colEnd: o.n1 } : { rowStart: o.n0, rowEnd: o.n1, colStart: o.m0, colEnd: o.m1 }));
}
