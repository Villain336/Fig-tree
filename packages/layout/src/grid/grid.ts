import { fitContentWidth, inlineBounds, inlineContribution, intrinsic, layout, place, space, type ContentInput, type ContentResult } from "../compute";
import { setStatic, type Intrinsic, type LayoutNode, type Rect } from "../node";
import { INF, aspectRatioOf, clamp, isAuto, isOutOfFlow, marginOf, pbOf, ratioHeightFromWidth, ratioWidthFromHeight, resolveLength } from "../sizing";
import { isScrollContainer, resolveLP, resolveLPOrZero, splitAlignment, type GridLine, type Style, type TrackBreadth, type TrackSize } from "../style";
import { isDefinite, placeItems, resolveAxis, type AxisLines, type AxisPlacement, type PlacedArea } from "./placement";
import { sizeTracks, track, type Available, type SizingFn, type SizingItem, type Track } from "./sizing";
import { areaLines, expandTrackList, type ExplicitAxis } from "./tracks";

/**
 * CSS Grid Layout 1: the explicit and implicit grid (§7), placement and
 * auto-placement (§8), the track sizing algorithm (§11, in sizing.ts) for
 * columns then rows, content and self alignment (§10), baselines, and
 * absolutely positioned children with grid areas as containing blocks (§9).
 */

interface GridItem {
  readonly node: LayoutNode;
  readonly style: Style;
  area: PlacedArea;
  /** Track index ranges in the implicit grid. */
  c0: number;
  c1: number;
  r0: number;
  r1: number;
  // Column-axis contributions (cached).
  colMin?: number;
  colMax?: number;
  colMinContribution?: number;
  // Row-axis values for a given area width.
  width?: number;
  rowOuter?: number;
  rowMinContribution?: number;
  rowMinIsContent?: boolean;
  firstBaseline?: number | undefined;
  /** Distance from the margin-box top to the first baseline (synthesized from the border box when none). */
  ascent?: number;
  /** The row's baseline-sharing group, when the item takes part in baseline alignment. */
  shimGroup?: { ascent: number };
}

interface Grid {
  readonly items: GridItem[];
  readonly cols: Track[];
  rows: Track[];
  /** The track sizes rows were built from (to re-resolve percentages). */
  readonly rowSizes: TrackSize[];
  /** Implicit-grid index of explicit line 0, per axis. */
  readonly colOffset: number;
  readonly rowOffset: number;
  readonly colLines: AxisLines;
  readonly rowLines: AxisLines;
  readonly colGap: number;
  rowGap: number;
}

/** Sizing functions of a track size, with percentages resolved against `basis` (or `auto` when it is indefinite). */
function fns(t: TrackSize, basis: number | undefined): { min: SizingFn; max: SizingFn } {
  const breadth = (b: TrackBreadth, isMin: boolean): SizingFn => {
    if (typeof b === "number") return { kind: "fixed", value: b };
    if (typeof b === "string") return { kind: b };
    if ("fr" in b) return isMin ? { kind: "auto" } : { kind: "fr", value: b.fr };
    const v = resolveLP(b, basis);
    return v === undefined ? { kind: "auto" } : { kind: "fixed", value: Math.max(0, v) };
  };
  if (typeof t === "object" && "min" in t) return { min: breadth(t.min, true), max: breadth(t.max, false) };
  if (typeof t === "object" && "fitContent" in t) {
    const v = resolveLP(t.fitContent, basis);
    return { min: { kind: "auto" }, max: v === undefined ? { kind: "max-content" } : { kind: "fit-content", value: Math.max(0, v) } };
  }
  const b = t as TrackBreadth;
  return { min: breadth(b, true), max: breadth(b, false) };
}

/** The `grid-auto-*` size of an implicit track `k` tracks after (k ≥ 0) or before (k < 0) the explicit grid. */
function autoTrack(auto: readonly TrackSize[], k: number): TrackSize {
  if (auto.length === 0) return "auto";
  const n = auto.length;
  return auto[((k % n) + n) % n]!;
}

function axisLines(explicit: ExplicitAxis, count: number, areas: Map<string, [number, number]>): AxisLines {
  const names: string[][] = [];
  for (let i = 0; i <= count; i++) names.push([...(explicit.lineNames[i] ?? [])]);
  for (const [name, [a, b]] of areas) {
    names[a]!.push(`${name}-start`);
    names[b]!.push(`${name}-end`);
  }
  return { count, names };
}

