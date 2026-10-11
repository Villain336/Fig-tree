/// <reference types="@webgpu/types" />
import { RangeAllocator, type Range } from "../arena";
import type { Backend, PixelData } from "../backend";
import { ItemKind } from "../compile";
import type { FrameEntry, FramePlan, PaintRecord } from "../frame";
import type { GeometryLevel, GeometrySlot } from "../geometry-cache";
import { premultiply } from "../paint";
import type { Color } from "../types";
import { binShader, compositeShader, coverageShader, indirectShader, tilesShader } from "./shaders";
import { GpuTimer, type Stage, type StageTimings } from "./timer";

const TILE = 16;
const ENTRY_WORDS = 20; // 80 bytes, matches `Entry` in WGSL
const PAINT_WORDS = 16; // 64 bytes, matches `Paint`
const PATH_TILE_BYTES = 16;
const PIECE_BYTES = 32;
const MASK_BYTES = 256;
const SLOT_ALIGN = 256; // uniform/storage dynamic-offset alignment
/** Upper bound for the per-pass z-order bitmaps; larger frames are split into passes. */
const BITMAP_BUDGET_BYTES = 64 << 20;
const MAX_LINEAR_WORKGROUPS = 65535;

const FLAG_EVENODD = 4;
const FLAG_CLIP = 8;

interface GeometryUpload {
  uploadId: number;
  range: Range;
}

interface PaintUpload {
  uploadId: number;
  slot: Range;
  stops: Range;
}

/** A GPU buffer that can grow; optionally preserving contents (for persistent arenas). */
class GrowableBuffer {
  buffer: GPUBuffer;

  constructor(
    private readonly device: GPUDevice,
    private readonly label: string,
    private readonly usage: GPUBufferUsageFlags,
    initialSize: number,
  ) {
    this.buffer = device.createBuffer({ label, size: align(initialSize, 256), usage });
  }

  get size(): number {
    return this.buffer.size;
  }

  /** Ensures capacity; returns true if the buffer object changed. */
  ensure(size: number, preserve: boolean): boolean {
    if (size <= this.buffer.size) return false;
    const next = this.device.createBuffer({
      label: this.label,
      size: align(Math.max(size, Math.ceil(this.buffer.size * 1.5)), 256),
      usage: this.usage,
    });
    if (preserve) {
      const enc = this.device.createCommandEncoder({ label: `${this.label} grow` });
      enc.copyBufferToBuffer(this.buffer, 0, next, 0, this.buffer.size);
      this.device.queue.submit([enc.finish()]);
    }
    this.buffer.destroy();
    this.buffer = next;
    return true;
  }
}

interface PassPlan {
  readonly start: number;
  readonly end: number;
  readonly entryByteOffset: number;
  readonly chunkCount: number;
  readonly segmentTotal: number;
  readonly rowTotal: number;
  readonly tileTotal: number;
}

/**
 * WebGPU compute rasterizer (see `shaders.ts` for the pipeline). Geometry and
 * paints live in persistent GPU arenas keyed by upload ids, so a frame whose
 * only change is the view uploads nothing but its compact entry list.
 */
export class WebGPUBackend implements Backend {
  readonly kind = "webgpu" as const;

  private readonly pipelines: {
    bin: GPUComputePipeline;
    tiles: GPUComputePipeline;
    indirect: GPUComputePipeline;
    coverage: GPUComputePipeline;
    composite: GPUComputePipeline;
  };
  private readonly segments: GrowableBuffer;
  private readonly segmentAlloc = new RangeAllocator(1 << 16);
  private readonly paints: GrowableBuffer;
  private readonly paintAlloc = new RangeAllocator(1024);
  private readonly stops: GrowableBuffer;
  private readonly stopAlloc = new RangeAllocator(1024);
  private readonly geometryCache = new Map<GeometrySlot, GeometryUpload>();
  private readonly paintCache = new Map<number, PaintUpload>();
  private cacheGeneration = -1;

