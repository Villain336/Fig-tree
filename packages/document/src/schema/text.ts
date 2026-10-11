import { z } from "zod";
import { PaintStack } from "./paint";
import { Num, NonNegative, optionalShape } from "./primitives";

/**
 * Typography follows CSS. A text node carries the base style as node
 * properties; style runs override any subset of it over a character range
 * (stored as Yjs text formatting, so concurrent typing and styling merge).
 */

const OpenTypeTag = z.string().regex(/^[\x20-\x7e]{4}$/, "OpenType tags are four printable ASCII characters");

/** CSS `line-height`: `normal`, a length in px, or a percentage of the font size. */
export const LineHeight = z.union([
  z.literal("normal"),
  z.strictObject({ unit: z.literal("px"), value: NonNegative }),
  z.strictObject({ unit: z.literal("percent"), value: NonNegative }),
]);
export type LineHeight = z.infer<typeof LineHeight>;

/** CSS `letter-spacing` in px or em. */
export const LetterSpacing = z.strictObject({ unit: z.enum(["px", "em"]), value: Num });

/** Properties that can vary within a text node (node-level defaults, per-run overrides). */
export const textStyleProps = {
  fontFamily: z.string().min(1).max(256),
  /** CSS `font-weight`, 1–1000. */
  fontWeight: z.number().min(1).max(1000),
  fontStyle: z.enum(["normal", "italic", "oblique"]),
  fontSize: z.number().positive().max(10_000),
  lineHeight: LineHeight,
  letterSpacing: LetterSpacing,
  textDecoration: z.enum(["none", "underline", "line-through"]),
  textTransform: z.enum(["none", "uppercase", "lowercase", "capitalize"]),
  /** CSS `font-feature-settings`: tag → value (0 disables, 1 enables, n selects an alternate). */
  fontFeatures: z.record(OpenTypeTag, z.number().int().min(0).max(65_535)),
  /** CSS `font-variation-settings`: axis tag → value. */
  fontVariations: z.record(OpenTypeTag, Num),
  /** Text color and other paints (CSS `color`, or `background-clip: text` for gradients). */
  fills: PaintStack,
};

/** Properties of the whole text box (paragraph level). */
export const textBoxProps = {
  textAlign: z.enum(["start", "end", "left", "right", "center", "justify"]),
  /** Vertical placement of the text in a box taller than its content (CSS `align-content` on a block). */
  verticalAlign: z.enum(["top", "center", "bottom"]),
  /** Space between paragraphs, in px. */
  paragraphSpacing: NonNegative,
  /** CSS `text-indent` of each paragraph's first line, in px. */
  paragraphIndent: Num,
  /** CSS `text-overflow`: `ellipsis` truncates overflowing text. */
  textOverflow: z.enum(["clip", "ellipsis"]),
  /** CSS `line-clamp`: maximum number of lines before truncation. */
  maxLines: z.number().int().min(1),
  /** CSS `white-space` collapsing and wrapping. */
  whiteSpace: z.enum(["normal", "pre", "pre-wrap", "pre-line", "nowrap"]),
};

/** A style run's overrides; `link` is per-run only. */
export const TextStyle = z.strictObject({ ...optionalShape(textStyleProps), link: z.url().max(2048).optional() });
export type TextStyle = z.infer<typeof TextStyle>;
export const TEXT_STYLE_KEYS = [...Object.keys(textStyleProps), "link"] as (keyof TextStyle)[];

export const MAX_TEXT_LENGTH = 1_000_000;

/**
 * Text content in the file format: the characters plus non-overlapping style
 * runs `[start, end)` in UTF-16 code units, sorted, each with at least one
 * override. Unstyled characters use the node's base style.
 */
export const TextContent = z
  .strictObject({
    content: z.string().max(MAX_TEXT_LENGTH),
    runs: z.array(
      z.strictObject({
        start: z.number().int().min(0),
        end: z.number().int().min(1),
        style: TextStyle.refine((s) => Object.keys(s).length > 0, "a run must override at least one property"),
      }),
    ),
  })
  .superRefine((t, ctx) => {
    let last = 0;
    t.runs.forEach((run, i) => {
      if (run.end <= run.start) ctx.addIssue({ code: "custom", path: ["runs", i], message: "run end must be greater than its start" });
      if (run.start < last) ctx.addIssue({ code: "custom", path: ["runs", i], message: "runs must be sorted and must not overlap" });
      if (run.end > t.content.length) ctx.addIssue({ code: "custom", path: ["runs", i], message: `run ends past the end of the text (${t.content.length})` });
      last = run.end;
    });
  });
export type TextContent = z.infer<typeof TextContent>;
