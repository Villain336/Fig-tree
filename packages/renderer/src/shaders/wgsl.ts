/**
 * WGSL building blocks shared by the WebGPU composite stage: blend modes,
 * image sampling and adjustments, and the shader fill library. Each
 * function has a GLSL ES 3.0 twin in `glsl.ts` computing the same thing;
 * keep them in step (e2e `effects-render.spec.ts` compares the backends).
 *
 * The functions read three globals the including shader declares:
 * `stops` (paint parameters as vec4s), `effectAtlas` and `imageAtlas`.
 */

/** W3C Compositing and Blending Level 1 (separable and non-separable modes), plus Level 2's plus-lighter and plus-darker. */
export const blendWgsl = /* wgsl */ `
fn blendLum(c: vec3<f32>) -> f32 { return dot(c, vec3<f32>(0.3, 0.59, 0.11)); }

fn clipColor(c: vec3<f32>) -> vec3<f32> {
  let l = blendLum(c);
  let n = min(min(c.r, c.g), c.b);
  let x = max(max(c.r, c.g), c.b);
  var r = c;
  if (n < 0.0) { r = l + (r - l) * l / (l - n); }
  if (x > 1.0) { r = l + (r - l) * (1.0 - l) / (x - l); }
  return r;
}

fn setLum(c: vec3<f32>, l: f32) -> vec3<f32> { return clipColor(c + (l - blendLum(c))); }

fn blendSat(c: vec3<f32>) -> f32 { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }

fn setSat(c: vec3<f32>, s: f32) -> vec3<f32> {
  let mx = max(max(c.r, c.g), c.b);
  let mn = min(min(c.r, c.g), c.b);
  if (mx <= mn) { return vec3<f32>(0.0); }
  return (c - mn) * s / (mx - mn);
}

fn softLightD(cb: f32) -> f32 {
  if (cb <= 0.25) { return ((16.0 * cb - 12.0) * cb + 4.0) * cb; }
  return sqrt(cb);
}

fn blendChannel(mode: u32, cb: f32, cs: f32) -> f32 {
  switch (mode) {
    case 1u: { return cb * cs; }
    case 2u: { return cb + cs - cb * cs; }
    case 3u: {
      // overlay = hard-light with the layers swapped
      if (cb <= 0.5) { return cs * 2.0 * cb; }
      let t = 2.0 * cb - 1.0;
      return cs + t - cs * t;
    }
    case 4u: { return min(cb, cs); }
    case 5u: { return max(cb, cs); }
    case 6u: {
      if (cb <= 0.0) { return 0.0; }
      if (cs >= 1.0) { return 1.0; }
      return min(1.0, cb / (1.0 - cs));
    }
    case 7u: {
      if (cb >= 1.0) { return 1.0; }
      if (cs <= 0.0) { return 0.0; }
      return 1.0 - min(1.0, (1.0 - cb) / cs);
    }
    case 8u: {
      if (cs <= 0.5) { return cb * 2.0 * cs; }
      let t = 2.0 * cs - 1.0;
      return cb + t - cb * t;
    }
    case 9u: {
      if (cs <= 0.5) { return cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb); }
      return cb + (2.0 * cs - 1.0) * (softLightD(cb) - cb);
    }
    case 10u: { return abs(cb - cs); }
    case 11u: { return cb + cs - 2.0 * cb * cs; }
    default: { return cs; }
  }
}

fn blendColor(mode: u32, cb: vec3<f32>, cs: vec3<f32>) -> vec3<f32> {
  switch (mode) {
    case 12u: { return setLum(setSat(cs, blendSat(cb)), blendLum(cb)); }
    case 13u: { return setLum(setSat(cb, blendSat(cs)), blendLum(cb)); }
    case 14u: { return setLum(cs, blendLum(cb)); }
    case 15u: { return setLum(cb, blendLum(cs)); }
    default: { return vec3<f32>(blendChannel(mode, cb.r, cs.r), blendChannel(mode, cb.g, cs.g), blendChannel(mode, cb.b, cs.b)); }
  }
}

/** Composites premultiplied src over premultiplied dst with a blend mode (codes as in BLEND_MODES). */
fn blendPremul(mode: u32, src: vec4<f32>, dst: vec4<f32>) -> vec4<f32> {
  if (mode == 0u) { return src + dst * (1.0 - src.a); }
  if (mode == 17u) { return min(src + dst, vec4<f32>(1.0)); }
  if (mode == 16u) {
    let a = min(1.0, src.a + dst.a);
    return vec4<f32>(max(vec3<f32>(0.0), vec3<f32>(a) - ((vec3<f32>(src.a) - src.rgb) + (vec3<f32>(dst.a) - dst.rgb))), a);
  }
  if (src.a <= 0.0) { return dst; }
  let cs = clamp(src.rgb / src.a, vec3<f32>(0.0), vec3<f32>(1.0));
  var cb = vec3<f32>(0.0);
  if (dst.a > 0.0) { cb = clamp(dst.rgb / dst.a, vec3<f32>(0.0), vec3<f32>(1.0)); }
  let b = clamp(blendColor(mode, cb, cs), vec3<f32>(0.0), vec3<f32>(1.0));
  return vec4<f32>(src.rgb * (1.0 - dst.a) + dst.rgb * (1.0 - src.a) + src.a * dst.a * b, src.a + dst.a * (1.0 - src.a));
}
`;