  private readonly entries: GrowableBuffer;
  private readonly config: GrowableBuffer;
  private readonly counters: GrowableBuffer;
  private readonly indirect: GrowableBuffer;
  private readonly pathTiles: GrowableBuffer;
  private readonly pieces: GrowableBuffer;
  private readonly edgeTiles: GrowableBuffer;
  private readonly masks: GrowableBuffer;
  private readonly bitmaps: GrowableBuffer;
  private readonly readback: GPUBuffer;
  private readbackBusy = false;
  private readbackDone: Promise<void> = Promise.resolve();
  private pieceCapacity = 1 << 18;
  private maskCapacity = 1 << 14;
  private overflowed = false;
  private readonly timer: GpuTimer | null;

  private targets: GPUTexture[] = [];
  private finalTarget = 0;
  private width = 0;
  private height = 0;

  private constructor(
    private readonly device: GPUDevice,
    private readonly context: GPUCanvasContext,
  ) {
    this.timer = device.features.has("timestamp-query") ? new GpuTimer(device) : null;
    const compute = (code: string, label: string): GPUComputePipeline =>
      device.createComputePipeline({
        label,
        layout: "auto",
        compute: { module: device.createShaderModule({ label, code }), entryPoint: "main" },
      });
    this.pipelines = {
      bin: compute(binShader, "bin"),
      tiles: compute(tilesShader, "tiles"),
      indirect: compute(indirectShader, "indirect"),
      coverage: compute(coverageShader, "coverage"),
      composite: compute(compositeShader, "composite"),
    };
    const S = GPUBufferUsage.STORAGE;
    const D = GPUBufferUsage.COPY_DST;
    const C = GPUBufferUsage.COPY_SRC;
    this.segments = new GrowableBuffer(device, "segments", S | D | C, this.segmentAlloc.capacity * 16);
    this.paints = new GrowableBuffer(device, "paints", S | D | C, this.paintAlloc.capacity * PAINT_WORDS * 4);
    this.stops = new GrowableBuffer(device, "stops", S | D | C, this.stopAlloc.capacity * 32);
    this.entries = new GrowableBuffer(device, "entries", S | D, 1 << 16);
    this.config = new GrowableBuffer(device, "config", GPUBufferUsage.UNIFORM | D, SLOT_ALIGN);
    this.counters = new GrowableBuffer(device, "counters", S | D | C, SLOT_ALIGN);
    this.indirect = new GrowableBuffer(device, "indirect", S | GPUBufferUsage.INDIRECT, SLOT_ALIGN);
    this.pathTiles = new GrowableBuffer(device, "path tiles", S | D, 1 << 16);
    this.pieces = new GrowableBuffer(device, "pieces", S, this.pieceCapacity * PIECE_BYTES);
    this.edgeTiles = new GrowableBuffer(device, "edge tiles", S, this.maskCapacity * 8);
    this.masks = new GrowableBuffer(device, "masks", S, this.maskCapacity * MASK_BYTES);
    this.bitmaps = new GrowableBuffer(device, "bitmaps", S | D, 1 << 16);
    this.readback = device.createBuffer({ label: "counters readback", size: SLOT_ALIGN * 64, usage: GPUBufferUsage.MAP_READ | D });
  }

  /** Returns null when WebGPU is unavailable, so callers can fall back. */
  static async create(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<WebGPUBackend | null> {
    if (typeof navigator === "undefined" || !("gpu" in navigator) || !navigator.gpu) return null;
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) return null;
    const device = await adapter.requestDevice({
      requiredFeatures: adapter.features.has("timestamp-query") ? ["timestamp-query"] : [],
      requiredLimits: {
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        maxBufferSize: adapter.limits.maxBufferSize,
      },
    });
    const context = canvas.getContext("webgpu");
    if (!context) {
      device.destroy();
      return null;
    }
    context.configure({
      device,
      format: "rgba8unorm",
      alphaMode: "premultiplied",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
    });
    device.addEventListener("uncapturederror", (event) => {
      console.error(`fig-tree renderer: WebGPU error: ${(event as GPUUncapturedErrorEvent).error.message}`);
    });
    device.lost.then((info) => {
      if (info.reason !== "destroyed") console.error(`fig-tree renderer: WebGPU device lost: ${info.message}`);
    });
    return new WebGPUBackend(device, context);
  }

