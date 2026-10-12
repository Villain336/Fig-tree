/**
 * GLSL ES 3.0 twins of `wgsl.ts`: the same blend modes, noise, image
 * sampling and shader fills, for the WebGL2 backend. Keep both files in
 * step; e2e `effects-render.spec.ts` compares the backends' pixels.
 *
 * The including shader declares `P(b, i)` (paint parameter vec4 i of a
 * paint whose parameters start at b), `u_imageAtlas`, `u_tex` (the
 * entry's sampled texture: backdrop or mesh lookup), `u_time` and the
 * entry's placements (`imagePlace()`, `texOrigin()`, `texSize()`).
 */

export const blendGlsl = /* glsl */ `
float blendLum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }

vec3 clipColor(vec3 c) {
  float l = blendLum(c);
  float n = min(min(c.r, c.g), c.b);
  float x = max(max(c.r, c.g), c.b);
  vec3 r = c;
  if (n < 0.0) r = l + (r - l) * l / (l - n);
  if (x > 1.0) r = l + (r - l) * (1.0 - l) / (x - l);
  return r;
}

vec3 setLum(vec3 c, float l) { return clipColor(c + (l - blendLum(c))); }

float blendSat(vec3 c) { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }

vec3 setSat(vec3 c, float s) {
  float mx = max(max(c.r, c.g), c.b);
  float mn = min(min(c.r, c.g), c.b);
  if (mx <= mn) return vec3(0.0);
  return (c - mn) * s / (mx - mn);
}

float softLightD(float cb) {
  if (cb <= 0.25) return ((16.0 * cb - 12.0) * cb + 4.0) * cb;
  return sqrt(cb);
}

float blendChannel(int mode, float cb, float cs) {
  if (mode == 1) return cb * cs;
  if (mode == 2) return cb + cs - cb * cs;
  if (mode == 3) {
    if (cb <= 0.5) return cs * 2.0 * cb;
    float t = 2.0 * cb - 1.0;
    return cs + t - cs * t;
  }
  if (mode == 4) return min(cb, cs);
  if (mode == 5) return max(cb, cs);
  if (mode == 6) {
    if (cb <= 0.0) return 0.0;
    if (cs >= 1.0) return 1.0;
    return min(1.0, cb / (1.0 - cs));
  }
  if (mode == 7) {
    if (cb >= 1.0) return 1.0;
    if (cs <= 0.0) return 0.0;
    return 1.0 - min(1.0, (1.0 - cb) / cs);
  }
  if (mode == 8) {
    if (cs <= 0.5) return cb * 2.0 * cs;
    float t = 2.0 * cs - 1.0;
    return cb + t - cb * t;
  }
  if (mode == 9) {
    if (cs <= 0.5) return cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb);
    return cb + (2.0 * cs - 1.0) * (softLightD(cb) - cb);
  }
  if (mode == 10) return abs(cb - cs);
  if (mode == 11) return cb + cs - 2.0 * cb * cs;
  return cs;
}

vec3 blendColor(int mode, vec3 cb, vec3 cs) {
  if (mode == 12) return setLum(setSat(cs, blendSat(cb)), blendLum(cb));
  if (mode == 13) return setLum(setSat(cb, blendSat(cs)), blendLum(cb));
  if (mode == 14) return setLum(cs, blendLum(cb));
  if (mode == 15) return setLum(cb, blendLum(cs));
  return vec3(blendChannel(mode, cb.r, cs.r), blendChannel(mode, cb.g, cs.g), blendChannel(mode, cb.b, cs.b));
}

vec4 blendPremul(int mode, vec4 src, vec4 dst) {
  if (mode == 0) return src + dst * (1.0 - src.a);
  if (mode == 17) return min(src + dst, vec4(1.0));
  if (mode == 16) {
    float a = min(1.0, src.a + dst.a);
    return vec4(max(vec3(0.0), vec3(a) - ((vec3(src.a) - src.rgb) + (vec3(dst.a) - dst.rgb))), a);
  }
  if (src.a <= 0.0) return dst;
  vec3 cs = clamp(src.rgb / src.a, vec3(0.0), vec3(1.0));
  vec3 cb = vec3(0.0);
  if (dst.a > 0.0) cb = clamp(dst.rgb / dst.a, vec3(0.0), vec3(1.0));
  vec3 b = clamp(blendColor(mode, cb, cs), vec3(0.0), vec3(1.0));
  return vec4(src.rgb * (1.0 - dst.a) + dst.rgb * (1.0 - src.a) + src.a * dst.a * b, src.a + dst.a * (1.0 - src.a));
}
`;

