import { FigDocument, seededRandom, type Command, type Paint } from "@fig-tree/document";

/**
 * The document the editor opens at `/`: frames with radii and clipping,
 * solid and gradient paint stacks, aligned strokes, nested groups, every
 * shape type and a text node (stored, not rendered until the text module).
 * Ids are fixed so tests can address nodes; e2e/editor.spec.ts knows the
 * coordinates.
 */

const rgb = (r: number, g: number, b: number, a = 1) => ({ r: r / 255, g: g / 255, b: b / 255, a });
const solid = (r: number, g: number, b: number, a = 1): Paint => ({ type: "solid", color: rgb(r, g, b, a) });
const linear = (from: [number, number], to: [number, number], ...colors: ReturnType<typeof rgb>[]): Paint => ({
  type: "linear-gradient",
  start: { x: from[0], y: from[1] },
  end: { x: to[0], y: to[1] },
  stops: colors.map((color, i) => ({ position: i / (colors.length - 1), color })),
});
const radial = (...colors: ReturnType<typeof rgb>[]): Paint => ({
  type: "radial-gradient",
  center: { x: 0.5, y: 0.5 },
  radiusX: { x: 1, y: 0.5 },
  radiusY: { x: 0.5, y: 1 },
  stops: colors.map((color, i) => ({ position: i / (colors.length - 1), color })),
});

export const SAMPLE_BOUNDS = { x: 0, y: 0, width: 880, height: 600 };