  render(plan: FramePlan, background: Color): number {
    const device = this.device;
    this.ensureTargets(plan.width, plan.height);
    if (plan.list.generation !== this.cacheGeneration) {
      this.sweep(plan);
      this.cacheGeneration = plan.list.generation;
    }
    let uploaded = 0;
    for (const e of plan.entries) {
      if (e.geometry && e.item.geometry) uploaded += this.uploadGeometry(e.item.geometry, e.geometry);
      if (e.paint) uploaded += this.uploadPaint(e.paint);
    }

    const tilesX = Math.ceil(plan.width / TILE);
    const tilesY = Math.ceil(plan.height / TILE);
    const { data, passes } = this.encodeEntries(plan.entries, this.planPasses(plan.entries, tilesX * tilesY), tilesX, tilesY);
    this.entries.ensure(data.byteLength, false);
    device.queue.writeBuffer(this.entries.buffer, 0, data);

    const maxTiles = Math.max(1, ...passes.map((p) => p.tileTotal));
    const maxBitmap = Math.max(1, ...passes.map((p) => tilesX * tilesY * p.chunkCount * 32));
    this.pathTiles.ensure(maxTiles * PATH_TILE_BYTES, false);
    this.bitmaps.ensure(maxBitmap, false);
    this.pieces.ensure(this.pieceCapacity * PIECE_BYTES, false);
    this.edgeTiles.ensure(this.maskCapacity * 8, false);
    this.masks.ensure(this.maskCapacity * MASK_BYTES, false);
    this.config.ensure(passes.length * SLOT_ALIGN, false);
    this.counters.ensure(passes.length * SLOT_ALIGN, false);
    this.indirect.ensure(passes.length * SLOT_ALIGN, false);

    const bg = premultiply(background);
    const enc = device.createCommandEncoder({ label: "frame" });
    this.timer?.beginFrame();
    passes.forEach((pass, i) => {
      const config = new ArrayBuffer(64);
      const u = new Uint32Array(config);
      const f = new Float32Array(config);
      u.set([plan.width, plan.height, tilesX, tilesY, pass.end - pass.start, pass.chunkCount, pass.segmentTotal, pass.rowTotal,
        this.pieceCapacity, this.maskCapacity, i === 0 ? 1 : 0, 0]);
      f.set(bg, 12);
      device.queue.writeBuffer(this.config.buffer, i * SLOT_ALIGN, config);
      this.encodePass(enc, pass, i, tilesX, tilesY);
    });
    this.finalTarget = (passes.length - 1) % 2;
    enc.copyTextureToTexture(
      { texture: this.targets[this.finalTarget]! },
      { texture: this.context.getCurrentTexture() },
      { width: plan.width, height: plan.height },
    );
    const readCounters = !this.readbackBusy && passes.length <= 64;
    if (readCounters) enc.copyBufferToBuffer(this.counters.buffer, 0, this.readback, 0, passes.length * SLOT_ALIGN);
    this.timer?.endFrame(enc);
    device.queue.submit([enc.finish()]);
    if (readCounters) this.checkCapacity(passes.length);
    this.timer?.collect();
    return uploaded;
  }

  get gpuTimings(): StageTimings | null {
    return this.timer?.last ?? null;
  }

  async settle(): Promise<boolean> {
    await this.device.queue.onSubmittedWorkDone();
    await this.readbackDone;
    const overflowed = this.overflowed;
    this.overflowed = false;
    return overflowed;
  }