/** Sizes in an axis (definite size, or max size, and min size) used to count auto repetitions. */
function buildGrid(node: LayoutNode, width: number | undefined, height: number | undefined, maxWidth: number | undefined, maxHeight: number | undefined, minWidth: number | undefined, minHeight: number | undefined): Grid {
  const s = node.style;
  const colGap = Math.max(0, resolveLPOrZero(s.columnGap, width));
  const rowGap = Math.max(0, resolveLPOrZero(s.rowGap, height));
  const colsX = expandTrackList(s.gridTemplateColumns, width ?? maxWidth, minWidth, colGap, width);
  const rowsX = expandTrackList(s.gridTemplateRows, height ?? maxHeight, minHeight, rowGap, height);
  const areas = areaLines(s.gridTemplateAreas);
  const explicitCols = Math.max(colsX.tracks.length, s.gridTemplateAreas[0]?.length ?? 0);
  const explicitRows = Math.max(rowsX.tracks.length, s.gridTemplateAreas.length);
  const colLines = axisLines(colsX, explicitCols, areas.cols);
  const rowLines = axisLines(rowsX, explicitRows, areas.rows);

  const children = node.children
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.style.display !== "none" && !isOutOfFlow(c))
    .sort((a, b) => a.c.style.order - b.c.style.order || a.i - b.i)
    .map(({ c }) => c);
  const placements = children.map((c) => ({
    row: resolveAxis(rowLines, c.style.gridRowStart, c.style.gridRowEnd),
    col: resolveAxis(colLines, c.style.gridColumnStart, c.style.gridColumnEnd),
  }));
  const flow = s.gridAutoFlow.startsWith("column") ? "column" : "row";
  const areasPlaced = placeItems(placements, explicitRows, explicitCols, flow, s.gridAutoFlow.endsWith("dense"));

  // The implicit grid spans the explicit grid and every item. (Like Chromium, an axis without explicit
  // tracks does not extend the grid to its line 1 when every item sits before it.)
  let rMin = 0;
  let rMax = explicitRows > 0 || areasPlaced.length === 0 ? explicitRows : -INF;
  let cMin = 0;
  let cMax = explicitCols > 0 || areasPlaced.length === 0 ? explicitCols : -INF;
  for (const a of areasPlaced) {
    rMin = Math.min(rMin, a.rowStart);
    rMax = Math.max(rMax, a.rowEnd);
    cMin = Math.min(cMin, a.colStart);
    cMax = Math.max(cMax, a.colEnd);
  }
  const items: GridItem[] = children.map((node, i) => {
    const area = areasPlaced[i]!;
    return { node, style: node.style, area, c0: area.colStart - cMin, c1: area.colEnd - cMin, r0: area.rowStart - rMin, r1: area.rowEnd - rMin };
  });

  const makeTracks = (x: ExplicitAxis, explicitCount: number, lo: number, hi: number, auto: readonly TrackSize[], basis: number | undefined, used: (k: number) => boolean, sizes: TrackSize[]): Track[] => {
    const out: Track[] = [];
    for (let k = lo; k < hi; k++) {
      let size: TrackSize;
      if (k >= 0 && k < x.tracks.length) size = x.tracks[k]!;
      else if (k >= 0 && k < explicitCount) size = autoTrack(auto, k - x.tracks.length);
      else size = autoTrack(auto, k >= explicitCount ? k - explicitCount : k);
      sizes.push(size);
      const f = fns(size, basis);
      const collapsed = k >= 0 && k < x.tracks.length && x.autoFit.has(k) && !used(k - lo);
      out.push(track(f.min, f.max, collapsed));
    }
    return out;
  };
  const colUsed = new Set<number>();
  const rowUsed = new Set<number>();
  for (const it of items) {
    for (let k = it.c0; k < it.c1; k++) colUsed.add(k);
    for (let k = it.r0; k < it.r1; k++) rowUsed.add(k);
  }
  const cols = makeTracks(colsX, explicitCols, cMin, cMax, s.gridAutoColumns, width, (k) => colUsed.has(k), []);
  const rowSizes: TrackSize[] = [];
  const rows = makeTracks(rowsX, explicitRows, rMin, rMax, s.gridAutoRows, height, (k) => rowUsed.has(k), rowSizes);
  return { items, cols, rows, rowSizes, colOffset: -cMin, rowOffset: -rMin, colLines, rowLines, colGap, rowGap };
}

