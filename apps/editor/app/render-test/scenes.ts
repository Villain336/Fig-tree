import { Path, ellipsePath, multiply, rotation, roundedRectPath, translation } from "@fig-tree/geometry";
import { Scene, hexColor, rgba, solid, type GradientStop } from "@fig-tree/renderer";

/**
 * Reference scenes for the pixel-quality suite (e2e/render.spec.ts). Each is
 * rendered at 1:1 into a canvas of the given size on a white background.
 * The tests know these coordinates; change both together.
 */
export interface TestScene {
  readonly width: number;
  readonly height: number;
  build(scene: Scene): void;
}

const black = solid(rgba(0, 0, 0, 1));
const stops: GradientStop[] = [
  { offset: 0, color: hexColor("#ff0000") },
  { offset: 0.5, color: rgba(0, 0, 1, 0.5) },
  { offset: 1, color: hexColor("#00ff00") },
];

function rect(x0: number, y0: number, x1: number, y1: number): Path {
  return new Path().moveTo(x0, y0).lineTo(x1, y0).lineTo(x1, y1).lineTo(x0, y1).close();
}

export const testScenes: Record<string, TestScene> = {
  "rect-fractional": {
    width: 128,
    height: 96,
    build(scene) {
      scene.root.appendChild(scene.createNode({ path: rect(10.25, 20.5, 100.75, 60.4), fill: black }));
    },
  },
  circle: {
    width: 128,
    height: 128,
    build(scene) {
      scene.root.appendChild(scene.createNode({ path: ellipsePath(64.3, 64.7, 50, 50), fill: black }));
    },
  },
  abutting: {
    width: 128,
    height: 64,
    build(scene) {
      // Two triangles of one path sharing a diagonal.
      const tri = new Path()
        .moveTo(4.3, 4.7).lineTo(58.1, 6.3).lineTo(55.6, 58.2).close()
        .moveTo(4.3, 4.7).lineTo(55.6, 58.2).lineTo(6.1, 57.9).close();
      scene.root.appendChild(scene.createNode({ path: tri, fill: black }));
      // Separate draws sharing a pixel-aligned edge at x = 96.
      scene.root.appendChild(scene.createNode({ path: rect(70, 8, 96, 56), fill: black }));
      scene.root.appendChild(scene.createNode({ path: rect(96, 8, 122, 56), fill: black }));
    },
  },
  "abutting-fractional": {
    width: 64,
    height: 32,
    build(scene) {
      scene.root.appendChild(scene.createNode({ path: rect(8, 4, 32.5, 28), fill: black }));
      scene.root.appendChild(scene.createNode({ path: rect(32.5, 4, 56, 28), fill: black }));
    },
  },
  gradients: {
    width: 160,
    height: 80,
    build(scene) {
      scene.root.appendChild(scene.createNode({
        path: rect(0, 0, 80, 80),
        fill: { type: "linear-gradient", start: { x: 8, y: 0 }, end: { x: 72, y: 0 }, stops },
      }));
      scene.root.appendChild(scene.createNode({
        path: rect(80, 0, 160, 80),
        fill: { type: "radial-gradient", center: { x: 120, y: 40 }, radius: 36, stops },
      }));
    },
  },
  evenodd: {
    width: 96,
    height: 96,
    build(scene) {
      const path = rect(8, 8, 88, 88).append(rect(28, 28, 68, 68));
      scene.root.appendChild(scene.createNode({ path, fill: black, fillRule: "evenodd" }));
    },
  },
  layers: {
    width: 160,
    height: 96,
    build(scene) {
      // Group opacity: the overlap shows only the top rect, at 50%.
      const group = scene.createNode({ opacity: 0.5 });
      group.appendChild(scene.createNode({ path: rect(8, 8, 56, 56), fill: solid(hexColor("#ff0000")) }));
      group.appendChild(scene.createNode({ path: rect(32, 32, 80, 80), fill: solid(hexColor("#0000ff")) }));
      scene.root.appendChild(group);
      // A rounded frame clipping a larger rect.
      const frame = scene.createNode({ path: roundedRectPath(96, 16, 56, 64, 16), fill: solid(rgba(0, 0, 0, 0)), clipsContent: true });
      frame.appendChild(scene.createNode({ path: rect(88, 8, 160, 96), fill: solid(hexColor("#00aa00")) }));
      scene.root.appendChild(frame);
    },
  },
  occlusion: {
    width: 96,
    height: 64,
    build(scene) {
      // Hidden under an opaque rect that fully covers several tiles.
      scene.root.appendChild(scene.createNode({ path: ellipsePath(48, 32, 30, 30), fill: solid(hexColor("#ff0000")) }));
      scene.root.appendChild(scene.createNode({ path: rect(0, 0, 64, 64), fill: solid(hexColor("#0000ff")) }));
      // Above it: translucent paint must still blend with the occluder.
      scene.root.appendChild(scene.createNode({ path: rect(8, 8, 88, 24), fill: solid(rgba(0, 1, 0, 0.5)) }));
      // An opaque occluder inside an opacity group must not cull what is below the group.
      const group = scene.createNode({ opacity: 0.5 });
      group.appendChild(scene.createNode({ path: rect(64, 32, 96, 64), fill: solid(hexColor("#000000")) }));
      group.appendChild(scene.createNode({ path: rect(80, 48, 96, 64), fill: solid(hexColor("#ffffff")) }));
      scene.root.appendChild(group);
    },
  },
  mixed: {
    width: 256,
    height: 192,
    build(scene) {
      const root = scene.root;
      root.appendChild(scene.createNode({
        path: roundedRectPath(12, 12, 104, 72, [4, 16, 28, 0], 0.6),
        fill: { type: "linear-gradient", start: { x: 12, y: 12 }, end: { x: 116, y: 84 }, stops },
        stroke: { paint: black, width: 3, join: "round" },
      }));
      root.appendChild(scene.createNode({
        path: ellipsePath(0, 0, 44, 26),
        transform: multiply(translation(186, 52), rotation(0.4)),
        fill: { type: "radial-gradient", center: { x: 0, y: 0 }, radius: 44, stops, transform: [1, 0, 0, 0.6, 0, 0] },
        stroke: { paint: solid(hexColor("#2050c0")), width: 4, dash: [10, 6], cap: "round" },
      }));
      const blob = new Path()
        .moveTo(20, 140).cubicTo(40, 96, 110, 170, 120, 120).cubicTo(130, 80, 170, 190, 90, 182).cubicTo(50, 178, 0, 180, 20, 140).close();
      root.appendChild(scene.createNode({ path: blob, fill: solid(rgba(0.95, 0.6, 0.1, 0.85)) }));
      root.appendChild(scene.createNode({
        path: new Path().moveTo(140, 110).lineTo(240, 120).lineTo(160, 180).lineTo(236, 176),
        stroke: { paint: solid(hexColor("#7a1fa2")), width: 9, join: "miter", cap: "square" },
      }));
      const frame = scene.createNode({ path: roundedRectPath(150, 126, 60, 44, 10, 1), fill: solid(rgba(0.1, 0.1, 0.1, 0.08)), clipsContent: true, opacity: 0.8 });
      frame.appendChild(scene.createNode({ path: ellipsePath(150, 126, 40, 40), fill: solid(hexColor("#e91e63")) }));
      frame.appendChild(scene.createNode({ path: ellipsePath(210, 170, 34, 34), fill: solid(hexColor("#00bcd4")) }));
      root.appendChild(frame);
    },
  },
  // A layer created mid-frame followed by a gradient: creating the layer's
  // render target must not disturb the textures gradients read.
  "layer-then-gradient": {
    width: 160,
    height: 80,
    build(scene) {
      const group = scene.createNode({ opacity: 0.5 });
      group.appendChild(scene.createNode({ path: rect(8, 8, 40, 40), fill: solid(rgba(1, 0, 0, 1)) }));
      group.appendChild(scene.createNode({ path: rect(24, 24, 56, 56), fill: solid(rgba(0, 0, 1, 1)) }));
      scene.root.appendChild(group);
      scene.root.appendChild(scene.createNode({ path: rect(80, 8, 152, 72), fill: { type: "linear-gradient", start: { x: 80, y: 0 }, end: { x: 152, y: 0 }, stops } }));
    },
  },
  // A stroke aligned outside: a double-width stroke clipped by the complement
  // of its outline (even-odd: a surrounding rect plus the outline).
  "outside-stroke": {
    width: 100,
    height: 100,
    build(scene) {
      const box = rect(30, 30, 70, 70);
      const outer = rect(0, 0, 100, 100).append(box);
      const clip = scene.createNode({ path: outer, fillRule: "evenodd", clipsContent: true });
      clip.appendChild(scene.createNode({ path: box, stroke: { paint: solid(rgba(0, 0, 0, 1)), width: 16 } }));
      scene.root.appendChild(clip);
    },
  },
  // A rotated clipping frame whose children cover only part of it, with a
  // center stroke drawn after the clip layer: the clip's stencil must not
  // leak outside the layer's bounds into the stroke's cover.
  "clip-stencil-leak": {
    width: 200,
    height: 160,
    build(scene) {
      const frame = scene.createNode({ transform: multiply(translation(30, 20), rotation(0.1)), path: roundedRectPath(0, 0, 140, 100, 20), fill: solid(rgba(1, 0.93, 0.83, 1)), stroke: { paint: solid(rgba(0.92, 0.35, 0.05, 1)), width: 3 } });
      const host = scene.createNode({ path: roundedRectPath(0, 0, 140, 100, 20), clipsContent: true });
      host.appendChild(scene.createNode({ transform: translation(80, 30), path: ellipsePath(50, 50, 50, 50), fill: solid(rgba(0.9, 0.2, 0.1, 1)) }));
      host.appendChild(scene.createNode({ transform: translation(-20, 70), path: roundedRectPath(0, 0, 120, 60, 30), fill: solid(rgba(0.1, 0.6, 0.3, 1)) }));
      frame.appendChild(host);
      scene.root.appendChild(frame);
    },
  },
};