  async readPixels(): Promise<PixelData> {
    const { width, height } = this;
    const bytesPerRow = align(width * 4, 256);
    const buffer = this.device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: this.targets[this.finalTarget]! }, { buffer, bytesPerRow }, { width, height });
    this.device.queue.submit([enc.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(buffer.getMappedRange());
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) data.set(src.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
    buffer.unmap();
    buffer.destroy();
    return { width, height, data };
  }

  destroy(): void {
    for (const t of this.targets) t.destroy();
    this.device.destroy();
  }

  private ensureTargets(width: number, height: number): void {
    if (width === this.width && height === this.height && this.targets.length === 2) return;
    for (const t of this.targets) t.destroy();
    this.width = width;
    this.height = height;
    this.targets = [0, 1].map((i) =>
      this.device.createTexture({
        label: `target ${i}`,
        size: { width: Math.max(1, width), height: Math.max(1, height) },
        format: "rgba8unorm",
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
      }),
    );
  }

  /** Frees GPU data of nodes no longer in the scene. */
  private sweep(plan: FramePlan): void {
    for (const [slot, up] of this.geometryCache) {
      if (plan.list.liveSlots.has(slot)) continue;
      this.segmentAlloc.release(up.range);
      this.geometryCache.delete(slot);
    }
    for (const [key, up] of this.paintCache) {
      if (plan.list.liveNodeIds.has(Math.floor(key / 2))) continue;
      this.paintAlloc.release(up.slot);
      this.stopAlloc.release(up.stops);
      this.paintCache.delete(key);
    }
  }

  private uploadGeometry(slot: GeometrySlot, level: GeometryLevel): number {
    const cached = this.geometryCache.get(slot);
    if (cached && cached.uploadId === level.uploadId) return 0;
    if (cached) this.segmentAlloc.release(cached.range);
    const range = allocateGrowing(this.segmentAlloc, level.segmentCount, (cap) => this.segments.ensure(cap * 16, true));
    if (level.segmentCount > 0) this.device.queue.writeBuffer(this.segments.buffer, range.offset * 16, level.segments);
    this.geometryCache.set(slot, { uploadId: level.uploadId, range });
    return level.segments.byteLength;
  }

  private uploadPaint(record: PaintRecord): number {
    const cached = this.paintCache.get(record.key);
    if (cached && cached.uploadId === record.uploadId) return 0;
    const paint = record.paint;
    const stopCount = paint.stops.length / 5;
    let slot = cached?.slot;
    if (!slot) slot = allocateGrowing(this.paintAlloc, 1, (cap) => this.paints.ensure(cap * PAINT_WORDS * 4, true));
    if (cached) this.stopAlloc.release(cached.stops);
    const stops = allocateGrowing(this.stopAlloc, stopCount, (cap) => this.stops.ensure(cap * 32, true));
    const data = new ArrayBuffer(PAINT_WORDS * 4);
    const u = new Uint32Array(data);
    const f = new Float32Array(data);
    u[0] = paint.kind;
    u[1] = stops.offset;
    u[2] = stopCount;
    f.set(paint.color, 4);
    const m = paint.matrix;
    f.set([m[0], m[1], m[2], m[3], m[4], m[5]], 8);
    this.device.queue.writeBuffer(this.paints.buffer, slot.offset * PAINT_WORDS * 4, data);
    if (stopCount > 0) {
      const sd = new Float32Array(stopCount * 8);
      for (let i = 0; i < stopCount; i++) {
        sd[i * 8] = paint.stops[i * 5]!;
        sd.set(paint.stops.subarray(i * 5 + 1, i * 5 + 5), i * 8 + 4);
      }
      this.device.queue.writeBuffer(this.stops.buffer, stops.offset * 32, sd);
    }
    this.paintCache.set(record.key, { uploadId: record.uploadId, slot, stops });
    return data.byteLength + stopCount * 32;
  }

  /**
   * Splits the frame so each pass's z-order bitmaps fit the budget. Splits
   * only happen between top-level steps, where no layer is open.
   */
  private planPasses(entries: readonly FrameEntry[], screenTiles: number): { start: number; end: number }[] {
    const maxChunks = Math.max(1, Math.floor(BITMAP_BUDGET_BYTES / (screenTiles * 32)));
    const maxEntries = maxChunks * 256;
    const passes: { start: number; end: number }[] = [];
    let start = 0;
    let depth = 0;
    let lastSafe = 0;
    for (let i = 0; i < entries.length; i++) {
      const kind = entries[i]!.kind;
      if (kind === ItemKind.BeginLayer) depth++;
      else if (kind === ItemKind.EndLayer) depth--;
      if (depth === 0) lastSafe = i + 1;
      if (i + 1 - start >= maxEntries && lastSafe > start) {
        passes.push({ start, end: lastSafe });
        start = lastSafe;
      }
    }
    if (start < entries.length || passes.length === 0) passes.push({ start, end: entries.length });
    return passes;
  }

  private encodeEntries(
    entries: readonly FrameEntry[],
    ranges: { start: number; end: number }[],
    tilesX: number,
    tilesY: number,
  ): { data: ArrayBuffer; passes: PassPlan[] } {
    let bytes = 0;
    const offsets = ranges.map((r) => {
      const o = bytes;
      bytes += align(Math.max(1, r.end - r.start) * ENTRY_WORDS * 4, SLOT_ALIGN);
      return o;
    });
    const data = new ArrayBuffer(bytes);
    const u = new Uint32Array(data);
    const f = new Float32Array(data);
    const passes = ranges.map((r, p): PassPlan => {
      let tileTotal = 0;
      let segmentTotal = 0;
      let rowTotal = 0;
      for (let i = r.start; i < r.end; i++) {
        const e = entries[i]!;
        const k = (offsets[p]! / 4) + (i - r.start) * ENTRY_WORDS;
        const tx0 = clampInt(Math.floor(e.bounds.minX / TILE), 0, tilesX);
        const ty0 = clampInt(Math.floor(e.bounds.minY / TILE), 0, tilesY);
        const tx1 = clampInt(Math.ceil(e.bounds.maxX / TILE), tx0 + 1, tilesX);
        const ty1 = clampInt(Math.ceil(e.bounds.maxY / TILE), ty0 + 1, tilesY);
        const m = e.matrix;
        f.set([m[0], m[1], m[2], m[3], m[4], m[5]], k);
        let flags: number = e.kind;
        if (e.item.fillRule === "evenodd") flags |= FLAG_EVENODD;
        if (e.kind === ItemKind.BeginLayer && e.geometry) flags |= FLAG_CLIP;
        u[k + 6] = flags;
        u[k + 7] = e.paint ? this.paintCache.get(e.paint.key)!.slot.offset : 0;
        u.set([tx0, ty0, tx1, ty1, tileTotal, segmentTotal, rowTotal], k + 8);
        f[k + 15] = e.item.alpha;
        const geometry = e.geometry && e.kind !== ItemKind.EndLayer && e.item.geometry ? this.geometryCache.get(e.item.geometry) : undefined;
        const segCount = geometry && e.geometry ? e.geometry.segmentCount : 0;
        u[k + 16] = geometry ? geometry.range.offset : 0;
        u[k + 17] = segCount;
        tileTotal += (tx1 - tx0) * (ty1 - ty0);
        segmentTotal += segCount;
        rowTotal += ty1 - ty0;
      }
      return {
        start: r.start,
        end: r.end,
        entryByteOffset: offsets[p]!,
        chunkCount: Math.ceil((r.end - r.start) / 256),
        segmentTotal,
        rowTotal,
        tileTotal,
      };
    });
    return { data, passes };
  }

  private encodePass(enc: GPUCommandEncoder, pass: PassPlan, index: number, tilesX: number, tilesY: number): void {
    const device = this.device;
    const slot = index * SLOT_ALIGN;
    const entryCount = pass.end - pass.start;
    const entriesBinding = { buffer: this.entries.buffer, offset: pass.entryByteOffset, size: Math.max(1, entryCount) * ENTRY_WORDS * 4 };
    const config = { buffer: this.config.buffer, offset: slot, size: 64 };
    const counters = { buffer: this.counters.buffer, offset: slot, size: 16 };
    const indirect = { buffer: this.indirect.buffer, offset: slot, size: 12 };
    const tiles = { buffer: this.pathTiles.buffer, size: Math.max(1, pass.tileTotal) * PATH_TILE_BYTES };
    const bitmapBytes = Math.max(4, tilesX * tilesY * pass.chunkCount * 32);
    const bitmaps = { buffer: this.bitmaps.buffer, size: bitmapBytes };
    const group = (pipeline: GPUComputePipeline, resources: GPUBindingResource[]): GPUBindGroup =>
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: resources.map((resource, binding) => ({ binding, resource })),
      });
    const stage = (name: Stage, run: (cp: GPUComputePassEncoder) => void): void => {
      const cp = enc.beginComputePass(this.timer?.pass(`${name} ${index}`, name) ?? { label: `${name} ${index}` });
      run(cp);
      cp.end();
    };
    enc.clearBuffer(this.counters.buffer, slot, SLOT_ALIGN);
    if (entryCount > 0) {
      enc.clearBuffer(this.pathTiles.buffer, 0, align(tiles.size, 4));
      enc.clearBuffer(this.bitmaps.buffer, 0, align(bitmapBytes, 4));
      if (pass.segmentTotal > 0) {
        stage("bin", (cp) => {
          cp.setPipeline(this.pipelines.bin);
          cp.setBindGroup(0, group(this.pipelines.bin, [config, entriesBinding, { buffer: this.segments.buffer }, tiles, { buffer: this.pieces.buffer }, counters]));
          dispatchLinear(cp, Math.ceil(pass.segmentTotal / 256));
        });
      }
      stage("tiles", (cp) => {
        cp.setPipeline(this.pipelines.tiles);
        cp.setBindGroup(0, group(this.pipelines.tiles, [config, entriesBinding, tiles, { buffer: this.edgeTiles.buffer }, bitmaps, counters]));
        dispatchLinear(cp, Math.ceil(pass.rowTotal / 256));
        cp.setPipeline(this.pipelines.indirect);
        cp.setBindGroup(0, group(this.pipelines.indirect, [config, counters, indirect]));
        cp.dispatchWorkgroups(1);
      });
      stage("coverage", (cp) => {
        cp.setPipeline(this.pipelines.coverage);
        cp.setBindGroup(0, group(this.pipelines.coverage, [config, tiles, { buffer: this.pieces.buffer }, { buffer: this.edgeTiles.buffer }, counters, { buffer: this.masks.buffer }]));
        cp.dispatchWorkgroupsIndirect(this.indirect.buffer, slot);
      });
    }
    // Composite always runs: an empty frame still clears to the background.
    stage("composite", (cp) => {
      cp.setPipeline(this.pipelines.composite);
      cp.setBindGroup(0, group(this.pipelines.composite, [
        config, entriesBinding, tiles, { buffer: this.masks.buffer }, bitmaps, { buffer: this.paints.buffer },
        { buffer: this.stops.buffer }, this.targets[(index + 1) % 2]!.createView(), this.targets[index % 2]!.createView(),
      ]));
      cp.dispatchWorkgroups(tilesX, tilesY);
    });
  }

  /** Reads the GPU counters back and grows capacities for the next frame if they overflowed. */
  private checkCapacity(passCount: number): void {
    this.readbackBusy = true;
    this.readbackDone = this.readback.mapAsync(GPUMapMode.READ, 0, passCount * SLOT_ALIGN).then(
      () => {
        const words = new Uint32Array(this.readback.getMappedRange(0, passCount * SLOT_ALIGN));
        let pieces = 0;
        let masks = 0;
        for (let p = 0; p < passCount; p++) {
          pieces = Math.max(pieces, words[p * (SLOT_ALIGN / 4)]!);
          masks = Math.max(masks, words[p * (SLOT_ALIGN / 4) + 1]!);
        }
        this.readback.unmap();
        this.readbackBusy = false;
        const limit = this.device.limits.maxStorageBufferBindingSize;
        if (pieces > this.pieceCapacity) {
          this.pieceCapacity = Math.min(Math.ceil(pieces * 1.25), Math.floor(limit / PIECE_BYTES));
          this.overflowed = true;
        }
        if (masks > this.maskCapacity) {
          this.maskCapacity = Math.min(Math.ceil(masks * 1.25), Math.floor(limit / MASK_BYTES));
          this.overflowed = true;
        }
      },
      () => {
        this.readbackBusy = false;
      },
    );
  }
}

function dispatchLinear(pass: GPUComputePassEncoder, workgroups: number): void {
  if (workgroups <= 0) return;
  const x = Math.min(workgroups, MAX_LINEAR_WORKGROUPS);
  pass.dispatchWorkgroups(x, Math.ceil(workgroups / x));
}

function allocateGrowing(alloc: RangeAllocator, size: number, grow: (capacity: number) => void): Range {
  let r = alloc.allocate(size);
  while (!r) {
    const capacity = Math.max(alloc.capacity * 2, alloc.used + size);
    grow(capacity);
    alloc.grow(capacity);
    r = alloc.allocate(size);
  }
  return r;
}

function align(n: number, a: number): number {
  return Math.ceil(n / a) * a;
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
