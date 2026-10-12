/**
 * Computed styles the layout engine reads: the CSS properties of CSS Box
 * Model 3, CSS Sizing 3, Flexbox 1, Grid 1, Box Alignment 3 and Positioned
 * Layout 3 that affect box geometry, with values already parsed (see
 * `css.ts` for the declaration parser). Only the horizontal-tb writing mode
 * with `direction: ltr` is modelled, so the inline axis is x and the block
 * axis is y.
 */

/** `calc(<pct>% + <px>px)`: a percentage of a basis plus a length. */
export interface Percent {
  readonly pct: number;
  readonly px: number;
}

/** A `<length-percentage>`: a number is pixels, {@link Percent} needs a basis. */
export type LengthPercentage = number | Percent;

export type IntrinsicKeyword = "min-content" | "max-content" | "fit-content";

/** `width`/`height`, `flex-basis` lengths, `min-*`. */
export type Size = "auto" | LengthPercentage | IntrinsicKeyword;
/** `max-width`/`max-height`. */
export type MaxSize = "none" | LengthPercentage | IntrinsicKeyword;
export type FlexBasis = Size | "content";

export type Display = "none" | "block" | "flex" | "grid";
export type PositionKind = "static" | "relative" | "absolute" | "fixed";
export type BoxSizing = "content-box" | "border-box";
export type Overflow = "visible" | "hidden" | "clip" | "scroll" | "auto";
export type FlexDirection = "row" | "row-reverse" | "column" | "column-reverse";
export type FlexWrap = "nowrap" | "wrap" | "wrap-reverse";

/**
 * Alignment keywords, optionally prefixed with an overflow position
 * (`"safe center"`). Self alignment (`align-self`, `justify-self`) also takes
 * `auto`; distributions (`*-content`) take `space-*`.
 */
export type ContentPosition = "start" | "end" | "center" | "flex-start" | "flex-end" | "left" | "right";
export type ContentDistribution = "space-between" | "space-around" | "space-evenly" | "stretch";
export type SelfPosition = ContentPosition | "self-start" | "self-end";
export type OverflowPosition = "safe" | "unsafe";
export type ContentAlignment = "normal" | ContentDistribution | ContentPosition | `${OverflowPosition} ${ContentPosition}`;
export type ItemAlignment =
  | "normal"
  | "stretch"
  | "baseline"
  | "first baseline"
  | "last baseline"
  | SelfPosition
  | `${OverflowPosition} ${SelfPosition}`;
export type SelfAlignment = "auto" | ItemAlignment;

// ── Grid ─────────────────────────────────────────────────────────────────

/** `<n>fr` */
export interface Flex {
  readonly fr: number;
}
/** A track breadth: a length, a percentage, `fr`, `auto`, `min-content` or `max-content`. */
export type TrackBreadth = LengthPercentage | Flex | "auto" | "min-content" | "max-content";
/** `minmax(min, max)` (the min cannot be flexible). */
export interface MinMax {
  readonly min: TrackBreadth;
  readonly max: TrackBreadth;
}
/** `fit-content(<length-percentage>)` */
export interface FitContent {
  readonly fitContent: LengthPercentage;
}
export type TrackSize = TrackBreadth | MinMax | FitContent;
/** `[name1 name2]` between tracks. */
export interface LineNames {
  readonly names: readonly string[];
}
/** `repeat(count | auto-fill | auto-fit, tracks and names…)` */
export interface Repeat {
  readonly repeat: number | "auto-fill" | "auto-fit";
  readonly entries: readonly (TrackSize | LineNames)[];
}
export type TrackListEntry = TrackSize | LineNames | Repeat;

/**
 * One end of a grid placement (`grid-row-start` etc.): `auto`, a line
 * number (negative counts from the end) with an optional name (the nth line
 * of that name), a span (of lines with an optional name), or a name.
 */
export type GridLine =
  | "auto"
  | { readonly line: number; readonly name?: string }
  | { readonly span: number; readonly name?: string }
  | { readonly name: string };

export type GridAutoFlow = "row" | "column" | "row dense" | "column dense";

export interface Sides<T> {
  readonly top: T;
  readonly right: T;
  readonly bottom: T;
  readonly left: T;
}

export interface Style {
  readonly display: Display;
  readonly position: PositionKind;
  readonly boxSizing: BoxSizing;
  readonly width: Size;
  readonly height: Size;
  readonly minWidth: Size;
  readonly minHeight: Size;
  readonly maxWidth: MaxSize;
  readonly maxHeight: MaxSize;
  /** `aspect-ratio` as width / height; `null` is `auto`. `aspectRatioAuto` is the `auto && <ratio>` form. */
  readonly aspectRatio: number | null;
  readonly aspectRatioAuto: boolean;
  readonly margin: Sides<LengthPercentage | "auto">;
  readonly padding: Sides<LengthPercentage>;
  /** Used border widths in px (a `border-style` of `none` is the caller's business: pass 0). */
  readonly border: Sides<number>;
  readonly inset: Sides<LengthPercentage | "auto">;
  readonly overflowX: Overflow;
  readonly overflowY: Overflow;

