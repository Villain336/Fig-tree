import {
  fitContentWidth,
  inlineBounds,
  inlineContribution,
  intrinsic,
  layout,
  place,
  preferredInlineSize,
  space,
  type ContentInput,
  type ContentResult,
} from "./compute";
import { setStatic, type Edges, type Intrinsic, type LayoutNode, type LayoutResult } from "./node";
import {
  INF,
  aspectRatioOf,
  clamp,
  isAuto,
  isOutOfFlow,
  marginOf,
  pbOf,
  ratioHeightFromWidth,
  ratioWidthFromHeight,
  resolveLength,
  type Ratio,
} from "./sizing";
import {
  isLengthPercentage,
  isScrollContainer,
  resolveLPOrZero,
  splitAlignment,
  type ContentAlignment,
  type MaxSize,
  type Size,
  type Style,
} from "./style";

/**
 * CSS Flexible Box Layout 1, following the layout algorithm of §9 step by
 * step: flex base and hypothetical main sizes (§9.2), line collection
 * (§9.3), resolving flexible lengths with the freeze loop (§9.7), cross
 * sizes and stretching (§9.4), main- and cross-axis alignment with auto
 * margins (§9.5, §9.6), baselines (§8.5) and the static position of
 * absolutely positioned children (§4.1). The automatic minimum size of
 * items follows §4.5.
 */

interface Item {
  readonly node: LayoutNode;
  readonly style: Style;
  readonly index: number;
  readonly margin: Edges;
  readonly autoMainStart: boolean;
  readonly autoMainEnd: boolean;
  readonly autoCrossStart: boolean;
  readonly autoCrossEnd: boolean;
  readonly pbH: number;
  readonly pbV: number;
  readonly pbMain: number;
  readonly pbCross: number;
  /** Margins in main-start/main-end and cross-start/cross-end order (physical: cross-start is top/left). */
  readonly marginMainStart: number;
  readonly marginMainEnd: number;
  readonly marginTop: number;
  readonly marginBottom: number;
  readonly marginLeft: number;
  readonly marginRight: number;
  readonly ratio: Ratio | null;
  /** Resolved `align-self` keyword and overflow position. */
  readonly align: string;
  readonly alignSafe: boolean;
  readonly stretches: boolean;
  /** The flexed main size counts as definite (percentages of children resolve against it). */
  mainDefinite: boolean;
  base: number;
  hypo: number;
  minMain: number;
  maxMain: number;
  target: number;
  frozen: boolean;
  violation: number;
  /** Final border-box main size. */
  main: number;
  /** Border-box cross size (hypothetical, then final). */
  cross: number;
  crossFixed: boolean;
  firstBaseline: number | undefined;
  lastBaseline: number | undefined;
  /** Physical border-box position in the container's border box. */
  x: number;
  y: number;
}

interface Line {
  readonly items: Item[];
  cross: number;
  /** Extents of the first- and last-baseline sharing groups: the largest distance from the packing side to the baseline, and the rest. */
  first: { a: number; rest: number };
  last: { a: number; rest: number };
  /** Physical cross position of the line (from the content-box top or left). */
  pos: number;
}

function resolvedAlign(item: Style, container: Style): { value: string; safe: boolean } {
  const raw = item.alignSelf === "auto" ? container.alignItems : item.alignSelf;
  const { overflow, value } = splitAlignment(raw);
  let v = value;
  if (v === "normal") v = "stretch";
  if (v === "first baseline") v = "baseline";
  return { value: v, safe: overflow === "safe" };
}

