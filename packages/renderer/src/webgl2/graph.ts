import { blurSteps, type FramePlan, type GraphNode } from "../frame";
import { inputsOf } from "../webgpu/graph";
import {
  backdropFragment,
  blurFragment,
  copyFragment,
  downsampleFragment,
  fullscreenVertex,
  meshFragment,
  morphFragment,
  shadowFragment,
  upsampleFragment,
} from "./effects";

/** A texture holding a graph node's result, top-down rows in GL's bottom-up storage. */
export interface GLTexture {
  readonly texture: WebGLTexture;
  readonly fbo: WebGLFramebuffer;
  readonly width: number;
  readonly height: number;
  readonly format: number;
}

interface Pooled extends GLTexture {
  busy: boolean;
  lastUsed: number;
}

interface Program {
  readonly program: WebGLProgram;
  readonly uniforms: Map<string, WebGLUniformLocation | null>;
}

const POOL_GRAIN = 64;
const POOL_BUDGET = 192 << 20;
const OUTPUT_BUDGET = 128 << 20;
const MAX_MORPH_TAPS = 33;
/** Texture units the graph passes use (the backend's draw rebinds its own units afterwards). */
const SRC_UNIT = 9;
const SHAPE_UNIT = 10;
const STOPS_UNIT = 11;

/**
 * Executes render graphs on WebGL2 with fullscreen fragment passes, the
 * twin of the WebGPU executor: same steps, same math. Outputs (textures
 * entries draw) are kept as RGBA8 textures under their node's key, so
 * unchanged effects are not recomputed; intermediates come from a pool
 * (RGBA16F when the context can render to it).
 */
