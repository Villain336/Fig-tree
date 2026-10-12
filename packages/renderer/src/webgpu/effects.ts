import { meshWgsl, noiseWgsl } from "../shaders/wgsl";

/**
 * WGSL compute passes for the render graph (see `GraphNode` in frame.ts).
 * Every texture covers an integer rectangle of frame pixels; uniforms give
 * each texture's origin and size, and reads outside a texture are
 * transparent (or mirrored, for backdrops). Intermediate textures are
 * rgba16float; the results frames draw from are stored into the rgba8
 * effect atlas by the store pass.
 */

const header = /* wgsl */ `
@group(0) @binding(0) var<uniform> u: Params;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var dst: texture_storage_2d<rgba16float, write>;
`;

/** 2x2 box filter to half size (odd edges: transparent, or the edge texel repeated). */
export const downsampleShader = /* wgsl */ `
struct Params { inSize: vec2<i32>, outSize: vec2<i32>, mirror: u32, _p0: u32, _p1: u32, _p2: u32 }
${header}
fn load(p: vec2<i32>) -> vec4<f32> {
  if (any(p >= u.inSize)) {
    if (u.mirror == 0u) { return vec4<f32>(0.0); }
    return textureLoad(src, min(p, u.inSize - 1), 0);
  }
  return textureLoad(src, p, 0);
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let o = vec2<i32>(gid.xy);
  if (any(o >= u.outSize)) { return; }
  let i = o * 2;
  let c = load(i) + load(i + vec2<i32>(1, 0)) + load(i + vec2<i32>(0, 1)) + load(i + vec2<i32>(1, 1));
  textureStore(dst, o, c * 0.25);
}
`;

/** One direction of a separable Gaussian (kernel radius ceil(3σ), weights normalized). */
export const blurShader = /* wgsl */ `
struct Params { size: vec2<i32>, dir: vec2<i32>, sigma: f32, radius: i32, mirror: u32, _p: u32 }
${header}
fn load(p: vec2<i32>) -> vec4<f32> {
  var q = p;
  if (u.mirror != 0u) {
    // Mirror without repeating the edge texel: -1 -> 0, size -> size - 1.
    let n = u.size;
    q = select(q, -q - 1, q < vec2<i32>(0));
    q = select(q, 2 * n - q - 1, q >= n);
    q = clamp(q, vec2<i32>(0), n - 1);
  } else if (any(q < vec2<i32>(0)) || any(q >= u.size)) {
    return vec4<f32>(0.0);
  }
  return textureLoad(src, q, 0);
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let p = vec2<i32>(gid.xy);
  if (any(p >= u.size)) { return; }
  var sum = vec4<f32>(0.0);
  var wsum = 0.0;
  let k = -0.5 / (u.sigma * u.sigma);
  for (var i = -u.radius; i <= u.radius; i++) {
    let w = exp(f32(i * i) * k);
    sum += w * load(p + u.dir * i);
    wsum += w;
  }
  textureStore(dst, p, sum / wsum);
}
`;

/** Bilinear upscaling by two (texel centers aligned with the 2x2 box filter's). */
export const upsampleShader = /* wgsl */ `
struct Params { inSize: vec2<i32>, outSize: vec2<i32>, mirror: u32, _p0: u32, _p1: u32, _p2: u32 }
${header}
fn load(p: vec2<i32>) -> vec4<f32> {
  if (any(p < vec2<i32>(0)) || any(p >= u.inSize)) {
    if (u.mirror == 0u) { return vec4<f32>(0.0); }
    return textureLoad(src, clamp(p, vec2<i32>(0), u.inSize - 1), 0);
  }
  return textureLoad(src, p, 0);
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let o = vec2<i32>(gid.xy);
  if (any(o >= u.outSize)) { return; }
  let t = (vec2<f32>(o) + 0.5) * 0.5 - 0.5;
  let i = floor(t);
  let f = t - i;
  let b = vec2<i32>(i);
  let c = mix(mix(load(b), load(b + vec2<i32>(1, 0)), f.x), mix(load(b + vec2<i32>(0, 1)), load(b + vec2<i32>(1, 1)), f.x), f.y);
  textureStore(dst, o, c);
}
`;

/**
 * Dilation (radius > 0) or erosion (radius < 0) of a coverage image by a
 * disk, with a one-pixel ramp at the disk's rim for fractional radii.
 * Large radii sample a coarser grid of offsets.
 */
export const morphShader = /* wgsl */ `
struct Params { size: vec2<i32>, radius: f32, stride: i32 }
${header}
fn load(p: vec2<i32>) -> f32 {
  if (any(p < vec2<i32>(0)) || any(p >= u.size)) { return 0.0; }
  return textureLoad(src, p, 0).a;
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let p = vec2<i32>(gid.xy);
  if (any(p >= u.size)) { return; }
  let r = abs(u.radius);
  let reach = i32(ceil(r + 0.5));
  let dilate = u.radius > 0.0;
  var v = select(1.0, 0.0, dilate);
  for (var dy = -reach; dy <= reach; dy += u.stride) {
    for (var dx = -reach; dx <= reach; dx += u.stride) {
      let w = clamp(r + 0.5 - length(vec2<f32>(f32(dx), f32(dy))), 0.0, 1.0);
      if (w <= 0.0) { continue; }
      let a = load(p + vec2<i32>(dx, dy));
      if (dilate) { v = max(v, a * w); } else { v = min(v, 1.0 - (1.0 - a) * w); }
    }
  }
  textureStore(dst, p, vec4<f32>(v));
}
`;