export function layoutFlex(node: LayoutNode, input: ContentInput): ContentResult {
  const s = node.style;
  const row = s.flexDirection === "row" || s.flexDirection === "row-reverse";
  const reverse = s.flexDirection === "row-reverse" || s.flexDirection === "column-reverse";
  const wrap = s.flexWrap !== "nowrap";
  const wrapReverse = s.flexWrap === "wrap-reverse";
  const cw = input.width;
  const ph = input.percentHeight;
  const mainGap = Math.max(0, row ? resolveLPOrZero(s.columnGap, cw) : resolveLPOrZero(s.rowGap, ph));
  const crossGap = Math.max(0, row ? resolveLPOrZero(s.rowGap, ph) : resolveLPOrZero(s.columnGap, cw));

  // Inner main size when it is known up front, and the space lines break in.
  const mainDefinite = row ? true : input.height !== undefined && input.percentHeight !== undefined;
  const fixedMain = row ? cw : input.height;
  const availMain = row ? cw : input.breakHeight;
  // Cross size, when definite (single-line stretching uses it).
  const fixedCross = row ? input.height : cw;

  // ── Items (§9.1) ──
  const items: Item[] = [];
  const outOfFlow: LayoutNode[] = [];
  node.children.forEach((child, index) => {
    const cs = child.style;
    if (cs.display === "none") {
      if (input.perform) layout(child, space(0, 0, cw, ph), true);
      return;
    }
    if (isOutOfFlow(child)) {
      outOfFlow.push(child);
      return;
    }
    const pb = pbOf(cs, cw);
    const m = marginOf(cs, cw);
    const al = resolvedAlign(cs, s);
    const autoT = isAuto(cs.margin.top);
    const autoB = isAuto(cs.margin.bottom);
    const autoL = isAuto(cs.margin.left);
    const autoR = isAuto(cs.margin.right);
    const autoCrossStart = row ? autoT : autoL;
    const autoCrossEnd = row ? autoB : autoR;
    const crossProp = row ? cs.height : cs.width;
    items.push({
      node: child,
      style: cs,
      index,
      margin: m,
      autoMainStart: row ? (reverse ? autoR : autoL) : reverse ? autoB : autoT,
      autoMainEnd: row ? (reverse ? autoL : autoR) : reverse ? autoT : autoB,
      autoCrossStart,
      autoCrossEnd,
      pbH: pb.h,
      pbV: pb.v,
      pbMain: row ? pb.h : pb.v,
      pbCross: row ? pb.v : pb.h,
      marginMainStart: row ? (reverse ? m.right : m.left) : reverse ? m.bottom : m.top,
      marginMainEnd: row ? (reverse ? m.left : m.right) : reverse ? m.top : m.bottom,
      marginTop: m.top,
      marginBottom: m.bottom,
      marginLeft: m.left,
      marginRight: m.right,
      ratio: aspectRatioOf(child),
      align: al.value,
      alignSafe: al.safe,
      stretches: al.value === "stretch" && crossProp === "auto" && !autoCrossStart && !autoCrossEnd,
      mainDefinite: true,
      base: 0,
      hypo: 0,
      minMain: 0,
      maxMain: INF,
      target: 0,
      frozen: false,
      violation: 0,
      main: 0,
      cross: 0,
      crossFixed: false,
      firstBaseline: undefined,
      lastBaseline: undefined,
      x: 0,
      y: 0,
    });
  });
  items.sort((a, b) => a.style.order - b.style.order || a.index - b.index);

  const outerMain = (it: Item, size: number): number => size + it.marginMainStart + it.marginMainEnd;
  const marginCross = (it: Item): number => (row ? it.marginTop + it.marginBottom : it.marginLeft + it.marginRight);

  /** Width a column item is laid out at before stretching (§9.4 step 7 uses fit-content for auto cross sizes). */
  const columnItemWidth = (it: Item, stretchTo: number | undefined, available = cw): number => {
    const cs = it.style;
    let w = resolveLength(cs, cs.width, cw, it.pbH);
    if (w === undefined) {
      if (cs.width === "min-content") w = intrinsic(it.node).min + it.pbH;
      else if (cs.width === "max-content") w = intrinsic(it.node).max + it.pbH;
      else if (cs.width === "fit-content") w = fitContentWidth(it.node, cw - it.marginLeft - it.marginRight, it.pbH);
      else if (stretchTo !== undefined && it.stretches) w = stretchTo - it.marginLeft - it.marginRight;
      else {
        let h = it.ratio ? definiteMainProp(it) : undefined;
        if (h !== undefined) h = clamp(h, resolveLength(cs, cs.minHeight, ph, it.pbV) ?? 0, resolveLength(cs, cs.maxHeight, ph, it.pbV) ?? INF);
        if (it.ratio && h !== undefined) w = ratioWidthFromHeight(it.ratio, h, it.pbH, it.pbV);
        else w = fitContentWidth(it.node, available - it.marginLeft - it.marginRight, it.pbH);
      }
    }
    const b = inlineBounds(it.node, cw, it.pbH);
    return Math.max(it.pbH, clamp(w, b.min, b.max));
  };

  /** The item's `width`/`height` in the main axis when definite (border-box). */
  const definiteMainProp = (it: Item): number | undefined => resolveLength(it.style, row ? it.style.width : it.style.height, row ? cw : ph, it.pbMain);
  /** The item's definite cross size: its cross size property, or the stretched size of a single-line container with a definite cross size. */
  const definiteCross = (it: Item): number | undefined => {
    const cs = it.style;
    const v = resolveLength(cs, row ? cs.height : cs.width, row ? ph : cw, it.pbCross);
    if (v !== undefined) return clampCross(it, v);
    if (!wrap && it.stretches && fixedCross !== undefined && (row ? ph !== undefined : true)) return clampCross(it, fixedCross - marginCross(it));
    return undefined;
  };
  const clampCross = (it: Item, v: number): number => {
    const cs = it.style;
    if (row) {
      const min = resolveLength(cs, cs.minHeight, ph, it.pbV) ?? 0;
      const max = resolveLength(cs, cs.maxHeight, ph, it.pbV) ?? INF;
      return Math.max(it.pbV, clamp(v, min, max));
    }
    const b = inlineBounds(it.node, cw, it.pbH);
    return Math.max(it.pbH, clamp(v, b.min, b.max));
  };

  /** Content-based main size of a column item at a width (its height with `height: auto`). */
  const columnContentHeight = (it: Item, width: number): number =>
    layout(it.node, space(width, undefined, cw, ph, { contentHeight: true }), false).height;

  const columnWidths = new Map<Item, number>();
  const columnWidth = (it: Item): number => {
    let w = columnWidths.get(it);
    if (w === undefined) columnWidths.set(it, (w = columnItemWidth(it, wrap ? undefined : cw)));
    return w;
  };

  // ── Flex base size and hypothetical main size (§9.2.3) ──
  for (const it of items) {
    const cs = it.style;
    let basis: Size | "content" = cs.flexBasis;
    if (basis === "auto") basis = row ? cs.width : cs.height;
    let base: number | undefined;
    if (isLengthPercentage(basis)) base = resolveLength(cs, basis, row ? cw : ph, it.pbMain);
    // Like Chromium, a column item's flexed height is definite when the container's height is, or when its flex basis is.
    it.mainDefinite = row || mainDefinite || base !== undefined;
    if (base === undefined) {
      const cross = it.ratio ? definiteCross(it) : undefined;
      if (it.ratio && cross !== undefined && (basis === "auto" || basis === "content" || isLengthPercentage(basis))) {
        // (B) a preferred aspect ratio and a definite cross size.
        base = row ? ratioWidthFromHeight(it.ratio, cross, it.pbH, it.pbV) : ratioHeightFromWidth(it.ratio, cross, it.pbH, it.pbV);
      } else if (row) {
        if (basis === "min-content") base = intrinsic(it.node).min + it.pbH;
        else if (basis === "fit-content") base = fitContentWidth(it.node, cw - it.marginLeft - it.marginRight, it.pbH);
        else base = intrinsic(it.node).max + it.pbH;
      } else {
        // (E) lay the item out at its cross size and use its content height.
        base = columnContentHeight(it, columnWidth(it));
      }
    }
    it.base = Math.max(base, it.pbMain);
    const bounds = mainBounds(it);
    it.minMain = bounds.min;
    it.maxMain = bounds.max;
    it.hypo = Math.max(it.pbMain, clamp(it.base, it.minMain, it.maxMain));
  }

  function mainBounds(it: Item): { min: number; max: number } {
    const cs = it.style;
    const minProp: Size = row ? cs.minWidth : cs.minHeight;
    const maxProp: MaxSize = row ? cs.maxWidth : cs.maxHeight;
    const basis = row ? cw : ph;
    let max = INF;
    if (maxProp !== "none") max = keywordMain(it, maxProp) ?? resolveLength(cs, maxProp, basis, it.pbMain) ?? INF;
    let min: number;
    if (minProp === "auto") {
      min = isScrollContainer(row ? cs.overflowX : cs.overflowY) ? 0 : automaticMinimum(it, max);
    } else {
      min = keywordMain(it, minProp) ?? resolveLength(cs, minProp, basis, it.pbMain) ?? 0;
    }
    return { min, max: Math.max(min, max) };
  }

  /** Intrinsic keywords in the main axis. */
  function keywordMain(it: Item, v: Size | MaxSize): number | undefined {
    if (v !== "min-content" && v !== "max-content" && v !== "fit-content") return undefined;
    if (row) {
      const i = intrinsic(it.node);
      return (v === "min-content" ? i.min : i.max) + it.pbH;
    }
    return columnContentHeight(it, columnWidth(it));
  }

  /** The automatic minimum size of a flex item in the main axis (§4.5). */
  function automaticMinimum(it: Item, maxMain: number): number {
    let content = row ? intrinsic(it.node).min + it.pbH : columnContentHeight(it, columnWidth(it));
    // With a preferred aspect ratio and a definite cross size, the min-content size is transferred through the ratio.
    const crossForRatio = it.ratio && !it.node.replaced ? (row ? definiteCross(it) : columnWidth(it)) : undefined;
    if (crossForRatio !== undefined) {
      const transferred = row ? ratioWidthFromHeight(it.ratio!, crossForRatio, it.pbH, it.pbV) : ratioHeightFromWidth(it.ratio!, crossForRatio, it.pbH, it.pbV);
      content = Math.max(content, transferred);
    }
    if (it.ratio) {
      // Clamp by definite min/max cross sizes converted through the ratio.
      const cs = it.style;
      const minC = row ? resolveLength(cs, cs.minHeight, ph, it.pbV) : resolveLength(cs, cs.minWidth, cw, it.pbH);
      const maxC = row ? resolveLength(cs, cs.maxHeight, ph, it.pbV) : resolveLength(cs, cs.maxWidth, cw, it.pbH);
      const conv = (c: number): number => (row ? ratioWidthFromHeight(it.ratio!, c, it.pbH, it.pbV) : ratioHeightFromWidth(it.ratio!, c, it.pbH, it.pbV));
      if (minC !== undefined) content = Math.max(content, conv(minC));
      if (maxC !== undefined) content = Math.min(content, conv(maxC));
    }
    content = Math.min(content, maxMain);
    const specified = definiteMainProp(it);
    let result = content;
    if (specified !== undefined) result = Math.min(specified, content);
    else if (it.ratio && it.node.replaced) {
      const cross = definiteCross(it);
      if (cross !== undefined) {
        const transferred = row ? ratioWidthFromHeight(it.ratio, cross, it.pbH, it.pbV) : ratioHeightFromWidth(it.ratio, cross, it.pbH, it.pbV);
        result = Math.min(transferred, content);
      }
    }
    return Math.min(result, maxMain);
  }

  // ── Collect items into lines (§9.3) ──
  const lines: Line[] = [];
  {
    let cur: Item[] = [];
    let used = 0;
    for (const it of items) {
      const size = outerMain(it, it.hypo);
      if (wrap && cur.length > 0 && used + mainGap + size > availMain + 1e-7) {
        lines.push(newLine(cur));
        cur = [];
        used = 0;
      }
      used += (cur.length > 0 ? mainGap : 0) + size;
      cur.push(it);
    }
    if (cur.length > 0 || lines.length === 0) lines.push(newLine(cur));
  }

  // ── Main size of the container (§9.2.4) ──
  let innerMain: number;
  if (fixedMain !== undefined) innerMain = fixedMain;
  else {
    let longest = 0;
    for (const line of lines) {
      let sum = 0;
      line.items.forEach((it, i) => (sum += outerMain(it, it.hypo) + (i > 0 ? mainGap : 0)));
      longest = Math.max(longest, sum);
    }
    innerMain = clamp(longest, input.minHeight, input.maxHeight);
  }

  // ── Resolve flexible lengths (§9.7) ──
  for (const line of lines) resolveFlexibleLengths(line.items, innerMain, mainGap, outerMain);

  // ── Hypothetical cross sizes (§9.4 step 7) ──
  const measure = (it: Item): LayoutResult => {
    if (row) return layout(it.node, space(it.main, it.crossFixed ? it.cross : undefined, cw, ph), false);
    return layout(it.node, space(it.cross, it.main, cw, ph, { heightIndefinite: !it.mainDefinite }), false);
  };
  for (const it of items) {
    if (!row) it.cross = columnWidth(it);
    const r = measure(it);
    if (row) it.cross = r.height;
    it.firstBaseline = r.firstBaseline;
    it.lastBaseline = r.lastBaseline;
  }

  // ── Line cross sizes (§9.4 step 8) ──
  const single = !wrap;
  for (const line of lines) {
    if (single && fixedCross !== undefined) {
      line.cross = fixedCross;
      measureBaselines(line);
    } else {
      line.cross = lineCrossSize(line);
    }
    if (!row && wrap) {
      // Like Chromium: in a multi-line column container, items that are not
      // stretched fit their width into their line's cross size, not the
      // container's (their flexed heights stay).
      for (const it of line.items) {
        if (it.stretches) continue;
        const w = columnItemWidth(it, undefined, line.cross);
        if (w !== it.cross) {
          it.cross = w;
          const r = measure(it);
          it.firstBaseline = r.firstBaseline;
          it.lastBaseline = r.lastBaseline;
        }
      }
      line.cross = lineCrossSize(line);
    }
  }
  let innerCross: number;
  if (fixedCross !== undefined) innerCross = fixedCross;
  else {
    let sum = 0;
    lines.forEach((l, i) => (sum += l.cross + (i > 0 ? crossGap : 0)));
    innerCross = clamp(sum, input.minHeight, input.maxHeight);
    if (single) lines[0]!.cross = innerCross;
  }

  // ── align-content (§9.4 step 15, §8.4) ──
  {
    let sum = 0;
    lines.forEach((l, i) => (sum += l.cross + (i > 0 ? crossGap : 0)));
    const free = innerCross - sum;
    let start = 0;
    let between = 0;
    if (single) {
      start = 0;
    } else {
      const { overflow, value } = splitAlignment(s.alignContent);
      const n = lines.length;
      const dist = distribute(value, overflow === "safe", free, n, true, wrapReverse, false);
      start = dist.start;
      between = dist.between;
      if ((value === "stretch" || value === "normal") && free > 0) for (const l of lines) l.cross += free / n;
    }
    // Logical (cross-start based) offsets, mapped to physical positions.
    let pos = start;
    for (const l of lines) {
      l.pos = wrapReverse ? innerCross - pos - l.cross : pos;
      pos += l.cross + crossGap + between;
    }
  }

  // ── Stretch (§9.4 step 11) ──
  for (const line of lines) {
    for (const it of line.items) {
      if (!it.stretches) continue;
      const cross = clampCross(it, line.cross - marginCross(it));
      if (row) {
        if (!it.crossFixed || it.cross !== cross) {
          it.cross = cross;
          it.crossFixed = true;
          const r = measure(it);
          it.firstBaseline = r.firstBaseline;
          it.lastBaseline = r.lastBaseline;
        }
      } else if (it.cross !== cross) {
        it.cross = cross;
        const r = measure(it);
        it.firstBaseline = r.firstBaseline;
        it.lastBaseline = r.lastBaseline;
      }
    }
  }

  // ── Main-axis alignment (§9.5) ──
  const jc = splitAlignment(s.justifyContent);
  for (const line of lines) {
    let used = 0;
    let autos = 0;
    line.items.forEach((it, i) => {
      used += outerMain(it, it.main) + (i > 0 ? mainGap : 0);
      autos += (it.autoMainStart ? 1 : 0) + (it.autoMainEnd ? 1 : 0);
    });
    let free = innerMain - used;
    let autoShare = 0;
    let start = 0;
    let between = 0;
    if (autos > 0 && free > 0) {
      autoShare = free / autos;
      free = 0;
    } else {
      const d = distribute(jc.value, jc.overflow === "safe", free, line.items.length, false, reverse, row);
      start = d.start;
      between = d.between;
    }
    let pos = start;
    for (const it of line.items) {
      pos += it.marginMainStart + (it.autoMainStart ? autoShare : 0);
      const mainPos = reverse ? innerMain - pos - it.main : pos;
      if (row) it.x = input.left + mainPos;
      else it.y = input.top + mainPos;
      pos += it.main + it.marginMainEnd + (it.autoMainEnd ? autoShare : 0) + mainGap + between;
    }
  }

  // ── Cross-axis alignment (§9.6) ──
  for (const line of lines) {
    for (const it of line.items) {
      const mStart = row ? it.marginTop : it.marginLeft;
      const mEnd = row ? it.marginBottom : it.marginRight;
      const outer = it.cross + mStart + mEnd;
      const free = line.cross - outer;
      let off: number;
      if (it.autoCrossStart || it.autoCrossEnd) {
        if (free > 0) off = it.autoCrossStart && it.autoCrossEnd ? free / 2 : it.autoCrossStart ? free : 0;
        else off = wrapReverse ? free : 0;
      } else {
        off = crossOffset(it, line, free);
      }
      const p = (row ? input.top : input.left) + line.pos + off + mStart;
      if (row) it.y = p;
      else it.x = p;
    }
  }

  function crossOffset(it: Item, line: Line, free: number): number {
    let v = it.align;
    if (it.alignSafe && free < 0) v = "start";
    switch (v) {
      case "baseline":
      case "last baseline": {
        const g = baselineGroup(it, v === "last baseline");
        const group = v === "last baseline" ? line.last : line.first;
        return g.atEnd ? free - (group.a - g.a) : group.a - g.a;
      }
      case "center":
        return free / 2;
      case "start":
      case "self-start":
        return 0;
      case "end":
      case "self-end":
        return free;
      case "flex-end":
        return wrapReverse ? 0 : free;
      default: // flex-start, stretch
        return wrapReverse ? free : 0;
    }
  }

  // ── Container height and baselines ──
  const contentHeight = row ? (input.height ?? innerCross) : (input.height ?? innerMain);
  let firstBaseline: number | undefined;
  let lastBaseline: number | undefined;
  if (items.length > 0) {
    const firstLine = lines[0]!;
    const lastLine = lines[lines.length - 1]!;
    const baselineOf = (it: Item, last: boolean): number => it.y + ((last ? it.lastBaseline : it.firstBaseline) ?? (row ? it.cross : it.main));
    if (row) {
      const group = firstLine.items.find((it) => it.align === "baseline" && !it.autoCrossStart && !it.autoCrossEnd);
      firstBaseline = baselineOf(group ?? firstLine.items[0]!, false);
      const lastGroup = lastLine.items.find((it) => it.align === "last baseline" && !it.autoCrossStart && !it.autoCrossEnd);
      lastBaseline = baselineOf(lastGroup ?? lastLine.items[lastLine.items.length - 1]!, true);
    } else {
      firstBaseline = baselineOf(firstLine.items[0]!, false);
      lastBaseline = baselineOf(lastLine.items[lastLine.items.length - 1]!, true);
    }
  }

  // ── Final layout ──
  if (input.perform) {
    for (const it of items) {
      if (row) layout(it.node, space(it.main, it.crossFixed ? it.cross : undefined, cw, ph), true);
      else layout(it.node, space(it.cross, it.main, cw, ph, { heightIndefinite: !it.mainDefinite }), true);
      place(it.node, it.x, it.y, cw, ph);
      it.node.out.margin = finalMargins(it, lines);
    }
  }

  // ── Static positions of absolutely positioned children (§4.1) ──
  for (const child of outOfFlow) {
    const cs = child.style;
    const jcv = splitAlignment(s.justifyContent).value;
    const mainFrac = staticFraction(jcv, reverse, row, false);
    const al = resolvedAlign(cs, s).value;
    // Baselines fall back to start/end alignment (physical, as Chromium does); stretch to flex-start.
    const crossFrac = staticFraction(al === "baseline" ? "start" : al === "last baseline" ? "end" : al === "stretch" ? "flex-start" : al, wrapReverse, !row, true);
    const w = row ? cw : cw;
    if (row) setStatic(child, input.left, input.top, w, contentHeight, mainFrac, crossFrac);
    else setStatic(child, input.left, input.top, w, contentHeight, crossFrac, mainFrac);
  }

  return { height: contentHeight, firstBaseline, lastBaseline };

  function newLine(lineItems: Item[]): Line {
    return { items: lineItems, cross: 0, first: { a: 0, rest: 0 }, last: { a: 0, rest: 0 }, pos: 0 };
  }

  /**
   * An item's baseline in the cross axis, from its border-box cross-start
   * edge. Rows use the content's first or last baseline, synthesized from
   * the border box's bottom edge when there is none. Horizontal items have
   * no baseline in a column container's (horizontal) cross axis: it is
   * synthesized from the border box's start or end edge.
   */
  /**
   * Baseline alignment (§8.3): a baseline-sharing group packs against one
   * physical side of the line, the cross-start side for first baselines and
   * the cross-end side for last baselines (so `wrap-reverse` flips them).
   * `a` is the distance from the item's margin edge on that side to its
   * baseline. Rows use the content's baseline, synthesized from the border
   * box's bottom edge when there is none; horizontal items have no baseline
   * in a column container's (horizontal) cross axis, so (as Chromium does)
   * it is synthesized at the left border edge.
   */
  function baselineGroup(it: Item, last: boolean): { a: number; atEnd: boolean } {
    const atEnd = last !== wrapReverse;
    // Column containers: synthesized at the physical left border edge, whichever side the group packs to.
    if (!row) return { a: atEnd ? it.marginRight + it.cross : it.marginLeft, atEnd };
    const bl = (last ? it.lastBaseline : it.firstBaseline) ?? it.cross;
    return { a: atEnd ? it.marginBottom + it.cross - bl : it.marginTop + bl, atEnd };
  }

  function measureBaselines(line: Line): number {
    let maxOuter = 0;
    // Groups start empty: a margin can make every member's distance negative.
    line.first = { a: -INF, rest: -INF };
    line.last = { a: -INF, rest: -INF };
    for (const it of line.items) {
      const outer = it.cross + marginCross(it);
      const participates = !it.autoCrossStart && !it.autoCrossEnd;
      if (participates && (it.align === "baseline" || it.align === "last baseline")) {
        const last = it.align === "last baseline";
        const g = baselineGroup(it, last);
        const group = last ? line.last : line.first;
        group.a = Math.max(group.a, g.a);
        group.rest = Math.max(group.rest, outer - g.a);
      } else {
        maxOuter = Math.max(maxOuter, outer);
      }
    }
    const extent = (g: { a: number; rest: number }): number => (g.a === -INF ? 0 : g.a + g.rest);
    return Math.max(maxOuter, extent(line.first), extent(line.last));
  }

  function lineCrossSize(line: Line): number {
    return measureBaselines(line);
  }
}