  // Flex container
  readonly flexDirection: FlexDirection;
  readonly flexWrap: FlexWrap;
  // Flex item
  readonly flexGrow: number;
  readonly flexShrink: number;
  readonly flexBasis: FlexBasis;
  readonly order: number;

  // Alignment
  readonly justifyContent: ContentAlignment;
  readonly alignContent: ContentAlignment;
  readonly justifyItems: ItemAlignment;
  readonly alignItems: ItemAlignment;
  readonly justifySelf: SelfAlignment;
  readonly alignSelf: SelfAlignment;
  /** `row-gap` and `column-gap`; `normal` is 0 for flex and grid. */
  readonly rowGap: LengthPercentage;
  readonly columnGap: LengthPercentage;

  // Grid container
  readonly gridTemplateColumns: readonly TrackListEntry[];
  readonly gridTemplateRows: readonly TrackListEntry[];
  /** Rows of area names (`.` for none). */
  readonly gridTemplateAreas: readonly (readonly string[])[];
  readonly gridAutoColumns: readonly TrackSize[];
  readonly gridAutoRows: readonly TrackSize[];
  readonly gridAutoFlow: GridAutoFlow;
  // Grid item
  readonly gridRowStart: GridLine;
  readonly gridRowEnd: GridLine;
  readonly gridColumnStart: GridLine;
  readonly gridColumnEnd: GridLine;
}

const ZERO = { top: 0, right: 0, bottom: 0, left: 0 } as const;
const AUTO_SIDES = { top: "auto", right: "auto", bottom: "auto", left: "auto" } as const;

/** CSS initial values, except `display`, which defaults to `block`. */
export const DEFAULT_STYLE: Style = Object.freeze({
  display: "block",
  position: "static",
  boxSizing: "content-box",
  width: "auto",
  height: "auto",
  minWidth: "auto",
  minHeight: "auto",
  maxWidth: "none",
  maxHeight: "none",
  aspectRatio: null,
  aspectRatioAuto: false,
  margin: ZERO,
  padding: ZERO,
  border: ZERO,
  inset: AUTO_SIDES,
  overflowX: "visible",
  overflowY: "visible",
  flexDirection: "row",
  flexWrap: "nowrap",
  flexGrow: 0,
  flexShrink: 1,
  flexBasis: "auto",
  order: 0,
  justifyContent: "normal",
  alignContent: "normal",
  justifyItems: "normal",
  alignItems: "normal",
  justifySelf: "auto",
  alignSelf: "auto",
  rowGap: 0,
  columnGap: 0,
  gridTemplateColumns: [],
  gridTemplateRows: [],
  gridTemplateAreas: [],
  gridAutoColumns: [],
  gridAutoRows: [],
  gridAutoFlow: "row",
  gridRowStart: "auto",
  gridRowEnd: "auto",
  gridColumnStart: "auto",
  gridColumnEnd: "auto",
} satisfies Style);

/** A full style from a partial one (unset properties take their initial values). */
export function makeStyle(partial: Partial<Style> = {}): Style {
  return Object.freeze({ ...DEFAULT_STYLE, ...stripUndefined(partial) });
}

function stripUndefined<T extends object>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}

// ── Value helpers ────────────────────────────────────────────────────────

export function isPercent(v: unknown): v is Percent {
  return typeof v === "object" && v !== null && "pct" in v;
}

/** A length-percentage against `basis`; `undefined` when it needs an indefinite basis. */
export function resolveLP(v: LengthPercentage, basis: number | undefined): number | undefined {
  if (typeof v === "number") return v;
  if (basis === undefined) return undefined;
  return (v.pct / 100) * basis + v.px;
}

/** Like {@link resolveLP}, but an indefinite percentage resolves against 0 (cyclic percentages in intrinsic contributions). */
export function resolveLPOrZero(v: LengthPercentage, basis: number | undefined): number {
  if (typeof v === "number") return v;
  return (v.pct / 100) * (basis ?? 0) + v.px;
}

export function isLengthPercentage(v: unknown): v is LengthPercentage {
  return typeof v === "number" || isPercent(v);
}

export function isScrollContainer(overflow: Overflow): boolean {
  return overflow !== "visible" && overflow !== "clip";
}

/** Splits `"safe center"` into its overflow position and keyword. */
export function splitAlignment<T extends string>(v: T | `${OverflowPosition} ${string}`): { overflow: "" | OverflowPosition; value: string } {
  const sp = v.indexOf(" ");
  if (sp < 0) return { overflow: "", value: v };
  const head = v.slice(0, sp);
  if (head === "safe" || head === "unsafe") return { overflow: head, value: v.slice(sp + 1) };
  return { overflow: "", value: v };
}
