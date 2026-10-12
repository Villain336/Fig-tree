import { imageGlsl, meshGlsl, noiseGlsl, packShader, shaderLibGlsl, type RenderImage } from "@fig-tree/renderer";
import { imagePlacement, toRenderPaint } from "./bridge/paints";
import type { ShaderPaint } from "./schema";

/**
 * Code export of a shader paint: shaders have no CSS form, so a shader fill
 * exports as a self-contained WebGL2 program that draws exactly what the
 * editor draws (the same GLSL the renderer's WebGL2 backend runs, and the
 * same packed parameters), as an HTML snippet and as a React component.
 * Fluted glass reads the backdrop: exported, it refracts an image passed as
 * `backdrop`. Image tone sources read the image at `image`.
 */
export interface ShaderExport {
  /** GLSL ES 3.0 fragment shader. */
  readonly fragment: string;
  /** Packed parameters (vec4s), as the shader's `u_params` reads them. */
  readonly params: readonly number[];
  /** A standalone HTML document drawing the paint into a canvas. */
  readonly html: string;
  /** A React component (TSX) drawing the paint into a canvas. */
  readonly react: string;
}

export interface ShaderExportOptions {
  /** The image an `image` tone source reads (URL and natural size). */
  readonly image?: { readonly url: string; readonly width: number; readonly height: number };
  /** Fluted glass: the image seen through the glass. */
  readonly backdrop?: string;
  /** Component name (React). Default `ShaderFill`. */
  readonly name?: string;
}

const MAX_PARAMS = 96;