/** Whether an item spans a track with an `auto` min sizing function and, if it spans several, no flexible track (§6.6). */
function autoMinApplies(tracks: readonly Track[], a: number, b: number): boolean {
  let auto = false;
  for (let i = a; i < b; i++) {
    const t = tracks[i]!;
    if (t.min.kind === "auto") auto = true;
    if (b - a > 1 && t.max.kind === "fr") return false;
  }
  return auto;
}

/** Sum of the spanned tracks' fixed maxima (and gaps) when all are fixed: the area's maximum size (§6.6). */
function fixedMaxArea(tracks: readonly Track[], a: number, b: number, gap: number): number {
  let sum = gap * (b - a - 1);
  for (let i = a; i < b; i++) {
    const m = tracks[i]!.max;
    if (m.kind !== "fixed") return INF;
    sum += m.value;
  }
  return sum;
}

function resolvedSelf(item: Style, container: Style, axis: "justify" | "align"): { value: string; safe: boolean } {
  const raw = axis === "justify" ? (item.justifySelf === "auto" ? container.justifyItems : item.justifySelf) : item.alignSelf === "auto" ? container.alignItems : item.alignSelf;
  const { overflow, value } = splitAlignment(raw);
  return { value: value === "first baseline" ? "baseline" : value, safe: overflow === "safe" };
}

/**
 * `normal` self-alignment sizes an item like `stretch` unless it has a
 * preferred aspect ratio or is replaced; those are sized like block-level
 * boxes instead (§6.2): a non-replaced box with a ratio still fills its
 * area's width (its height then follows the ratio), a replaced one takes its
 * natural size.
 */
function stretches(node: LayoutNode, value: string, axis: "justify" | "align"): boolean {
  if (value === "stretch") return true;
  if (value !== "normal" || node.replaced) return false;
  return axis === "justify" || aspectRatioOf(node) === null;
}

/** Column-axis contributions of an item (outer sizes, percentages of the unknown area as auto / 0). */
function columnSizingItem(it: GridItem, g: Grid): SizingItem {
  return {
    start: it.c0,
    span: it.c1 - it.c0,
    minContent: () => (it.colMin ??= inlineContribution(it.node, "min")),
    maxContent: () => (it.colMax ??= inlineContribution(it.node, "max")),
    minContribution: () => (it.colMinContribution ??= columnMinContribution(it, g)),
  };
}

function columnMinContribution(it: GridItem, g: Grid): number {
  const cs = it.style;
  const pb = pbOf(cs, undefined);
  const m = marginOf(cs, undefined);
  const preferred = resolveLength(cs, cs.width, undefined, pb.h);
  // A preferred size that depends on the containing block (auto, percentages, fit-content) uses the minimum size instead.
  if (preferred !== undefined || cs.width === "min-content" || cs.width === "max-content") return inlineContribution(it.node, "min");
  let min = 0;
  if (cs.minWidth === "auto") {
    if (!isScrollContainer(cs.overflowX) && autoMinApplies(g.cols, it.c0, it.c1)) min = contentBasedMinWidth(it, g, pb.h, pb.v, m.left + m.right);
  } else {
    min = inlineBounds(it.node, undefined, pb.h).min;
  }
  return Math.max(pb.h, min) + m.left + m.right;
}

/** Content-based minimum width of a grid item (§6.6): its min-content width (or transferred size), clamped by its max width and a fixed-maximum area. */
function contentBasedMinWidth(it: GridItem, g: Grid, pbH: number, pbV: number, margins: number): number {
  const cs = it.style;
  let v = intrinsic(it.node).min + pbH;
  const ratio = aspectRatioOf(it.node);
  if (ratio) {
    const h = resolveLength(cs, cs.height, undefined, pbV);
    if (h !== undefined) v = ratioWidthFromHeight(ratio, h, pbH, pbV);
  }
  const maxW = inlineBounds(it.node, undefined, pbH).max;
  v = Math.min(v, maxW);
  const area = fixedMaxArea(g.cols, it.c0, it.c1, g.colGap);
  if (area !== INF) v = Math.min(v, Math.max(0, area - margins));
  return v;
}

