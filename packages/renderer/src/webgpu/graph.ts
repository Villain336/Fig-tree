/// <reference types="@webgpu/types" />
import { blurSteps, type FramePlan, type GraphNode, type IRect } from "../frame";
import { backdropShader, blurShader, downsampleShader, meshLutShader, morphShader, shadowShader, storeShader, upsampleShader } from "./effects";

/** Where an output texture lives in the effect atlas. */
export interface AtlasSpot {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface PoolTexture {
  readonly texture: GPUTexture;
  readonly format: GPUTextureFormat;
  readonly width: number;
  readonly height: number;
  lastUsed: number;
  busy: boolean;
}

/** What one frame's graph execution needs: nodes to run and atlas spots of outputs. */
export interface GraphFrame {
  /** Nodes to execute this frame, in graph order. */
  readonly run: readonly GraphNode[];
  /** Atlas spot of every output (node drawn by an entry), executed or cached. */
  readonly spots: ReadonlyMap<GraphNode, AtlasSpot>;
  /** Outputs that could not be placed (drawn transparent). */
  readonly dropped: number;
}

const POOL_GRAIN = 64;
/** Bytes of pooled effect textures kept between frames. */
const POOL_BUDGET = 192 << 20;
const ATLAS_START = 2048;
/** The effect atlas grows to this side at most (64 MB of RGBA8). */
export const EFFECT_ATLAS_MAX = 4096;
const UNIFORM_SLOT = 256;
const MAX_MORPH_TAPS = 33;

/**
 * Executes render graphs on WebGPU: pooled intermediate textures, compute
 * passes for blurs, morphology, shadows, backdrops and mesh lookup
 * textures, and an effect atlas (RGBA8) that frames draw outputs from.
 * Outputs stay in the atlas between frames under their node's key, so
 * frames whose effects did not change composite them without recomputing.
 */
export class GraphExecutor {
  private readonly pipelines: Record<"downsample" | "blur" | "upsample" | "morph" | "shadow" | "backdrop" | "store" | "mesh", GPUComputePipeline>;
  private pool: PoolTexture[] = [];
  private frame = 0;
  private atlas: GPUTexture;
  private atlasSize = ATLAS_START;
  private shelves: { y: number; height: number; x: number }[] = [];
  private cache = new Map<string, { spot: AtlasSpot; frame: number }>();
  private uniforms: GPUBuffer;
  private uniformSlots = 64;
  private slot = 0;
  /** Textures of nodes executed this frame. */
  private live = new Map<GraphNode, { texture: GPUTexture; width: number; height: number }>();
  private warned = false;
  private readonly dummy: GPUTexture;

