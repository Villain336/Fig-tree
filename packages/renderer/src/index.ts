export { Renderer, backendFromSearch, type BackendPreference, type RendererOptions } from "./renderer";
export { Scene, SceneNode, type NodeProps } from "./scene";
export type { FrameStats, PixelData } from "./backend";
export { MAX_LAYER_DEPTH } from "./compile";
export { SCREEN_TOLERANCE } from "./geometry-cache";
export { sampleStops, encodePaint, type EncodedPaint } from "./paint";
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