function finalMargins(it: Item, _lines: Line[]): Edges {
  return { top: it.marginTop, right: it.marginRight, bottom: it.marginBottom, left: it.marginLeft };
}

/**
 * The flex algorithm's step 9.7 for one line: grows or shrinks items from
 * their flex base sizes toward the inner main size, freezing items that hit
 * their min or max (the freeze loop). Sets `main` on every item.
 */
export function resolveFlexibleLengths(
  items: readonly {
    base: number;
    hypo: number;
    minMain: number;
    maxMain: number;
    pbMain: number;
    target: number;
    frozen: boolean;
    violation: number;
    main: number;
    readonly style: Style;
  }[],
  innerMain: number,
  gap: number,
  outer: (it: never, size: number) => number,
): void {
  type It = (typeof items)[number];
  const outerOf = outer as unknown as (it: It, size: number) => number;
  if (items.length === 0) return;
  const gaps = gap * (items.length - 1);
  let hypoSum = gaps;
  for (const it of items) hypoSum += outerOf(it, it.hypo);
  const growing = hypoSum < innerMain;
  // Size inflexible items.
  for (const it of items) {
    const factor = growing ? it.style.flexGrow : it.style.flexShrink;
    it.frozen = false;
    it.target = it.base;
    if (factor === 0 || (growing && it.base > it.hypo) || (!growing && it.base < it.hypo)) {
      it.frozen = true;
      it.target = it.hypo;
    }
  }
  const freeSpace = (): number => {
    let used = gaps;
    for (const it of items) used += outerOf(it, it.frozen ? it.target : it.base);
    return innerMain - used;
  };
  const initialFree = freeSpace();
  for (let guard = 0; guard <= items.length + 1; guard++) {
    const unfrozen = items.filter((it) => !it.frozen);
    if (unfrozen.length === 0) break;
    let remaining = freeSpace();
    let sumFactors = 0;
    for (const it of unfrozen) sumFactors += growing ? it.style.flexGrow : it.style.flexShrink;
    if (sumFactors < 1) {
      const scaled = initialFree * sumFactors;
      if (Math.abs(scaled) < Math.abs(remaining)) remaining = scaled;
    }
    if (remaining !== 0 && Number.isFinite(remaining)) {
      if (growing) {
        for (const it of unfrozen) it.target = it.base + (remaining * it.style.flexGrow) / sumFactors;
      } else {
        let sumScaled = 0;
        for (const it of unfrozen) sumScaled += it.style.flexShrink * Math.max(0, it.base - it.pbMain);
        for (const it of unfrozen) {
          const scaled = it.style.flexShrink * Math.max(0, it.base - it.pbMain);
          it.target = sumScaled > 0 ? it.base - (Math.abs(remaining) * scaled) / sumScaled : it.base;
        }
      }
    } else {
      for (const it of unfrozen) it.target = it.base;
    }
    // Fix min/max violations.
    let total = 0;
    for (const it of unfrozen) {
      const clamped = Math.max(it.pbMain, clamp(it.target, it.minMain, it.maxMain));
      it.violation = clamped - it.target;
      it.target = clamped;
      total += it.violation;
    }
    if (Math.abs(total) < 1e-9) {
      for (const it of unfrozen) it.frozen = true;
    } else {
      for (const it of unfrozen) if ((total > 0 && it.violation > 0) || (total < 0 && it.violation < 0)) it.frozen = true;
    }
  }
  for (const it of items) it.main = it.target;
}