/** An item's used border-box width in an area `areaW` wide, and its horizontal margins (auto margins as 0). */
function widthInArea(it: GridItem, container: Style, areaW: number, areaH: number | undefined, g: Grid): { width: number; ml: number; mr: number } {
  const cs = it.style;
  const pb = pbOf(cs, areaW);
  const ml = isAuto(cs.margin.left) ? 0 : resolveLPOrZero(cs.margin.left, areaW);
  const mr = isAuto(cs.margin.right) ? 0 : resolveLPOrZero(cs.margin.right, areaW);
  const avail = areaW - ml - mr;
  let w = resolveLength(cs, cs.width, areaW, pb.h);
  if (w === undefined) {
    const j = resolvedSelf(cs, container, "justify");
    const ratio = aspectRatioOf(it.node);
    let h = ratio ? resolveLength(cs, cs.height, areaH, pb.v) : undefined;
    // The ratio transfers the used (min/max-clamped) height.
    if (h !== undefined) h = clamp(h, resolveLength(cs, cs.minHeight, areaH, pb.v) ?? 0, resolveLength(cs, cs.maxHeight, areaH, pb.v) ?? INF);
    const noAutoMargins = !isAuto(cs.margin.left) && !isAuto(cs.margin.right);
    if (cs.width === "min-content") w = intrinsic(it.node).min + pb.h;
    else if (cs.width === "max-content") w = intrinsic(it.node).max + pb.h;
    else if (cs.width === "fit-content") w = fitContentWidth(it.node, avail, pb.h);
    // An explicit stretch wins over the aspect ratio.
    else if (j.value === "stretch" && noAutoMargins) w = avail;
    else if (ratio && h !== undefined) w = ratioWidthFromHeight(ratio, h, pb.h, pb.v);
    else if (stretches(it.node, j.value, "justify") && noAutoMargins) w = avail;
    else if (it.node.replaced) w = intrinsic(it.node).max + pb.h;
    else w = fitContentWidth(it.node, avail, pb.h);
  }
  let autoMin = 0;
  if (cs.minWidth === "auto" && !isScrollContainer(cs.overflowX) && autoMinApplies(g.cols, it.c0, it.c1)) {
    const spec = resolveLength(cs, cs.width, areaW, pb.h);
    const content = contentBasedMinWidth(it, g, pb.h, pb.v, ml + mr);
    autoMin = spec !== undefined ? Math.min(spec, content) : content;
  }
  const b = inlineBounds(it.node, areaW, pb.h, autoMin);
  return { width: Math.max(pb.h, clamp(w, b.min, Math.max(b.min, b.max))), ml, mr };
}