export const noiseGlsl = /* glsl */ `
uint hashU(uint x) {
  uint v = x * 747796405u + 2891336453u;
  uint w = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u;
  return (w >> 22u) ^ w;
}

float hash2(int ix, int iy, uint seed) {
  uint h = hashU(uint(ix) ^ hashU(uint(iy) ^ hashU(seed)));
  return float(h >> 8u) / 16777216.0;
}

float valueNoise(vec2 p, uint seed) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  int x = int(i.x);
  int y = int(i.y);
  float a = hash2(x, y, seed);
  float b = hash2(x + 1, y, seed);
  float c = hash2(x, y + 1, seed);
  float d = hash2(x + 1, y + 1, seed);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float simplexCorner(vec2 d, vec2 c, uint seed) {
  float t = 0.5 - dot(d, d);
  if (t <= 0.0) return 0.0;
  float a = hash2(int(c.x), int(c.y), seed) * 6.283185307;
  float t2 = t * t;
  return t2 * t2 * dot(vec2(cos(a), sin(a)), d);
}

float simplex(vec2 p, uint seed) {
  const float F2 = 0.3660254038;
  const float G2 = 0.2113248654;
  vec2 i = floor(p + (p.x + p.y) * F2);
  vec2 x0 = p - (i - (i.x + i.y) * G2);
  vec2 o = x0.x > x0.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec2 x1 = x0 - o + G2;
  vec2 x2 = x0 - 1.0 + 2.0 * G2;
  return 70.0 * (simplexCorner(x0, i, seed) + simplexCorner(x1, i + o, seed) + simplexCorner(x2, i + 1.0, seed));
}

float fbm(vec2 p, int octaves, uint seed) {
  float sum = 0.0;
  float amp = 0.5;
  vec2 q = p;
  float norm = 0.0;
  for (int k = 0; k < 6; k++) {
    if (k >= octaves) break;
    sum += amp * simplex(q, seed + uint(k) * 101u);
    norm += amp;
    q = q * 2.03 + vec2(17.3, 9.1);
    amp *= 0.5;
  }
  return sum / norm;
}
`;

export const imageGlsl = /* glsl */ `
struct ImagePlace {
  ivec2 atlas;
  ivec2 rectOrigin;
  ivec2 rectSize;
  ivec2 levelSize;
  float pixelsPerTexel;
};

vec4 imageTexel(ImagePlace p, ivec2 t, bool repeat) {
  ivec2 q = t;
  if (repeat) {
    q = ((q % p.levelSize) + p.levelSize) % p.levelSize;
  } else {
    q = clamp(q, ivec2(0), p.levelSize - 1);
  }
  ivec2 local = clamp(q - p.rectOrigin, ivec2(0), p.rectSize - 1);
  return texelFetch(u_imageAtlas, p.atlas + local, 0);
}

vec4 sampleImage(ImagePlace p, vec2 u, vec2 wh, bool repeat) {
  vec2 t = u * vec2(p.levelSize) / wh - 0.5;
  vec2 i = floor(t);
  vec2 f = t - i;
  ivec2 b = ivec2(i);
  vec4 c = mix(mix(imageTexel(p, b, repeat), imageTexel(p, b + ivec2(1, 0), repeat), f.x),
               mix(imageTexel(p, b + ivec2(0, 1), repeat), imageTexel(p, b + ivec2(1, 1), repeat), f.x), f.y);
  if (repeat) return c;
  vec2 inside = min(u, wh - u) * p.pixelsPerTexel;
  vec2 cov = clamp(0.5 + inside, vec2(0.0), vec2(1.0));
  return c * cov.x * cov.y;
}

vec3 adjustImage(vec3 c, vec4 a1, vec4 a2) {
  vec3 r = c * exp2(a1.x);
  r = (r - 0.5) * (1.0 + a1.y) + 0.5;
  float s = 1.0 + a1.z;
  float l = dot(r, vec3(0.2126, 0.7152, 0.0722));
  r = mix(vec3(l), r, s);
  r = r * vec3(1.0 + 0.2 * a1.w + 0.1 * a2.x, 1.0 - 0.2 * a2.x, 1.0 - 0.2 * a1.w + 0.1 * a2.x);
  r = clamp(r, vec3(0.0), vec3(1.0));
  float l2 = dot(r, vec3(0.2126, 0.7152, 0.0722));
  float hi = smoothstep(0.5, 1.0, l2);
  float lo = 1.0 - smoothstep(0.0, 0.5, l2);
  r = r + 0.25 * (a2.y * hi + a2.z * lo);
  return clamp(r, vec3(0.0), vec3(1.0));
}
`;