  constructor(private readonly device: GPUDevice) {
    const compute = (code: string, label: string): GPUComputePipeline =>
      device.createComputePipeline({ label, layout: "auto", compute: { module: device.createShaderModule({ label, code }), entryPoint: "main" } });
    this.pipelines = {
      downsample: compute(downsampleShader, "fx downsample"),
      blur: compute(blurShader, "fx blur"),
      upsample: compute(upsampleShader, "fx upsample"),
      morph: compute(morphShader, "fx morph"),
      shadow: compute(shadowShader, "fx shadow"),
      backdrop: compute(backdropShader, "fx backdrop"),
      store: compute(storeShader, "fx store"),
      mesh: compute(meshLutShader, "fx mesh"),
    };
    this.atlas = this.createAtlas(this.atlasSize);
    this.uniforms = device.createBuffer({ label: "fx uniforms", size: this.uniformSlots * UNIFORM_SLOT, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.dummy = device.createTexture({ label: "fx dummy", size: { width: 1, height: 1 }, format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING });
  }

  /** The atlas texture composites sample (a 1×1 dummy is never needed: the atlas always exists). */
  get atlasTexture(): GPUTexture {
    return this.atlas;
  }

  get dummyTexture(): GPUTexture {
    return this.dummy;
  }

  /** GPU bytes held: the atlas plus pooled textures. */
  get bytes(): number {
    let b = this.atlasSize * this.atlasSize * 4;
    for (const t of this.pool) b += t.width * t.height * (t.format === "rgba16float" ? 8 : 4);
    return b;
  }

  /** Drops every cached output (a frame overflowed and has to be rendered again). */
  invalidate(): void {
    this.cache.clear();
    this.shelves = [];
  }

  /**
   * Decides which nodes run: every output drawn by `plans` (or by the plans
   * of raster nodes that run) that is not cached, and what it reads.
   */
  prepare(plans: readonly FramePlan[], graph: readonly GraphNode[]): GraphFrame {
    this.frame++;
    this.slot = 0;
    const outputs = new Set<GraphNode>();
    const collect = (plan: FramePlan): void => {
      for (const e of plan.entries) {
        if (e.texture) outputs.add(e.texture.node);
        if (e.sampled) outputs.add(e.sampled.node);
      }
    };
    for (const p of plans) collect(p);
    // Outputs inside raster plans become known as those plans are required; place lazily.
    const spots = new Map<GraphNode, AtlasSpot>();
    const run = new Set<GraphNode>();
    let dropped = 0;
    const place = (node: GraphNode): boolean => {
      const cached = this.cache.get(node.key);
      if (cached) {
        cached.frame = this.frame;
        spots.set(node, cached.spot);
        return true;
      }
      const spot = this.allocate(node.rect.width, node.rect.height);
      if (!spot) return false;
      spots.set(node, spot);
      return false;
    };
    const require = (node: GraphNode, asOutput: boolean): void => {
      if (run.has(node)) return;
      if (asOutput && spots.has(node)) return;
      if (asOutput) {
        if (place(node)) return; // cached in the atlas
        if (!spots.has(node)) {
          dropped++;
          return;
        }
      }
      for (const input of inputsOf(node)) require(input, false);
      if (node.op === "raster") {
        for (const e of node.plan.entries) {
          if (e.texture) require(e.texture.node, true);
          if (e.sampled) require(e.sampled.node, true);
        }
      }
      run.add(node);
    };
    // First pass: try to place everything; if the atlas is full, start it over once, larger if possible.
    for (let attempt = 0; attempt < 3; attempt++) {
      spots.clear();
      run.clear();
      dropped = 0;
      for (const node of outputs) require(node, true);
      if (dropped === 0) break;
      this.cache.clear();
      this.shelves = [];
      if (attempt === 1 && this.atlasSize < EFFECT_ATLAS_MAX) this.grow();
    }
    if (dropped > 0 && !this.warned) {
      this.warned = true;
      console.warn(`fig-tree renderer: ${dropped} effect textures did not fit the ${this.atlasSize}px effect atlas and were skipped`);
    }
    // Run in graph order: inputs always come first.
    const order = graph.filter((n) => run.has(n));
    for (const node of order) {
      const spot = spots.get(node);
      if (spot) this.cache.set(node.key, { spot, frame: this.frame });
    }
    this.ensureUniforms(order.length * 24 + 8);
    return { run: order, spots, dropped };
  }

  /** Keeps a raster node's result: copies the region of the target it was drawn into. */
  captureRaster(enc: GPUCommandEncoder, node: GraphNode, target: GPUTexture): void {
    const { width, height } = node.rect;
    const tex = this.acquire("rgba8unorm", width, height);
    enc.copyTextureToTexture({ texture: target }, { texture: tex }, { width, height });
    this.live.set(node, { texture: tex, width, height });
  }

  /** Encodes one non-raster node. */
  encode(enc: GPUCommandEncoder, node: GraphNode, stops: GPUBuffer): void {
    switch (node.op) {
      case "blur":
        this.encodeBlur(enc, node.input, node, node.sigma, node.edge === "mirror");
        return;
      case "morph": {
        const input = this.texture(node.input);
        const out = this.acquire("rgba16float", node.rect.width, node.rect.height);
        const r = Math.abs(node.radius);
        const stride = Math.max(1, Math.ceil((2 * Math.ceil(r + 0.5) + 1) / MAX_MORPH_TAPS));
        this.dispatch(enc, "morph", [i32(node.rect.width), i32(node.rect.height), f32(node.radius), i32(stride)], input.texture, out, node.rect.width, node.rect.height);
        this.live.set(node, { texture: out, width: node.rect.width, height: node.rect.height });
        return;
      }
      case "shadow": {
        const b = this.texture(node.blurred);
        const s = node.shape ? this.texture(node.shape) : null;
        const out = this.acquire("rgba16float", node.rect.width, node.rect.height);
        const r = node.rect;
        const words = [
          i32(r.x), i32(r.y), i32(r.width), i32(r.height),
          i32(node.blurred.rect.x), i32(node.blurred.rect.y), i32(node.blurred.rect.width), i32(node.blurred.rect.height),
          i32(node.shape?.rect.x ?? 0), i32(node.shape?.rect.y ?? 0), i32(node.shape?.rect.width ?? 0), i32(node.shape?.rect.height ?? 0),
          f32(node.offsetX), f32(node.offsetY), node.inner ? 1 : 0, node.shape ? 1 : 0,
          ...node.color.map(f32),
        ];
        this.dispatch(enc, "shadow", words, b.texture, out, r.width, r.height, s?.texture ?? this.dummy);
        this.live.set(node, { texture: out, width: r.width, height: r.height });
        return;
      }
      case "backdrop": {
        const b = this.texture(node.blurred);
        const s = this.texture(node.shape);
        const out = this.acquire("rgba16float", node.rect.width, node.rect.height);
        const r = node.rect;
        const words = [
          i32(r.x), i32(r.y), i32(r.width), i32(r.height),
          i32(node.blurred.rect.x), i32(node.blurred.rect.y), i32(node.blurred.rect.width), i32(node.blurred.rect.height),
          i32(node.shape.rect.x), i32(node.shape.rect.y), i32(node.shape.rect.width), i32(node.shape.rect.height),
        ];
        this.dispatch(enc, "backdrop", words, b.texture, out, r.width, r.height, s.texture);
        this.live.set(node, { texture: out, width: r.width, height: r.height });
        return;
      }
      case "mesh": {
        const out = this.acquire("rgba16float", node.rect.width, node.rect.height);
        const words = [i32(node.rect.width), i32(node.rect.height), 0, 0, f32(node.time), Math.round(node.paint.paint.params[1] ?? 0), 0, 0];
        this.dispatchMesh(enc, words, node, stops, out);
        this.live.set(node, { texture: out, width: node.rect.width, height: node.rect.height });
        return;
      }
      case "raster":
        throw new Error("raster nodes are captured, not encoded");
    }
  }

  /** Copies an executed output into its atlas spot. */
  store(enc: GPUCommandEncoder, node: GraphNode, spot: AtlasSpot): void {
    const t = this.live.get(node);
    if (!t) return;
    this.dispatch(enc, "store", [i32(spot.width), i32(spot.height), i32(spot.x), i32(spot.y)], t.texture, this.atlas, spot.width, spot.height);
  }

  /** Returns this frame's textures to the pool and trims it to its budget. */
  endFrame(): void {
    for (const b of this.retired) b.destroy();
    this.retired = [];
    for (const t of this.pool) t.busy = false;
    this.live.clear();
    let bytes = this.pool.reduce((n, t) => n + t.width * t.height * (t.format === "rgba16float" ? 8 : 4), 0);
    if (bytes <= POOL_BUDGET) return;
    this.pool.sort((a, b) => a.lastUsed - b.lastUsed);
    while (bytes > POOL_BUDGET && this.pool.length > 0) {
      const t = this.pool.shift()!;
      bytes -= t.width * t.height * (t.format === "rgba16float" ? 8 : 4);
      t.texture.destroy();
    }
  }

  destroy(): void {
    for (const t of this.pool) t.texture.destroy();
    this.pool = [];
    this.atlas.destroy();
    this.dummy.destroy();
    this.uniforms.destroy();
  }

  private texture(node: GraphNode): { texture: GPUTexture; width: number; height: number } {
    const t = this.live.get(node);
    if (!t) throw new Error(`render graph: input ${node.op} ${node.id} was not executed`);
    return t;
  }

  /**
   * Blur by `blurSteps`: halve `levels` times, Gaussian at the lowest level
   * (horizontal, then vertical), then double back up to the input's size.
   */
  private encodeBlur(enc: GPUCommandEncoder, inputNode: GraphNode, node: GraphNode, sigma: number, mirror: boolean): void {
    const input = this.texture(inputNode);
    const { levels, sigmaLow } = blurSteps(sigma);
    const sizes: [number, number][] = [[input.width, input.height]];
    let cur: GPUTexture = input.texture;
    const chain: GPUTexture[] = [input.texture];
    for (let l = 1; l <= levels; l++) {
      const [pw, ph] = sizes[l - 1]!;
      const w = Math.max(1, Math.ceil(pw / 2));
      const h = Math.max(1, Math.ceil(ph / 2));
      const out = this.acquire("rgba16float", w, h);
      this.dispatch(enc, "downsample", [i32(pw), i32(ph), i32(w), i32(h), mirror ? 1 : 0, 0, 0, 0], cur, out, w, h);
      sizes.push([w, h]);
      chain.push(out);
      cur = out;
    }
    const [lw, lh] = sizes[levels]!;
    const radius = Math.max(1, Math.ceil(3 * sigmaLow));
    const tmp = this.acquire("rgba16float", lw, lh);
    this.dispatch(enc, "blur", [i32(lw), i32(lh), i32(1), i32(0), f32(Math.max(sigmaLow, 1e-3)), i32(radius), mirror ? 1 : 0, 0], cur, tmp, lw, lh);
    const blurred = this.acquire("rgba16float", lw, lh);
    this.dispatch(enc, "blur", [i32(lw), i32(lh), i32(0), i32(1), f32(Math.max(sigmaLow, 1e-3)), i32(radius), mirror ? 1 : 0, 0], tmp, blurred, lw, lh);
    cur = blurred;
    for (let l = levels; l >= 1; l--) {
      const [iw, ih] = sizes[l]!;
      const [ow, oh] = sizes[l - 1]!;
      const out = this.acquire("rgba16float", ow, oh);
      this.dispatch(enc, "upsample", [i32(iw), i32(ih), i32(ow), i32(oh), mirror ? 1 : 0, 0, 0, 0], cur, out, ow, oh);
      cur = out;
    }
    this.live.set(node, { texture: cur, width: input.width, height: input.height });
  }

  private dispatch(enc: GPUCommandEncoder, name: keyof GraphExecutor["pipelines"], words: number[], src: GPUTexture, dst: GPUTexture, w: number, h: number, extra?: GPUTexture): void {
    const offset = this.writeUniforms(words);
    const pipeline = this.pipelines[name];
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: this.uniforms, offset, size: Math.max(16, align(words.length * 4, 16)) } },
      { binding: 1, resource: src.createView() },
      { binding: 2, resource: dst.createView() },
    ];
    if (extra) entries.push({ binding: 3, resource: extra.createView() });
    const pass = enc.beginComputePass({ label: `fx ${name}` });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }));
    pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    pass.end();
  }

  private dispatchMesh(enc: GPUCommandEncoder, words: number[], node: GraphNode & { op: "mesh" }, stops: GPUBuffer, dst: GPUTexture): void {
    // The paint's parameters start at its stop slot, two vec4s per stop.
    const base = this.stopBase(node);
    words[2] = base;
    const offset = this.writeUniforms(words);
    const pipeline = this.pipelines.mesh;
    const pass = enc.beginComputePass({ label: "fx mesh" });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniforms, offset, size: 32 } },
        { binding: 1, resource: { buffer: stops } },
        { binding: 2, resource: dst.createView() },
      ],
    }));
    pass.dispatchWorkgroups(Math.ceil(node.rect.width / 8), Math.ceil(node.rect.height / 8));
    pass.end();
  }

  /** Set by the backend before encoding: where each paint's parameters start (vec4 index). */
  stopBase: (node: GraphNode & { op: "mesh" }) => number = () => 0;

  private writeUniforms(words: number[]): number {
    if (this.slot >= this.uniformSlots) this.ensureUniforms(this.uniformSlots + 64);
    const offset = this.slot * UNIFORM_SLOT;
    this.slot++;
    const data = new ArrayBuffer(Math.max(16, align(words.length * 4, 16)));
    const u = new Uint32Array(data);
    words.forEach((w, i) => (u[i] = w));
    this.device.queue.writeBuffer(this.uniforms, offset, data);
    return offset;
  }

  /**
   * Grows the uniform buffer. Bind groups of this frame may still reference
   * the old one, so it is retired (destroyed at the end of the frame) and
   * new slots start at 0 in the new buffer.
   */
  private ensureUniforms(slots: number): void {
    if (this.slot + slots <= this.uniformSlots && slots <= this.uniformSlots) return;
    this.retired.push(this.uniforms);
    this.uniformSlots = Math.max(slots, this.uniformSlots * 2);
    this.uniforms = this.device.createBuffer({ label: "fx uniforms", size: this.uniformSlots * UNIFORM_SLOT, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.slot = 0;
  }

  private retired: GPUBuffer[] = [];

  private acquire(format: GPUTextureFormat, width: number, height: number): GPUTexture {
    const w = Math.ceil(width / POOL_GRAIN) * POOL_GRAIN;
    const h = Math.ceil(height / POOL_GRAIN) * POOL_GRAIN;
    let best: PoolTexture | null = null;
    for (const t of this.pool) {
      if (t.busy || t.format !== format || t.width < w || t.height < h) continue;
      if (!best || t.width * t.height < best.width * best.height) best = t;
    }
    if (!best || best.width * best.height > 4 * w * h) {
      const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC;
      best = { texture: this.device.createTexture({ label: `fx ${format} ${w}x${h}`, size: { width: w, height: h }, format, usage }), format, width: w, height: h, lastUsed: 0, busy: false };
      this.pool.push(best);
    }
    best.busy = true;
    best.lastUsed = this.frame;
    return best.texture;
  }

  private createAtlas(size: number): GPUTexture {
    return this.device.createTexture({
      label: "effect atlas",
      size: { width: size, height: size },
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });
  }

  private grow(): void {
    this.atlas.destroy();
    this.atlasSize = Math.min(EFFECT_ATLAS_MAX, this.atlasSize * 2);
    this.atlas = this.createAtlas(this.atlasSize);
    this.cache.clear();
    this.shelves = [];
  }

  /** Shelf packing with a texel of padding; evicts outputs unused for a few frames when full. */
  private allocate(w: number, h: number): AtlasSpot | null {
    if (w > this.atlasSize || h > this.atlasSize) return null;
    const pw = w + 1;
    const ph = h + 1;
    for (const s of this.shelves) {
      if (ph <= s.height && ph * 2 > s.height && s.x + pw <= this.atlasSize) {
        const spot = { x: s.x, y: s.y, width: w, height: h };
        s.x += pw;
        return spot;
      }
    }
    const top = this.shelves.reduce((m, s) => Math.max(m, s.y + s.height), 0);
    if (top + ph > this.atlasSize) return null;
    this.shelves.push({ y: top, height: ph, x: pw });
    return { x: 0, y: top, width: w, height: h };
  }
}

/** The nodes a node reads (raster nodes read the outputs their plan draws; those are handled separately). */
export function inputsOf(node: GraphNode): GraphNode[] {
  switch (node.op) {
    case "blur":
    case "morph":
      return [node.input];
    case "shadow":
      return node.shape ? [node.blurred, node.shape] : [node.blurred];
    case "backdrop":
      return [node.blurred, node.shape];
    default:
      return [];
  }
}

export function rectArea(r: IRect): number {
  return r.width * r.height;
}

const scratch = new DataView(new ArrayBuffer(4));
function f32(v: number): number {
  scratch.setFloat32(0, v, true);
  return scratch.getUint32(0, true);
}
function i32(v: number): number {
  return v >>> 0;
}
function align(n: number, a: number): number {
  return Math.ceil(n / a) * a;
}
