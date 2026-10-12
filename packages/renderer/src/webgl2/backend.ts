import { intersectRect, transformRect, type Rect } from "@fig-tree/geometry";
import { RangeAllocator, type Range } from "../arena";
import type { Backend, PixelData, TileJob } from "../backend";
import { ItemKind } from "../compile";
import type { FrameEntry, FramePlan, GraphNode, PaintRecord } from "../frame";
import type { GeometryLevel, GeometrySlot } from "../geometry-cache";
import type { ImageAtlas } from "../images";
import { PaintKind, premultiply } from "../paint";
import { blendCode } from "../types";
import { GLGraph, type GLTexture } from "./graph";
import { ATLAS_SLOTS_PER_ROW, TILE_SIZE, slotOrigin, type TilePlacement } from "../tile-cache";
import type { Color } from "../types";
import type { GlyphAtlas } from "../glyphs/atlas";
import {
  coverFragmentShader,
  coverVertexShader,
  glyphFragmentShader,
  glyphVertexShader,
  stencilFragmentShader,
  stencilVertexShader,
} from "./shaders";

const DATA_WIDTH = 1024; // texels per row of the data textures
const ENTRY_TEXELS = 8;
const PAINT_TEXELS = 4;
const MAX_LAYERS = 8;
/** Cell size of the occupancy grid used to find non-overlapping draws to batch. */
const BATCH_CELL = 32;

interface Target {
  msaaFbo: WebGLFramebuffer;
  color: WebGLRenderbuffer;
  depthStencil: WebGLRenderbuffer;
  resolveFbo: WebGLFramebuffer;
  resolveTexture: WebGLTexture;
}

interface Program {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

interface MultiDraw {
  multiDrawArraysWEBGL(
    mode: GLenum, firsts: Int32Array, firstsOffset: number, counts: Int32Array, countsOffset: number, drawCount: number,
  ): void;
}

/** A persistent RGBA32F texture with a CPU mirror, grown by whole rows. */
class DataTexture {
  readonly texture: WebGLTexture;
  private data: Float32Array;
  private rows = 0;

  constructor(private readonly gl: WebGL2RenderingContext, initialRows: number) {
    this.texture = gl.createTexture()!;
    this.data = new Float32Array(0);
    this.resize(initialRows);
  }

  /** Writes texels starting at `texel` (must not cross a row for single uploads). */
  write(texel: number, values: Float32Array): void {
    const neededRows = Math.ceil((texel + values.length / 4) / DATA_WIDTH);
    if (neededRows > this.rows) this.resize(Math.max(neededRows, this.rows * 2));
    this.data.set(values, texel * 4);
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    const firstRow = Math.floor(texel / DATA_WIDTH);
    const lastRow = Math.floor((texel + values.length / 4 - 1) / DATA_WIDTH);
    if (firstRow === lastRow) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, texel % DATA_WIDTH, firstRow, values.length / 4, 1, gl.RGBA, gl.FLOAT, values);
    } else {
      const rows = this.data.subarray(firstRow * DATA_WIDTH * 4, (lastRow + 1) * DATA_WIDTH * 4);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, firstRow, DATA_WIDTH, lastRow - firstRow + 1, gl.RGBA, gl.FLOAT, rows);
    }
  }

  private resize(rows: number): void {
    const gl = this.gl;
    const next = new Float32Array(rows * DATA_WIDTH * 4);
    next.set(this.data.subarray(0, Math.min(this.data.length, next.length)));
    this.data = next;
    this.rows = rows;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, DATA_WIDTH, rows, 0, gl.RGBA, gl.FLOAT, next);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }
}

/**
 * WebGL2 fallback: stencil-then-cover with MSAA. Consecutive fills whose
 * bounds do not overlap are batched into one multi-draw stencil call and one
 * instanced cover call; layers render into an MSAA framebuffer stack.
 */
export class WebGL2Backend implements Backend {
  readonly kind = "webgl2" as const;
  /** WebGL2 timer queries are rarely exposed to the web, so GPU timings are not measured. */
  readonly gpuTimings = null;
  private readonly stencilProgram: Program;
  private readonly coverProgram: Program;
  private readonly glyphProgram: Program;
  private readonly glyphVao: WebGLVertexArrayObject;
  private glyphBuffer: WebGLBuffer;
  private glyphBufferBytes = 0;
  /** Per entry index: first glyph instance and count in the frame's glyph buffer. */
  private glyphRanges = new Map<number, [number, number]>();
  private glyphAtlas: WebGLTexture | null = null;
  private glyphAtlasSize: [number, number] = [0, 0];
  private glyphAtlasGeneration = -1;
  private readonly multiDraw: MultiDraw | null;
  private readonly graph: GLGraph;
  /** Output textures of the render graph the current frame's entries draw. */
  private textures = new Map<GraphNode, GLTexture>();
  private imageAtlas: WebGLTexture | null = null;
  private imageAtlasSize = 0;
  /** Per layer depth: the mask texture of a mask group at that depth. */
  private maskTargets: { fbo: WebGLFramebuffer; texture: WebGLTexture; width: number; height: number }[] = [];
  /** Scratch copy of a layer's backdrop for blend modes. */
  private backdrop: { fbo: WebGLFramebuffer; texture: WebGLTexture; width: number; height: number } | null = null;
  private time = 0;
  private readonly samples: number;
  private vertexBuffer: WebGLBuffer;
  private readonly vertexAlloc = new RangeAllocator(1 << 16);
  private readonly geometryVao: WebGLVertexArrayObject;
  private readonly emptyVao: WebGLVertexArrayObject;
  private readonly geometryCache = new Map<GeometrySlot, { uploadId: number; range: Range }>();
  private readonly paintCache = new Map<number, { uploadId: number; slot: Range; stops: Range }>();
  private readonly paintAlloc = new RangeAllocator(256);
  private readonly stopAlloc = new RangeAllocator(1024);
  private readonly paints: DataTexture;
  private readonly stops: DataTexture;
  private readonly entryTexture: WebGLTexture;
  private entryRows = 0;
  private cacheGeneration = -1;
  private targets: Target[] = [];
  private capacityWidth = 0;
  private capacityHeight = 0;
  /** Size of the frame being drawn (targets may be larger). */
  private width = 0;
  private height = 0;
  private atlas: { fbo: WebGLFramebuffer; texture: WebGLTexture } | null = null;
  private present: { fbo: WebGLFramebuffer; texture: WebGLTexture; width: number; height: number } | null = null;
  /** What readPixels returns: the framebuffer last shown on the canvas. */
  private output: { fbo: WebGLFramebuffer; width: number; height: number } | null = null;