/**
 * Distribution of `free` space among `n` subjects for a content-distribution
 * value (`justify-content` / `align-content`): the offset before the first
 * subject and the extra space between subjects, in the axis's logical
 * direction. `reverse` says the logical start is the physical end;
 * `leftRight` says `left`/`right` are meaningful (a horizontal axis).
 */
function distribute(value: string, safe: boolean, free: number, n: number, crossAxis: boolean, reverse: boolean, leftRight: boolean): { start: number; between: number } {
  const physicalStart = reverse ? free : 0;
  const physicalEnd = reverse ? 0 : free;
  if (safe && free < 0) return { start: physicalStart, between: 0 };
  switch (value as ContentAlignment) {
    case "flex-start":
    case "normal":
    case "stretch":
      return { start: 0, between: 0 };
    case "flex-end":
      return { start: free, between: 0 };
    case "start":
      return { start: physicalStart, between: 0 };
    case "end":
      return { start: physicalEnd, between: 0 };
    case "left":
      return { start: leftRight ? physicalStart : physicalStart, between: 0 };
    case "right":
      return { start: leftRight ? physicalEnd : physicalStart, between: 0 };
    case "center":
      return { start: free / 2, between: 0 };
    case "space-between":
      if (free <= 0 || n < 2) return { start: 0, between: 0 };
      return { start: 0, between: free / (n - 1) };
    // space-around and space-evenly fall back to `safe center`.
    case "space-around":
      if (free <= 0) return { start: free < 0 ? physicalStart : 0, between: 0 };
      return { start: free / n / 2, between: free / n };
    case "space-evenly":
      if (free <= 0) return { start: free < 0 ? physicalStart : 0, between: 0 };
      return { start: free / (n + 1), between: free / (n + 1) };
    default:
      void crossAxis;
      return { start: 0, between: 0 };
  }
}

