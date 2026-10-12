import { blendGlsl, imageGlsl, noiseGlsl, shaderLibGlsl } from "../shaders/glsl";

/**
 * GLSL ES 3.0 for the WebGL2 fallback. Per-frame entry data and persistent
 * paint data live in RGBA32F textures read with texelFetch, so batches of
 * draws need no per-draw uniform updates.
 *
 * Entry texels (8 per entry): matrix (a, b, c, d) | (e, f, opacity, paint) |
 * cover rect in device px | (mode, blend, mask type, flags) | texture
 * (origin x, y, width, height) | image (atlas x, y, rect x, y) | image
 * (rect width, height, level width, height) | (pixels per texel, -, -, -).
 */

const fetchEntry = /* glsl */ `
uniform highp sampler2D u_entries;
vec4 entryTexel(int id, int k) {
  int i = id * 8 + k;
  return texelFetch(u_entries, ivec2(i % 1024, i / 1024), 0);
}
`;

/** Stencil pass: triangles fanned from an anchor point, in local coordinates. */
export function stencilVertexShader(multiDraw: boolean): string {
  return /* glsl */ `#version 300 es
${multiDraw ? "#extension GL_ANGLE_multi_draw : require" : ""}
precision highp float;
layout(location = 0) in vec2 a_pos;
uniform int u_entryBase;
uniform vec2 u_viewport;
${fetchEntry}
void main() {
  int id = u_entryBase${multiDraw ? " + gl_DrawID" : ""};
  vec4 m = entryTexel(id, 0);
  vec4 t = entryTexel(id, 1);
  vec2 p = vec2(m.x * a_pos.x + m.z * a_pos.y + t.x, m.y * a_pos.x + m.w * a_pos.y + t.y);
  gl_Position = vec4(p.x / u_viewport.x * 2.0 - 1.0, 1.0 - p.y / u_viewport.y * 2.0, 0.0, 1.0);
}
`;
}

export const stencilFragmentShader = /* glsl */ `#version 300 es
precision mediump float;
out vec4 o_color;
void main() { o_color = vec4(0.0); }
`;

/** Cover pass: one instanced quad per entry over its device-space bounds. */
export const coverVertexShader = /* glsl */ `#version 300 es
precision highp float;
uniform int u_entryBase;
uniform vec2 u_viewport;
flat out int v_id;
${fetchEntry}
void main() {
  int id = u_entryBase + gl_InstanceID;
  vec4 r = entryTexel(id, 2);
  int corner = gl_VertexID % 6;
  vec2 uv = vec2(corner == 1 || corner == 2 || corner == 4 ? 1.0 : 0.0, corner == 2 || corner == 4 || corner == 5 ? 1.0 : 0.0);
  vec2 p = mix(r.xy, r.zw, uv);
  v_id = id;
  gl_Position = vec4(p.x / u_viewport.x * 2.0 - 1.0, 1.0 - p.y / u_viewport.y * 2.0, 0.0, 1.0);
}
`;

/**
 * Paint evaluation shared by the cover and glyph passes: the premultiplied
 * paint color of entry `v_id` at the fragment (twin of the WGSL composite's
 * paintColor).
 */
const paintFunctions = /* glsl */ `
uniform highp sampler2D u_paints;
uniform highp sampler2D u_stops;
uniform highp sampler2D u_imageAtlas;
uniform highp sampler2D u_tex;
uniform float u_time;
flat in int v_id;
vec4 paintTexel(int paint, int k) {
  int i = paint * 4 + k;
  return texelFetch(u_paints, ivec2(i % 1024, i / 1024), 0);
}
vec4 stopTexel(int stop, int k) {
  int i = stop * 2 + k;
  return texelFetch(u_stops, ivec2(i % 1024, i / 1024), 0);
}
vec4 P(int b, int i) {
  int k = b + i;
  return texelFetch(u_stops, ivec2(k % 1024, k / 1024), 0);
}
ivec2 topDown(ivec2 p, ivec2 size) { return ivec2(p.x, size.y - 1 - p.y); }
vec2 texOrigin() { return entryTexel(v_id, 4).xy; }
vec2 texSize() { return entryTexel(v_id, 4).zw; }
${imageGlsl}
ImagePlace imagePlace() {
  vec4 a = entryTexel(v_id, 5);
  vec4 b = entryTexel(v_id, 6);
  ImagePlace p;
  p.atlas = ivec2(a.xy);
  p.rectOrigin = ivec2(a.zw);
  p.rectSize = ivec2(b.xy);
  p.levelSize = ivec2(b.zw);
  p.pixelsPerTexel = entryTexel(v_id, 7).x;
  return p;
}
${noiseGlsl}
${shaderLibGlsl}
vec4 gradientStops(int base, int count, float u) {
  int i = 0;
  for (int k = 0; k < 4096; k++) {
    if (i + 1 >= count || stopTexel(base + i + 1, 0).x >= u) break;
    i++;
  }
  int j = min(i + 1, count - 1);
  float o0 = stopTexel(base + i, 0).x;
  float o1 = stopTexel(base + j, 0).x;
  float s = o1 > o0 ? clamp((u - o0) / (o1 - o0), 0.0, 1.0) : (u >= o1 ? 1.0 : 0.0);
  vec4 c0 = stopTexel(base + i, 1);
  vec4 c1 = stopTexel(base + j, 1);
  // Premultiplied interpolation, like CSS gradients.
  return mix(vec4(c0.rgb * c0.a, c0.a), vec4(c1.rgb * c1.a, c1.a), s);
}
vec4 rawPaint(int id) {
  vec4 t = entryTexel(id, 1);
  int paint = int(t.w);
  vec4 header = paintTexel(paint, 0);
  int kind = int(header.x);
  if (kind == 0) return paintTexel(paint, 1);
  vec4 m = entryTexel(id, 0);
  vec2 pos = vec2(gl_FragCoord.x, u_viewport.y - gl_FragCoord.y);
  vec2 q = pos - t.xy;
  float det = m.x * m.w - m.y * m.z;
  vec2 lp = vec2(m.w * q.x - m.z * q.y, -m.y * q.x + m.x * q.y) / det;
  vec4 gm = paintTexel(paint, 2);
  vec4 gt = paintTexel(paint, 3);
  vec2 g = vec2(gm.x * lp.x + gm.z * lp.y + gt.x, gm.y * lp.x + gm.w * lp.y + gt.y);
  int base = int(header.y);
  float flags = entryTexel(id, 3).w;
  bool hasTex = mod(flags, 2.0) >= 1.0;
  bool hasImage = mod(floor(flags / 2.0), 2.0) >= 1.0;
  if (kind == 5) {
    if (!hasImage) return vec4(0.0);
    int b = base * 2;
    vec4 info = P(b, 0);
    vec4 c = sampleImage(imagePlace(), g, info.xy, info.z > 0.5);
    vec4 a2 = P(b, 2);
    if (a2.w > 0.5 && c.a > 0.0) c = vec4(adjustImage(c.rgb / c.a, P(b, 1), a2) * c.a, c.a);
    return c * info.w;
  }
  if (kind == 6) return shaderPaint(base * 2, lp, sqrt(abs(det)), hasTex, hasImage, pos);
  float u;
  if (kind == 1) u = g.x;
  else if (kind == 2) u = length(g);
  else if (kind == 3) { u = atan(g.y, g.x) / 6.283185307; if (u < 0.0) u += 1.0; }
  else u = abs(g.x) + abs(g.y);
  return gradientStops(base, int(header.z), clamp(u, 0.0, 1.0));
}
vec4 paintColor(int id) {
  float flags = entryTexel(id, 3).w;
  if (mod(floor(flags / 4.0), 2.0) >= 1.0) {
    // Shape renders: solid and gradient paints count as opaque; images and shaders by their alpha.
    float paint = entryTexel(id, 1).w;
    if (paint < 0.0) return vec4(1.0);
    int kind = int(paintTexel(int(paint), 0).x);
    return vec4(kind >= 5 ? rawPaint(id).a : 1.0);
  }
  return rawPaint(id) * entryTexel(id, 1).z;
}
`;

