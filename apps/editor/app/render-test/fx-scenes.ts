import { Path, ellipsePath, multiply, rotation, roundedRectPath, translation } from "@fig-tree/geometry";
import { BLEND_MODES, hexColor, rgba, solid, type Paint, type RenderImage, type Scene, type ShaderPaint } from "@fig-tree/renderer";
import type { TestScene } from "./scenes";

/**
 * Effects, blend modes, masks, new paints and shader fills for the pixel
 * suite (e2e/effects-render.spec.ts). Every scene renders on both
 * backends; the suite compares them and against goldens.
 */

function rect(x0: number, y0: number, x1: number, y1: number): Path {
  return new Path().moveTo(x0, y0).lineTo(x1, y0).lineTo(x1, y1).lineTo(x0, y1).close();
}

/** Four vertical color bands and a gray ramp below: a backdrop that exercises every channel. */
function bands(scene: Scene, w: number, h: number): void {
  const colors = ["#e53935", "#43a047", "#1e88e5", "#fdd835"];
  colors.forEach((c, i) => scene.root.appendChild(scene.createNode({ path: rect((i * w) / 4, 0, ((i + 1) * w) / 4, h * 0.7), fill: solid(hexColor(c)) })));
  scene.root.appendChild(scene.createNode({
    path: rect(0, h * 0.7, w, h),
    fill: { type: "linear-gradient", start: { x: 0, y: 0 }, end: { x: w, y: 0 }, stops: [{ offset: 0, color: rgba(0, 0, 0, 1) }, { offset: 1, color: rgba(1, 1, 1, 1) }] },
  }));
}

/** A small generated RGBA image (premultiplied): a 2x2 checker of colors with a translucent corner. */
export function testImage(): RenderImage {
  const w = 16;
  const h = 12;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const left = x < w / 2;
      const top = y < h / 2;
      const c = top ? (left ? [230, 57, 53] : [67, 160, 71]) : left ? [30, 136, 229] : [253, 216, 53];
      const a = !top && !left ? 128 : 255;
      data.set([Math.round((c[0]! * a) / 255), Math.round((c[1]! * a) / 255), Math.round((c[2]! * a) / 255), a], i);
    }
  }
  return { key: "test-checker", width: w, height: h, data };
}

const size = { width: 96, height: 72 };

export function shaderPaints(): ShaderPaint[] {
  const c = (hex: string) => hexColor(hex);
  return [
    {
      type: "shader", shader: "mesh-gradient", size, seed: 3,
      params: {
        columns: 3, rows: 3,
        points: [
          { x: 0, y: 0, color: c("#ff5f6d") }, { x: 0.5, y: 0, color: c("#ffc371") }, { x: 1, y: 0, color: c("#47cacc") },
          { x: 0, y: 0.5, color: c("#5b247a") }, { x: 0.6, y: 0.4, color: c("#ffffff") }, { x: 1, y: 0.5, color: c("#1bcedf") },
          { x: 0, y: 1, color: c("#2d3436") }, { x: 0.5, y: 1, color: c("#e84393") }, { x: 1, y: 1, color: c("#fdcb6e") },
        ],
      },
    },
    { type: "shader", shader: "grain", size, seed: 7, params: { colorBack: c("#f1e3c8"), colorFront: c("#3b2f2f"), size: 1.5, density: 0.35, softness: 0.3 } },
    { type: "shader", shader: "halftone", size, seed: 1, params: { style: "dots", cmyk: false, colorBack: c("#ffffff"), colorFront: c("#14213d"), cellSize: 8, angle: 45, source: "radial", contrast: 0.2 } },
    { type: "shader", shader: "fluted-glass", size, seed: 0, params: { fluteWidth: 12, angle: 0, distortion: 0.6, shading: 0.5, frost: 2, tint: rgba(1, 1, 1, 0.1) } },
    { type: "shader", shader: "liquid", size, seed: 11, params: { colors: [c("#0f2027"), c("#2c5364"), c("#00d2ff"), c("#f8f8f8")], scale: 40, warp: 1, detail: 4 } },
    { type: "shader", shader: "dithering", size, seed: 5, params: { pattern: "bayer4", pixelSize: 3, colorBack: c("#1d3557"), colorFront: c("#f1faee"), source: "linear", sourceAngle: 30 } },
  ];
}

