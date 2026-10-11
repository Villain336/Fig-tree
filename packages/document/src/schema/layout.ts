import { z } from "zod";
import { Num, NonNegative, Unit, sides } from "./primitives";

/**
 * Box model, positioning and layout properties. They are stored with CSS
 * semantics; `css.ts` maps them to declarations and the layout engine
 * (module 3) computes boxes from them. Until then `x`, `y`, `width` and
 * `height` hold the node's last laid-out box and are what the renderer uses.
 */

// ── Geometry ─────────────────────────────────────────────────────────────

export const geometryProps = {
  /** Left edge of the unrotated border box, relative to the parent's border-box origin. */
  x: Num,
  /** Top edge of the unrotated border box, relative to the parent's border-box origin. */
  y: Num,
  width: NonNegative,
  height: NonNegative,
  /** Clockwise rotation in degrees about the box center (CSS `transform-origin: center`). */
  rotation: Num,
  /** Mirror horizontally about the box center (`scale(-1, 1)`), applied before rotation. */
  flipX: z.boolean(),
  flipY: z.boolean(),
};

// ── Sizing ───────────────────────────────────────────────────────────────

/**
 * How a dimension is sized. CSS mapping (see `css.ts`):
 * - `fixed`: `width: <width>px` (and `flex-shrink: 0` on a flex main axis);
 * - `hug`: `width: fit-content`, the content's size;
 * - `fill`: on a flex main axis `flex: 1 1 0px`, on a cross axis or in grid
 *   `align-self`/`justify-self: stretch`, otherwise `width: 100%`.
 */
export const SizingMode = z.enum(["fixed", "hug", "fill"]);
export type SizingMode = z.infer<typeof SizingMode>;

export const sizingProps = {
  widthMode: SizingMode,
  heightMode: SizingMode,
  minWidth: NonNegative,
  maxWidth: NonNegative,
  minHeight: NonNegative,
  maxHeight: NonNegative,
  /** CSS `aspect-ratio` as width / height; set when the ratio is locked. */
  aspectRatio: z.number().positive(),
};

// ── Positioning ──────────────────────────────────────────────────────────

/**
 * CSS `position`. `absolute` takes the node out of its parent's flex or grid
 * flow and places it at `x`/`y` with `constraints`; `relative` keeps it in
 * flow. `fixed` and `sticky` express scroll behaviour for prototypes.
 */
export const Position = z.enum(["absolute", "relative", "fixed", "sticky"]);

/**
 * Which insets pin an absolutely positioned node when its containing block
 * resizes: `start` (left/top), `end` (right/bottom), `start-end` (both, the
 * size follows), `center` (offset from the center) or `scale` (percentages).
 */
export const ConstraintKind = z.enum(["start", "end", "start-end", "center", "scale"]);
export const Constraints = z.strictObject({ horizontal: ConstraintKind, vertical: ConstraintKind });
export type Constraints = z.infer<typeof Constraints>;

export const positionProps = {
  position: Position,
  constraints: Constraints,
};

// ── Box model ────────────────────────────────────────────────────────────

export const Margin = z.union([Num, z.literal("auto")]);

export const boxProps = {
  /** CSS `box-sizing`; `width`/`height` measure the border box by default. */
  boxSizing: z.enum(["border-box", "content-box"]),
  padding: sides(NonNegative),
  /**
   * When true, stroke weights act as CSS `border-*-width`: they take space in
   * layout and inset the content box. When false (the default) strokes are
   * paint only, like `outline`.
   */
  strokesInLayout: z.boolean(),
};

// ── Overflow and corners ─────────────────────────────────────────────────

/** CSS `overflow-x`/`overflow-y`. Anything other than `visible` clips children to the padding box. */
export const Overflow = z.enum(["visible", "hidden", "clip", "scroll", "auto"]);
export type Overflow = z.infer<typeof Overflow>;

export const CornerRadius = z.union([
  NonNegative,
  z.strictObject({ topLeft: NonNegative, topRight: NonNegative, bottomRight: NonNegative, bottomLeft: NonNegative }),
]);
export type CornerRadius = z.infer<typeof CornerRadius>;

export const cornerProps = {
  /** CSS `border-radius`, uniform or per corner; clamped like CSS when corners overlap. */
  cornerRadius: CornerRadius,
  /** 0 = circular corners, 1 = fully smoothed (curvature-continuous) corners. */
  cornerSmoothing: Unit,
};