export const coverFragmentShader = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform vec2 u_viewport;
uniform highp sampler2D u_layer;
uniform highp sampler2D u_backdrop;
uniform highp sampler2D u_mask;
out vec4 o_color;
${fetchEntry}
${paintFunctions}
${blendGlsl}
void main() {
  vec4 info = entryTexel(v_id, 3);
  int mode = int(info.x);
  if (mode == 0) {
    o_color = paintColor(v_id);
    return;
  }
  if (mode == 2) {
    // A texture entry: the effect texture at this pixel, transparent outside it.
    vec2 pos = vec2(gl_FragCoord.x, u_viewport.y - gl_FragCoord.y);
    ivec2 local = ivec2(floor(pos - texOrigin()));
    ivec2 size = ivec2(texSize());
    if (any(lessThan(local, ivec2(0))) || any(greaterThanEqual(local, size))) { o_color = vec4(0.0); return; }
    o_color = texelFetch(u_tex, topDown(local, size), 0) * entryTexel(v_id, 1).z;
    return;
  }
  // Layer composites (end entries): 1 src-over, 3 blend mode (blending off, backdrop read), 4 raw (non-isolated clip).
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 layer = texelFetch(u_layer, p, 0);
  if (mode == 4) { o_color = layer; return; }
  float scale = entryTexel(v_id, 1).z;
  if (info.z > 2.5) {
    // Mask group: multiply by the mask's value (type in info.z - 3: alpha, luminance).
    vec4 m = texelFetch(u_mask, p, 0);
    scale *= info.z > 3.5 ? dot(m.rgb, vec3(0.2125, 0.7154, 0.0721)) : m.a;
  }
  vec4 src = layer * scale;
  if (mode == 3) {
    o_color = blendPremul(int(info.y), src, texelFetch(u_backdrop, p, 0));
    return;
  }
  o_color = src;
}
`;

/** Glyph pass: one instanced quad per glyph bitmap, at whole device pixels. */
export const glyphVertexShader = /* glsl */ `#version 300 es
precision highp float;
layout(location = 1) in vec4 a_rect;
layout(location = 2) in vec2 a_atlas;
layout(location = 3) in float a_entry;
uniform vec2 u_viewport;
flat out int v_id;
out vec2 v_atlas;
void main() {
  int corner = gl_VertexID % 6;
  vec2 uv = vec2(corner == 1 || corner == 2 || corner == 4 ? 1.0 : 0.0, corner == 2 || corner == 4 || corner == 5 ? 1.0 : 0.0);
  vec2 p = a_rect.xy + uv * a_rect.zw;
  v_id = int(a_entry);
  v_atlas = a_atlas + uv * a_rect.zw;
  gl_Position = vec4(p.x / u_viewport.x * 2.0 - 1.0, 1.0 - p.y / u_viewport.y * 2.0, 0.0, 1.0);
}
`;

export const glyphFragmentShader = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec2 v_atlas;
uniform vec2 u_viewport;
uniform highp sampler2D u_atlas;
out vec4 o_color;
${fetchEntry}
${paintFunctions}
void main() {
  float coverage = texelFetch(u_atlas, ivec2(v_atlas), 0).r;
  if (coverage <= 0.0) discard;
  o_color = paintColor(v_id) * coverage;
}
`;