export const fxScenes: Record<string, TestScene> = {
  // Every blend mode: a translucent-edged disc over the color bands.
  "fx-blend": {
    width: 288,
    height: 216,
    build(scene) {
      bands(scene, 288, 216);
      BLEND_MODES.slice(1).forEach((mode, i) => {
        const x = 12 + (i % 6) * 46;
        const y = 12 + Math.floor(i / 6) * 66;
        scene.root.appendChild(scene.createNode({
          path: ellipsePath(x + 20, y + 26, 20, 26),
          fill: { type: "linear-gradient", start: { x, y: 0 }, end: { x: x + 40, y: 0 }, stops: [{ offset: 0, color: rgba(1, 0.4, 0.8, 1) }, { offset: 1, color: rgba(0.2, 0.9, 0.7, 0.6) }] },
          blendMode: mode,
        }));
      });
    },
  },
  // Isolation: a group of two blended discs, pass-through vs isolated, and inside a clipping frame.
  "fx-isolation": {
    width: 240,
    height: 100,
    build(scene) {
      bands(scene, 240, 100);
      for (const [i, isolate] of [[0, false], [1, true]] as const) {
        const g = scene.createNode({ isolate });
        g.appendChild(scene.createNode({ path: ellipsePath(30 + i * 80, 40, 24, 24), fill: solid(hexColor("#ff9800")), blendMode: "multiply" }));
        g.appendChild(scene.createNode({ path: ellipsePath(50 + i * 80, 50, 24, 24), fill: solid(hexColor("#9c27b0")), blendMode: "screen" }));
        scene.root.appendChild(g);
      }
      const frame = scene.createNode({ path: roundedRectPath(170, 10, 60, 80, 12), fill: solid(rgba(1, 1, 1, 0.5)), clipsContent: true });
      frame.appendChild(scene.createNode({ path: ellipsePath(200, 50, 40, 30), fill: solid(hexColor("#00bcd4")), blendMode: "difference" }));
      scene.root.appendChild(frame);
    },
  },
  "fx-shadows": {
    width: 320,
    height: 160,
    build(scene) {
      scene.root.appendChild(scene.createNode({ path: rect(0, 0, 320, 160), fill: solid(hexColor("#eceff1")) }));
      scene.root.appendChild(scene.createNode({
        path: roundedRectPath(20, 20, 80, 60, 10), fill: solid(hexColor("#ffffff")),
        effects: [{ type: "drop-shadow", color: rgba(0, 0, 0, 0.35), offset: { x: 4, y: 8 }, radius: 16, spread: 0 }],
      }));
      scene.root.appendChild(scene.createNode({
        path: rect(130, 30, 190, 80), fill: solid(rgba(0.2, 0.5, 1, 0.4)),
        effects: [{ type: "drop-shadow", color: rgba(0.8, 0, 0, 0.8), offset: { x: -6, y: 6 }, radius: 6, spread: 6, showBehind: true }],
      }));
      scene.root.appendChild(scene.createNode({
        path: roundedRectPath(220, 20, 80, 60, 30), fill: solid(hexColor("#ffcc80")),
        effects: [{ type: "inner-shadow", color: rgba(0, 0, 0, 0.6), offset: { x: 3, y: 5 }, radius: 10, spread: 2 }],
      }));
      const star = new Path().moveTo(60, 100).lineTo(72, 130).lineTo(104, 132).lineTo(78, 150).lineTo(88, 158).lineTo(60, 145).lineTo(32, 158).lineTo(42, 150).lineTo(16, 132).lineTo(48, 130).close();
      scene.root.appendChild(scene.createNode({
        path: star, fill: solid(hexColor("#7e57c2")),
        effects: [{ type: "drop-shadow", color: rgba(0, 0, 0, 0.5), offset: { x: 0, y: 3 }, radius: 4, spread: 2 }, { type: "inner-shadow", color: rgba(1, 1, 1, 0.7), offset: { x: 0, y: 2 }, radius: 2, spread: 0 }],
      }));
      const g = scene.createNode({ transform: multiply(translation(200, 120), rotation(0.3)), effects: [{ type: "drop-shadow", color: rgba(0, 0.2, 0.4, 0.6), offset: { x: 0, y: 6 }, radius: 8, spread: 0 }] });
      g.appendChild(scene.createNode({ path: ellipsePath(0, 0, 30, 18), fill: solid(hexColor("#26a69a")) }));
      g.appendChild(scene.createNode({ path: rect(20, -8, 60, 8), fill: solid(hexColor("#ef5350")) }));
      scene.root.appendChild(g);
    },
  },
  "fx-blur": {
    width: 320,
    height: 160,
    build(scene) {
      bands(scene, 320, 160);
      const blurred = scene.createNode({ effects: [{ type: "layer-blur", radius: 12 }] });
      blurred.appendChild(scene.createNode({ path: ellipsePath(60, 70, 36, 36), fill: solid(hexColor("#ffffff")) }));
      blurred.appendChild(scene.createNode({ path: rect(50, 30, 70, 120), fill: solid(hexColor("#000000")) }));
      scene.root.appendChild(blurred);
      scene.root.appendChild(scene.createNode({
        path: roundedRectPath(150, 20, 150, 110, 18), fill: solid(rgba(1, 1, 1, 0.25)),
        effects: [{ type: "background-blur", radius: 24 }],
      }));
      scene.root.appendChild(scene.createNode({ path: rect(270, 0, 280, 160), fill: solid(hexColor("#000000")) }));
    },
  },
  "fx-mask": {
    width: 300,
    height: 100,
    build(scene) {
      bands(scene, 300, 100);
      const kinds = ["alpha", "luminance", "vector"] as const;
      kinds.forEach((kind, i) => {
        const g = scene.createNode({});
        const x = 10 + i * 100;
        g.appendChild(scene.createNode({
          path: ellipsePath(x + 40, 50, 40, 40),
          fill: { type: "linear-gradient", start: { x, y: 0 }, end: { x: x + 80, y: 0 }, stops: [{ offset: 0, color: rgba(1, 1, 1, 1) }, { offset: 1, color: rgba(0, 0, 0, 0.2) }] },
          mask: kind,
        }));
        g.appendChild(scene.createNode({ path: rect(x, 0, x + 80, 100), fill: solid(hexColor("#212121")) }));
        g.appendChild(scene.createNode({ path: rect(x + 20, 20, x + 60, 80), fill: solid(hexColor("#ff4081")) }));
        scene.root.appendChild(g);
      });
    },
  },
  "fx-paints": {
    width: 320,
    height: 100,
    build(scene) {
      const stops = [{ offset: 0, color: hexColor("#ff0000") }, { offset: 0.33, color: hexColor("#ffff00") }, { offset: 0.66, color: hexColor("#00aaff") }, { offset: 1, color: hexColor("#ff0000") }];
      scene.root.appendChild(scene.createNode({ path: rect(10, 10, 90, 90), fill: { type: "angular-gradient", center: { x: 50, y: 50 }, stops } }));
      scene.root.appendChild(scene.createNode({ path: rect(100, 10, 180, 90), fill: { type: "diamond-gradient", center: { x: 140, y: 50 }, radius: 40, stops } }));
      const image = testImage();
      const img = (x: number, scale: number, repeat: boolean, adjust?: Paint): Paint =>
        adjust ?? { type: "image", image, transform: [scale, 0, 0, scale, x, 15], repeat };
      scene.root.appendChild(scene.createNode({ path: rect(190, 10, 250, 90), fill: img(190, 3.5, false) }));
      scene.root.appendChild(scene.createNode({ path: rect(255, 10, 315, 90), fill: { type: "image", image, transform: [1.5, 0, 0, 1.5, 255, 10], repeat: true, adjustments: { saturation: -0.6, contrast: 0.3 } } }));
    },
  },
  "fx-shaders": {
    width: 312,
    height: 160,
    build(scene) {
      bands(scene, 312, 160);
      shaderPaints().forEach((paint, i) => {
        const x = 4 + (i % 3) * 104;
        const y = 4 + Math.floor(i / 3) * 78;
        scene.root.appendChild(scene.createNode({ transform: translation(x, y), path: rect(0, 0, 96, 72), fill: paint }));
      });
    },
  },
};