  private constructor(private readonly gl: WebGL2RenderingContext) {
    this.multiDraw = gl.getExtension("WEBGL_multi_draw") as MultiDraw | null;
    this.samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES) as number);
    this.stencilProgram = link(gl, stencilVertexShader(this.multiDraw !== null), stencilFragmentShader, ["u_entryBase", "u_viewport", "u_entries"]);
    this.coverProgram = link(gl, coverVertexShader, coverFragmentShader, ["u_entryBase", "u_viewport", "u_entries", "u_paints", "u_stops", "u_layer", "u_backdrop", "u_mask", "u_imageAtlas", "u_tex", "u_time"]);
    this.glyphProgram = link(gl, glyphVertexShader, glyphFragmentShader, ["u_viewport", "u_entries", "u_paints", "u_stops", "u_atlas", "u_imageAtlas", "u_tex", "u_time"]);
    this.graph = new GLGraph(gl);
    this.glyphBuffer = gl.createBuffer()!;
    this.glyphVao = gl.createVertexArray()!;
    this.vertexBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.vertexAlloc.capacity * 8, gl.STATIC_DRAW);
    this.geometryVao = gl.createVertexArray()!;
    this.bindGeometryVao();
    this.emptyVao = gl.createVertexArray()!;
    this.paints = new DataTexture(gl, 1);
    this.stops = new DataTexture(gl, 1);
    this.entryTexture = gl.createTexture()!;
  }

  static create(canvas: HTMLCanvasElement | OffscreenCanvas): WebGL2Backend | null {
    const gl = canvas.getContext("webgl2", {
      antialias: false,
      alpha: true,
      premultipliedAlpha: true,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    }) as WebGL2RenderingContext | null;
    return gl ? new WebGL2Backend(gl) : null;
  }

  /** GPU bytes held for effects (pooled and output textures) and the image atlas. */
  get textureBytes(): number {
    return this.graph.bytes + this.imageAtlasSize * this.imageAtlasSize * 4;
  }

  /** Runs the render graph of `plans` (rasters, effects), keeping the output textures their entries draw. */
  private runGraph(plans: readonly FramePlan[]): number {
    let uploaded = 0;
    const graph = plans.flatMap((p) => p.graph);
    this.time = plans[0]?.time ?? 0;
    if (graph.length === 0) {
      this.textures = new Map();
      return 0;
    }
    // Mesh lookups read their paint's parameters.
    for (const node of graph) if (node.op === "mesh") uploaded += this.uploadPaint(node.paint);
    this.textures = this.graph.run(
      plans,
      graph,
      (plan, background, textures) => {
        this.textures = textures;
        uploaded += this.draw(plan, background);
        return this.targets[0]!.resolveFbo;
      },
      () => this.stops.texture,
      (node) => (this.paintCache.get(node.paint.key)?.stops.offset ?? 0) * 2,
    );
    return uploaded;
  }

  render(plan: FramePlan, background: Color): number {
    const gl = this.gl;
    let uploaded = this.runGraph([plan]);
    uploaded += this.draw(plan, background);
    const main = this.targets[0]!;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, main.resolveFbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(0, 0, plan.width, plan.height, 0, 0, plan.width, plan.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    this.output = { fbo: main.resolveFbo, width: plan.width, height: plan.height };
    return uploaded;
  }

  renderTiles(jobs: readonly TileJob[], background: Color): number {
    const gl = this.gl;
    const atlas = this.ensureAtlas();
    let uploaded = 0;
    for (const job of jobs) {
      uploaded += this.runGraph([job.plan]);
      uploaded += this.draw(job.plan, background);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.targets[0]!.resolveFbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, atlas.fbo);
      const h = job.plan.height;
      for (const c of job.copies) {
        // Atlas slots keep GL's bottom-up row order.
        const o = slotOrigin(c.slot);
        gl.blitFramebuffer(c.dx, h - c.dy - TILE_SIZE, c.dx + TILE_SIZE, h - c.dy, o.x, o.y, o.x + TILE_SIZE, o.y + TILE_SIZE, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      }
    }
    return uploaded;
  }

  presentTiles(placements: readonly TilePlacement[], width: number, height: number): void {
    const gl = this.gl;
    const atlas = this.ensureAtlas();
    if (!this.present || this.present.width < width || this.present.height < height) {
      if (this.present) {
        gl.deleteFramebuffer(this.present.fbo);
        gl.deleteTexture(this.present.texture);
      }
      this.present = createColorTarget(gl, Math.max(width, this.present?.width ?? 0), Math.max(height, this.present?.height ?? 0));
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, atlas.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.present.fbo);
    for (const p of placements) {
      const o = slotOrigin(p.slot);
      // Clip in software: blits outside the destination would be dropped anyway,
      // but the source rect must shrink with it to keep a 1:1 copy.
      const x0 = Math.max(0, p.x), x1 = Math.min(width, p.x + TILE_SIZE);
      const top = Math.max(0, p.y), bottom = Math.min(height, p.y + TILE_SIZE);
      if (x1 <= x0 || bottom <= top) continue;
      const sx = o.x + (x0 - p.x);
      const sy = o.y + (p.y + TILE_SIZE - bottom);
      gl.blitFramebuffer(sx, sy, sx + (x1 - x0), sy + (bottom - top), x0, height - bottom, x1, height - top, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.present.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    this.output = { fbo: this.present.fbo, width, height };
  }

  /** Rasterizes `plan` into the main MSAA target and resolves it; returns bytes uploaded. */
  private draw(plan: FramePlan, background: Color | readonly [number, number, number, number]): number {
    const gl = this.gl;
    this.ensureTargets(plan.width, plan.height);
    if (plan.list.generation !== this.cacheGeneration) {
      this.sweep(plan);
      this.cacheGeneration = plan.list.generation;
    }
    gl.activeTexture(gl.TEXTURE0);
    let uploaded = this.uploadGlyphs(plan.atlas);
    uploaded += this.uploadImages(plan.images);
    this.prepareGlyphInstances(plan.entries);
    for (const e of plan.entries) {
      if (e.geometry && e.item.geometry) uploaded += this.uploadGeometry(e.item.geometry, e.geometry);
      if (e.paint) uploaded += this.uploadPaint(e.paint);
    }
    // Cover the whole geometry, not just its clipped bounds: every stencil
    // sample a path touches must be reset by its own cover.
    const screen: Rect = { minX: 0, minY: 0, maxX: plan.width, maxY: plan.height };
    const rects = plan.entries.map((e) =>
      e.kind === ItemKind.Fill && e.geometry ? intersectRect(transformRect(e.matrix, e.geometry.bounds), screen) : e.bounds,
    );
    this.uploadEntries(plan.entries, rects);

    gl.viewport(0, 0, plan.width, plan.height);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.targets[0]!.msaaFbo);
    const bg = "r" in background ? premultiply(background) : background;
    gl.clearColor(bg[0], bg[1], bg[2], bg[3]);
    gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    gl.enable(gl.STENCIL_TEST);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.bindTextures();

    const entries = plan.entries;
    const layerStack: number[] = [];
    let batchStart = -1;
    const occupied = new Set<number>();
    const flush = (end: number): void => {
      if (batchStart >= 0 && end > batchStart) this.drawBatch(entries, batchStart, end);
      batchStart = -1;
      occupied.clear();
    };
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      if (e.kind === ItemKind.Fill && e.glyphs) {
        flush(i);
        // Consecutive glyph entries draw together (one with its own texture draws alone).
        let j = i + 1;
        if (!e.sampled) while (j < entries.length && entries[j]!.kind === ItemKind.Fill && entries[j]!.glyphs && !entries[j]!.sampled) j++;
        this.bindEntryTexture(e);
        this.drawGlyphs(i, j);
        i = j - 1;
        continue;
      }
      if (e.kind === ItemKind.Fill && e.texture) {
        flush(i);
        this.bindEntryTexture(e);
        this.cover(i, 1, false);
        continue;
      }
      if (e.kind === ItemKind.Fill && e.sampled) {
        flush(i);
        this.bindEntryTexture(e);
        this.drawBatch(entries, i, i + 1);
        continue;
      }
      if (e.kind === ItemKind.Fill) {
        const cells = cellsOf(rects[i]!);
        const rule = e.fillRule;
        const conflicts =
          batchStart >= 0 && (entries[batchStart]!.fillRule !== rule || cells.some((c) => occupied.has(c)));
        if (conflicts) flush(i);
        if (batchStart < 0) batchStart = i;
        for (const c of cells) occupied.add(c);
      } else if (e.kind === ItemKind.BeginLayer) {
        flush(i);
        layerStack.push(i);
        this.beginLayer(layerStack.length, e, i);
      } else {
        flush(i);
        const begin = entries[layerStack.pop()!]!;
        this.endLayer(layerStack.length + 1, begin, i);
      }
    }
    flush(entries.length);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.BLEND);

    const main = this.targets[0]!;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, main.msaaFbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, main.resolveFbo);
    gl.blitFramebuffer(0, 0, plan.width, plan.height, 0, 0, plan.width, plan.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    return uploaded;

    function cellsOf(r: Rect): number[] {
      const out: number[] = [];
      const x0 = Math.floor((r.minX - 1) / BATCH_CELL), x1 = Math.floor((r.maxX + 1) / BATCH_CELL);
      const y0 = Math.floor((r.minY - 1) / BATCH_CELL), y1 = Math.floor((r.maxY + 1) / BATCH_CELL);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push(y * 65536 + x);
      return out;
    }
  }

  /** Waits for the GPU via a fence, polled so the main thread never blocks. */
  async settle(): Promise<boolean> {
    const gl = this.gl;
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!sync) return false;
    gl.flush();
    while (gl.clientWaitSync(sync, 0, 0) === gl.TIMEOUT_EXPIRED) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    gl.deleteSync(sync);
    return false;
  }

  async readPixels(): Promise<PixelData> {
    const gl = this.gl;
    if (!this.output) throw new Error("nothing rendered yet");
    const { fbo, width, height } = this.output;
    const raw = new Uint8Array(width * height * 4);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    // GL rows are bottom-up.
    const data = new Uint8Array(raw.length);
    for (let y = 0; y < height; y++) data.set(raw.subarray((height - 1 - y) * width * 4, (height - y) * width * 4), y * width * 4);
    return { width, height, data };
  }

  destroy(): void {
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  /** Stencil all fills in [start, end) at once, then cover them with one instanced draw. */
  private drawBatch(entries: readonly FrameEntry[], start: number, end: number): void {
    const firsts = new Int32Array(end - start);
    const counts = new Int32Array(end - start);
    for (let i = start; i < end; i++) {
      const up = this.geometryCache.get(entries[i]!.item.geometry!)!;
      firsts[i - start] = up.range.offset;
      counts[i - start] = up.range.size;
    }
    this.stencil(start, firsts, counts, entries[start]!.fillRule === "evenodd");
    this.cover(start, end - start);
  }

  /** Uploads new glyph bitmaps into the R8 atlas texture; returns the bytes uploaded. */
  private uploadGlyphs(atlas: GlyphAtlas | null): number {
    if (!atlas) return 0;
    const gl = this.gl;
    if (!this.glyphAtlas || atlas.generation !== this.glyphAtlasGeneration || this.glyphAtlasSize[0] !== atlas.width || this.glyphAtlasSize[1] !== atlas.height) {
      if (this.glyphAtlas) gl.deleteTexture(this.glyphAtlas);
      this.glyphAtlas = gl.createTexture()!;
      gl.activeTexture(gl.TEXTURE0 + GLYPH_UNIT);
      gl.bindTexture(gl.TEXTURE_2D, this.glyphAtlas);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, atlas.width, atlas.height);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      this.glyphAtlasSize = [atlas.width, atlas.height];
      this.glyphAtlasGeneration = atlas.generation;
    }
    const uploads = atlas.takeUploads();
    if (uploads.length === 0) return 0;
    gl.activeTexture(gl.TEXTURE0 + GLYPH_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.glyphAtlas);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    let bytes = 0;
    for (const u of uploads) {
      if (u.width === 0 || u.height === 0) continue;
      gl.texSubImage2D(gl.TEXTURE_2D, 0, u.x, u.y, u.width, u.height, gl.RED, gl.UNSIGNED_BYTE, u.data);
      bytes += u.data.byteLength;
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.activeTexture(gl.TEXTURE0);
    return bytes;
  }

  /** Packs every glyph entry's placements into the per-frame instance buffer. */
  private prepareGlyphInstances(entries: readonly FrameEntry[]): void {
    this.glyphRanges.clear();
    let count = 0;
    for (const e of entries) if (e.glyphs) count += e.glyphs.length;
    if (count === 0) return;
    // Per glyph: device rect (x, y, w, h), atlas origin (x, y) and the entry index.
    const data = new Float32Array(count * GLYPH_FLOATS);
    let k = 0;
    entries.forEach((e, i) => {
      if (!e.glyphs) return;
      this.glyphRanges.set(i, [k, e.glyphs.length]);
      for (const g of e.glyphs) {
        const o = k * GLYPH_FLOATS;
        data[o] = g.x;
        data[o + 1] = g.y;
        data[o + 2] = g.glyph.width;
        data[o + 3] = g.glyph.height;
        data[o + 4] = g.glyph.x;
        data[o + 5] = g.glyph.y;
        data[o + 6] = i;
        k++;
      }
    });
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.glyphBuffer);
    if (data.byteLength > this.glyphBufferBytes) {
      this.glyphBufferBytes = Math.max(data.byteLength, this.glyphBufferBytes * 2);
      gl.bufferData(gl.ARRAY_BUFFER, this.glyphBufferBytes, gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
  }

  /**
   * Draws glyph entries `[first, end)` (consecutive in paint order) as one
   * instanced draw: a quad per glyph, coverage from the atlas, paint from
   * the glyph's entry. Instances draw in order, so overlaps blend in paint order.
   */
  private drawGlyphs(first: number, end: number): void {
    if (!this.glyphAtlas) return;
    let start = -1;
    let count = 0;
    for (let i = first; i < end; i++) {
      const range = this.glyphRanges.get(i);
      if (!range) continue;
      if (start < 0) start = range[0];
      count = range[0] + range[1] - start;
    }
    if (start < 0 || count === 0) return;
    const gl = this.gl;
    const p = this.glyphProgram;
    gl.useProgram(p.program);
    gl.uniform2f(p.uniforms["u_viewport"]!, this.width, this.height);
    gl.uniform1f(p.uniforms["u_time"]!, this.time);
    gl.bindVertexArray(this.glyphVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.glyphBuffer);
    const stride = GLYPH_FLOATS * 4;
    const base = start * stride;
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, base);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, base + 16);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, base + 24);
    gl.vertexAttribDivisor(3, 1);
    gl.colorMask(true, true, true, true);
    gl.enable(gl.BLEND);
    gl.disable(gl.STENCIL_TEST);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
    gl.enable(gl.STENCIL_TEST);
    gl.bindVertexArray(null);
  }

  private stencil(entryBase: number, firsts: Int32Array, counts: Int32Array, evenodd: boolean): void {
    const gl = this.gl;
    gl.useProgram(this.stencilProgram.program);
    gl.uniform1i(this.stencilProgram.uniforms["u_entryBase"]!, entryBase);
    gl.uniform2f(this.stencilProgram.uniforms["u_viewport"]!, this.width, this.height);
    gl.bindVertexArray(this.geometryVao);
    gl.colorMask(false, false, false, false);
    gl.disable(gl.BLEND);
    gl.stencilFunc(gl.ALWAYS, 0, 0xff);
    if (evenodd) {
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
    } else {
      gl.stencilOpSeparate(gl.FRONT, gl.KEEP, gl.KEEP, gl.INCR_WRAP);
      gl.stencilOpSeparate(gl.BACK, gl.KEEP, gl.KEEP, gl.DECR_WRAP);
    }
    if (this.multiDraw) {
      this.multiDraw.multiDrawArraysWEBGL(gl.TRIANGLES, firsts, 0, counts, 0, firsts.length);
    } else {
      for (let i = 0; i < firsts.length; i++) {
        gl.uniform1i(this.stencilProgram.uniforms["u_entryBase"]!, entryBase + i);
        gl.drawArrays(gl.TRIANGLES, firsts[i]!, counts[i]!);
      }
    }
  }

  /** Draws cover quads where the stencil is non-zero, resetting it to zero. */
  private cover(entryBase: number, count: number, useStencil = true, replace = false): void {
    const gl = this.gl;
    gl.useProgram(this.coverProgram.program);
    gl.uniform1i(this.coverProgram.uniforms["u_entryBase"]!, entryBase);
    gl.uniform2f(this.coverProgram.uniforms["u_viewport"]!, this.width, this.height);
    gl.uniform1f(this.coverProgram.uniforms["u_time"]!, this.time);
    gl.bindVertexArray(this.emptyVao);
    gl.colorMask(true, true, true, true);
    if (replace) gl.disable(gl.BLEND);
    else gl.enable(gl.BLEND);
    if (useStencil) {
      gl.enable(gl.STENCIL_TEST);
      gl.stencilFunc(gl.NOTEQUAL, 0, 0xff);
      gl.stencilOp(gl.KEEP, gl.ZERO, gl.ZERO);
    } else {
      gl.disable(gl.STENCIL_TEST);
    }
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
    gl.enable(gl.STENCIL_TEST);
    gl.enable(gl.BLEND);
  }

  private beginLayer(depth: number, e: FrameEntry, index: number): void {
    const gl = this.gl;
    const t = this.target(depth);
    gl.enable(gl.SCISSOR_TEST);
    const r = scissorRect(e, this.height);
    gl.scissor(r[0], r[1], r[2], r[3]);
    if (e.layer?.backdrop) {
      // A non-isolated layer starts from what is below it: resolve the parent, then copy it in
      // (GL ES cannot blit into a multisampled framebuffer).
      const b = this.backdropTarget();
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.targets[depth - 1]!.msaaFbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, b.fbo);
      gl.blitFramebuffer(r[0], r[1], r[0] + r[2], r[1] + r[3], r[0], r[1], r[0] + r[2], r[1] + r[3], gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.msaaFbo);
      gl.clear(gl.STENCIL_BUFFER_BIT);
      gl.activeTexture(gl.TEXTURE0 + LAYER_UNIT);
      gl.bindTexture(gl.TEXTURE_2D, b.texture);
      gl.activeTexture(gl.TEXTURE0);
      this.cover(index, 1, false, true);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.msaaFbo);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    }
    if (e.layer?.mode === "mask-group") {
      // No mask drawn means nothing shows.
      const m = this.maskTarget(depth);
      gl.bindFramebuffer(gl.FRAMEBUFFER, m.fbo);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.msaaFbo);
    }
    gl.disable(gl.SCISSOR_TEST);
  }

  /** Resolves layer `depth` and composites it into its parent (clip, opacity, mask, blend mode). */
  private endLayer(depth: number, begin: FrameEntry, endIndex: number): void {
    const gl = this.gl;
    const layer = this.target(depth);
    const parent = this.targets[depth - 1]!;
    const r = scissorRect(begin, this.height);
    const info = begin.layer!;
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(r[0], r[1], r[2], r[3]);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, layer.msaaFbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, layer.resolveFbo);
    gl.blitFramebuffer(0, 0, this.width, this.height, 0, 0, this.width, this.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    if (info.mode === "mask-source") {
      // The mask's rendering becomes its group's mask; nothing is composited.
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, layer.resolveFbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.maskTarget(depth - 1).fbo);
      gl.blitFramebuffer(r[0], r[1], r[0] + r[2], r[1] + r[3], r[0], r[1], r[0] + r[2], r[1] + r[3], gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, parent.msaaFbo);
      gl.disable(gl.SCISSOR_TEST);
      return;
    }
    const blends = info.blend !== "normal" && !info.backdrop;
    if (blends) {
      // Blend modes read the backdrop: resolve the parent's pixels under the layer.
      const b = this.backdropTarget();
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, parent.msaaFbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, b.fbo);
      gl.blitFramebuffer(r[0], r[1], r[0] + r[2], r[1] + r[3], r[0], r[1], r[0] + r[2], r[1] + r[3], gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.activeTexture(gl.TEXTURE0 + BACKDROP_UNIT);
      gl.bindTexture(gl.TEXTURE_2D, b.texture);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, parent.msaaFbo);
    gl.activeTexture(gl.TEXTURE0 + LAYER_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, layer.resolveTexture);
    if (info.mode === "mask-group") {
      gl.activeTexture(gl.TEXTURE0 + MASK_UNIT);
      gl.bindTexture(gl.TEXTURE_2D, this.maskTarget(depth).texture);
    }
    gl.activeTexture(gl.TEXTURE0);
    const clip = info.mode === "clip" && begin.geometry && begin.item.geometry ? this.geometryCache.get(begin.item.geometry) : undefined;
    // Blend modes and non-isolated clips replace the parent's pixels (they already include it).
    const replace = blends || info.backdrop;
    // The scissor stays on: the clip path's stencil may extend past the layer's
    // bounds, and the cover (which resets the stencil) only spans those bounds.
    // Stencil left outside would leak into later covers.
    if (clip) {
      this.stencil(endIndex, Int32Array.of(clip.range.offset), Int32Array.of(clip.range.size), begin.fillRule === "evenodd");
      this.cover(endIndex, 1, true, replace);
    } else {
      this.cover(endIndex, 1, false, replace);
    }
    gl.disable(gl.SCISSOR_TEST);
    gl.activeTexture(gl.TEXTURE0 + LAYER_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
  }

  /** Binds the texture a fill entry draws or samples (effect output, backdrop, mesh lookup). */
  private bindEntryTexture(e: FrameEntry): void {
    const gl = this.gl;
    const node = e.texture?.node ?? e.sampled?.node;
    const t = node ? this.textures.get(node) : undefined;
    gl.activeTexture(gl.TEXTURE0 + TEX_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, t?.texture ?? null);
    gl.activeTexture(gl.TEXTURE0);
  }

  private maskTarget(depth: number) {
    while (this.maskTargets.length <= depth) this.maskTargets.push(createColorTarget(this.gl, this.capacityWidth, this.capacityHeight));
    return this.maskTargets[depth]!;
  }

  private backdropTarget() {
    this.backdrop ??= createColorTarget(this.gl, this.capacityWidth, this.capacityHeight);
    return this.backdrop;
  }

  /** Uploads image regions placed since the last frame into the image atlas texture. */
  private uploadImages(images: ImageAtlas | null): number {
    if (!images || !images.used) return 0;
    const gl = this.gl;
    if (!this.imageAtlas || this.imageAtlasSize !== images.width) {
      if (this.imageAtlas) gl.deleteTexture(this.imageAtlas);
      this.imageAtlas = gl.createTexture()!;
      gl.activeTexture(gl.TEXTURE0 + IMAGE_UNIT);
      gl.bindTexture(gl.TEXTURE_2D, this.imageAtlas);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, images.width, images.height);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      this.imageAtlasSize = images.width;
    }
    const uploads = images.takeUploads();
    if (uploads.length === 0) return 0;
    gl.activeTexture(gl.TEXTURE0 + IMAGE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.imageAtlas);
    let bytes = 0;
    for (const u of uploads) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, u.x, u.y, u.width, u.height, gl.RGBA, gl.UNSIGNED_BYTE, u.data);
      bytes += u.data.byteLength;
    }
    gl.activeTexture(gl.TEXTURE0);
    return bytes;
  }

  private bindTextures(): void {
    const gl = this.gl;
    const bind = (unit: number, tex: WebGLTexture | null): void => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
    };
    bind(0, this.entryTexture);
    bind(1, this.paints.texture);
    bind(2, this.stops.texture);
    gl.useProgram(this.stencilProgram.program);
    gl.uniform1i(this.stencilProgram.uniforms["u_entries"]!, 0);
    gl.useProgram(this.coverProgram.program);
    gl.uniform1i(this.coverProgram.uniforms["u_entries"]!, 0);
    gl.uniform1i(this.coverProgram.uniforms["u_paints"]!, 1);
    gl.uniform1i(this.coverProgram.uniforms["u_stops"]!, 2);
    gl.uniform1i(this.coverProgram.uniforms["u_layer"]!, LAYER_UNIT);
    gl.uniform1i(this.coverProgram.uniforms["u_backdrop"]!, BACKDROP_UNIT);
    gl.uniform1i(this.coverProgram.uniforms["u_mask"]!, MASK_UNIT);
    gl.uniform1i(this.coverProgram.uniforms["u_imageAtlas"]!, IMAGE_UNIT);
    gl.uniform1i(this.coverProgram.uniforms["u_tex"]!, TEX_UNIT);
    bind(GLYPH_UNIT, this.glyphAtlas);
    bind(IMAGE_UNIT, this.imageAtlas);
    gl.useProgram(this.glyphProgram.program);
    gl.uniform1i(this.glyphProgram.uniforms["u_entries"]!, 0);
    gl.uniform1i(this.glyphProgram.uniforms["u_paints"]!, 1);
    gl.uniform1i(this.glyphProgram.uniforms["u_stops"]!, 2);
    gl.uniform1i(this.glyphProgram.uniforms["u_atlas"]!, GLYPH_UNIT);
    gl.uniform1i(this.glyphProgram.uniforms["u_imageAtlas"]!, IMAGE_UNIT);
    gl.uniform1i(this.glyphProgram.uniforms["u_tex"]!, TEX_UNIT);
    gl.activeTexture(gl.TEXTURE0);
  }

  private uploadEntries(entries: readonly FrameEntry[], rects: readonly Rect[]): void {
    const gl = this.gl;
    const rows = Math.max(1, Math.ceil((entries.length * ENTRY_TEXELS) / DATA_WIDTH));
    const data = new Float32Array(rows * DATA_WIDTH * 4);
    entries.forEach((e, i) => {
      const k = i * ENTRY_TEXELS * 4;
      const m = e.matrix;
      const paint = e.paint ? this.paintCache.get(e.paint.key)!.slot.offset : -1;
      const pad = 1; // cover one extra pixel so every MSAA sample the stencil touched is reset
      data.set([m[0], m[1], m[2], m[3], m[4], m[5], e.alpha, paint], k);
      const r = rects[i]!;
      // Layer composites cover exactly their scissor rect (see endLayer).
      const end = e.kind === ItemKind.EndLayer || (e.kind === ItemKind.BeginLayer && !!e.layer?.backdrop);
      data.set([
        Math.max(0, end ? Math.floor(r.minX) - 1 : r.minX - pad), Math.max(0, end ? Math.floor(r.minY) - 1 : r.minY - pad),
        Math.min(this.width, end ? Math.ceil(r.maxX) + 1 : r.maxX + pad), Math.min(this.height, end ? Math.ceil(r.maxY) + 1 : r.maxY + pad),
      ], k + 8);
      let mode = 0;
      let mask = 0;
      const layer = e.layer;
      if (e.kind === ItemKind.BeginLayer && layer?.backdrop) {
        mode = 4; // copies the parent's pixels into the layer (see beginLayer)
      } else if (end && layer) {
        mode = layer.backdrop ? 4 : layer.blend !== "normal" ? 3 : 1;
        if (layer.mode === "mask-group") mask = 3 + (layer.maskType === "luminance" ? 1 : 0);
      } else if (e.texture) mode = 2;
      const tex = e.texture ?? e.sampled;
      const im = e.image;
      const flags = (tex ? 1 : 0) | (im ? 2 : 0) | (e.shape ? 4 : 0);
      data.set([mode, layer ? blendCode(layer.blend) : 0, mask, flags], k + 12);
      if (tex) {
        const node = tex.node;
        data.set([tex.x, tex.y, node.rect.width, node.rect.height], k + 16);
      }
      if (im) {
        data.set([im.atlasX, im.atlasY, im.rectX, im.rectY, im.rectWidth, im.rectHeight, im.levelWidth, im.levelHeight, im.pixelsPerTexel, 0, 0, 0], k + 20);
      }
    });
    gl.bindTexture(gl.TEXTURE_2D, this.entryTexture);
    if (rows > this.entryRows) {
      this.entryRows = Math.max(rows, this.entryRows * 2);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, DATA_WIDTH, this.entryRows, 0, gl.RGBA, gl.FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    }
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, DATA_WIDTH, rows, gl.RGBA, gl.FLOAT, data);
  }

  private sweep(plan: FramePlan): void {
    for (const [slot, up] of this.geometryCache) {
      if (plan.list.liveSlots.has(slot)) continue;
      this.vertexAlloc.release(up.range);
      this.geometryCache.delete(slot);
    }
    for (const [key, up] of this.paintCache) {
      if (plan.list.liveNodeIds.has(Math.floor(key / 2))) continue;
      this.paintAlloc.release(up.slot);
      this.stopAlloc.release(up.stops);
      this.paintCache.delete(key);
    }
  }

  /** Uploads geometry as triangles fanned from the first vertex (valid for stencil winding counts). */
  private uploadGeometry(slot: GeometrySlot, level: GeometryLevel): number {
    const cached = this.geometryCache.get(slot);
    if (cached && cached.uploadId === level.uploadId) return 0;
    if (cached) this.vertexAlloc.release(cached.range);
    const segs = level.segments;
    const n = level.segmentCount;
    const verts = new Float32Array(n * 6);
    const ax = segs[0] ?? 0, ay = segs[1] ?? 0;
    for (let i = 0; i < n; i++) {
      verts.set([ax, ay, segs[i * 4]!, segs[i * 4 + 1]!, segs[i * 4 + 2]!, segs[i * 4 + 3]!], i * 6);
    }
    let range = this.vertexAlloc.allocate(n * 3);
    while (!range) {
      this.growVertices(Math.max(this.vertexAlloc.capacity * 2, this.vertexAlloc.used + n * 3));
      range = this.vertexAlloc.allocate(n * 3);
    }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    if (n > 0) gl.bufferSubData(gl.ARRAY_BUFFER, range.offset * 8, verts);
    this.geometryCache.set(slot, { uploadId: level.uploadId, range });
    return verts.byteLength;
  }

  private growVertices(capacity: number): void {
    const gl = this.gl;
    const next = gl.createBuffer()!;
    gl.bindBuffer(gl.COPY_WRITE_BUFFER, next);
    gl.bufferData(gl.COPY_WRITE_BUFFER, capacity * 8, gl.STATIC_DRAW);
    gl.bindBuffer(gl.COPY_READ_BUFFER, this.vertexBuffer);
    gl.copyBufferSubData(gl.COPY_READ_BUFFER, gl.COPY_WRITE_BUFFER, 0, 0, this.vertexAlloc.capacity * 8);
    gl.deleteBuffer(this.vertexBuffer);
    this.vertexBuffer = next;
    this.vertexAlloc.grow(capacity);
    this.bindGeometryVao();
  }

  private bindGeometryVao(): void {
    const gl = this.gl;
    gl.bindVertexArray(this.geometryVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    gl.bindVertexArray(null);
  }

  private uploadPaint(record: PaintRecord): number {
    const cached = this.paintCache.get(record.key);
    if (cached && cached.uploadId === record.uploadId) return 0;
    const paint = record.paint;
    const params = paint.params.length > 0 ? paramsWithImageMatrix(paint) : null;
    const stopCount = params ? Math.ceil(params.length / 8) : paint.stops.length / 5;
    const slot = cached?.slot ?? this.allocate(this.paintAlloc, 1);
    if (cached) this.stopAlloc.release(cached.stops);
    const stops = this.allocate(this.stopAlloc, stopCount);
    const m = paint.matrix;
    this.paints.write(slot.offset * PAINT_TEXELS, Float32Array.of(
      paint.kind, stops.offset, stopCount, 0,
      ...paint.color,
      m[0], m[1], m[2], m[3],
      m[4], m[5], 0, 0,
    ));
    if (params) {
      const sd = new Float32Array(stopCount * 8);
      sd.set(params);
      this.stops.write(stops.offset * 2, sd);
    } else if (stopCount > 0) {
      const sd = new Float32Array(stopCount * 8);
      for (let i = 0; i < stopCount; i++) {
        sd[i * 8] = paint.stops[i * 5]!;
        sd.set(paint.stops.subarray(i * 5 + 1, i * 5 + 5), i * 8 + 4);
      }
      this.stops.write(stops.offset * 2, sd);
    }
    this.paintCache.set(record.key, { uploadId: record.uploadId, slot, stops });
    return 64 + stopCount * 32;
  }

  /** Paint and stop data textures grow on write, so their allocators can always grow. */
  private allocate(alloc: RangeAllocator, size: number): Range {
    let r = alloc.allocate(size);
    while (!r) {
      alloc.grow(Math.max(alloc.capacity * 2, alloc.used + size));
      r = alloc.allocate(size);
    }
    return r;
  }

  /** Targets only grow, so tile regions of varying size never reallocate them. */
  private ensureTargets(width: number, height: number): void {
    this.width = width;
    this.height = height;
    if (width <= this.capacityWidth && height <= this.capacityHeight && this.targets.length > 0) return;
    const gl = this.gl;
    for (const t of this.targets) deleteTarget(gl, t);
    this.targets = [];
    for (const t of [...this.maskTargets, ...(this.backdrop ? [this.backdrop] : [])]) {
      gl.deleteFramebuffer(t.fbo);
      gl.deleteTexture(t.texture);
    }
    this.maskTargets = [];
    this.backdrop = null;
    this.capacityWidth = Math.max(width, this.capacityWidth);
    this.capacityHeight = Math.max(height, this.capacityHeight);
    this.target(0);
  }

  private ensureAtlas(): { fbo: WebGLFramebuffer; texture: WebGLTexture } {
    this.atlas ??= createColorTarget(this.gl, ATLAS_SLOTS_PER_ROW * TILE_SIZE, ATLAS_SLOTS_PER_ROW * TILE_SIZE);
    return this.atlas;
  }

  /** Framebuffers for layer `depth` (0 is the main target), created on first use. */
  private target(depth: number): Target {
    if (depth > MAX_LAYERS) throw new Error(`layer depth ${depth} exceeds ${MAX_LAYERS}`);
    while (this.targets.length <= depth) this.targets.push(createTarget(this.gl, this.capacityWidth, this.capacityHeight, this.samples));
    return this.targets[depth]!;
  }
}