export const shaderLibGlsl = /* glsl */ `
vec4 premul(vec4 c) { return vec4(c.rgb * c.a, c.a); }

/** The entry's sampled texture (top-down texel coordinates t, bilinear, clamped). */
vec4 entryTexture(vec2 t) {
  ivec2 size = ivec2(texSize());
  vec2 q = t - 0.5;
  vec2 i = floor(q);
  vec2 f = q - i;
  ivec2 b = ivec2(i);
  ivec2 m = size - 1;
  vec4 c00 = texelFetch(u_tex, topDown(clamp(b, ivec2(0), m), size), 0);
  vec4 c10 = texelFetch(u_tex, topDown(clamp(b + ivec2(1, 0), ivec2(0), m), size), 0);
  vec4 c01 = texelFetch(u_tex, topDown(clamp(b + ivec2(0, 1), ivec2(0), m), size), 0);
  vec4 c11 = texelFetch(u_tex, topDown(clamp(b + ivec2(1, 1), ivec2(0), m), size), 0);
  return mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
}

mat2 rot(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat2(c, s, -s, c);
}

vec4 sampleShaderImage(int b, vec2 px) {
  vec4 m = P(b, 6);
  vec4 mt = P(b, 7);
  vec2 u = vec2(m.x * px.x + m.z * px.y + mt.x, m.y * px.x + m.w * px.y + mt.y);
  return sampleImage(imagePlace(), u, mt.zw, false);
}

float tone(float source, float angle, vec2 uv, vec2 px, uint seed, float contrast, bool hasImage, int b) {
  float t = 0.0;
  if (source < 0.5) {
    float a = radians(angle);
    vec2 d = vec2(cos(a), sin(a));
    t = dot(uv - 0.5, d) / (abs(d.x) + abs(d.y)) + 0.5;
  } else if (source < 1.5) {
    t = 1.0 - length(uv - 0.5) * 2.0;
  } else if (source < 2.5) {
    t = fbm(uv * 3.0, 4, seed) * 0.5 + 0.5;
  } else if (hasImage) {
    vec4 im = sampleShaderImage(b, px);
    vec3 c = im.a > 0.0 ? im.rgb / im.a : vec3(1.0);
    t = 1.0 - dot(mix(vec3(1.0), c, im.a), vec3(0.2126, 0.7152, 0.0722));
  }
  t = (t - 0.5) * (1.0 + contrast) + 0.5;
  return clamp(t, 0.0, 1.0);
}

vec4 grainShader(int b, vec2 px, uint seed, float time) {
  vec4 back = P(b, 2);
  vec4 front = P(b, 3);
  vec4 g = P(b, 4);
  uint frame = uint(max(0.0, floor(time * 24.0)));
  float n = valueNoise(px / g.x, seed + frame * 7919u);
  float hard = 1.0 - g.z;
  float edge = 0.5 * hard + 0.02;
  float t = smoothstep(1.0 - g.y - edge, 1.0 - g.y + edge, n);
  return mix(premul(back), premul(front), t);
}

float halftoneScreen(vec2 px, float cell, float angle, float ink, bool lines, float scale) {
  vec2 q = rot(-radians(angle)) * px / cell;
  vec2 f = fract(q) - 0.5;
  float aa = 1.0 / (cell * scale);
  if (lines) {
    float h = ink * 0.5;
    return clamp((h - abs(f.y)) / aa + 0.5, 0.0, 1.0);
  }
  float r = sqrt(ink) * 0.7071;
  return clamp((r - length(f)) / aa + 0.5, 0.0, 1.0);
}

vec4 halftoneShader(int b, vec2 uv, vec2 px, float scale, uint seed, bool hasImage) {
  vec4 back = premul(P(b, 2));
  vec4 front = premul(P(b, 3));
  vec4 s = P(b, 4);
  vec4 src = P(b, 5);
  bool lines = s.x > 0.5;
  if (s.y < 0.5) {
    float t = tone(src.x, src.y, uv, px, seed, src.z, hasImage, b);
    float ink = halftoneScreen(px, s.z, s.w, t, lines, scale);
    return mix(back, front, ink);
  }
  vec3 rgb = vec3(1.0 - tone(src.x, src.y, uv, px, seed, src.z, hasImage, b));
  if (src.x > 2.5 && hasImage) {
    vec4 im = sampleShaderImage(b, px);
    rgb = mix(vec3(1.0), im.a > 0.0 ? im.rgb / im.a : vec3(1.0), im.a);
  }
  float k = 1.0 - max(max(rgb.r, rgb.g), rgb.b);
  float d = max(1.0 - k, 1e-4);
  vec3 cmy = (1.0 - rgb - k) / d;
  float c = halftoneScreen(px, s.z, s.w + 15.0, cmy.x, lines, scale);
  float m = halftoneScreen(px, s.z, s.w + 75.0, cmy.y, lines, scale);
  float y = halftoneScreen(px, s.z, s.w, cmy.z, lines, scale);
  float kk = halftoneScreen(px, s.z, s.w + 45.0, k, lines, scale);
  vec3 paper = back.rgb / max(back.a, 1e-4);
  vec3 ink = paper * (1.0 - c * vec3(1.0, 0.0, 0.0)) * (1.0 - m * vec3(0.0, 1.0, 0.0)) * (1.0 - y * vec3(0.0, 0.0, 1.0));
  ink = ink * (1.0 - kk);
  return vec4(ink * back.a, back.a);
}

vec4 flutedShader(int b, vec2 uv, vec2 px, float scale, bool hasTex, vec2 pos) {
  vec4 p = P(b, 2);
  vec4 tint = premul(P(b, 3));
  float a = radians(p.y);
  vec2 dir = vec2(cos(a), sin(a));
  float across = dot(px, dir) / p.x;
  float f = fract(across) - 0.5;
  float shift = -f * p.z * p.x * 1.6 * (1.0 - 4.0 * f * f);
  vec4 color = vec4(0.0);
  if (hasTex) {
    vec2 deviceShift = dir * shift * scale;
    vec2 t = pos + deviceShift - texOrigin();
    color = entryTexture(clamp(t, vec2(0.5), texSize() - 0.5));
  }
  float light = (0.5 - abs(f) * 2.0) * 0.6 + f * 0.8;
  vec3 shaded = clamp(color.rgb + vec3(light * p.w * 0.35) * color.a, vec3(0.0), vec3(color.a));
  vec4 glass = vec4(shaded, color.a);
  return tint + glass * (1.0 - tint.a);
}

vec4 liquidShader(int b, vec2 px, uint seed, float time) {
  vec4 s = P(b, 2);
  vec2 q = px / s.x;
  int octaves = int(s.z);
  float t = time * 0.15;
  vec2 w1 = vec2(fbm(q + vec2(0.0, t), octaves, seed), fbm(q + vec2(5.2, 1.3 - t), octaves, seed + 11u));
  vec2 w2 = vec2(fbm(q + s.y * 2.0 * w1 + vec2(1.7 + t, 9.2), octaves, seed + 23u), fbm(q + s.y * 2.0 * w1 + vec2(8.3, 2.8 + t), octaves, seed + 37u));
  float n = clamp(fbm(q + s.y * 2.0 * w2, octaves, seed + 51u) * 0.75 + 0.5, 0.0, 1.0);
  float count = max(2.0, s.w);
  float fi = n * (count - 1.0);
  int i = int(min(floor(fi), count - 2.0));
  vec4 c0 = premul(P(b, 3 + i));
  vec4 c1 = premul(P(b, 4 + i));
  return mix(c0, c1, smoothstep(0.0, 1.0, fi - float(i)));
}

float bayer(uint i, uint j, uint n) {
  uint v = 0u;
  uint size = 1u;
  uint x = i;
  uint y = j;
  for (int k = 0; k < 4; k++) {
    if (size >= n) break;
    uint xb = x & 1u;
    uint yb = y & 1u;
    v = v * 4u + (((xb ^ yb) << 1u) | yb);
    x = x >> 1u;
    y = y >> 1u;
    size = size * 2u;
  }
  return (float(v) + 0.5) / float(n * n);
}

vec4 ditherShader(int b, vec2 uv, vec2 px, uint seed, bool hasImage) {
  vec4 back = premul(P(b, 2));
  vec4 front = premul(P(b, 3));
  vec4 s = P(b, 4);
  vec4 s2 = P(b, 5);
  vec2 cell = floor(px / s.y);
  vec2 center = (cell + 0.5) * s.y;
  float t = tone(s.z, s.w, center / max(P(b, 1).xy, vec2(1e-4)), center, seed, s2.x, hasImage, b);
  ivec2 ci = ivec2(cell);
  float threshold = 0.5;
  if (s.x > 2.5) {
    threshold = hash2(ci.x, ci.y, seed);
  } else {
    uint n = s.x > 1.5 ? 8u : (s.x > 0.5 ? 4u : 2u);
    int m = int(n);
    threshold = bayer(uint(((ci.x % m) + m) % m), uint(((ci.y % m) + m) % m), n);
  }
  return t > threshold ? front : back;
}

vec4 meshShader(vec2 uv, bool hasTex) {
  if (!hasTex) return vec4(0.0);
  return entryTexture(clamp(uv, vec2(0.0), vec2(1.0)) * texSize());
}

vec4 shaderPaint(int b, vec2 local, float scale, bool hasTex, bool hasImage, vec2 pos) {
  vec4 h = P(b, 0);
  vec4 box = P(b, 1);
  int kind = int(h.x);
  uint seed = uint(h.y);
  float time = h.z + u_time * h.w;
  vec2 uv = local / box.xy;
  vec4 c = vec4(0.0);
  if (kind == 0) c = meshShader(uv, hasTex);
  else if (kind == 1) c = grainShader(b, local, seed, time);
  else if (kind == 2) c = halftoneShader(b, uv, local, scale, seed, hasImage);
  else if (kind == 3) c = flutedShader(b, uv, local, scale, hasTex, pos);
  else if (kind == 4) c = liquidShader(b, local, seed, time);
  else if (kind == 5) c = ditherShader(b, uv, local, seed, hasImage);
  return c * box.z;
}
`;