/**
 * Noise and hashing: an integer hash (so seeds give the same values on
 * every GPU), value noise, 2D simplex noise (our own implementation of the
 * skewed-grid algorithm) and fractal sums.
 */
export const noiseWgsl = /* wgsl */ `
fn hashU(x: u32) -> u32 {
  let v = x * 747796405u + 2891336453u;
  let w = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u;
  return (w >> 22u) ^ w;
}

/** Uniform in [0, 1) for an integer lattice point and a seed. */
fn hash2(ix: i32, iy: i32, seed: u32) -> f32 {
  let h = hashU(bitcast<u32>(ix) ^ hashU(bitcast<u32>(iy) ^ hashU(seed)));
  return f32(h >> 8u) / 16777216.0;
}

fn valueNoise(p: vec2<f32>, seed: u32) -> f32 {
  let i = floor(p);
  let f = p - i;
  let u = f * f * (3.0 - 2.0 * f);
  let x = i32(i.x);
  let y = i32(i.y);
  let a = hash2(x, y, seed);
  let b = hash2(x + 1, y, seed);
  let c = hash2(x, y + 1, seed);
  let d = hash2(x + 1, y + 1, seed);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn simplexCorner(d: vec2<f32>, c: vec2<f32>, seed: u32) -> f32 {
  let t = 0.5 - dot(d, d);
  if (t <= 0.0) { return 0.0; }
  let a = hash2(i32(c.x), i32(c.y), seed) * 6.283185307;
  let t2 = t * t;
  return t2 * t2 * dot(vec2<f32>(cos(a), sin(a)), d);
}

/** 2D simplex noise in about [-1, 1]. */
fn simplex(p: vec2<f32>, seed: u32) -> f32 {
  let F2 = 0.3660254038;
  let G2 = 0.2113248654;
  let i = floor(p + (p.x + p.y) * F2);
  let x0 = p - (i - (i.x + i.y) * G2);
  var o = vec2<f32>(0.0, 1.0);
  if (x0.x > x0.y) { o = vec2<f32>(1.0, 0.0); }
  let x1 = x0 - o + G2;
  let x2 = x0 - 1.0 + 2.0 * G2;
  return 70.0 * (simplexCorner(x0, i, seed) + simplexCorner(x1, i + o, seed) + simplexCorner(x2, i + 1.0, seed));
}

fn fbm(p: vec2<f32>, octaves: i32, seed: u32) -> f32 {
  var sum = 0.0;
  var amp = 0.5;
  var q = p;
  var norm = 0.0;
  for (var k = 0; k < 6; k++) {
    if (k >= octaves) { break; }
    sum += amp * simplex(q, seed + u32(k) * 101u);
    norm += amp;
    q = q * 2.03 + vec2<f32>(17.3, 9.1);
    amp *= 0.5;
  }
  return sum / norm;
}
`;

/**
 * Image sampling from the image atlas: bilinear over premultiplied texels of
 * one mip level, wrapping for repeated images, clamped at the edges
 * otherwise, with the image's outline anti-aliased; then the adjustments.
 */