/** Where a sole item's margin box sits in the static-position area (0 start, 0.5 center, 1 end), physically. */
function staticFraction(value: string, reverse: boolean, horizontal: boolean, self: boolean): number {
  const { value: v } = splitAlignment(value);
  switch (v) {
    case "center":
    case "space-around":
    case "space-evenly":
      return 0.5;
    case "flex-end":
      return reverse ? 0 : 1;
    case "end":
    case "self-end":
      return 1;
    case "start":
    case "self-start":
      return 0;
    case "left":
      return horizontal ? 0 : 0;
    case "right":
      return horizontal ? 1 : 0;
    default:
      void self;
      return reverse ? 1 : 0; // flex-start, normal, stretch, space-between
  }
}

// ── Intrinsic sizes (§9.9) ───────────────────────────────────────────────

/**
 * Intrinsic inline sizes of a flex container. Row containers add up their
 * items' contributions; each one follows §9.9.3 as Chromium implements it:
 * the item's ordinary contribution (its preferred size when definite,
 * otherwise its content size), clamped by its flex base size as a maximum
 * when it cannot grow and as a minimum when it cannot shrink, then by its
 * min/max main size. A wrapping container's min-content size is its largest
 * plain (unclamped) min-content contribution. Like Chromium, the §9.9.1
 * flex-fraction algorithm is not used. Column containers take their widest item, except
 * that a wrapping column container with a definite height lays its items
 * out in columns and adds the columns up for its max-content size.
 */
