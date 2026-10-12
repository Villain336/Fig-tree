import { invert, multiply, scaling, transformPoint, translation, type Mat2D, type Point } from "@fig-tree/geometry";
import type { Backend, FrameStats, PixelData } from "./backend";
import { DrawList } from "./compile";
import { PaintCache, planFrame, type FramePlan } from "./frame";
import { GlyphAtlas } from "./glyphs/atlas";
import { hitTest } from "./hit-test";
import { ATLAS_SLOTS, TILE_SIZE, TileCache } from "./tile-cache";
import { Scene, type SceneNode } from "./scene";
import { type BackendKind, type Color, type Viewport } from "./types";
import type { StageTimings } from "./webgpu/timer";
import { WebGL2Backend } from "./webgl2/backend";
import { WebGPUBackend } from "./webgpu/backend";

export type BackendPreference = BackendKind | "auto";

export interface RendererOptions {
  /** `"auto"` (default) uses WebGPU when available and falls back to WebGL2. */
  readonly backend?: BackendPreference;
  /** Canvas clear color; defaults to opaque white. */
  readonly background?: Color;
  /**
   * Cache rendered 256 px screen tiles while scale and scene are unchanged,
   * so panning only rasterizes newly exposed tiles. Defaults to true.
   */
  readonly tileCache?: boolean;
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
  /** Coverage bitmaps of small, axis-aligned glyphs, shared by every frame. */
  readonly glyphAtlas = new GlyphAtlas();
  private width = 0;
  private height = 0;
  private pixelRatio = 1;
  private lastViewport: Viewport | null = null;
  private lastView: Mat2D | null = null;
  private lastSceneVersion = -1;
  private readonly tiles: TileCache | null;
  background: Color;

  private constructor(
    private readonly canvas: HTMLCanvasElement | OffscreenCanvas,
    private readonly backend: Backend,
    options: RendererOptions,
  ) {
    this.background = options.background ?? { r: 1, g: 1, b: 1, a: 1 };
    this.tiles = options.tileCache === false ? null : new TileCache(ATLAS_SLOTS);
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
    this.lastSceneVersion = -1;
  }

  /** Sets the drawing size in CSS pixels; the canvas backing store uses `pixelRatio`. */
  setSize(width: number, height: number, pixelRatio = 1): void {
    this.pixelRatio = pixelRatio;
    this.width = Math.max(1, Math.round(width * pixelRatio));
    this.height = Math.max(1, Math.round(height * pixelRatio));
    if (this.canvas.width !== this.width) this.canvas.width = this.width;
    if (this.canvas.height !== this.height) this.canvas.height = this.height;
    this.lastView = null;
  }

  render(viewport: Viewport): FrameStats {
    const start = performance.now();
    this.lastViewport = viewport;
    this.list.sync(this.scene);
    this.glyphAtlas.beginFrame();
    const raw = multiply(scaling(this.pixelRatio), viewport.transform);
    // Whole-device-pixel translation keeps cached tiles aligned and makes
    // direct and tiled frames identical.
    const view: Mat2D = [raw[0], raw[1], raw[2], raw[3], Math.round(raw[4]), Math.round(raw[5])];
    const prev = this.lastView;
    const sameScale = prev !== null && prev[0] === view[0] && prev[1] === view[1] && prev[2] === view[2] && prev[3] === view[3];
    const sameScene = this.scene.version === this.lastSceneVersion;
    const viewMoving = !sameScale || prev[4] !== view[4] || prev[5] !== view[5];
    this.lastView = view;
    this.lastSceneVersion = this.scene.version;
    if (!sameScale || !sameScene) this.tiles?.invalidate();

    // Zooming or editing changes every tile, so those frames render directly;
    // once scale and scene hold still, panning only rasterizes new tiles.
    const tilesAcross = (Math.ceil(this.width / TILE_SIZE) + 1) * (Math.ceil(this.height / TILE_SIZE) + 1);
    if (!this.tiles || !sameScale || !sameScene || tilesAcross * 2 > this.tiles.capacity) {
      const plan = planFrame(this.list, this.paints, view, this.width, this.height, this.glyphAtlas);
      const uploadedBytes = this.backend.render(plan, this.background);
      return this.stats("direct", [plan], uploadedBytes, 0, start);
    }
    const frame = this.tiles.schedule(view[4], view[5], this.width, this.height, viewMoving);
    const linear: Mat2D = [view[0], view[1], view[2], view[3], 0, 0];
    const jobs = frame.regions.map((r) => ({
      plan: planFrame(this.list, this.paints, multiply(translation(-r.x, -r.y), linear), r.width, r.height, this.glyphAtlas),
      copies: r.copies,
    }));
    const uploadedBytes = jobs.length > 0 ? this.backend.renderTiles(jobs, this.background) : 0;
    this.backend.presentTiles(frame.placements, this.width, this.height);
    const tilesRendered = frame.regions.reduce((n, r) => n + r.copies.length, 0);
    return this.stats("tiles", jobs.map((j) => j.plan), uploadedBytes, tilesRendered, start);
  }

  private stats(mode: FrameStats["mode"], plans: readonly FramePlan[], uploadedBytes: number, tilesRendered: number, start: number): FrameStats {
    let entries = 0;
    let segments = 0;
    for (const plan of plans) {
      entries += plan.entries.length;
      for (const e of plan.entries) segments += e.geometry?.segmentCount ?? 0;
    }
    return {
      backend: this.backend.kind,
      mode,
      entries,
      segments,
      uploadedBytes,
      tilesRendered,
      glyphsRasterized: this.glyphAtlas.rasterizedThisFrame,
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

  /** Per-stage GPU milliseconds of a recent frame, if the backend supports timestamp queries. */
  get gpuTimings(): StageTimings | null {
    return this.backend.gpuTimings;
  }

  readPixels(): Promise<PixelData> {
    return this.backend.readPixels();
  }

  destroy(): void {
    this.backend.destroy();
  }
}