export const imageWgsl = /* wgsl */ `
struct ImagePlace {
  atlas: vec2<i32>,
  rectOrigin: vec2<i32>,
  rectSize: vec2<i32>,
  levelSize: vec2<i32>,
  pixelsPerTexel: f32,
}

fn imagePlace(x: u32) -> ImagePlace {
  var p: ImagePlace;
  p.atlas = vec2<i32>(i32(frameData[x + 3u] & 0xffffu), i32(frameData[x + 3u] >> 16u));
  p.rectOrigin = vec2<i32>(i32(frameData[x + 4u] & 0xffffu), i32(frameData[x + 4u] >> 16u));
  p.rectSize = vec2<i32>(i32(frameData[x + 5u] & 0xffffu), i32(frameData[x + 5u] >> 16u));
  p.levelSize = vec2<i32>(i32(frameData[x + 6u] & 0xffffu), i32(frameData[x + 6u] >> 16u));
  p.pixelsPerTexel = bitcast<f32>(frameData[x + 7u]);
  return p;
}

fn imageTexel(p: ImagePlace, t: vec2<i32>, repeat: bool) -> vec4<f32> {
  var q = t;
  if (repeat) {
    q = ((q % p.levelSize) + p.levelSize) % p.levelSize;
  } else {
    q = clamp(q, vec2<i32>(0), p.levelSize - 1);
  }
  let local = clamp(q - p.rectOrigin, vec2<i32>(0), p.rectSize - 1);
  return textureLoad(imageAtlas, p.atlas + local, 0);
}

/** The image at level-0 pixel position u of an image of size wh (premultiplied). */
fn sampleImage(p: ImagePlace, u: vec2<f32>, wh: vec2<f32>, repeat: bool) -> vec4<f32> {
  let t = u * vec2<f32>(p.levelSize) / wh - 0.5;
  let i = floor(t);
  let f = t - i;
  let b = vec2<i32>(i);
  let c = mix(mix(imageTexel(p, b, repeat), imageTexel(p, b + vec2<i32>(1, 0), repeat), f.x),
              mix(imageTexel(p, b + vec2<i32>(0, 1), repeat), imageTexel(p, b + vec2<i32>(1, 1), repeat), f.x), f.y);
  if (repeat) { return c; }
  // Box-filtered edge: the share of the pixel inside the image along each axis.
  let inside = min(u, wh - u) * p.pixelsPerTexel;
  let cov = clamp(0.5 + inside, vec2<f32>(0.0), vec2<f32>(1.0));
  return c * cov.x * cov.y;
}

/** Image adjustments on an unpremultiplied sRGB color (exposure, contrast, saturation, temperature, tint, highlights, shadows). */
fn adjustImage(c: vec3<f32>, a1: vec4<f32>, a2: vec4<f32>) -> vec3<f32> {
  var r = c * exp2(a1.x);
  r = (r - 0.5) * (1.0 + a1.y) + 0.5;
  let s = 1.0 + a1.z;
  let l = dot(r, vec3<f32>(0.2126, 0.7152, 0.0722));
  r = mix(vec3<f32>(l), r, s);
  r = r * vec3<f32>(1.0 + 0.2 * a1.w + 0.1 * a2.x, 1.0 - 0.2 * a2.x, 1.0 - 0.2 * a1.w + 0.1 * a2.x);
  r = clamp(r, vec3<f32>(0.0), vec3<f32>(1.0));
  let l2 = dot(r, vec3<f32>(0.2126, 0.7152, 0.0722));
  let hi = smoothstep(0.5, 1.0, l2);
  let lo = 1.0 - smoothstep(0.0, 0.5, l2);
  r = r + 0.25 * (a2.y * hi + a2.z * lo);
  return clamp(r, vec3<f32>(0.0), vec3<f32>(1.0));
}
`;

/**
 * The shader fill library. `uv` is the pixel's position in the node's box
 * (0..1), `px` the same in local units, `scale` device pixels per local
 * unit (for anti-aliasing), `b` the index of the paint's first parameter
 * vec4 in `stops`, `x` the entry's frame-data index (backdrop, LUT and
 * image placements), `time` the shader's time in seconds.
 */