/** Shaders reading an image get its image-to-local matrix after their parameters (vec4s 6 and 7). */
function paramsWithImageMatrix(paint: { readonly kind: number; readonly params: Float32Array; readonly imageMatrix: readonly number[]; readonly image: { width: number; height: number } | null }): Float32Array {
  if (paint.kind !== PaintKind.Shader || !paint.image) return paint.params;
  const m = paint.imageMatrix;
  const out = new Float32Array(Math.max(paint.params.length, 24) + 8);
  out.set(paint.params);
  out.set([m[0]!, m[1]!, m[2]!, m[3]!, m[4]!, m[5]!, paint.image.width, paint.image.height], 24);
  return out;
}

function scissorRect(e: FrameEntry, height: number): [number, number, number, number] {
  const x0 = Math.max(0, Math.floor(e.bounds.minX) - 1);
  const x1 = Math.ceil(e.bounds.maxX) + 1;
  const y0 = Math.max(0, Math.floor(e.bounds.minY) - 1);
  const y1 = Math.ceil(e.bounds.maxY) + 1;
  return [x0, height - y1, x1 - x0, y1 - y0];
}

/**
 * Texture unit used for layer compositing; `endLayer` binds it before every
 * use, so render-target setup may clobber it. Setup must not bind on other
 * units: targets are created lazily mid-frame, while units 0-2 hold the
 * entry, paint and gradient-stop textures the cover pass reads.
 */