export class GLGraph {
  private readonly programs = new Map<string, Program>();
  private readonly vao: WebGLVertexArrayObject;
  private pool: Pooled[] = [];
  private outputs = new Map<string, Pooled & { frame: number }>();
  private live = new Map<GraphNode, GLTexture>();
  private frame = 0;
  private readonly floatFormat: number;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.floatFormat = gl.getExtension("EXT_color_buffer_float") ? gl.RGBA16F : gl.RGBA8;
    this.vao = gl.createVertexArray()!;
    const make = (name: string, fs: string): void => {
      this.programs.set(name, link(gl, fullscreenVertex, fs));
    };
    make("downsample", downsampleFragment);
    make("blur", blurFragment);
    make("upsample", upsampleFragment);
    make("morph", morphFragment);
    make("shadow", shadowFragment);
    make("backdrop", backdropFragment);
    make("copy", copyFragment);
    make("mesh", meshFragment);
  }

  /** GPU bytes held by pooled and output textures. */
  get bytes(): number {
    let b = 0;
    for (const t of this.pool) b += t.width * t.height * (t.format === this.gl.RGBA8 ? 4 : 8);
    for (const t of this.outputs.values()) b += t.width * t.height * 4;
    return b;
  }

  /** Forgets cached outputs. */
  invalidate(): void {
    for (const t of this.outputs.values()) this.deleteTexture(t);
    this.outputs.clear();
  }

  /**
   * Runs what the plans' entries need (outputs not cached, and what they
   * read). `raster` draws a plan and returns the framebuffer holding it
   * (its top-left `width` × `height` region). Returns the output texture of
   * every node an entry draws.
   */
  run(
    plans: readonly FramePlan[],
    graph: readonly GraphNode[],
    raster: (plan: FramePlan, background: readonly [number, number, number, number], textures: Map<GraphNode, GLTexture>) => WebGLFramebuffer,
    stops: () => WebGLTexture,
    stopBase: (node: GraphNode & { op: "mesh" }) => number,
  ): Map<GraphNode, GLTexture> {
    this.frame++;
    const result = new Map<GraphNode, GLTexture>();
    const run = new Set<GraphNode>();
    const isOutput = new Set<GraphNode>();
    const require = (node: GraphNode, asOutput: boolean): void => {
      if (run.has(node) || result.has(node)) return;
      if (asOutput) {
        isOutput.add(node);
        const cached = this.outputs.get(node.key);
        if (cached) {
          cached.frame = this.frame;
          result.set(node, cached);
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
    for (const plan of plans) {
      for (const e of plan.entries) {
        if (e.texture) require(e.texture.node, true);
        if (e.sampled) require(e.sampled.node, true);
      }
    }
    const gl = this.gl;
    for (const node of graph) {
      if (!run.has(node)) continue;
      if (node.op === "raster") {
        const fbo = raster(node.plan, node.background ?? [0, 0, 0, 0], result);
        const t = this.acquire(gl.RGBA8, node.rect.width, node.rect.height);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, t.fbo);
        gl.disable(gl.SCISSOR_TEST);
        gl.blitFramebuffer(0, 0, node.rect.width, node.rect.height, 0, 0, node.rect.width, node.rect.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        this.live.set(node, { ...t, width: node.rect.width, height: node.rect.height });
      } else {
        this.encode(node, stops, stopBase);
      }
      if (isOutput.has(node)) {
        const src = this.live.get(node)!;
        const out = this.createOutput(node.rect.width, node.rect.height);
        this.pass("copy", out, [], src);
        const entry = { ...out, busy: false, lastUsed: this.frame, frame: this.frame };
        this.outputs.set(node.key, entry);
        result.set(node, entry);
      }
    }
    this.endFrame();
    return result;
  }

  private endFrame(): void {
    for (const t of this.pool) t.busy = false;
    this.live.clear();
    // Outputs not drawn for a few frames, then the pool, are trimmed to their budgets.
    let outBytes = 0;
    for (const [key, t] of this.outputs) {
      if (t.frame < this.frame - 2) {
        this.deleteTexture(t);
        this.outputs.delete(key);
      } else outBytes += t.width * t.height * 4;
    }
    if (outBytes > OUTPUT_BUDGET) {
      for (const [key, t] of [...this.outputs].sort((a, b) => a[1].frame - b[1].frame)) {
        if (outBytes <= OUTPUT_BUDGET || t.frame === this.frame) break;
        outBytes -= t.width * t.height * 4;
        this.deleteTexture(t);
        this.outputs.delete(key);
      }
    }
    let bytes = this.pool.reduce((n, t) => n + t.width * t.height * (t.format === this.gl.RGBA8 ? 4 : 8), 0);
    if (bytes > POOL_BUDGET) {
      this.pool.sort((a, b) => a.lastUsed - b.lastUsed);
      while (bytes > POOL_BUDGET && this.pool.length > 0) {
        const t = this.pool.shift()!;
        bytes -= t.width * t.height * (t.format === this.gl.RGBA8 ? 4 : 8);
        this.deleteTexture(t);
      }
    }
  }

  private encode(node: GraphNode, stops: () => WebGLTexture, stopBase: (node: GraphNode & { op: "mesh" }) => number): void {
    const gl = this.gl;
    const f = this.floatFormat;
    const sized = (t: GLTexture, width: number, height: number): GLTexture => ({ ...t, width, height });
    switch (node.op) {
      case "blur": {
        const input = this.live.get(node.input)!;
        const mirror = node.edge === "mirror" ? 1 : 0;
        const { levels, sigmaLow } = blurSteps(node.sigma);
        const chain: GLTexture[] = [input];
        let cur: GLTexture = input;
        for (let l = 1; l <= levels; l++) {
          const w = Math.max(1, Math.ceil(cur.width / 2));
          const h = Math.max(1, Math.ceil(cur.height / 2));
          const out = sized(this.acquire(f, w, h), w, h);
          this.pass("downsample", out, [["u_mirror", "1i", mirror]], cur);
          chain.push(out);
          cur = out;
        }
        const radius = Math.max(1, Math.ceil(3 * sigmaLow));
        const sigma = Math.max(sigmaLow, 1e-3);
        const tmp = sized(this.acquire(f, cur.width, cur.height), cur.width, cur.height);
        this.pass("blur", tmp, [["u_dir", "2i", [1, 0]], ["u_sigma", "1f", sigma], ["u_radius", "1i", radius], ["u_mirror", "1i", mirror]], cur);
        const blurred = sized(this.acquire(f, cur.width, cur.height), cur.width, cur.height);
        this.pass("blur", blurred, [["u_dir", "2i", [0, 1]], ["u_sigma", "1f", sigma], ["u_radius", "1i", radius], ["u_mirror", "1i", mirror]], tmp);
        cur = blurred;
        for (let l = levels; l >= 1; l--) {
          const target = chain[l - 1]!;
          const out = sized(this.acquire(f, target.width, target.height), target.width, target.height);
          this.pass("upsample", out, [["u_mirror", "1i", mirror]], cur);
          cur = out;
        }
        this.live.set(node, cur);
        return;
      }
      case "morph": {
        const input = this.live.get(node.input)!;
        const out = sized(this.acquire(f, node.rect.width, node.rect.height), node.rect.width, node.rect.height);
        const stride = Math.max(1, Math.ceil((2 * Math.ceil(Math.abs(node.radius) + 0.5) + 1) / MAX_MORPH_TAPS));
        this.pass("morph", out, [["u_radius", "1f", node.radius], ["u_stride", "1i", stride]], input);
        this.live.set(node, out);
        return;
      }
      case "shadow": {
        const b = this.live.get(node.blurred)!;
        const s = node.shape ? this.live.get(node.shape)! : null;
        const out = sized(this.acquire(f, node.rect.width, node.rect.height), node.rect.width, node.rect.height);
        this.pass("shadow", out, [
          ["u_outOrigin", "2i", [node.rect.x, node.rect.y]],
          ["u_srcOrigin", "2i", [node.blurred.rect.x, node.blurred.rect.y]],
          ["u_shapeOrigin", "2i", [node.shape?.rect.x ?? 0, node.shape?.rect.y ?? 0]],
          ["u_shapeSize", "2i", [node.shape?.rect.width ?? 1, node.shape?.rect.height ?? 1]],
          ["u_offset", "2f", [node.offsetX, node.offsetY]],
          ["u_mode", "1i", node.inner ? 1 : 0],
          ["u_hasShape", "1i", node.shape ? 1 : 0],
          ["u_color", "4f", [...node.color]],
        ], b, s ?? b);
        this.live.set(node, out);
        return;
      }
      case "backdrop": {
        const b = this.live.get(node.blurred)!;
        const s = this.live.get(node.shape)!;
        const out = sized(this.acquire(f, node.rect.width, node.rect.height), node.rect.width, node.rect.height);
        this.pass("backdrop", out, [
          ["u_outOrigin", "2i", [node.rect.x, node.rect.y]],
          ["u_srcOrigin", "2i", [node.blurred.rect.x, node.blurred.rect.y]],
          ["u_shapeOrigin", "2i", [node.shape.rect.x, node.shape.rect.y]],
          ["u_shapeSize", "2i", [node.shape.rect.width, node.shape.rect.height]],
        ], b, s);
        this.live.set(node, out);
        return;
      }
      case "mesh": {
        const out = sized(this.acquire(f, node.rect.width, node.rect.height), node.rect.width, node.rect.height);
        gl.activeTexture(gl.TEXTURE0 + STOPS_UNIT);
        gl.bindTexture(gl.TEXTURE_2D, stops());
        this.pass("mesh", out, [
          ["u_stops", "1i", STOPS_UNIT],
          ["u_base", "1i", stopBase(node)],
          ["u_time", "1f", node.time],
          ["u_seed", "1ui", Math.round(node.paint.paint.params[1] ?? 0)],
        ], null);
        this.live.set(node, out);
        return;
      }
      case "raster":
        return;
    }
  }

  /** One fullscreen pass into `out` (its top-left width × height texels). */
  private pass(name: string, out: GLTexture, uniforms: [string, "1i" | "1f" | "1ui" | "2i" | "2f" | "4f", number | number[]][], src: GLTexture | null, shape?: GLTexture): void {
    const gl = this.gl;
    const p = this.programs.get(name)!;
    gl.useProgram(p.program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo);
    gl.viewport(0, 0, out.width, out.height);
    gl.disable(gl.BLEND);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    const loc = (n: string): WebGLUniformLocation | null => {
      if (!p.uniforms.has(n)) p.uniforms.set(n, gl.getUniformLocation(p.program, n));
      return p.uniforms.get(n)!;
    };
    if (src) {
      gl.activeTexture(gl.TEXTURE0 + SRC_UNIT);
      gl.bindTexture(gl.TEXTURE_2D, src.texture);
      gl.uniform1i(loc("u_src"), SRC_UNIT);
      gl.uniform2i(loc("u_srcSize"), src.width, src.height);
    }
    if (shape) {
      gl.activeTexture(gl.TEXTURE0 + SHAPE_UNIT);
      gl.bindTexture(gl.TEXTURE_2D, shape.texture);
      gl.uniform1i(loc("u_shape"), SHAPE_UNIT);
    }
    gl.uniform2i(loc("u_outSize"), out.width, out.height);
    for (const [n, type, v] of uniforms) {
      const l = loc(n);
      const a = Array.isArray(v) ? v : [v];
      if (type === "1i") gl.uniform1i(l, a[0]!);
      else if (type === "1ui") gl.uniform1ui(l, a[0]!);
      else if (type === "1f") gl.uniform1f(l, a[0]!);
      else if (type === "2i") gl.uniform2i(l, a[0]!, a[1]!);
      else if (type === "2f") gl.uniform2f(l, a[0]!, a[1]!);
      else gl.uniform4f(l, a[0]!, a[1]!, a[2]!, a[3]!);
    }
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
  }

  private acquire(format: number, width: number, height: number): GLTexture {
    const w = Math.ceil(width / POOL_GRAIN) * POOL_GRAIN;
    const h = Math.ceil(height / POOL_GRAIN) * POOL_GRAIN;
    let best: Pooled | null = null;
    for (const t of this.pool) {
      if (t.busy || t.format !== format || t.width < w || t.height < h) continue;
      if (!best || t.width * t.height < best.width * best.height) best = t;
    }
    if (!best || best.width * best.height > 4 * w * h) {
      best = { ...this.createTexture(format, w, h), busy: false, lastUsed: 0 };
      this.pool.push(best);
    }
    best.busy = true;
    best.lastUsed = this.frame;
    return best;
  }

  private createOutput(width: number, height: number): GLTexture {
    return this.createTexture(this.gl.RGBA8, width, height);
  }

  private createTexture(format: number, width: number, height: number): GLTexture {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0 + SRC_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, format, Math.max(1, width), Math.max(1, height));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.activeTexture(gl.TEXTURE0);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { texture, fbo, width, height, format };
  }

  private deleteTexture(t: GLTexture): void {
    this.gl.deleteTexture(t.texture);
    this.gl.deleteFramebuffer(t.fbo);
  }
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): Program {
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
  return { program, uniforms: new Map() };
}