/** Row-axis contributions of an item laid out in its column area. */
function rowSizingItem(it: GridItem, g: Grid, container: Style, colPos: readonly number[]): SizingItem {
  const areaW = colPos[it.c1 - 1]! + g.cols[it.c1 - 1]!.base - colPos[it.c0]!;
  const measure = (): void => {
    if (it.rowOuter !== undefined) return;
    const cs = it.style;
    const w = widthInArea(it, container, areaW, undefined, g);
    it.width = w.width;
    const m = marginOf(cs, areaW);
    const r = layout(it.node, space(w.width, undefined, areaW, undefined), false);
    it.rowOuter = r.height + m.top + m.bottom;
    it.firstBaseline = r.firstBaseline;
    it.ascent = m.top + (r.firstBaseline ?? r.height);
    const pb = pbOf(cs, areaW);
    const preferred = resolveLength(cs, cs.height, undefined, pb.v);
    if (preferred !== undefined) {
      // The minimum contribution is the min-content contribution (baseline shim included).
      it.rowMinContribution = it.rowOuter;
      it.rowMinIsContent = true;
      return;
    }
    let min = resolveLength(cs, cs.minHeight, undefined, pb.v) ?? 0;
    if (cs.minHeight === "auto" && !isScrollContainer(cs.overflowY) && autoMinApplies(g.rows, it.r0, it.r1)) {
      // Content-based minimum: the content height at this width (or the ratio-transferred height), clamped.
      const ratio = aspectRatioOf(it.node);
      let v = ratio && !it.node.replaced ? Math.max(ratioHeightFromWidth(ratio, w.width, pb.h, pb.v), contentHeight(it, w.width, areaW)) : contentHeight(it, w.width, areaW);
      if (it.node.replaced && ratio) v = ratioHeightFromWidth(ratio, w.width, pb.h, pb.v);
      const maxH = resolveLength(cs, cs.maxHeight, undefined, pb.v) ?? INF;
      v = Math.min(v, maxH);
      const area = fixedMaxArea(g.rows, it.r0, it.r1, g.rowGap);
      if (area !== INF) v = Math.min(v, Math.max(0, area - m.top - m.bottom));
      min = v;
      // A content-based minimum is a content contribution: it carries the baseline shim.
      it.rowMinIsContent = true;
    }
    it.rowMinContribution = Math.max(pb.v, min) + m.top + m.bottom;
  };
  // Baseline-aligned items get a shim: their contributions grow by how far their baseline sits below the group's (§11.5 step 1).
  const shim = (): number => (it.shimGroup ? it.shimGroup.ascent - it.ascent! : 0);
  return {
    start: it.r0,
    span: it.r1 - it.r0,
    minContent: () => (measure(), it.rowOuter! + shim()),
    maxContent: () => (measure(), it.rowOuter! + shim()),
    // Only a minimum contribution that comes from content gets the shim (as in Chromium).
    minContribution: () => (measure(), it.rowMinContribution! + (it.rowMinIsContent ? shim() : 0)),
  };
}

/**
 * Items that take part in first-baseline alignment in the block axis: a
 * baseline self-alignment, no auto block margins, and a baseline that does
 * not depend on the row's intrinsic size: a content baseline, or one
 * synthesized from a box whose height is not a percentage or whose rows are
 * all fixed-size (Box Alignment 3 §9.3). Items spanning
 * several rows join the group of their first row (as in Chromium). Call
 * after measuring the item.
 */
function baselineParticipant(it: GridItem, container: Style, rows: readonly Track[]): boolean {
  const cs = it.style;
  if (resolvedSelf(cs, container, "align").value !== "baseline") return false;
  if (isAuto(cs.margin.top) || isAuto(cs.margin.bottom)) return false;
  if (it.firstBaseline !== undefined) return true;
  // A baseline synthesized from a percentage height would depend on the row's size: circular unless the rows are fixed.
  const pct = (v: unknown): boolean => typeof v === "object" && v !== null && "pct" in v;
  if (!pct(cs.height) && !pct(cs.minHeight) && !pct(cs.maxHeight)) return true;
  for (let r = it.r0; r < it.r1; r++) if (rows[r]!.min.kind !== "fixed" || rows[r]!.max.kind !== "fixed") return false;
  return true;
}

function contentHeight(it: GridItem, width: number, areaW: number): number {
  return layout(it.node, space(width, undefined, areaW, undefined, { contentHeight: true }), false).height;
}

function hasPercent(t: TrackSize): boolean {
  const pct = (b: unknown): boolean => typeof b === "object" && b !== null && "pct" in b;
  if (typeof t === "object" && "min" in t) return pct(t.min) || pct(t.max);
  if (typeof t === "object" && "fitContent" in t) return pct(t.fitContent);
  return pct(t);
}


function stretchContent(value: string): boolean {
  const v = splitAlignment(value).value;
  return v === "normal" || v === "stretch";
}

/** Line positions (from the content-box start) after content distribution (§10.5). */
function linePositions(tracks: readonly Track[], gap: number, size: number, alignment: string, horizontal: boolean): number[] {
  const live = tracks.filter((t) => !t.collapsed).length;
  let used = gap * Math.max(0, live - 1);
  for (const t of tracks) used += t.base;
  const free = size - used;
  const { overflow, value } = splitAlignment(alignment);
  let start = 0;
  let between = 0;
  const n = live;
  if (!(overflow === "safe" && free < 0)) {
    switch (value) {
      case "end":
      case "flex-end":
        start = free;
        break;
      case "right":
        start = horizontal ? free : 0;
        break;
      case "center":
        start = free / 2;
        break;
      case "space-between":
        if (free > 0 && n > 1) between = free / (n - 1);
        break;
      case "space-around":
        if (free > 0) {
          between = free / n;
          start = between / 2;
        } else if (free < 0) start = 0;
        break;
      case "space-evenly":
        if (free > 0) {
          between = free / (n + 1);
          start = between;
        }
        break;
      default:
        break;
    }
  }
  const pos: number[] = [start];
  let p = start;
  let seen = 0;
  tracks.forEach((t) => {
    p += t.base;
    if (!t.collapsed) {
      seen++;
      if (seen < n) p += gap + between;
    }
    pos.push(p);
  });
  return pos;
}

