/**
 * The grid track sizing algorithm (CSS Grid 1 §11.3–§11.8) for one axis,
 * as a pure function of track sizing functions and item contributions:
 * initialize track sizes (§11.4), resolve intrinsic track sizes including
 * spanning items and items crossing flexible tracks, with the "distribute
 * extra space" procedure (§11.5), maximize tracks (§11.6), expand flexible
 * tracks with "find the size of an fr" (§11.7) and stretch `auto` tracks
 * (§11.8).
 */

const INF = Number.POSITIVE_INFINITY;
const EPS = 1e-9;

/** A resolved track sizing function (percentages already resolved, or turned into `auto` when indefinite). */
export type SizingFn =
  | { readonly kind: "fixed"; readonly value: number }
  | { readonly kind: "auto" }
  | { readonly kind: "min-content" }
  | { readonly kind: "max-content" }
  | { readonly kind: "fr"; readonly value: number }
  | { readonly kind: "fit-content"; readonly value: number };

export interface Track {
  readonly min: SizingFn;
  readonly max: SizingFn;
  /** An empty `auto-fit` track: sized 0, its gutters collapse. */
  readonly collapsed: boolean;
  base: number;
  limit: number;
  infinitelyGrowable: boolean;
  planned: number;
  incurred: number;
}

export function track(min: SizingFn, max: SizingFn, collapsed = false): Track {
  return { min, max, collapsed, base: 0, limit: 0, infinitelyGrowable: false, planned: 0, incurred: 0 };
}

/** An item's span in this axis and its outer contributions (computed lazily by the caller). */
export interface SizingItem {
  readonly start: number;
  readonly span: number;
  /** The smallest outer size it can have (its automatic or specified minimum as its preferred size). */
  minContribution(): number;
  minContent(): number;
  maxContent(): number;
}

export type Available =
  | { readonly kind: "definite"; readonly size: number }
  | { readonly kind: "min-content" }
  | { readonly kind: "max-content" }
  /** Sized by content but not under a constraint (an `auto` block size). */
  | { readonly kind: "indefinite" };

export interface SizingOptions {
  readonly available: Available;
  readonly gap: number;
  /** The container's content-box min and max size in this axis (0 / ∞ when none). */
  readonly minSize: number;
  readonly maxSize: number;
  /** `justify-content`/`align-content` is `normal` or `stretch`: `auto` tracks absorb free space (§11.8). */
  readonly stretch: boolean;
}

const isIntrinsic = (f: SizingFn): boolean => f.kind === "auto" || f.kind === "min-content" || f.kind === "max-content" || f.kind === "fit-content";
const isFlex = (t: Track): boolean => t.max.kind === "fr";
const flexFactor = (t: Track): number => (t.max.kind === "fr" ? t.max.value : 0);
/** `auto` and `fit-content()` maxima behave as `max-content` (fit-content capped by its argument). */
const isMaxContentMax = (f: SizingFn): boolean => f.kind === "max-content" || f.kind === "auto" || f.kind === "fit-content";

