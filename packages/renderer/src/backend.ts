import type { FramePlan } from "./frame";
import type { BackendKind, Color } from "./types";

export interface FrameStats {
  readonly backend: BackendKind;
  /** Visible draw steps (fills and layer brackets) in the frame. */
  readonly entries: number;
  /** Line segments rasterized this frame. */
  readonly segments: number;
  /** Bytes of geometry and paint uploaded this frame (0 when only the view changed). */
  readonly uploadedBytes: number;
  /** CPU time spent planning and encoding the frame. */
  readonly cpuMs: number;
}

/** RGBA8, premultiplied alpha, rows top to bottom. */
export interface PixelData {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** A GPU implementation of the frame renderer. Both backends share the CPU-side plan. */
export interface Backend {
  readonly kind: BackendKind;
  /** Renders `plan` to the canvas; returns bytes uploaded for geometry and paint. */
  render(plan: FramePlan, background: Color): number;
  /**
   * Resolves once the GPU finished the last frame. Returns true if that frame
   * hit an internal capacity limit and has to be rendered again.
   */
  settle(): Promise<boolean>;
  /** Reads back the last rendered frame. */
  readPixels(): Promise<PixelData>;
  destroy(): void;
}
