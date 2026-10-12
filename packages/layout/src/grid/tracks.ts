import { INF } from "../sizing";
import { resolveLP, type LengthPercentage, type LineNames, type Repeat, type TrackBreadth, type TrackListEntry, type TrackSize } from "../style";

/**
 * The explicit grid of one axis (CSS Grid 1 §7): the track list with
 * `repeat()` expanded (including `auto-fill` / `auto-fit` repetitions), the
 * names of every line, and which tracks came from an `auto-fit` repeat
 * (they collapse when empty).
 */
export interface ExplicitAxis {
  readonly tracks: TrackSize[];
  /** Names of explicit lines 0…tracks.length. */
  readonly lineNames: string[][];
  /** Track indices produced by an `auto-fit` repetition. */
  readonly autoFit: ReadonlySet<number>;
}

const isNames = (e: TrackListEntry | TrackSize | LineNames): e is LineNames => typeof e === "object" && "names" in e;
const isRepeat = (e: TrackListEntry): e is Repeat => typeof e === "object" && "repeat" in e;

/**
 * Expands a track list. `available` is the content-box size used to count
 * auto repetitions (`undefined` when indefinite), `minAvailable` the
 * definite min size when the size is indefinite, `gap` the gutter.
 */
export function expandTrackList(list: readonly TrackListEntry[], available: number | undefined, minAvailable: number | undefined, gap: number, percentBasis: number | undefined): ExplicitAxis {
  const tracks: TrackSize[] = [];
  const lineNames: string[][] = [[]];
  const autoFit = new Set<number>();
  const addNames = (names: readonly string[]): void => {
    const cur = lineNames[lineNames.length - 1]!;
    for (const n of names) if (!cur.includes(n)) cur.push(n);
  };
  const addTrack = (t: TrackSize, fit: boolean): void => {
    if (fit) autoFit.add(tracks.length);
    tracks.push(t);
    lineNames.push([]);
  };
  const emit = (entries: readonly (TrackSize | LineNames)[], fit: boolean): void => {
    for (const e of entries) {
      if (isNames(e)) addNames(e.names);
      else addTrack(e, fit);
    }
  };
  for (const e of list) {
    if (isNames(e)) addNames(e.names);
    else if (isRepeat(e)) {
      const count = typeof e.repeat === "number" ? e.repeat : autoRepeatCount(list, e, available, minAvailable, gap, percentBasis);
      for (let i = 0; i < count; i++) emit(e.entries, e.repeat === "auto-fit");
    } else addTrack(e, false);
  }
  return { tracks, lineNames, autoFit };
}

/** A fixed breadth in px, or undefined when it is intrinsic, flexible or an unresolvable percentage. */
function fixedBreadth(b: TrackBreadth, basis: number | undefined): number | undefined {
  if (typeof b === "number") return b;
  if (typeof b === "object" && "pct" in b) return resolveLP(b as LengthPercentage, basis);
  return undefined;
}

/**
 * The size a track counts as when computing auto repetitions: its max
 * sizing function when definite, else its min sizing function (§7.2.3.2).
 */
function repeatTrackSize(t: TrackSize, basis: number | undefined): number | undefined {
  if (typeof t === "object" && "min" in t) return fixedBreadth(t.max, basis) ?? fixedBreadth(t.min, basis);
  if (typeof t === "object" && "fitContent" in t) return resolveLP(t.fitContent, basis);
  return fixedBreadth(t as TrackBreadth, basis);
}

function autoRepeatCount(list: readonly TrackListEntry[], rep: Repeat, available: number | undefined, minAvailable: number | undefined, gap: number, basis: number | undefined): number {
  const space = available ?? minAvailable;
  if (space === undefined) return 1;
  // Size of everything outside the repeat, and of one repetition.
  let fixed = 0;
  let fixedTracks = 0;
  for (const e of list) {
    if (e === rep || isNames(e)) continue;
    if (isRepeat(e)) {
      for (const t of e.entries) if (!isNames(t)) {
        fixed += (repeatTrackSize(t, basis) ?? 0) * (typeof e.repeat === "number" ? e.repeat : 1);
        fixedTracks += typeof e.repeat === "number" ? e.repeat : 1;
      }
      continue;
    }
    fixed += repeatTrackSize(e, basis) ?? 0;
    fixedTracks++;
  }
  let per = 0;
  let perTracks = 0;
  for (const t of rep.entries) {
    if (isNames(t)) continue;
    const size = repeatTrackSize(t, basis);
    if (size === undefined) return 1;
    per += Math.max(size, 0);
    perTracks++;
  }
  if (perTracks === 0) return 1;
  const total = (n: number): number => fixed + per * n + gap * Math.max(0, fixedTracks + perTracks * n - 1);
  if (available !== undefined) {
    // Largest count that does not overflow (at least 1).
    if (per + gap * perTracks <= 0) return 1;
    let n = Math.max(1, Math.floor((space - fixed + gap) / (per + gap * perTracks)));
    while (n > 1 && total(n) > space + 1e-7) n--;
    while (total(n + 1) <= space + 1e-7 && n < 10_000) n++;
    return Math.max(1, n);
  }
  // Only a definite min size: the smallest count that reaches it.
  let n = 1;
  while (total(n) < space - 1e-7 && n < 10_000) n++;
  return n;
}

/** Implicit grid line names from `grid-template-areas`: `<area>-start` and `<area>-end` (§7.3.2). */
export function areaLines(areas: readonly (readonly string[])[]): { rows: Map<string, [number, number]>; cols: Map<string, [number, number]> } {
  const rows = new Map<string, [number, number]>();
  const cols = new Map<string, [number, number]>();
  areas.forEach((row, r) =>
    row.forEach((name, c) => {
      if (name === ".") return;
      const rr = rows.get(name);
      rows.set(name, rr ? [Math.min(rr[0], r), Math.max(rr[1], r + 1)] : [r, r + 1]);
      const cc = cols.get(name);
      cols.set(name, cc ? [Math.min(cc[0], c), Math.max(cc[1], c + 1)] : [c, c + 1]);
    }),
  );
  return { rows, cols };
}

export { INF };