/** Sizes the tracks in place (base sizes are the used sizes). */
export function sizeTracks(tracks: Track[], items: readonly SizingItem[], o: SizingOptions): void {
  const underConstraint = o.available.kind === "min-content" || o.available.kind === "max-content";
  const live = tracks.filter((t) => !t.collapsed);
  const gaps = o.gap * Math.max(0, live.length - 1);

  // §11.4 Initialize track sizes.
  for (const t of tracks) {
    t.base = t.collapsed ? 0 : t.min.kind === "fixed" ? t.min.value : 0;
    t.limit = t.collapsed ? 0 : t.max.kind === "fixed" ? t.max.value : INF;
    if (t.limit < t.base) t.limit = t.base;
    t.infinitelyGrowable = false;
  }

  // Limited contributions: capped by the spanned tracks' fixed maxima (when all are fixed), floored by the minimum contribution.
  const fixedMaxCap = (it: SizingItem): number => {
    let sum = o.gap * (it.span - 1);
    for (let i = it.start; i < it.start + it.span; i++) {
      const m = tracks[i]!.max;
      if (m.kind === "fixed" || m.kind === "fit-content") sum += m.value;
      else return INF;
    }
    return sum;
  };
  const limitedMin = (it: SizingItem): number => Math.max(Math.min(it.minContent(), fixedMaxCap(it)), it.minContribution());
  const limitedMax = (it: SizingItem): number => Math.max(Math.min(it.maxContent(), fixedMaxCap(it)), it.minContribution());

  const spansFlex = (it: SizingItem): boolean => {
    for (let i = it.start; i < it.start + it.span; i++) if (isFlex(tracks[i]!)) return true;
    return false;
  };

  // §11.5 step 2: tracks with intrinsic sizing functions, items with a span of 1 not in flexible tracks.
  for (const it of items) {
    if (it.span !== 1) continue;
    const t = tracks[it.start]!;
    if (t.collapsed || isFlex(t)) continue;
    if (t.min.kind === "min-content") t.base = Math.max(t.base, it.minContent());
    else if (t.min.kind === "max-content") t.base = Math.max(t.base, it.maxContent());
    else if (t.min.kind === "auto") t.base = Math.max(t.base, underConstraint ? limitedMin(it) : it.minContribution());
    if (t.max.kind === "min-content") t.limit = max0(t.limit, it.minContent());
    else if (isMaxContentMax(t.max)) {
      let v = it.maxContent();
      if (t.max.kind === "fit-content") v = Math.min(v, t.max.value);
      t.limit = max0(t.limit, v);
    }
  }
  for (const t of tracks) if (t.limit < t.base) t.limit = t.base;

  // §11.5 step 3: spanning items not crossing flexible tracks, by increasing span.
  const spanning = items.filter((it) => it.span > 1 && !spansFlex(it)).sort((a, b) => a.span - b.span);
  for (let i = 0; i < spanning.length; ) {
    let j = i;
    while (j < spanning.length && spanning[j]!.span === spanning[i]!.span) j++;
    const group = spanning.slice(i, j);
    accommodate(group, () => true, false);
    i = j;
  }

  // §11.5 step 4: items crossing flexible tracks, space going to flexible tracks only. The spec handles
  // them all together; Chromium groups them by span like step 3, and so do we.
  const crossing = items.filter((it) => spansFlex(it)).sort((a, b) => a.span - b.span);
  for (let i = 0; i < crossing.length; ) {
    let j = i;
    while (j < crossing.length && crossing[j]!.span === crossing[i]!.span) j++;
    accommodate(crossing.slice(i, j), isFlex, true);
    i = j;
  }

  // §11.5 step 5.
  for (const t of tracks) if (t.limit === INF) t.limit = t.base;

  /** The six sub-steps of §11.5 step 3 for one group of items, restricted to `eligible` tracks. */
  function accommodate(group: readonly SizingItem[], eligible: (t: Track) => boolean, byFlex: boolean): void {
    // 1. Intrinsic minimums. (For items crossing flexible tracks Chromium keeps the minimum contribution
    // under a min-/max-content constraint too, instead of the limited min-content contribution.)
    distribute(group, (t) => eligible(t) && isIntrinsic(t.min), true, underConstraint && !byFlex ? limitedMin : (it) => it.minContribution(), "min", byFlex);
    // 2. Content-based minimums.
    distribute(group, (t) => eligible(t) && (t.min.kind === "min-content" || t.min.kind === "max-content"), true, (it) => it.minContent(), "min", byFlex);
    // 3. Max-content minimums.
    if (o.available.kind === "max-content") distribute(group, (t) => eligible(t) && (t.min.kind === "auto" || t.min.kind === "max-content"), true, limitedMax, "max", byFlex);
    distribute(group, (t) => eligible(t) && t.min.kind === "max-content", true, (it) => it.maxContent(), "max", byFlex);
    // 4.
    for (const t of tracks) if (t.limit < t.base) t.limit = t.base;
    if (byFlex) return; // flexible tracks have no intrinsic maximum
    // 5. Intrinsic maximums.
    const before = tracks.map((t) => t.limit);
    distribute(group, (t) => eligible(t) && isIntrinsic(t.max), false, (it) => it.minContent(), "limit", false);
    tracks.forEach((t, k) => (t.infinitelyGrowable = before[k] === INF && t.limit !== INF));
    // 6. Max-content maximums.
    distribute(group, (t) => eligible(t) && isMaxContentMax(t.max), false, (it) => it.maxContent(), "limit", false);
    for (const t of tracks) t.infinitelyGrowable = false;
  }

  /**
   * §11.5.1 Distribute extra space: each item's contribution beyond the
   * spanned tracks' current sizes goes to the affected tracks, equally (or
   * by flex factor) up to their limits, then beyond them; tracks keep the
   * largest increase any item asked for.
   */
  function distribute(group: readonly SizingItem[], affected: (t: Track) => boolean, toBase: boolean, contribution: (it: SizingItem) => number, mode: "min" | "max" | "limit", byFlex: boolean): void {
    const touched = new Set<Track>();
    for (const t of tracks) t.planned = 0;
    const size = (t: Track): number => (toBase ? t.base : t.limit === INF ? t.base : t.limit);
    for (const it of group) {
      const spanned = tracks.slice(it.start, it.start + it.span);
      const targets = spanned.filter(affected);
      if (targets.length === 0) continue;
      let space = contribution(it) - o.gap * (it.span - 1);
      for (const t of spanned) space -= size(t);
      if (space <= EPS) {
        for (const t of targets) touched.add(t);
        continue;
      }
      for (const t of targets) {
        t.incurred = 0;
        touched.add(t);
      }
      const limitOf = (t: Track): number => {
        if (toBase) return t.max.kind === "fit-content" ? Math.min(t.limit, Math.max(t.max.value, t.base)) : t.limit;
        if (t.limit !== INF && !t.infinitelyGrowable) return t.limit;
        return t.max.kind === "fit-content" ? t.max.value : INF;
      };
      const weight = byFlex ? flexWeights(targets) : null;
      space = fill(targets, space, (t) => limitOf(t) - size(t), weight);
      if (space > EPS) {
        // Beyond limits.
        let beyond: Track[];
        if (mode === "limit") beyond = targets;
        else if (mode === "min") beyond = targets.filter((t) => isIntrinsic(t.max));
        else beyond = targets.filter((t) => isMaxContentMax(t.max));
        if (beyond.length === 0) beyond = targets;
        const cap = (t: Track): number => (mode === "max" && t.max.kind === "fit-content" ? Math.max(0, t.max.value - size(t) - t.incurred) + t.incurred : INF);
        space = fill(beyond, space, cap, byFlex ? flexWeights(beyond) : null);
        if (space > EPS) fill(beyond, space, () => INF, byFlex ? flexWeights(beyond) : null);
      }
      for (const t of targets) t.planned = Math.max(t.planned, t.incurred);
    }
    for (const t of touched) {
      if (toBase) t.base += t.planned;
      else if (t.limit === INF) t.limit = t.base + t.planned;
      else t.limit += t.planned;
    }
  }

  // §11.6 Maximize tracks.
  const sumBase = (): number => {
    let s = gaps;
    for (const t of tracks) s += t.base;
    return s;
  };
  let free: number;
  if (o.available.kind === "definite") free = o.available.size - sumBase();
  else if (o.available.kind === "min-content") free = 0;
  else free = INF;
  if (free === INF) {
    let total = gaps;
    for (const t of tracks) total += t.limit;
    // Do not grow past the container's max size.
    if (total > o.maxSize + EPS) free = o.maxSize - sumBase();
  }
  if (free > EPS) {
    if (free === INF) for (const t of tracks) t.base = t.limit;
    else {
      for (const t of tracks) t.incurred = 0;
      fill(live, free, (t) => t.limit - t.base, null);
      for (const t of live) t.base += t.incurred;
    }
  }

  // §11.7 Expand flexible tracks.
  const flexTracks = tracks.filter(isFlex);
  if (flexTracks.length) {
    let fr = 0;
    if (o.available.kind === "min-content") fr = 0;
    else if (o.available.kind === "definite") {
      fr = frSize(tracks, o.available.size, gaps);
    } else {
      for (const t of flexTracks) {
        const f = flexFactor(t);
        fr = Math.max(fr, f > 1 ? t.base / f : t.base);
      }
      for (const it of items) {
        if (!spansFlex(it)) continue;
        const spanned = tracks.slice(it.start, it.start + it.span);
        fr = Math.max(fr, frSize(spanned, it.maxContent(), o.gap * (it.span - 1)));
      }
      // Respect the container's min and max sizes.
      let total = gaps;
      for (const t of tracks) total += isFlex(t) ? Math.max(t.base, fr * flexFactor(t)) : t.base;
      if (total < o.minSize - EPS) fr = frSize(tracks, o.minSize, gaps);
      else if (total > o.maxSize + EPS) fr = frSize(tracks, o.maxSize, gaps);
    }
    for (const t of flexTracks) {
      const size = fr * flexFactor(t);
      if (size > t.base) t.base = size;
    }
  }

  // §11.8 Stretch auto tracks.
  if (o.stretch) {
    const autos = live.filter((t) => t.max.kind === "auto");
    if (autos.length) {
      let space: number | undefined;
      if (o.available.kind === "definite") space = o.available.size;
      else if (o.available.kind === "indefinite" && o.minSize > 0) space = o.minSize;
      if (space !== undefined) {
        const f = space - sumBase();
        if (f > EPS) for (const t of autos) t.base += f / autos.length;
      }
    }
  }
}