const LAYER_UNIT = 3;
/** Texture unit of the glyph atlas (R8 coverage). */
const GLYPH_UNIT = 4;
/** Units of the image atlas, an entry's effect texture, a blend backdrop and a mask. */
const IMAGE_UNIT = 5;
const TEX_UNIT = 6;
const BACKDROP_UNIT = 7;
const MASK_UNIT = 8;
/** Floats per glyph instance: device rect, atlas origin, entry index. */
const GLYPH_FLOATS = 7;

/** Allocates RGBA8 storage for a new texture on the layer unit, keeping the active unit. */
function allocateTexture(gl: WebGL2RenderingContext, width: number, height: number): WebGLTexture {
  const texture = gl.createTexture()!;
  const active = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
  gl.activeTexture(gl.TEXTURE0 + LAYER_UNIT);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
  gl.activeTexture(active);
  return texture;
}

function createTarget(gl: WebGL2RenderingContext, width: number, height: number, samples: number): Target {
  const w = Math.max(1, width), h = Math.max(1, height);
  const color = gl.createRenderbuffer()!;
  gl.bindRenderbuffer(gl.RENDERBUFFER, color);
  gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, w, h);
  const depthStencil = gl.createRenderbuffer()!;
  gl.bindRenderbuffer(gl.RENDERBUFFER, depthStencil);
  gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH24_STENCIL8, w, h);
  const msaaFbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, msaaFbo);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, depthStencil);
  const resolveTexture = allocateTexture(gl, w, h);
  const resolveFbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, resolveFbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, resolveTexture, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { msaaFbo, color, depthStencil, resolveFbo, resolveTexture };
}

function createColorTarget(gl: WebGL2RenderingContext, width: number, height: number) {
  const texture = allocateTexture(gl, width, height);
  const fbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, texture, width, height };
}

function deleteTarget(gl: WebGL2RenderingContext, t: Target): void {
  gl.deleteFramebuffer(t.msaaFbo);
  gl.deleteFramebuffer(t.resolveFbo);
  gl.deleteRenderbuffer(t.color);
  gl.deleteRenderbuffer(t.depthStencil);
  gl.deleteTexture(t.resolveTexture);
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string, uniforms: string[]): Program {
  const compile = (type: GLenum, src: string): WebGLShader => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader compile failed: ${gl.getShaderInfoLog(s)}`);
    return s;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`program link failed: ${gl.getProgramInfoLog(program)}`);
  return { program, uniforms: Object.fromEntries(uniforms.map((u) => [u, gl.getUniformLocation(program, u)])) };
}