export function layoutGrid(node: LayoutNode, input: ContentInput): ContentResult {
  const s = node.style;
  const cw = input.width;
  const g = buildGrid(node, cw, input.percentHeight, undefined, Number.isFinite(input.maxHeight) ? input.maxHeight : undefined, undefined, input.minHeight > 0 ? input.minHeight : undefined);

  // Columns.
  sizeTracks(g.cols, g.items.map((it) => columnSizingItem(it, g)), { available: { kind: "definite", size: cw }, gap: g.colGap, minSize: 0, maxSize: INF, stretch: stretchContent(s.justifyContent) });

  // Rows: items are measured in their column areas, after justify-content (§11.1 step 2).
  const colPosForRows = linePositions(g.cols, g.colGap, cw, s.justifyContent, true);
  const rowAvail: Available = input.height !== undefined ? { kind: "definite", size: input.height } : { kind: "indefinite" };
  const rowItems = g.items.map((it) => rowSizingItem(it, g, s, colPosForRows));
  // Baseline-sharing groups per row.
  const groups = new Map<number, { ascent: number }>();
  g.items.forEach((it, k) => {
    if (resolvedSelf(it.style, s, "align").value !== "baseline") return;
    rowItems[k]!.maxContent();
    if (!baselineParticipant(it, s, g.rows)) return;
    let grp = groups.get(it.r0);
    if (!grp) groups.set(it.r0, (grp = { ascent: -INF }));
    grp.ascent = Math.max(grp.ascent, it.ascent!);
    it.shimGroup = grp;
  });
  sizeTracks(g.rows, rowItems, { available: rowAvail, gap: g.rowGap, minSize: input.minHeight, maxSize: input.maxHeight, stretch: stretchContent(s.alignContent) });
  const rowsTotal = (): number => {
    let total = g.rowGap * Math.max(0, g.rows.filter((t) => !t.collapsed).length - 1);
    for (const t of g.rows) total += t.base;
    return total;
  };
  const height = input.height ?? clamp(rowsTotal(), input.minHeight, input.maxHeight);
  if (input.percentHeight === undefined && (g.rowSizes.some(hasPercent) || typeof s.rowGap === "object")) {
    // §7.2.1: percentages of the indefinite height were treated as auto to find the height; they now resolve against it.
    g.rows = g.rows.map((t, k) => {
      const f = fns(g.rowSizes[k]!, height);
      return track(f.min, f.max, t.collapsed);
    });
    g.rowGap = Math.max(0, resolveLPOrZero(s.rowGap, height));
    sizeTracks(g.rows, rowItems, { available: { kind: "definite", size: height }, gap: g.rowGap, minSize: 0, maxSize: INF, stretch: stretchContent(s.alignContent) });
  }

  const colPos = linePositions(g.cols, g.colGap, cw, s.justifyContent, true);
  const rowPos = linePositions(g.rows, g.rowGap, height, s.alignContent, false);

  // Items: size and align within their areas.
  const placed: { it: GridItem; x: number; y: number; w: number; h: number; fixedH: number | undefined; areaW: number; areaH: number; m: { top: number; right: number; bottom: number; left: number } }[] = [];
  for (const it of g.items) {
    const cs = it.style;
    // The area runs from its first track's start to its last track's end (distributed space between its tracks included).
    const ax = colPos[it.c0]!;
    const areaW = colPos[it.c1 - 1]! + g.cols[it.c1 - 1]!.base - ax;
    const ay = rowPos[it.r0]!;
    const areaH = rowPos[it.r1 - 1]! + g.rows[it.r1 - 1]!.base - ay;
    const wa = widthInArea(it, s, areaW, areaH, g);
    const pb = pbOf(cs, areaW);
    const m = marginOf(cs, areaW);
    const autoT = isAuto(cs.margin.top);
    const autoB = isAuto(cs.margin.bottom);
    const al = resolvedSelf(cs, s, "align");
    let fixedH: number | undefined;
    if (cs.height === "auto" && stretches(it.node, al.value, "align") && !autoT && !autoB) {
      const minH = resolveLength(cs, cs.minHeight, areaH, pb.v) ?? 0;
      const maxH = resolveLength(cs, cs.maxHeight, areaH, pb.v) ?? INF;
      fixedH = Math.max(pb.v, clamp(areaH - m.top - m.bottom, minH, maxH));
    }
    const r = layout(it.node, space(wa.width, fixedH, areaW, areaH), false);
    it.firstBaseline = r.firstBaseline;
    placed.push({ it, x: ax, y: ay, w: wa.width, h: r.height, fixedH, areaW, areaH, m: { top: m.top, bottom: m.bottom, left: wa.ml, right: wa.mr } });
  }

  // Baseline alignment within rows: the row's shared first baseline, from the final layouts.
  const rowBaseline = new Map<number, number>();
  for (const p of placed) {
    if (!p.it.shimGroup) continue;
    const asc = p.m.top + (p.it.firstBaseline ?? p.h);
    rowBaseline.set(p.it.r0, Math.max(rowBaseline.get(p.it.r0) ?? -INF, asc));
  }

  let firstBaseline: number | undefined;
  let lastBaseline: number | undefined;
  let firstKey = INF;
  let lastKey = -INF;
  for (const p of placed) {
    const { it } = p;
    const cs = it.style;
    // Inline axis.
    const freeX = p.areaW - (p.w + p.m.left + p.m.right);
    let offX: number;
    const autoL = isAuto(cs.margin.left);
    const autoR = isAuto(cs.margin.right);
    if (autoL || autoR) offX = freeX > 0 ? (autoL && autoR ? freeX / 2 : autoL ? freeX : 0) : 0;
    else offX = selfOffset(resolvedSelf(cs, s, "justify"), freeX, true);
    // Block axis.
    const freeY = p.areaH - (p.h + p.m.top + p.m.bottom);
    let offY: number;
    const autoT = isAuto(cs.margin.top);
    const autoB = isAuto(cs.margin.bottom);
    const al = resolvedSelf(cs, s, "align");
    if (autoT || autoB) offY = freeY > 0 ? (autoT && autoB ? freeY / 2 : autoT ? freeY : 0) : 0;
    else if (it.shimGroup) offY = rowBaseline.get(it.r0)! - (p.m.top + (it.firstBaseline ?? p.h));
    else offY = selfOffset(al, freeY, false);
    const x = input.left + p.x + offX + p.m.left;
    const y = input.top + p.y + offY + p.m.top;
    if (input.perform) {
      layout(it.node, space(p.w, p.fixedH, p.areaW, p.areaH), true);
      place(it.node, x, y, p.areaW, p.areaH);
      it.node.out.margin = { top: p.m.top, right: p.m.right, bottom: p.m.bottom, left: p.m.left };
    }
    // Container baselines: the first item (in grid order) of the first row and of the last row.
    const key = it.r0 * 1e6 + it.c0;
    if (key < firstKey) {
      firstKey = key;
      firstBaseline = y + (it.firstBaseline ?? p.h);
    }
    const lastKeyOf = it.r1 * 1e6 + it.c0;
    if (lastKeyOf > lastKey) {
      lastKey = lastKeyOf;
      lastBaseline = y + (it.firstBaseline ?? p.h);
    }
  }

  // Absolutely positioned children.
  for (const child of node.children) {
    if (child.style.display === "none" || !isOutOfFlow(child)) continue;
    const cs = child.style;
    const fx = staticFraction(resolvedSelf(cs, s, "justify").value, true);
    const fy = staticFraction(resolvedSelf(cs, s, "align").value, false);
    // As Chromium does: a grid containing block aligns the static position in the child's grid area (the
    // padding box when it is not placed); otherwise the static position is in the content box.
    const area = node.style.position !== "static" ? absoluteArea(child, g, colPos, rowPos, input, cw, height) : null;
    child.absArea = area;
    if (area) setStatic(child, area.x, area.y, area.width, area.height, fx, fy);
    else setStatic(child, input.left, input.top, cw, height, fx, fy);
  }

  return { height, firstBaseline, lastBaseline };
}