export function intrinsicFlex(node: LayoutNode): Intrinsic {
  const s = node.style;
  const row = s.flexDirection === "row" || s.flexDirection === "row-reverse";
  const wrap = s.flexWrap !== "nowrap";
  const kids = node.children.filter((c) => c.style.display !== "none" && !isOutOfFlow(c));
  let min = 0;
  let max = 0;
  if (row) {
    for (const c of kids) {
      if (wrap) min = Math.max(min, inlineContribution(c, "min"));
      else min += rowContribution(c, "min");
      max += rowContribution(c, "max");
    }
    if (kids.length > 1) {
      const gap = Math.max(0, resolveLPOrZero(s.columnGap, undefined)) * (kids.length - 1);
      max += gap;
      if (!wrap) min += gap;
    }
    return { min, max };
  }
  for (const c of kids) {
    min = Math.max(min, inlineContribution(c, "min"));
    max = Math.max(max, inlineContribution(c, "max"));
  }
  if (wrap && kids.length > 1) {
    const pbV = pbOf(s, undefined).v;
    const h = resolveLength(s, s.height, undefined, pbV) ?? resolveLength(s, s.maxHeight, undefined, pbV);
    if (h !== undefined) max = Math.max(min, columnWrapWidth(node, kids, Math.max(0, h - pbV)));
  }
  return { min, max };
}

