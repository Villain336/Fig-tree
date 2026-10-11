/**
 * GLSL ES 3.0 for the WebGL2 fallback. Per-frame entry data and persistent
 * paint data live in RGBA32F textures read with texelFetch, so batches of
 * draws need no per-draw uniform updates.
 *
 * Entry texels (4 per entry): matrix (a, b, c, d) | (e, f, opacity, paint) |
 * cover rect in device px | (kind, -, -, -).
 */

const fetchEntry = /* glsl */ `
uniform highp sampler2D u_entries;
vec4 entryTexel(int id, int k) {
  int i = id * 4 + k;
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

export const coverFragmentShader = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
flat in int v_id;
uniform vec2 u_viewport;
uniform highp sampler2D u_paints;
uniform highp sampler2D u_stops;
uniform highp sampler2D u_layer;
out vec4 o_color;
${fetchEntry}
vec4 paintTexel(int paint, int k) {
  int i = paint * 4 + k;
  return texelFetch(u_paints, ivec2(i % 1024, i / 1024), 0);
}
vec4 stopTexel(int stop, int k) {
  int i = stop * 2 + k;
  return texelFetch(u_stops, ivec2(i % 1024, i / 1024), 0);
}
void main() {
  vec4 t = entryTexel(v_id, 1);
  float opacity = t.z;
  if (entryTexel(v_id, 3).x > 0.5) {
    // Composite a finished layer onto its parent.
    o_color = texelFetch(u_layer, ivec2(gl_FragCoord.xy), 0) * opacity;
    return;
  }
  int paint = int(t.w);
  vec4 header = paintTexel(paint, 0);
  int kind = int(header.x);
  if (kind == 0) {
    o_color = paintTexel(paint, 1) * opacity;
    return;
  }
  vec4 m = entryTexel(v_id, 0);
  vec2 pos = vec2(gl_FragCoord.x, u_viewport.y - gl_FragCoord.y);
  vec2 q = pos - t.xy;
  float det = m.x * m.w - m.y * m.z;
  vec2 lp = vec2(m.w * q.x - m.z * q.y, -m.y * q.x + m.x * q.y) / det;
  vec4 gm = paintTexel(paint, 2);
  vec4 gt = paintTexel(paint, 3);
  vec2 g = vec2(gm.x * lp.x + gm.z * lp.y + gt.x, gm.y * lp.x + gm.w * lp.y + gt.y);
  float u = clamp(kind == 1 ? g.x : length(g), 0.0, 1.0);
  int base = int(header.y);
  int count = int(header.z);
  int i = 0;
  for (int k = 0; k < 4096; k++) {
    if (i + 1 >= count || stopTexel(base + i + 1, 0).x >= u) break;
    i++;
  }
  int j = min(i + 1, count - 1);
  float o0 = stopTexel(base + i, 0).x;
  float o1 = stopTexel(base + j, 0).x;
  float s = o1 > o0 ? clamp((u - o0) / (o1 - o0), 0.0, 1.0) : (u >= o1 ? 1.0 : 0.0);
  vec4 c = mix(stopTexel(base + i, 1), stopTexel(base + j, 1), s);
  o_color = vec4(c.rgb * c.a, c.a) * opacity;
}
`;