/** Offset of an item's margin box in its area for a self-alignment value (unsafe by default, like Chromium). */
function selfOffset(a: { value: string; safe: boolean }, free: number, horizontal: boolean): number {
  if (a.safe && free < 0) return 0;
  switch (a.value) {
    case "center":
      return free / 2;
    case "end":
    case "self-end":
    case "flex-end":
      return free;
    case "right":
      return horizontal ? free : 0;
    case "last baseline":
      return free;
    default:
      return 0;
  }
}

function staticFraction(value: string, horizontal: boolean): number {
  switch (value) {
    case "center":
      return 0.5;
    case "end":
    case "self-end":
    case "flex-end":
    case "last baseline":
      return 1;
    case "right":
      return horizontal ? 1 : 0;
    default:
      return 0;
  }
}

/**
 * The containing block of an absolutely positioned child of a positioned
 * grid container (§9.1): its grid area, where `auto` lines (and lines
 * outside the implicit grid) are the padding edges. In the grid container's
 * border-box coordinates.
 */
function absoluteArea(child: LayoutNode, g: Grid, colPos: number[], rowPos: number[], input: ContentInput, cw: number, ch: number): Rect {
  const cs = child.style;
  const axis = (lines: AxisLines, start: GridLine, end: GridLine, offset: number, pos: number[], ts: readonly Track[]): [number | null, number | null] => {
    const tracks = ts.length;
    // A start line is where its track starts; an end line is where the previous track ends (gutters are not in the area).
    const startOf = (k: number): number => pos[k]!;
    const endOf = (k: number): number => (k === 0 ? pos[0]! : pos[k - 1]! + ts[k - 1]!.base);
    if (start === "auto" && end === "auto") return [null, null];
    const onlySpan = (start === "auto" || "span" in start) && (end === "auto" || "span" in end);
    if (onlySpan) return [null, null];
    const p: AxisPlacement = resolveAxis(lines, start, end);
    if (!isDefinite(p)) return [null, null];
    const a = p.start + offset;
    const b = p.end + offset;
    // Only `auto` lines are padding edges; a span next to a definite line resolves against it.
    const sAuto = start === "auto";
    const eAuto = end === "auto";
    return [sAuto || a < 0 || a > tracks ? null : startOf(a), eAuto || b < 0 || b > tracks ? null : endOf(b)];
  };
  const [x0, x1] = axis(g.colLines, cs.gridColumnStart, cs.gridColumnEnd, g.colOffset, colPos, g.cols);
  const [y0, y1] = axis(g.rowLines, cs.gridRowStart, cs.gridRowEnd, g.rowOffset, rowPos, g.rows);
  // Padding box edges in border-box coordinates.
  const padL = input.border.left;
  const padT = input.border.top;
  const padR = input.left + cw + input.padding.right;
  const padB = input.top + ch + input.padding.bottom;
  const left = x0 === null ? padL : input.left + x0;
  const right = x1 === null ? padR : input.left + x1;
  const top = y0 === null ? padT : input.top + y0;
  const bottom = y1 === null ? padB : input.top + y1;
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** Intrinsic widths: the column sizes under a min-content and a max-content constraint. */
export function intrinsicGrid(node: LayoutNode): Intrinsic {
  const s = node.style;
  const pbH = pbOf(s, undefined).h;
  const maxW = resolveLength(s, s.maxWidth, undefined, pbH);
  const minW = resolveLength(s, s.minWidth, undefined, pbH);
  const size = (kind: "min-content" | "max-content"): number => {
    const g = buildGrid(node, undefined, undefined, maxW === undefined ? undefined : Math.max(0, maxW - pbH), undefined, minW === undefined ? undefined : Math.max(0, minW - pbH), undefined);
    sizeTracks(g.cols, g.items.map((it) => columnSizingItem(it, g)), { available: { kind }, gap: g.colGap, minSize: 0, maxSize: INF, stretch: false });
    let sum = g.colGap * Math.max(0, g.cols.filter((t) => !t.collapsed).length - 1);
    for (const t of g.cols) sum += t.base;
    return sum;
  };
  return { min: size("min-content"), max: size("max-content") };
}