export const shaderLibWgsl = /* wgsl */ `
fn P(b: u32, i: u32) -> vec4<f32> { return stops[b + i]; }

fn premul(c: vec4<f32>) -> vec4<f32> { return vec4<f32>(c.rgb * c.a, c.a); }

/** A texture of the frame-data entry x (effect atlas), at texel position t (clamped to its rect). */
fn entryTexture(x: u32, t: vec2<f32>) -> vec4<f32> {
  let atlas = vec2<i32>(i32(frameData[x] & 0xffffu), i32(frameData[x] >> 16u));
  let size = vec2<i32>(i32(frameData[x + 2u] & 0xffffu), i32(frameData[x + 2u] >> 16u));
  let q = t - 0.5;
  let i = floor(q);
  let f = q - i;
  let b = vec2<i32>(i);
  let m = size - 1;
  let c00 = textureLoad(effectAtlas, atlas + clamp(b, vec2<i32>(0), m), 0);
  let c10 = textureLoad(effectAtlas, atlas + clamp(b + vec2<i32>(1, 0), vec2<i32>(0), m), 0);
  let c01 = textureLoad(effectAtlas, atlas + clamp(b + vec2<i32>(0, 1), vec2<i32>(0), m), 0);
  let c11 = textureLoad(effectAtlas, atlas + clamp(b + vec2<i32>(1, 1), vec2<i32>(0), m), 0);
  return mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
}

fn entryTextureOrigin(x: u32) -> vec2<f32> {
  let o = frameData[x + 1u];
  return vec2<f32>(f32(i32(o << 16u) >> 16u), f32(i32(o) >> 16u));
}

fn entryTextureSize(x: u32) -> vec2<f32> {
  return vec2<f32>(f32(frameData[x + 2u] & 0xffffu), f32(frameData[x + 2u] >> 16u));
}

fn rot(a: f32) -> mat2x2<f32> {
  let c = cos(a);
  let s = sin(a);
  return mat2x2<f32>(c, s, -s, c);
}

/** Tone for halftone and dithering, 0 (paper) to 1 (ink). */
fn tone(source: f32, angle: f32, uv: vec2<f32>, px: vec2<f32>, seed: u32, contrast: f32, x: u32, b: u32) -> f32 {
  var t = 0.0;
  if (source < 0.5) {
    let a = radians(angle);
    let d = vec2<f32>(cos(a), sin(a));
    t = dot(uv - 0.5, d) / (abs(d.x) + abs(d.y)) + 0.5;
  } else if (source < 1.5) {
    t = 1.0 - length(uv - 0.5) * 2.0;
  } else if (source < 2.5) {
    t = fbm(uv * 3.0, 4, seed) * 0.5 + 0.5;
  } else if (x != 0xffffffffu) {
    let im = sampleShaderImage(x, b, px);
    let c = select(vec3<f32>(1.0), im.rgb / im.a, im.a > 0.0);
    t = 1.0 - dot(mix(vec3<f32>(1.0), c, im.a), vec3<f32>(0.2126, 0.7152, 0.0722));
  }
  t = (t - 0.5) * (1.0 + contrast) + 0.5;
  return clamp(t, 0.0, 1.0);
}

/** Image tone source: the paint's image mapped by its image matrix (stored after the shader's parameters). */
fn sampleShaderImage(x: u32, b: u32, px: vec2<f32>) -> vec4<f32> {
  let m = P(b, 6u);
  let mt = P(b, 7u);
  let u = vec2<f32>(m.x * px.x + m.z * px.y + mt.x, m.y * px.x + m.w * px.y + mt.y);
  return sampleImage(imagePlace(x), u, mt.zw, false);
}

fn grainShader(b: u32, px: vec2<f32>, seed: u32, time: f32) -> vec4<f32> {
  let back = P(b, 2u);
  let front = P(b, 3u);
  let g = P(b, 4u);
  let frame = u32(max(0.0, floor(time * 24.0)));
  let n = valueNoise(px / g.x, seed + frame * 7919u);
  let hard = 1.0 - g.z;
  let edge = 0.5 * hard + 0.02;
  let t = smoothstep(1.0 - g.y - edge, 1.0 - g.y + edge, n);
  return mix(premul(back), premul(front), t);
}

fn halftoneScreen(px: vec2<f32>, cell: f32, angle: f32, ink: f32, lines: bool, scale: f32) -> f32 {
  let q = rot(-radians(angle)) * px / cell;
  let f = fract(q) - 0.5;
  let aa = 1.0 / (cell * scale);
  if (lines) {
    let half = ink * 0.5;
    return clamp((half - abs(f.y)) / aa + 0.5, 0.0, 1.0);
  }
  let r = sqrt(ink) * 0.7071;
  return clamp((r - length(f)) / aa + 0.5, 0.0, 1.0);
}

fn halftoneShader(b: u32, uv: vec2<f32>, px: vec2<f32>, scale: f32, seed: u32, x: u32) -> vec4<f32> {
  let back = premul(P(b, 2u));
  let front = premul(P(b, 3u));
  let s = P(b, 4u);
  let src = P(b, 5u);
  let lines = s.x > 0.5;
  if (s.y < 0.5) {
    let t = tone(src.x, src.y, uv, px, seed, src.z, x, b);
    let ink = halftoneScreen(px, s.z, s.w, t, lines, scale);
    return mix(back, front, ink);
  }
  // CMYK: separate the tone's color (or a gray ramp) into four screens at the classic angles.
  var rgb = vec3<f32>(1.0 - tone(src.x, src.y, uv, px, seed, src.z, x, b));
  if (src.x > 2.5 && x != 0xffffffffu) {
    let im = sampleShaderImage(x, b, px);
    rgb = mix(vec3<f32>(1.0), select(vec3<f32>(1.0), im.rgb / im.a, im.a > 0.0), im.a);
  }
  let k = 1.0 - max(max(rgb.r, rgb.g), rgb.b);
  let d = max(1.0 - k, 1e-4);
  let cmy = (1.0 - rgb - k) / d;
  let c = halftoneScreen(px, s.z, s.w + 15.0, cmy.x, lines, scale);
  let m = halftoneScreen(px, s.z, s.w + 75.0, cmy.y, lines, scale);
  let y = halftoneScreen(px, s.z, s.w, cmy.z, lines, scale);
  let kk = halftoneScreen(px, s.z, s.w + 45.0, k, lines, scale);
  let paper = back.rgb / max(back.a, 1e-4);
  var ink = paper * (1.0 - c * vec3<f32>(1.0, 0.0, 0.0)) * (1.0 - m * vec3<f32>(0.0, 1.0, 0.0)) * (1.0 - y * vec3<f32>(0.0, 0.0, 1.0));
  ink = ink * (1.0 - kk);
  return vec4<f32>(ink * back.a, back.a);
}

fn flutedShader(b: u32, uv: vec2<f32>, px: vec2<f32>, scale: f32, x: u32, pos: vec2<f32>) -> vec4<f32> {
  let p = P(b, 2u);
  let tint = premul(P(b, 3u));
  let a = radians(p.y);
  let dir = vec2<f32>(cos(a), sin(a));
  let across = dot(px, dir) / p.x;
  let f = fract(across) - 0.5;
  // A cylindrical lens: the backdrop is pulled towards each flute's center and mirrored at its edge.
  let shift = -f * p.z * p.x * 1.6 * (1.0 - 4.0 * f * f) ;
  var color = vec4<f32>(0.0);
  if (x != 0xffffffffu) {
    let deviceShift = dir * shift * scale;
    let t = pos + deviceShift - entryTextureOrigin(x);
    color = entryTexture(x, clamp(t, vec2<f32>(0.5), entryTextureSize(x) - 0.5));
  }
  let light = (0.5 - abs(f) * 2.0) * 0.6 + f * 0.8;
  let shaded = clamp(color.rgb + vec3<f32>(light * p.w * 0.35) * color.a, vec3<f32>(0.0), vec3<f32>(color.a));
  let glass = vec4<f32>(shaded, color.a);
  return tint + glass * (1.0 - tint.a);
}

fn liquidShader(b: u32, px: vec2<f32>, seed: u32, time: f32) -> vec4<f32> {
  let s = P(b, 2u);
  let q = px / s.x;
  let octaves = i32(s.z);
  let t = time * 0.15;
  let w1 = vec2<f32>(fbm(q + vec2<f32>(0.0, t), octaves, seed), fbm(q + vec2<f32>(5.2, 1.3 - t), octaves, seed + 11u));
  let w2 = vec2<f32>(fbm(q + s.y * 2.0 * w1 + vec2<f32>(1.7 + t, 9.2), octaves, seed + 23u), fbm(q + s.y * 2.0 * w1 + vec2<f32>(8.3, 2.8 + t), octaves, seed + 37u));
  let n = clamp(fbm(q + s.y * 2.0 * w2, octaves, seed + 51u) * 0.75 + 0.5, 0.0, 1.0);
  let count = max(2.0, s.w);
  let fi = n * (count - 1.0);
  let i = u32(min(floor(fi), count - 2.0));
  let c0 = premul(P(b, 3u + i));
  let c1 = premul(P(b, 4u + i));
  return mix(c0, c1, smoothstep(0.0, 1.0, fi - f32(i)));
}

fn bayer(i: u32, j: u32, n: u32) -> f32 {
  // Bayer matrix by bit interleaving: the lowest coordinate bits give the most significant base-4 digit.
  var v = 0u;
  var size = 1u;
  var x = i;
  var y = j;
  loop {
    if (size >= n) { break; }
    let xb = x & 1u;
    let yb = y & 1u;
    v = v * 4u + (((xb ^ yb) << 1u) | yb);
    x = x >> 1u;
    y = y >> 1u;
    size = size * 2u;
  }
  return (f32(v) + 0.5) / f32(n * n);
}

fn ditherShader(b: u32, uv: vec2<f32>, px: vec2<f32>, seed: u32, x: u32) -> vec4<f32> {
  let back = premul(P(b, 2u));
  let front = premul(P(b, 3u));
  let s = P(b, 4u);
  let s2 = P(b, 5u);
  let cell = floor(px / s.y);
  let center = (cell + 0.5) * s.y;
  let t = tone(s.z, s.w, center / max(P(b, 1u).xy, vec2<f32>(1e-4)), center, seed, s2.x, x, b);
  let ci = vec2<i32>(cell);
  var threshold = 0.5;
  if (s.x > 2.5) {
    threshold = hash2(ci.x, ci.y, seed);
  } else {
    let n = select(select(2u, 4u, s.x > 0.5), 8u, s.x > 1.5);
    let m = i32(n);
    threshold = bayer(u32(((ci.x % m) + m) % m), u32(((ci.y % m) + m) % m), n);
  }
  return select(back, front, t > threshold);
}

/** The mesh gradient's lookup texture (computed by the mesh pass), sampled bilinearly. */
fn meshShader(uv: vec2<f32>, x: u32) -> vec4<f32> {
  if (x == 0xffffffffu) { return vec4<f32>(0.0); }
  let size = entryTextureSize(x);
  return entryTexture(x, clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0)) * size);
}

/** Premultiplied color of shader paint b at a pixel (before the paint's opacity). */
fn shaderPaint(b: u32, local: vec2<f32>, scale: f32, x: u32, pos: vec2<f32>) -> vec4<f32> {
  let h = P(b, 0u);
  let box = P(b, 1u);
  let kind = u32(h.x);
  let seed = u32(h.y);
  let time = h.z + config.time * h.w;
  let uv = local / box.xy;
  var c = vec4<f32>(0.0);
  switch (kind) {
    case 0u: { c = meshShader(uv, x); }
    case 1u: { c = grainShader(b, local, seed, time); }
    case 2u: { c = halftoneShader(b, uv, local, scale, seed, x); }
    case 3u: { c = flutedShader(b, uv, local, scale, x, pos); }
    case 4u: { c = liquidShader(b, local, seed, time); }
    case 5u: { c = ditherShader(b, uv, local, seed, x); }
    default: {}
  }
  return c * box.z;
}
`;

