import { meshGlsl, noiseGlsl } from "../shaders/glsl";

/**
 * GLSL ES 3.0 render-graph passes, the WebGL2 twins of `webgpu/effects.ts`.
 * Each pass draws one fullscreen triangle into a texture of `u_outSize`
 * texels. Textures are addressed top-down (row 0 is the top of the
 * rectangle); `topDown` converts to GL's bottom-up rows.
 */

export const fullscreenVertex = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}
`;

const head = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D u_src;
uniform ivec2 u_srcSize;
uniform ivec2 u_outSize;
out vec4 o_color;
ivec2 topDown(ivec2 p, ivec2 size) { return ivec2(p.x, size.y - 1 - p.y); }
ivec2 outPos() { return ivec2(int(gl_FragCoord.x), u_outSize.y - 1 - int(gl_FragCoord.y)); }
vec4 loadSrc(ivec2 p) { return texelFetch(u_src, topDown(p, u_srcSize), 0); }
`;

export const downsampleFragment = /* glsl */ `${head}
uniform int u_mirror;
vec4 load(ivec2 p) {
  if (any(greaterThanEqual(p, u_srcSize))) {
    if (u_mirror == 0) return vec4(0.0);
    return loadSrc(min(p, u_srcSize - 1));
  }
  return loadSrc(p);
}
void main() {
  ivec2 i = outPos() * 2;
  o_color = (load(i) + load(i + ivec2(1, 0)) + load(i + ivec2(0, 1)) + load(i + ivec2(1, 1))) * 0.25;
}
`;

export const blurFragment = /* glsl */ `${head}
uniform ivec2 u_dir;
uniform float u_sigma;
uniform int u_radius;
uniform int u_mirror;
vec4 load(ivec2 p) {
  ivec2 q = p;
  if (u_mirror != 0) {
    ivec2 n = u_srcSize;
    q = ivec2(q.x < 0 ? -q.x - 1 : q.x, q.y < 0 ? -q.y - 1 : q.y);
    q = ivec2(q.x >= n.x ? 2 * n.x - q.x - 1 : q.x, q.y >= n.y ? 2 * n.y - q.y - 1 : q.y);
    q = clamp(q, ivec2(0), n - 1);
  } else if (any(lessThan(q, ivec2(0))) || any(greaterThanEqual(q, u_srcSize))) {
    return vec4(0.0);
  }
  return loadSrc(q);
}
void main() {
  ivec2 p = outPos();
  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  float k = -0.5 / (u_sigma * u_sigma);
  for (int i = -64; i <= 64; i++) {
    if (i < -u_radius || i > u_radius) continue;
    float w = exp(float(i * i) * k);
    sum += w * load(p + u_dir * i);
    wsum += w;
  }
  o_color = sum / wsum;
}
`;

export const upsampleFragment = /* glsl */ `${head}
uniform int u_mirror;
vec4 load(ivec2 p) {
  if (any(lessThan(p, ivec2(0))) || any(greaterThanEqual(p, u_srcSize))) {
    if (u_mirror == 0) return vec4(0.0);
    return loadSrc(clamp(p, ivec2(0), u_srcSize - 1));
  }
  return loadSrc(p);
}
void main() {
  vec2 t = (vec2(outPos()) + 0.5) * 0.5 - 0.5;
  vec2 i = floor(t);
  vec2 f = t - i;
  ivec2 b = ivec2(i);
  o_color = mix(mix(load(b), load(b + ivec2(1, 0)), f.x), mix(load(b + ivec2(0, 1)), load(b + ivec2(1, 1)), f.x), f.y);
}
`;