function max0(limit: number, v: number): number {
  return limit === INF ? v : Math.max(limit, v);
}

function flexWeights(ts: readonly Track[]): Map<Track, number> | null {
  let sum = 0;
  for (const t of ts) sum += flexFactor(t);
  if (sum <= 0) return null;
  return new Map(ts.map((t) => [t, flexFactor(t) / sum]));
}

/**
 * Water-filling: adds `space` to the tracks' `incurred`, equally (or by
 * weight), never past `room(t)` (measured from the current incurred value).
 * Returns the space left when every track is full.
 */
function fill(ts: readonly Track[], space: number, room: (t: Track) => number, weights: Map<Track, number> | null): number {
  let open = ts.filter((t) => room(t) - t.incurred > EPS || room(t) === INF);
  // `room` is the total allowed increase; track what is left of it.
  const left = new Map(open.map((t) => [t, room(t) === INF ? INF : room(t) - t.incurred]));
  while (space > EPS && open.length > 0) {
    let wsum = 0;
    for (const t of open) wsum += weights ? weights.get(t)! : 1;
    if (wsum <= 0) break;
    let next: Track[] = [];
    let used = 0;
    // The largest uniform step before some track fills up.
    let step = space / wsum;
    for (const t of open) {
      const w = weights ? weights.get(t)! : 1;
      if (w > 0) step = Math.min(step, left.get(t)! / w);
    }
    for (const t of open) {
      const w = weights ? weights.get(t)! : 1;
      const add = step * w;
      t.incurred += add;
      used += add;
      const l = left.get(t)! - add;
      left.set(t, l);
      if (l > EPS) next.push(t);
    }
    space -= used;
    if (next.length === open.length && used <= EPS) break;
    open = next;
    next = [];
  }
  return space;
}

/** §11.7.1 Find the size of an fr: leftover space shared by flex factors, treating tracks that would go below their base as inflexible. */
export function frSize(tracks: readonly Track[], space: number, gaps: number): number {
  const inflexible = new Set<Track>();
  for (;;) {
    let leftover = space - gaps;
    let flex = 0;
    for (const t of tracks) {
      if (t.collapsed) continue;
      if (isFlex(t) && !inflexible.has(t)) flex += flexFactor(t);
      else leftover -= t.base;
    }
    const hypo = leftover / Math.max(1, flex);
    let restart = false;
    for (const t of tracks) {
      if (isFlex(t) && !inflexible.has(t) && hypo * flexFactor(t) < t.base - EPS) {
        inflexible.add(t);
        restart = true;
      }
    }
    if (!restart) return Math.max(0, hypo);
  }
}
