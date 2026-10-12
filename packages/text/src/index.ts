export { loadHarfBuzz, harfbuzzLoaded } from "./hb";
export { Typeface, FontInstance, decodeFontFile, HB_SUBUNITS, type FaceStyle, type InstanceMetrics } from "./font/face";
export { FontFormatError, detectFormat, type FontFormat, type FontInfo, type FontNames, type VariationAxis } from "./font/sfnt";
export { decodeWoff, decodeWoff2 } from "./font/woff";
export {
  FontRegistry,
  FontFaceEntry,
  instanceFor,
  NORMAL_REQUEST,
  type FaceDescriptor,
  type FontRequest,
  type FontSource,
  type MatchedFont,
} from "./font/registry";
export { SCRIPT_FALLBACKS, fallbackFamilyFor } from "./ported/penpot/fallback";
export * from "./style";
export { parseTextStyle, parseParagraphStyle, declarations, TextCssError, type Declarations } from "./css";
export { prepareText, type Span, type PreparedText } from "./layout/prepare";
export { ShapedParagraph, effectiveFontSize, fontMetricsPx, type ParagraphInput, type Item, type BoxMetrics } from "./layout/paragraph";
export { layoutLines, breakLines, type ParagraphLayout, type Line, type GlyphRun, type CharBox, type DecorationRect, type PlacedGlyph } from "./layout/lines";
export { featuresFor, shapeItem, type ShapedGlyphs } from "./layout/shape";
export { TextBlock, ceil64, type TextBlockInput, type TextBlockLayout, type PlacedParagraph, type CaretPosition, type CaretRect } from "./block";
export { lineBreaks, NO_BREAK, ALLOW_BREAK, MANDATORY_BREAK, type LineBreakOptions } from "./unicode/linebreak";
export { graphemeBoundaries, graphemeStarts } from "./unicode/grapheme";
export * as unicode from "./unicode/props";