export const overflowProps = {
  overflowX: Overflow,
  overflowY: Overflow,
};

// ── Flex and grid containers ─────────────────────────────────────────────

/** `block` lays nothing out: children are positioned absolutely, like a classic canvas frame. */
export const Display = z.enum(["block", "flex", "grid"]);
export type Display = z.infer<typeof Display>;

const ContentDistribution = z.enum([
  "normal",
  "start",
  "end",
  "center",
  "flex-start",
  "flex-end",
  "space-between",
  "space-around",
  "space-evenly",
  "stretch",
]);
const ItemAlignment = z.enum(["normal", "stretch", "start", "end", "center", "flex-start", "flex-end", "baseline", "last baseline"]);
const SelfAlignment = z.enum(["auto", "normal", "stretch", "start", "end", "center", "flex-start", "flex-end", "baseline", "last baseline"]);

/** One grid track size: a fixed or flexible breadth, or `minmax()`/`fit-content()`. */
const TrackBreadth = z.union([
  z.strictObject({ type: z.literal("px"), value: NonNegative }),
  z.strictObject({ type: z.literal("percent"), value: NonNegative }),
  z.strictObject({ type: z.literal("fr"), value: NonNegative }),
  z.strictObject({ type: z.literal("auto") }),
  z.strictObject({ type: z.literal("min-content") }),
  z.strictObject({ type: z.literal("max-content") }),
]);
export const TrackSize = z.union([
  TrackBreadth,
  z.strictObject({ type: z.literal("minmax"), min: TrackBreadth, max: TrackBreadth }),
  z.strictObject({ type: z.literal("fit-content"), value: NonNegative }),
]);
export type TrackSize = z.infer<typeof TrackSize>;
/** A track list entry: a size or `repeat(count | auto-fill | auto-fit, sizes…)`. */
export const TrackListEntry = z.union([
  TrackSize,
  z.strictObject({
    type: z.literal("repeat"),
    count: z.union([z.number().int().min(1).max(10_000), z.literal("auto-fill"), z.literal("auto-fit")]),
    tracks: z.array(TrackSize).min(1).max(64),
  }),
]);
export type TrackListEntry = z.infer<typeof TrackListEntry>;
const TrackList = z.array(TrackListEntry).max(1_000);

export const containerProps = {
  display: Display,
  flexDirection: z.enum(["row", "row-reverse", "column", "column-reverse"]),
  flexWrap: z.enum(["nowrap", "wrap", "wrap-reverse"]),
  justifyContent: ContentDistribution,
  alignItems: ItemAlignment,
  alignContent: ContentDistribution,
  /** Grid only: default `justify-self` of items. */
  justifyItems: ItemAlignment,
  rowGap: NonNegative,
  columnGap: NonNegative,
  gridTemplateColumns: TrackList,
  gridTemplateRows: TrackList,
  gridAutoColumns: z.array(TrackSize).max(64),
  gridAutoRows: z.array(TrackSize).max(64),
  gridAutoFlow: z.enum(["row", "column", "row dense", "column dense"]),
  /** CSS `grid-template-areas`, one string per row (e.g. `"header header"`). */
  gridTemplateAreas: z.array(z.string().regex(/^\s*(?:[A-Za-z_][\w-]*|\.+)(?:\s+(?:[A-Za-z_][\w-]*|\.+))*\s*$/, "rows are whitespace-separated area names or dots")).max(1_000),
};

/** A grid line: a line number (negative counts from the end), `auto`, a span, or a named area/line. */
export const GridLine = z.union([
  z.number().int().refine((n) => n !== 0, "grid line 0 does not exist"),
  z.literal("auto"),
  z.strictObject({ span: z.number().int().min(1) }),
  z.strictObject({ name: z.string().regex(/^[A-Za-z_][\w-]*$/) }),
]);
export type GridLine = z.infer<typeof GridLine>;
export const GridPlacement = z.strictObject({ start: GridLine, end: GridLine });

export const itemProps = {
  flexGrow: NonNegative,
  flexShrink: NonNegative,
  /** CSS `flex-basis`: a length in px, `auto` or `content`. */
  flexBasis: z.union([NonNegative, z.literal("auto"), z.literal("content")]),
  alignSelf: SelfAlignment,
  justifySelf: SelfAlignment,
  order: z.number().int(),
  gridColumn: GridPlacement,
  gridRow: GridPlacement,
  margin: sides(Margin),
};