export function sampleCommands(page: string): Command[] {
  return [
    { type: "updateProps", id: page, props: { name: "Overview", backgroundColor: rgb(238, 238, 234) } },

    // A card with a gradient header and an avatar clipped by its rounded corners.
    {
      type: "createNode",
      node: {
        id: "card",
        type: "frame",
        props: { name: "Card", x: 40, y: 40, width: 360, height: 240, cornerRadius: 24, cornerSmoothing: 0.6, fills: [solid(255, 255, 255)], strokes: [solid(24, 24, 27, 0.15)], strokeWeight: 1 },
      },
      parent: page,
    },
    { type: "createNode", node: { id: "header", type: "rectangle", props: { name: "Header", x: 0, y: 0, width: 360, height: 104, fills: [linear([0, 0], [1, 1], rgb(91, 33, 182), rgb(37, 99, 235))] } }, parent: "card" },
    { type: "createNode", node: { id: "avatar", type: "ellipse", props: { name: "Avatar", x: 280, y: -36, width: 120, height: 120, fills: [radial(rgb(253, 224, 71), rgb(234, 88, 12))], strokes: [solid(255, 255, 255)], strokeWeight: 6, strokeAlign: "outside" } }, parent: "card" },
    { type: "createNode", node: { id: "title", type: "text", props: { name: "Title", x: 24, y: 128, fontSize: 20, fontWeight: 600, fills: [solid(24, 24, 27)] }, text: { content: "Fig Tree", runs: [{ start: 4, end: 8, style: { fontWeight: 800 } }] } }, parent: "card" },
    { type: "createNode", node: { id: "bars", type: "group", props: { name: "Bars", opacity: 0.85 } }, parent: "card" },
    { type: "createNode", node: { id: "bar1", type: "rectangle", props: { name: "Bar 1", x: 24, y: 176, width: 200, height: 14, cornerRadius: 7, fills: [solid(228, 228, 231)] } }, parent: "bars" },
    { type: "createNode", node: { id: "bar2", type: "rectangle", props: { name: "Bar 2", x: 24, y: 176, width: 120, height: 14, cornerRadius: 7, fills: [solid(16, 185, 129)] } }, parent: "bars" },
    { type: "createNode", node: { id: "bar3", type: "rectangle", props: { name: "Bar 3", x: 24, y: 202, width: 160, height: 14, cornerRadius: 7, fills: [solid(228, 228, 231)] } }, parent: "bars" },

    // Every shape type, on a frame with a two-paint fill stack and an outside stroke.
    {
      type: "createNode",
      node: {
        id: "shapes",
        type: "frame",
        props: {
          name: "Shapes",
          x: 480,
          y: 40,
          width: 360,
          height: 240,
          cornerRadius: { topLeft: 32, topRight: 8, bottomRight: 32, bottomLeft: 8 },
          fills: [solid(250, 250, 249), linear([0.5, 0], [0.5, 1], rgb(14, 165, 233, 0), rgb(14, 165, 233, 0.25))],
          strokes: [solid(14, 165, 233)],
          strokeWeight: 4,
          strokeAlign: "outside",
        },
      },
      parent: page,
    },
    { type: "createNode", node: { id: "hexagon", type: "polygon", props: { name: "Hexagon", x: 24, y: 24, width: 88, height: 88, pointCount: 6, cornerRadius: 6, fills: [solid(244, 63, 94)] } }, parent: "shapes" },
    { type: "createNode", node: { id: "star", type: "star", props: { name: "Star", x: 136, y: 24, width: 88, height: 88, pointCount: 5, innerRadius: 0.45, fills: [solid(250, 204, 21)], strokes: [solid(161, 98, 7)], strokeWeight: 2, strokeAlign: "inside" } }, parent: "shapes" },
    { type: "createNode", node: { id: "donut", type: "ellipse", props: { name: "Donut", x: 248, y: 24, width: 88, height: 88, arcStart: -90, arcSweep: 270, innerRadius: 0.55, fills: [solid(139, 92, 246)] } }, parent: "shapes" },
    { type: "createNode", node: { id: "line", type: "line", props: { name: "Line", x: 24, y: 172, width: 120, rotation: -20, strokes: [solid(24, 24, 27)], strokeWeight: 6, strokeCap: "round", strokeDashes: [18, 12] } }, parent: "shapes" },
    {
      type: "createNode",
      node: {
        id: "vector",
        type: "vector",
        props: {
          name: "Vector",
          x: 184,
          y: 132,
          width: 150,
          height: 90,
          fills: [solid(34, 197, 94)],
          strokes: [solid(21, 128, 61)],
          strokeWeight: 3,
          strokeJoin: "round",
          vectorNetwork: {
            vertices: [{ x: 0, y: 90 }, { x: 60, y: 0 }, { x: 120, y: 90 }, { x: 150, y: 20 }],
            segments: [
              { start: 0, end: 1, tangentStart: { x: 0, y: -40 }, tangentEnd: { x: -30, y: 0 } },
              { start: 1, end: 2 },
              { start: 2, end: 0 },
              { start: 1, end: 3, tangentStart: { x: 40, y: -20 }, tangentEnd: { x: 0, y: -30 } },
            ],
            regions: [{ loops: [[0, 1, 2]], fillRule: "nonzero" }],
          },
        },
      },
      parent: "shapes",
    },

    // Nested groups inside a frame inside a group.
    { type: "createNode", node: { id: "outer", type: "group", props: { name: "Nested" } }, parent: page },
    { type: "createNode", node: { id: "panel", type: "frame", props: { name: "Panel", x: 40, y: 320, width: 360, height: 240, cornerRadius: 12, fills: [solid(24, 24, 27)] } }, parent: "outer" },
    { type: "createNode", node: { id: "inner", type: "group", props: { name: "Tiles", opacity: 0.9 } }, parent: "panel" },
    ...[0, 1, 2].flatMap((row) =>
      [0, 1, 2, 3].map(
        (col): Command => ({
          type: "createNode",
          node: {
            id: `tile-${row}-${col}`,
            type: "rectangle",
            props: { name: `Tile ${row * 4 + col + 1}`, x: 24 + col * 80, y: 24 + row * 68, width: 68, height: 56, cornerRadius: 10, fills: [linear([0, 0], [1, 1], rgb(63 + col * 40, 63, 70 + row * 50), rgb(39, 39, 42))] },
          },
          parent: "inner",
        }),
      ),
    ),

    // A rotated clipping frame with content spilling past its edges.
    {
      type: "createNode",
      node: { id: "clip", type: "frame", props: { name: "Clip", x: 500, y: 340, width: 320, height: 200, rotation: 6, cornerRadius: 40, fills: [solid(255, 237, 213)], strokes: [solid(234, 88, 12)], strokeWeight: 3, strokeAlign: "center" } },
      parent: page,
    },
    { type: "createNode", node: { id: "sun", type: "ellipse", props: { name: "Sun", x: 180, y: 60, width: 220, height: 220, fills: [radial(rgb(251, 146, 60), rgb(220, 38, 38))] } }, parent: "clip" },
    { type: "createNode", node: { id: "hill", type: "rectangle", props: { name: "Hill", x: -40, y: 140, width: 300, height: 120, rotation: -12, cornerRadius: 60, fills: [solid(22, 163, 74)] } }, parent: "clip" },
  ];
}

export function buildSampleDocument(): FigDocument {
  const doc = FigDocument.create({ random: seededRandom(2026), clientId: 1, name: "Sample", pageName: "Overview" });
  doc.apply(sampleCommands(doc.pages[0]!), doc.actor("sample", "system"));
  return doc;
}