/** Shadows: drop c·B(p − o)·(1 − S(p)) (or without S), inner c·S(p)·(1 − B(p − o)). */
export const shadowShader = /* wgsl */ `
struct Params {
  outOrigin: vec2<i32>, outSize: vec2<i32>,
  bOrigin: vec2<i32>, bSize: vec2<i32>,
  sOrigin: vec2<i32>, sSize: vec2<i32>,
  offset: vec2<f32>, mode: u32, hasShape: u32,
  color: vec4<f32>,
}
@group(0) @binding(0) var<uniform> u: Params;
@group(0) @binding(1) var blurred: texture_2d<f32>;
@group(0) @binding(2) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var shape: texture_2d<f32>;
fn loadB(p: vec2<i32>) -> f32 {
  if (any(p < vec2<i32>(0)) || any(p >= u.bSize)) { return 0.0; }
  return textureLoad(blurred, p, 0).a;
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let o = vec2<i32>(gid.xy);
  if (any(o >= u.outSize)) { return; }
  let frame = vec2<f32>(u.outOrigin + o) + 0.5;
  let t = frame - u.offset - vec2<f32>(u.bOrigin) - 0.5;
  let i = floor(t);
  let f = t - i;
  let b = vec2<i32>(i);
  let bv = mix(mix(loadB(b), loadB(b + vec2<i32>(1, 0)), f.x), mix(loadB(b + vec2<i32>(0, 1)), loadB(b + vec2<i32>(1, 1)), f.x), f.y);
  var s = 0.0;
  if (u.hasShape != 0u) {
    let sp = u.outOrigin + o - u.sOrigin;
    if (all(sp >= vec2<i32>(0)) && all(sp < u.sSize)) { s = textureLoad(shape, sp, 0).a; }
  }
  var a: f32;
  if (u.mode == 1u) {
    a = s * (1.0 - bv);
  } else if (u.hasShape != 0u) {
    a = bv * (1.0 - s);
  } else {
    a = bv;
  }
  textureStore(dst, o, u.color * a);
}
`;

/** Background blur: the blurred backdrop B shown through the shape S. */
export const backdropShader = /* wgsl */ `
struct Params { outOrigin: vec2<i32>, outSize: vec2<i32>, bOrigin: vec2<i32>, bSize: vec2<i32>, sOrigin: vec2<i32>, sSize: vec2<i32> }
@group(0) @binding(0) var<uniform> u: Params;
@group(0) @binding(1) var blurred: texture_2d<f32>;
@group(0) @binding(2) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var shape: texture_2d<f32>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let o = vec2<i32>(gid.xy);
  if (any(o >= u.outSize)) { return; }
  let f = u.outOrigin + o;
  let bp = clamp(f - u.bOrigin, vec2<i32>(0), u.bSize - 1);
  let sp = f - u.sOrigin;
  var s = 0.0;
  if (all(sp >= vec2<i32>(0)) && all(sp < u.sSize)) { s = textureLoad(shape, sp, 0).a; }
  textureStore(dst, o, textureLoad(blurred, bp, 0) * s);
}
`;

/** Copies a texture into the rgba8 effect atlas at an offset. */
export const storeShader = /* wgsl */ `
struct Params { size: vec2<i32>, atlas: vec2<i32> }
@group(0) @binding(0) var<uniform> u: Params;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var dst: texture_storage_2d<rgba8unorm, write>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let p = vec2<i32>(gid.xy);
  if (any(p >= u.size)) { return; }
  textureStore(dst, u.atlas + p, clamp(textureLoad(src, p, 0), vec4<f32>(0.0), vec4<f32>(1.0)));
}
`;

/** The mesh gradient's lookup texture: the surface color at each texel's box position, premultiplied. */
export const meshLutShader = /* wgsl */ `
struct Params { size: vec2<i32>, base: u32, _p: u32, time: f32, seed: u32, _q0: u32, _q1: u32 }
@group(0) @binding(0) var<uniform> u: Params;
@group(0) @binding(1) var<storage, read> stops: array<vec4<f32>>;
@group(0) @binding(2) var dst: texture_storage_2d<rgba16float, write>;
fn P(b: u32, i: u32) -> vec4<f32> { return stops[b + i]; }
${noiseWgsl}
${meshWgsl}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let p = vec2<i32>(gid.xy);
  if (any(p >= u.size)) { return; }
  let goal = (vec2<f32>(p) + 0.5) / vec2<f32>(u.size);
  let c = meshColor(u.base, goal, u.time, u.seed);
  textureStore(dst, p, vec4<f32>(c.rgb * c.a, c.a));
}
`;