export const meshGlsl = /* glsl */ `
vec4 crWeights(float s) {
  float s2 = s * s;
  float s3 = s2 * s;
  return 0.5 * vec4(-s3 + 2.0 * s2 - s, 3.0 * s3 - 5.0 * s2 + 2.0, -3.0 * s3 + 4.0 * s2 + s, s3 - s2);
}

vec4 crDerivative(float s) {
  float s2 = s * s;
  return 0.5 * vec4(-3.0 * s2 + 4.0 * s - 1.0, 9.0 * s2 - 10.0 * s, -9.0 * s2 + 8.0 * s + 1.0, 3.0 * s2 - 2.0 * s);
}

vec2 meshRaw(int b, int i, int j, int cols, float motion, float time, uint seed) {
  vec2 p = P(b, 3 + 2 * (j * cols + i)).xy;
  if (motion != 0.0) {
    float f1 = 0.6 + 0.8 * hash2(i, j, seed + 1u);
    float f2 = 0.6 + 0.8 * hash2(i, j, seed + 2u);
    float ph = 6.283185307 * hash2(i, j, seed + 3u);
    p += motion * vec2(sin(time * f1 + ph), cos(time * f2 + ph * 1.3));
  }
  return p;
}

vec2 meshPos(int b, int i, int j, int cols, int rows, float motion, float time, uint seed) {
  int ci = clamp(i, 0, cols - 1);
  int cj = clamp(j, 0, rows - 1);
  vec2 p = meshRaw(b, ci, cj, cols, motion, time, seed);
  if (i != ci || j != cj) {
    int ni = clamp(ci - (i - ci), 0, cols - 1);
    int nj = clamp(cj - (j - cj), 0, rows - 1);
    p = 2.0 * p - meshRaw(b, ni, nj, cols, motion, time, seed);
  }
  return p;
}

vec4 meshCol(int b, int i, int j, int cols, int rows) {
  int ci = clamp(i, 0, cols - 1);
  int cj = clamp(j, 0, rows - 1);
  return P(b, 4 + 2 * (cj * cols + ci));
}

vec4 meshColor(int b, vec2 goal, float time, uint seed) {
  vec4 g = P(b, 2);
  int cols = int(g.x);
  int rows = int(g.y);
  float motion = g.z;
  float u = goal.x * float(cols - 1);
  float v = goal.y * float(rows - 1);
  for (int it = 0; it < 10; it++) {
    int i0 = clamp(int(floor(u)), 0, cols - 2);
    int j0 = clamp(int(floor(v)), 0, rows - 2);
    float s = u - float(i0);
    float t = v - float(j0);
    vec4 wu = crWeights(s);
    vec4 wv = crWeights(t);
    vec4 du = crDerivative(s);
    vec4 dv = crDerivative(t);
    vec2 pos = vec2(0.0);
    vec2 pu = vec2(0.0);
    vec2 pv = vec2(0.0);
    for (int a = 0; a < 4; a++) {
      for (int c = 0; c < 4; c++) {
        vec2 p = meshPos(b, i0 - 1 + a, j0 - 1 + c, cols, rows, motion, time, seed);
        pos += wu[a] * wv[c] * p;
        pu += du[a] * wv[c] * p;
        pv += wu[a] * dv[c] * p;
      }
    }
    vec2 r = pos - goal;
    float det = pu.x * pv.y - pu.y * pv.x;
    if (abs(det) < 1e-9) break;
    vec2 dstep = vec2(pv.y * r.x - pv.x * r.y, -pu.y * r.x + pu.x * r.y) / det;
    float len = length(dstep);
    if (len > 0.5) dstep = dstep * (0.5 / len);
    u = clamp(u - dstep.x, -0.5, float(cols - 1) + 0.5);
    v = clamp(v - dstep.y, -0.5, float(rows - 1) + 0.5);
    if (len < 1e-5) break;
  }
  u = clamp(u, 0.0, float(cols - 1));
  v = clamp(v, 0.0, float(rows - 1));
  int i0 = clamp(int(floor(u)), 0, cols - 2);
  int j0 = clamp(int(floor(v)), 0, rows - 2);
  vec4 wu = crWeights(u - float(i0));
  vec4 wv = crWeights(v - float(j0));
  vec4 col = vec4(0.0);
  for (int a = 0; a < 4; a++) {
    for (int c = 0; c < 4; c++) {
      col += wu[a] * wv[c] * meshCol(b, i0 - 1 + a, j0 - 1 + c, cols, rows);
    }
  }
  return clamp(col, vec4(0.0), vec4(1.0));
}
`;