export const morphFragment = /* glsl */ `${head}
uniform float u_radius;
uniform int u_stride;
float load(ivec2 p) {
  if (any(lessThan(p, ivec2(0))) || any(greaterThanEqual(p, u_srcSize))) return 0.0;
  return loadSrc(p).a;
}
void main() {
  ivec2 p = outPos();
  float r = abs(u_radius);
  int reach = int(ceil(r + 0.5));
  bool dilate = u_radius > 0.0;
  float v = dilate ? 0.0 : 1.0;
  for (int dy = -64; dy <= 64; dy++) {
    if (dy < -reach || dy > reach || ((dy + reach) % u_stride) != 0) continue;
    for (int dx = -64; dx <= 64; dx++) {
      if (dx < -reach || dx > reach || ((dx + reach) % u_stride) != 0) continue;
      float w = clamp(r + 0.5 - length(vec2(float(dx), float(dy))), 0.0, 1.0);
      if (w <= 0.0) continue;
      float a = load(p + ivec2(dx, dy));
      if (dilate) v = max(v, a * w); else v = min(v, 1.0 - (1.0 - a) * w);
    }
  }
  o_color = vec4(v);
}
`;

/** u_src is the blurred shape B, u_shape the node's shape S (see ShadowNode). */
export const shadowFragment = /* glsl */ `${head}
uniform highp sampler2D u_shape;
uniform ivec2 u_shapeSize;
uniform ivec2 u_outOrigin;
uniform ivec2 u_srcOrigin;
uniform ivec2 u_shapeOrigin;
uniform vec2 u_offset;
uniform int u_mode;
uniform int u_hasShape;
uniform vec4 u_color;
float loadB(ivec2 p) {
  if (any(lessThan(p, ivec2(0))) || any(greaterThanEqual(p, u_srcSize))) return 0.0;
  return loadSrc(p).a;
}
void main() {
  ivec2 o = outPos();
  vec2 frame = vec2(u_outOrigin + o) + 0.5;
  vec2 t = frame - u_offset - vec2(u_srcOrigin) - 0.5;
  vec2 i = floor(t);
  vec2 f = t - i;
  ivec2 b = ivec2(i);
  float bv = mix(mix(loadB(b), loadB(b + ivec2(1, 0)), f.x), mix(loadB(b + ivec2(0, 1)), loadB(b + ivec2(1, 1)), f.x), f.y);
  float s = 0.0;
  if (u_hasShape != 0) {
    ivec2 sp = u_outOrigin + o - u_shapeOrigin;
    if (all(greaterThanEqual(sp, ivec2(0))) && all(lessThan(sp, u_shapeSize))) s = texelFetch(u_shape, topDown(sp, u_shapeSize), 0).a;
  }
  float a;
  if (u_mode == 1) a = s * (1.0 - bv);
  else if (u_hasShape != 0) a = bv * (1.0 - s);
  else a = bv;
  o_color = u_color * a;
}
`;

export const backdropFragment = /* glsl */ `${head}
uniform highp sampler2D u_shape;
uniform ivec2 u_shapeSize;
uniform ivec2 u_outOrigin;
uniform ivec2 u_srcOrigin;
uniform ivec2 u_shapeOrigin;
void main() {
  ivec2 f = u_outOrigin + outPos();
  ivec2 bp = clamp(f - u_srcOrigin, ivec2(0), u_srcSize - 1);
  ivec2 sp = f - u_shapeOrigin;
  float s = 0.0;
  if (all(greaterThanEqual(sp, ivec2(0))) && all(lessThan(sp, u_shapeSize))) s = texelFetch(u_shape, topDown(sp, u_shapeSize), 0).a;
  o_color = loadSrc(bp) * s;
}
`;

/** Copy (into an RGBA8 output texture: the same quantization as the WebGPU effect atlas). */
export const copyFragment = /* glsl */ `${head}
void main() {
  o_color = clamp(loadSrc(outPos()), vec4(0.0), vec4(1.0));
}
`;

export const meshFragment = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D u_stops;
uniform ivec2 u_outSize;
uniform int u_base;
uniform float u_time;
uniform uint u_seed;
out vec4 o_color;
vec4 P(int b, int i) {
  int k = b + i;
  return texelFetch(u_stops, ivec2(k % 1024, k / 1024), 0);
}
${noiseGlsl}
${meshGlsl}
void main() {
  ivec2 p = ivec2(int(gl_FragCoord.x), u_outSize.y - 1 - int(gl_FragCoord.y));
  vec2 goal = (vec2(p) + 0.5) / vec2(u_outSize);
  vec4 c = meshColor(u_base, goal, u_time, u_seed);
  o_color = vec4(c.rgb * c.a, c.a);
}
`;
