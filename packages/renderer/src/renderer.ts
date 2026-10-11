import { invert, multiply, scaling, transformPoint, type Point } from "@fig-tree/geometry";
import type { Backend, FrameStats, PixelData } from "./backend";
import { DrawList } from "./compile";
import { PaintCache, planFrame } from "./frame";
import { hitTest } from "./hit-test";
import { Scene, type SceneNode } from "./scene";
import { type BackendKind, type Color, type Viewport } from "./types";
import { WebGL2Backend } from "./webgl2/backend";
import { WebGPUBackend } from "./webgpu/backend";

export type BackendPreference = BackendKind | "auto";

export interface RendererOptions {
  /** `"auto"` (default) uses WebGPU when available and falls back to WebGL2. */
  readonly backend?: BackendPreference;
  /** Canvas clear color; defaults to opaque white. */
  readonly background?: Color;
}

/**
 * Reads a backend override from a query string: `?renderer=webgl2` forces the
 * fallback, `?renderer=webgpu` requires WebGPU.
 */
export function backendFromSearch(search: string): BackendPreference {
  const value = new URLSearchParams(search).get("renderer");
  return value === "webgl2" || value === "webgpu" ? value : "auto";
}

/**
 * Retained-mode scene renderer. Owns a canvas and one GPU backend; the scene
 * is compiled to a paint-ordered draw list that is re-derived only when the
 * scene changes, then culled per frame through a spatial index.
 */
export class Renderer {
  private scene = new Scene();
  private list = new DrawList();
  private readonly paints = new PaintCache();
  private width = 0;
  private height = 0;
  private pixelRatio = 1;
  private lastViewport: Viewport | null = null;
  background: Color;

  private constructor(
    private readonly canvas: HTMLCanvasElement | OffscreenCanvas,
    private readonly backend: Backend,
    options: RendererOptions,
  ) {
    this.background = options.background ?? { r: 1, g: 1, b: 1, a: 1 };
    this.setSize(canvas.width, canvas.height, 1);
  }

  /**
   * Creates a renderer, picking the backend by feature detection. WebGPU is
   * probed before the canvas gets a context, so falling back stays possible.
   */
  static async create(canvas: HTMLCanvasElement | OffscreenCanvas, options: RendererOptions = {}): Promise<Renderer> {
    const preference = options.backend ?? "auto";
    let backend: Backend | null = null;
    if (preference !== "webgl2") {
      backend = await WebGPUBackend.create(canvas);
      if (!backend && preference === "webgpu") throw new Error("WebGPU is not available");
    }
    backend ??= WebGL2Backend.create(canvas);
    if (!backend) throw new Error("neither WebGPU nor WebGL2 is available");
    return new Renderer(canvas, backend, options);
  }

  get backendKind(): BackendKind {
    return this.backend.kind;
  }

  setScene(scene: Scene): void {
    if (scene === this.scene) return;
    this.scene = scene;
    this.list = new DrawList();
  }

  /** Sets the drawing size in CSS pixels; the canvas backing store uses `pixelRatio`. */
  setSize(width: number, height: number, pixelRatio = 1): void {
    this.pixelRatio = pixelRatio;
    this.width = Math.max(1, Math.round(width * pixelRatio));
    this.height = Math.max(1, Math.round(height * pixelRatio));
    if (this.canvas.width !== this.width) this.canvas.width = this.width;
    if (this.canvas.height !== this.height) this.canvas.height = this.height;
  }

  render(viewport: Viewport): FrameStats {
    const start = performance.now();
    this.lastViewport = viewport;
    this.list.sync(this.scene);
    const view = multiply(scaling(this.pixelRatio), viewport.transform);
    const plan = planFrame(this.list, this.paints, view, this.width, this.height);
    const uploadedBytes = this.backend.render(plan, this.background);
    let segments = 0;
    for (const e of plan.entries) segments += e.geometry?.segmentCount ?? 0;
    return {
      backend: this.backend.kind,
      entries: plan.entries.length,
      segments,
      uploadedBytes,
      cpuMs: performance.now() - start,
    };
  }

  /**
   * Renders and waits for the GPU, re-rendering while the backend reports
   * that internal buffers had to grow. Use for screenshots and tests.
   */
  async renderComplete(viewport: Viewport): Promise<FrameStats> {
    for (let attempt = 0; ; attempt++) {
      const stats = this.render(viewport);
      const incomplete = await this.backend.settle();
      if (!incomplete || attempt >= 4) return stats;
    }
  }

  /** Waits until the GPU has finished all submitted frames. */
  async finish(): Promise<void> {
    await this.backend.settle();
  }

  /** Topmost node under a point given in CSS pixels, using the last rendered viewport. */
  hitTest(point: Point): SceneNode | null {
    if (!this.lastViewport) return null;
    const inv = invert(this.lastViewport.transform);
    if (!inv) return null;
    this.list.sync(this.scene);
    return hitTest(this.list, transformPoint(inv, point.x, point.y));
  }

  readPixels(): Promise<PixelData> {
    return this.backend.readPixels();
  }

  destroy(): void {
    this.backend.destroy();
  }
}
