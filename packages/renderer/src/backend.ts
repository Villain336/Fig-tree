import type { FramePlan } from "./frame";
import type { TilePlacement } from "./tile-cache";
import type { BackendKind, Color } from "./types";
import type { StageTimings } from "./webgpu/timer";

export interface FrameStats {
  readonly backend: BackendKind;
  /** "direct" rasterizes the whole screen; "tiles" reuses cached tiles and rasterizes only new ones. */
  readonly mode: "direct" | "tiles";
  /** Tiles rasterized this frame (tiles mode). */
  readonly tilesRendered: number;
  /** Visible draw steps (fills and layer brackets) in the frame. */
  readonly entries: number;
  /** Line segments rasterized this frame. */
  readonly segments: number;
  /** Bytes of geometry, paint and glyph bitmaps uploaded this frame (0 when only the view changed). */
  readonly uploadedBytes: number;
  /** Glyph bitmaps rasterized into the atlas this frame (0 on frames that reuse the atlas). */
  readonly glyphsRasterized: number;
  /** Render-graph nodes planned (effects, blurred layers, backdrops, mesh lookups); cached ones are not recomputed. */
  readonly graphNodes: number;
  /** GPU memory held for effects and images: effect atlas, pooled effect textures, image atlas (bytes). */
  readonly textureBytes: number;
  /** Whether the scene has paints that change with the clock (the frame must be redrawn as time passes). */
  readonly animated: boolean;
  /** CPU time spent planning and encoding the frame. */
  readonly cpuMs: number;
}

/** RGBA8, premultiplied alpha, rows top to bottom. */
export interface PixelData {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** A region of the tile grid rendered as one plan, then split into atlas slots. */
export interface TileJob {
  readonly plan: FramePlan;
  readonly copies: readonly { readonly slot: number; readonly dx: number; readonly dy: number }[];
}

/** A GPU implementation of the frame renderer. Both backends share the CPU-side plan. */
export interface Backend {
  readonly kind: BackendKind;
  /** Renders `plan` to the canvas; returns bytes uploaded for geometry and paint. */
  render(plan: FramePlan, background: Color): number;
  /** Rasterizes tile regions into the tile atlas (not shown until `presentTiles`). */
  renderTiles(jobs: readonly TileJob[], background: Color): number;
  /** Assembles cached tiles onto the canvas at whole-pixel positions. */
  presentTiles(placements: readonly TilePlacement[], width: number, height: number): void;
  /**
   * Resolves once the GPU finished the last frame. Returns true if that frame
   * hit an internal capacity limit and has to be rendered again.
   */
  settle(): Promise<boolean>;
  /** GPU bytes held for effects and images. */
  readonly textureBytes: number;
  /** Latest per-stage GPU timings, when the backend can measure them (lags a frame or two). */
  readonly gpuTimings: StageTimings | null;
  /** Reads back the last rendered frame. */
  readPixels(): Promise<PixelData>;
  destroy(): void;
}