export function exportShaderPaint(paint: ShaderPaint, width: number, height: number, options: ShaderExportOptions = {}): ShaderExport {
  const img = options.image;
  // A stand-in for the bitmap: only its size matters for packing; the program loads the real one.
  const stand: RenderImage | null = img ? { key: img.url, width: img.width, height: img.height, data: new Uint8Array(img.width * img.height * 4) } : null;
  const r = toRenderPaint(paint, width, height, stand ? { get: () => stand } : null);
  if (!("paint" in r) || r.paint.type !== "shader") throw new Error(`shader paint cannot be exported: ${"unsupported" in r ? r.unsupported : "not a shader"}`);
  const packed = Array.from(packShader(r.paint));
  while (packed.length < 24) packed.push(0);
  if (stand && img) {
    const m = imagePlacement({ fit: "cover" }, img.width, img.height, width, height);
    // Local → image px (the inverse of the placement), then the image size.
    const det = m[0] * m[3] - m[1] * m[2];
    const inv = [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
    packed.length = 24;
    packed.push(...inv, img.width, img.height);
  }
  if (packed.length / 4 > MAX_PARAMS) throw new Error("shader parameters exceed the export limit");
  const fragment = fragmentSource(paint.shader === "mesh-gradient");
  const config = { params: packed, width, height, speed: paint.speed ?? 0, image: img?.url ?? null, backdrop: options.backdrop ?? null };
  return { fragment, params: packed, html: htmlSnippet(fragment, config), react: reactComponent(fragment, config, options.name ?? "ShaderFill") };
}

function fragmentSource(mesh: boolean): string {
  return `#version 300 es
precision highp float;
precision highp int;
uniform vec4 u_params[${MAX_PARAMS}];
uniform vec2 u_canvas;
uniform float u_time;
uniform highp sampler2D u_tex;
uniform highp sampler2D u_imageAtlas;
uniform vec2 u_texSize;
uniform vec2 u_imageSize;
uniform int u_hasTex;
uniform int u_hasImage;
out vec4 o_color;
vec4 P(int b, int i) { return u_params[b + i]; }
ivec2 topDown(ivec2 p, ivec2 size) { return ivec2(p.x, size.y - 1 - p.y); }
vec2 texOrigin() { return vec2(0.0); }
vec2 texSize() { return u_texSize; }
${imageGlsl}
ImagePlace imagePlace() {
  ImagePlace p;
  p.atlas = ivec2(0);
  p.rectOrigin = ivec2(0);
  p.rectSize = ivec2(u_imageSize);
  p.levelSize = ivec2(u_imageSize);
  p.pixelsPerTexel = 1.0;
  return p;
}
${noiseGlsl}
${mesh ? meshGlsl : ""}
${shaderLibGlsl}
void main() {
  vec2 box = P(0, 1).xy;
  // Canvas pixels (top-down) to the paint's local units.
  vec2 pos = vec2(gl_FragCoord.x, u_canvas.y - gl_FragCoord.y);
  vec2 local = pos * box / u_canvas;
  float scale = u_canvas.x / box.x;
  vec4 c;
  ${mesh
    ? `vec4 h = P(0, 0);
  vec4 m = meshColor(0, local / box, h.z + u_time * h.w, uint(h.y));
  c = vec4(m.rgb * m.a, m.a) * P(0, 1).z;`
    : `c = shaderPaint(0, local, scale, u_hasTex != 0, u_hasImage != 0, pos);`}
  o_color = c;
}
`;
}

interface Config {
  params: number[];
  width: number;
  height: number;
  speed: number;
  image: string | null;
  backdrop: string | null;
}

/** The JavaScript that compiles the program and draws it (every frame when the paint animates). */
function runtime(fragment: string, c: Config): string {
  return `const FRAGMENT = ${JSON.stringify(fragment)};
const PARAMS = new Float32Array(${JSON.stringify(c.params)});
function drawShader(canvas, options = {}) {
  const gl = canvas.getContext("webgl2", { premultipliedAlpha: true });
  if (!gl) throw new Error("WebGL2 is not available");
  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, "#version 300 es\\nvoid main(){vec2 p=vec2(gl_VertexID==1?3.0:-1.0,gl_VertexID==2?3.0:-1.0);gl_Position=vec4(p,0.0,1.0);}"));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  gl.useProgram(program);
  const u = (n) => gl.getUniformLocation(program, n);
  gl.uniform4fv(u("u_params"), PARAMS);
  const textures = { tex: null, image: null };
  const load = (url, unit, name, sizeName, flag) => new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.uniform1i(u(name), unit);
      gl.uniform2f(u(sizeName), img.naturalWidth, img.naturalHeight);
      gl.uniform1i(u(flag), 1);
      resolve();
    };
    img.onerror = () => resolve();
    img.src = url;
  });
  const backdrop = options.backdrop ?? ${JSON.stringify(c.backdrop)};
  const image = options.image ?? ${JSON.stringify(c.image)};
  let frame = 0;
  const start = performance.now();
  const draw = () => {
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(u("u_canvas"), canvas.width, canvas.height);
    gl.uniform1f(u("u_time"), options.time ?? (performance.now() - start) / 1000);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (${c.speed !== 0} && options.time === undefined) frame = requestAnimationFrame(draw);
  };
  Promise.all([backdrop && load(backdrop, 0, "u_tex", "u_texSize", "u_hasTex"), image && load(image, 1, "u_imageAtlas", "u_imageSize", "u_hasImage")]).then(draw);
  return () => cancelAnimationFrame(frame);
}`;
}

function htmlSnippet(fragment: string, c: Config): string {
  return `<canvas id="shader-fill" width="${Math.round(c.width)}" height="${Math.round(c.height)}" style="width:${c.width}px;height:${c.height}px"></canvas>
<script>
${runtime(fragment, c)}
drawShader(document.getElementById("shader-fill"));
</script>
`;
}

function reactComponent(fragment: string, c: Config, name: string): string {
  return `import { useEffect, useRef } from "react";

${runtime(fragment, c)}

export function ${name}({ width = ${c.width}, height = ${c.height}, time, backdrop, image }: { width?: number; height?: number; time?: number; backdrop?: string; image?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => (ref.current ? drawShader(ref.current, { time, backdrop, image }) : undefined), [time, backdrop, image]);
  return <canvas ref={ref} width={width} height={height} style={{ width, height }} />;
}
`;
}