/** A flex item's main-size contribution to a row flex container (§9.9.3). */
function rowContribution(c: LayoutNode, kind: "min" | "max"): number {
  const cs = c.style;
  const pb = pbOf(cs, undefined);
  const m = marginOf(cs, undefined);
  const i = intrinsic(c);
  // Flex base size under this constraint.
  let basis: Size | "content" = cs.flexBasis;
  if (basis === "auto") basis = cs.width;
  let base = isLengthPercentage(basis) ? resolveLength(cs, basis, undefined, pb.h) : undefined;
  if (base === undefined) {
    if (basis === "min-content") base = i.min + pb.h;
    else if (basis === "max-content") base = i.max + pb.h;
    else base = preferredInlineSize(c, kind, undefined, undefined, pb.h, pb.v);
  }
  base = Math.max(base, pb.h);
  // Chromium starts from the ordinary contribution (the preferred size when definite), not the larger of it and the content size.
  let w = preferredInlineSize(c, kind, undefined, undefined, pb.h, pb.v);
  if (cs.flexGrow === 0) w = Math.min(w, base);
  if (cs.flexShrink === 0) w = Math.max(w, base);
  let autoMin = 0;
  if (cs.minWidth === "auto" && !isScrollContainer(cs.overflowX)) {
    const spec = resolveLength(cs, cs.width, undefined, pb.h);
    autoMin = spec === undefined ? i.min + pb.h : Math.min(spec, i.min + pb.h);
    // The automatic minimum is capped by the maximum main size.
    autoMin = Math.min(autoMin, inlineBounds(c, undefined, pb.h).max);
  }
  const b = inlineBounds(c, undefined, pb.h, autoMin);
  return Math.max(pb.h, clamp(w, b.min, Math.max(b.min, b.max))) + m.left + m.right;
}

