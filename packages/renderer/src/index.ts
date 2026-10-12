export { Renderer, backendFromSearch, type BackendPreference, type RendererOptions } from "./renderer";
export { Scene, SceneNode, type NodeProps } from "./scene";
export type { FrameStats, PixelData } from "./backend";
export type { StageTimings } from "./webgpu/timer";
export { MAX_LAYER_DEPTH } from "./compile";
export {
  GlyphAtlas,
  ATLAS_MAX_SIZE,
  SUBPIXEL_STEPS,
  atlasCompatible,
  placeGlyphs,
  runBounds,
  runOutlinePath,
  sizeBucket,
  type AtlasGlyph,
  type GlyphPlacement,
  type GlyphRun,
  type GlyphSource,
} from "./glyphs/atlas";
export { rasterizeCoverage } from "./glyphs/rasterize";
export {
  hexColor,
  rgba,
  solid,
  type BackendKind,
  type Color,
  type FillRule,
  type GradientStop,
  type LinearGradientPaint,
  type Paint,
  type RadialGradientPaint,
  type SolidPaint,
  type Stroke,
  type Viewport,
} from "./types";