/**
 * The mesh gradient surface, evaluated per texel of its lookup texture by
 * the mesh pass: a Catmull-Rom surface through the control points
 * (positions and colors), inverted per texel by Newton's method.
 */
export const meshWgsl = /* wgsl */ `
fn crWeights(s: f32) -> vec4<f32> {
  let s2 = s * s;
  let s3 = s2 * s;
  return 0.5 * vec4<f32>(-s3 + 2.0 * s2 - s, 3.0 * s3 - 5.0 * s2 + 2.0, -3.0 * s3 + 4.0 * s2 + s, s3 - s2);
}

fn crDerivative(s: f32) -> vec4<f32> {
  let s2 = s * s;
  return 0.5 * vec4<f32>(-3.0 * s2 + 4.0 * s - 1.0, 9.0 * s2 - 10.0 * s, -9.0 * s2 + 8.0 * s + 1.0, 3.0 * s2 - 2.0 * s);
}

/** Control point (i, j), moved along its seeded path; outside the grid, extrapolated linearly. */
fn meshPos(b: u32, i: i32, j: i32, cols: i32, rows: i32, motion: f32, time: f32, seed: u32) -> vec2<f32> {
  let ci = clamp(i, 0, cols - 1);
  let cj = clamp(j, 0, rows - 1);
  var p = meshRaw(b, ci, cj, cols, motion, time, seed);
  if (i != ci || j != cj) {
    let ni = clamp(ci - (i - ci), 0, cols - 1);
    let nj = clamp(cj - (j - cj), 0, rows - 1);
    p = 2.0 * p - meshRaw(b, ni, nj, cols, motion, time, seed);
  }
  return p;
}

fn meshRaw(b: u32, i: i32, j: i32, cols: i32, motion: f32, time: f32, seed: u32) -> vec2<f32> {
  var p = P(b, 3u + 2u * u32(j * cols + i)).xy;
  if (motion != 0.0) {
    let f1 = 0.6 + 0.8 * hash2(i, j, seed + 1u);
    let f2 = 0.6 + 0.8 * hash2(i, j, seed + 2u);
    let ph = 6.283185307 * hash2(i, j, seed + 3u);
    p += motion * vec2<f32>(sin(time * f1 + ph), cos(time * f2 + ph * 1.3));
  }
  return p;
}

fn meshCol(b: u32, i: i32, j: i32, cols: i32, rows: i32) -> vec4<f32> {
  let ci = clamp(i, 0, cols - 1);
  let cj = clamp(j, 0, rows - 1);
  return P(b, 4u + 2u * u32(cj * cols + ci));
}

/** Mesh color at box position goal (unpremultiplied, clamped). */
fn meshColor(b: u32, goal: vec2<f32>, time: f32, seed: u32) -> vec4<f32> {
  let g = P(b, 2u);
  let cols = i32(g.x);
  let rows = i32(g.y);
  let motion = g.z;
  var u = goal.x * f32(cols - 1);
  var v = goal.y * f32(rows - 1);
  for (var it = 0; it < 10; it++) {
    let i0 = clamp(i32(floor(u)), 0, cols - 2);
    let j0 = clamp(i32(floor(v)), 0, rows - 2);
    let s = u - f32(i0);
    let t = v - f32(j0);
    let wu = crWeights(s);
    let wv = crWeights(t);
    let du = crDerivative(s);
    let dv = crDerivative(t);
    var pos = vec2<f32>(0.0);
    var pu = vec2<f32>(0.0);
    var pv = vec2<f32>(0.0);
    for (var a = 0; a < 4; a++) {
      for (var c = 0; c < 4; c++) {
        let p = meshPos(b, i0 - 1 + a, j0 - 1 + c, cols, rows, motion, time, seed);
        pos += wu[a] * wv[c] * p;
        pu += du[a] * wv[c] * p;
        pv += wu[a] * dv[c] * p;
      }
    }
    let r = pos - goal;
    let det = pu.x * pv.y - pu.y * pv.x;
    if (abs(det) < 1e-9) { break; }
    var dstep = vec2<f32>(pv.y * r.x - pv.x * r.y, -pu.y * r.x + pu.x * r.y) / det;
    let len = length(dstep);
    if (len > 0.5) { dstep = dstep * (0.5 / len); }
    u = clamp(u - dstep.x, -0.5, f32(cols - 1) + 0.5);
    v = clamp(v - dstep.y, -0.5, f32(rows - 1) + 0.5);
    if (len < 1e-5) { break; }
  }
  u = clamp(u, 0.0, f32(cols - 1));
  v = clamp(v, 0.0, f32(rows - 1));
  let i0 = clamp(i32(floor(u)), 0, cols - 2);
  let j0 = clamp(i32(floor(v)), 0, rows - 2);
  let wu = crWeights(u - f32(i0));
  let wv = crWeights(v - f32(j0));
  var col = vec4<f32>(0.0);
  for (var a = 0; a < 4; a++) {
    for (var c = 0; c < 4; c++) {
      col += wu[a] * wv[c] * meshCol(b, i0 - 1 + a, j0 - 1 + c, cols, rows);
    }
  }
  return clamp(col, vec4<f32>(0.0), vec4<f32>(1.0));
}
`;