/** Max-content width of a wrapping column flex container whose lines break at `height`. */
function columnWrapWidth(node: LayoutNode, kids: readonly LayoutNode[], height: number): number {
  const s = node.style;
  const rowGap = Math.max(0, resolveLPOrZero(s.rowGap, height));
  const colGap = Math.max(0, resolveLPOrZero(s.columnGap, undefined));
  let total = 0;
  let lines = 0;
  let lineWidth = 0;
  let used = 0;
  let count = 0;
  for (const c of kids) {
    const cs = c.style;
    const pb = pbOf(cs, undefined);
    const m = marginOf(cs, undefined);
    const outerW = inlineContribution(c, "max");
    const w = Math.max(pb.h, outerW - m.left - m.right);
    let basis: Size | "content" = cs.flexBasis;
    if (basis === "auto") basis = cs.height;
    let main = isLengthPercentage(basis) ? resolveLength(cs, basis, undefined, pb.v) : undefined;
    main ??= layout(c, space(w, undefined, undefined, undefined, { contentHeight: true }), false).height;
    const minH = resolveLength(cs, cs.minHeight, undefined, pb.v) ?? 0;
    const maxH = resolveLength(cs, cs.maxHeight, undefined, pb.v) ?? INF;
    const outerMain = Math.max(pb.v, clamp(main, minH, maxH)) + m.top + m.bottom;
    if (count > 0 && used + rowGap + outerMain > height + 1e-7) {
      total += lineWidth;
      lines++;
      lineWidth = 0;
      used = 0;
      count = 0;
    }
    used += (count > 0 ? rowGap : 0) + outerMain;
    lineWidth = Math.max(lineWidth, outerW);
    count++;
  }
  total += lineWidth;
  lines++;
  return total + colGap * (lines - 1);
}
