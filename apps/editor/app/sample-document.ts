import { FigDocument, seededRandom, type Command, type Paint } from "@fig-tree/document";

/**
 * The document the editor opens at `/`: frames with radii and clipping,
 * solid and gradient paint stacks, aligned strokes, nested groups, every
 * shape type, auto-layout (flexbox) and grid frames laid out by the layout
 * engine, and text shaped and laid out by the text engine (headings, a
 * wrapping paragraph with style runs, buttons hugging their labels,
 * right-to-left Arabic, Devanagari and variable font weights).
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

export const SAMPLE_BOUNDS = { x: 0, y: 0, width: 1340, height: 920 };

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

    // Auto layout (flexbox): a toolbar row with fixed, filling and centered children.
    {
      type: "createNode",
      node: {
        id: "toolbar",
        type: "frame",
        props: {
          name: "Toolbar",
          x: 40,
          y: 620,
          width: 360,
          height: 56,
          cornerRadius: 14,
          fills: [solid(255, 255, 255)],
          display: "flex",
          alignItems: "center",
          columnGap: 8,
          padding: { top: 12, right: 12, bottom: 12, left: 12 },
        },
      },
      parent: page,
    },
    { type: "createNode", node: { id: "tb-avatar", type: "ellipse", props: { name: "Avatar", width: 32, height: 32, fills: [solid(249, 115, 22)] } }, parent: "toolbar" },
    { type: "createNode", node: { id: "tb-search", type: "rectangle", props: { name: "Search", width: 40, height: 32, widthMode: "fill", cornerRadius: 8, fills: [solid(228, 228, 231)] } }, parent: "toolbar" },
    { type: "createNode", node: { id: "tb-button", type: "rectangle", props: { name: "Button", width: 72, height: 24, cornerRadius: 12, fills: [solid(24, 24, 27)] } }, parent: "toolbar" },

    // Auto layout, vertical and hugging its content: rows stretch across it.
    {
      type: "createNode",
      node: {
        id: "list",
        type: "frame",
        props: {
          name: "List",
          x: 40,
          y: 700,
          width: 360,
          height: 100,
          heightMode: "hug",
          cornerRadius: 14,
          fills: [solid(255, 255, 255)],
          display: "flex",
          flexDirection: "column",
          rowGap: 10,
          padding: { top: 12, right: 12, bottom: 12, left: 12 },
        },
      },
      parent: page,
    },
    ...[0, 1, 2].map(
      (i): Command => ({
        type: "createNode",
        node: { id: `row-${i}`, type: "rectangle", props: { name: `Row ${i + 1}`, width: 100, height: 40 + i * 10, widthMode: "fill", cornerRadius: 8, fills: [solid(14 + i * 60, 165, 233 - i * 50)] } },
        parent: "list",
      }),
    ),

    // CSS grid: three 1fr columns, two 1fr rows; one cell spans two columns, one spans two rows.
    {
      type: "createNode",
      node: {
        id: "gallery",
        type: "frame",
        props: {
          name: "Gallery",
          x: 480,
          y: 620,
          width: 360,
          height: 260,
          cornerRadius: 14,
          fills: [solid(255, 255, 255)],
          display: "grid",
          gridTemplateColumns: [{ type: "repeat", count: 3, tracks: [{ type: "fr", value: 1 }] }],
          gridTemplateRows: [{ type: "fr", value: 1 }, { type: "fr", value: 1 }],
          rowGap: 8,
          columnGap: 8,
          padding: { top: 12, right: 12, bottom: 12, left: 12 },
        },
      },
      parent: page,
    },
    ...(
      [
        ["cell-wide", { gridColumn: { start: { span: 2 }, end: "auto" } }, [139, 92, 246]],
        ["cell-tall", { gridRow: { start: { span: 2 }, end: "auto" } }, [236, 72, 153]],
        ["cell-a", {}, [34, 197, 94]],
        ["cell-b", {}, [234, 179, 8]],
      ] as const
    ).map(
      ([id, placement, [r, g, b]]): Command => ({
        type: "createNode",
        node: { id, type: "rectangle", props: { name: id, width: 10, height: 10, widthMode: "fill", heightMode: "fill", cornerRadius: 6, fills: [solid(r, g, b)], ...placement } },
        parent: "gallery",
      }),
    ),

    // Typography: a vertical auto-layout frame of text laid out and drawn by the text engine.
    {
      type: "createNode",
      node: {
        id: "type",
        type: "frame",
        props: {
          name: "Typography",
          x: 920,
          y: 40,
          width: 380,
          height: 100,
          heightMode: "hug",
          cornerRadius: 24,
          fills: [solid(255, 255, 255)],
          display: "flex",
          flexDirection: "column",
          rowGap: 16,
          padding: { top: 24, right: 24, bottom: 24, left: 24 },
        },
      },
      parent: page,
    },
    { type: "createNode", node: { id: "type-heading", type: "text", props: { name: "Heading", fontSize: 32, fontWeight: 700, letterSpacing: { unit: "em", value: -0.02 }, fills: [solid(24, 24, 27)] }, text: { content: "Typography", runs: [] } }, parent: "type" },
    {
      type: "createNode",
      node: {
        id: "type-body",
        type: "text",
        props: { name: "Body", widthMode: "fill", fontSize: 15, lineHeight: { unit: "percent", value: 150 }, fills: [solid(82, 82, 91)] },
        text: { content: "Text is shaped with HarfBuzz and broken into lines the way browsers do it: kerning, ligatures such as ffi and fl, style runs in bold and italic, and line boxes that match CSS.", runs: [{ start: 128, end: 132, style: { fontWeight: 700 } }, { start: 137, end: 143, style: { fontFamily: "Noto Sans", fontStyle: "italic" } }] },
      },
      parent: "type",
    },
    // A row of buttons whose width hugs their labels.
    { type: "createNode", node: { id: "type-buttons", type: "frame", props: { name: "Buttons", width: 10, height: 10, widthMode: "hug", heightMode: "hug", display: "flex", columnGap: 8 } }, parent: "type" },
    ...(
      [
        ["save", "Save", [24, 24, 27], [255, 255, 255]],
        ["cancel", "Cancel", [228, 228, 231], [24, 24, 27]],
        ["publish", "Publish draft", [37, 99, 235], [255, 255, 255]],
      ] as const
    ).flatMap(([id, label, bg, ink]): Command[] => [
      {
        type: "createNode",
        node: { id: `btn-${id}`, type: "frame", props: { name: label, width: 10, height: 10, widthMode: "hug", heightMode: "hug", cornerRadius: 999, fills: [solid(bg[0], bg[1], bg[2])], display: "flex", padding: { top: 8, right: 16, bottom: 8, left: 16 } } },
        parent: "type-buttons",
      },
      { type: "createNode", node: { id: `label-${id}`, type: "text", props: { name: "Label", fontSize: 14, fontWeight: 500, fills: [solid(ink[0], ink[1], ink[2])] }, text: { content: label, runs: [] } }, parent: `btn-${id}` },
    ]),
    // Right-to-left Arabic (from the script fallback font), aligned to the start (right) edge.
    { type: "createNode", node: { id: "type-arabic", type: "text", props: { name: "Arabic", widthMode: "fill", fontSize: 20, fills: [solid(24, 24, 27)] }, text: { content: "مرحبا بالعالم، هذا نص من اليمين إلى اليسار", runs: [] } }, parent: "type" },
    { type: "createNode", node: { id: "type-devanagari", type: "text", props: { name: "Devanagari", fontSize: 18, fills: [solid(24, 24, 27)] }, text: { content: "नमस्ते दुनिया", runs: [] } }, parent: "type" },
    // One variable font at five weights, and a line whose weight the tests change.
    {
      type: "createNode",
      node: {
        id: "type-weights",
        type: "text",
        props: { name: "Weights", fontSize: 20, fills: [solid(24, 24, 27)] },
        text: { content: "Thin Light Regular Bold Black", runs: [{ start: 0, end: 4, style: { fontWeight: 100 } }, { start: 5, end: 10, style: { fontWeight: 300 } }, { start: 19, end: 23, style: { fontWeight: 700 } }, { start: 24, end: 29, style: { fontWeight: 900 } }] },
      },
      parent: "type",
    },
    { type: "createNode", node: { id: "type-variable", type: "text", props: { name: "Variable weight", fontSize: 28, fontWeight: 300, fills: [solid(124, 58, 237)] }, text: { content: "Variable weight", runs: [] } }, parent: "type" },
  ];
}

export function buildSampleDocument(): FigDocument {
  const doc = FigDocument.create({ random: seededRandom(2026), clientId: 1, name: "Sample", pageName: "Overview" });
  doc.apply(sampleCommands(doc.pages[0]!), doc.actor("sample", "system"));
  return doc;
}

/** A 10,000-node document (100 frames of 99 shapes, plus the page) for performance tests: `/?doc=grid10k`. */
export function buildGridDocument(): FigDocument {
  const doc = FigDocument.create({ random: seededRandom(10_000), clientId: 1, name: "Grid", pageName: "Grid" });
  const page = doc.pages[0]!;
  const commands: Command[] = [{ type: "updateProps", id: page, props: { backgroundColor: rgb(238, 238, 234) } }];
  for (let f = 0; f < 100; f++) {
    commands.push({
      type: "createNode",
      node: { id: `f${f}`, type: "frame", props: { name: `Frame ${f + 1}`, x: (f % 10) * 600, y: Math.floor(f / 10) * 400, width: 580, height: 380, cornerRadius: 8, fills: [solid(255, 255, 255)] } },
      parent: page,
    });
    for (let i = 0; i < 99; i++) {
      const shape = i % 3 === 0 ? "ellipse" : "rectangle";
      commands.push({
        type: "createNode",
        node: {
          id: `n${f}-${i}`,
          type: shape,
          props: {
            x: (i % 10) * 55 + 15,
            y: Math.floor(i / 10) * 37 + 10,
            width: 50,
            height: 30,
            ...(shape === "rectangle" ? { cornerRadius: 4 } : {}),
            fills: [i % 7 === 0 ? linear([0, 0], [1, 1], rgb(91, 33, 182), rgb(37, 99, 235)) : solid((f * 7) % 255, (i * 13) % 255, 160)],
            ...(i % 10 === 0 ? { strokes: [solid(24, 24, 27)], strokeWeight: 2 } : {}),
          },
        },
        parent: `f${f}`,
      });
    }
  }
  doc.apply(commands, doc.actor("sample", "system"));
  return doc;
}

export const GRID_BOUNDS = { x: 0, y: 0, width: 5980, height: 3980 };

/**
 * A 10,000-node document laid out by the layout engine (`/?doc=layout10k`):
 * 100 frames, alternately wrapping flex rows and 10-column grids, of 99
 * rectangles each. Same ids as the grid document.
 */
export function buildLayoutDocument(): FigDocument {
  const doc = FigDocument.create({ random: seededRandom(10_001), clientId: 1, name: "Layout", pageName: "Layout" });
  const page = doc.pages[0]!;
  const commands: Command[] = [{ type: "updateProps", id: page, props: { backgroundColor: rgb(238, 238, 234) } }];
  for (let f = 0; f < 100; f++) {
    const container =
      f % 2
        ? { display: "flex" as const, flexWrap: "wrap" as const, alignItems: "center" as const, rowGap: 6, columnGap: 6 }
        : { display: "grid" as const, gridTemplateColumns: [{ type: "repeat" as const, count: 10, tracks: [{ type: "fr" as const, value: 1 }] }], rowGap: 4, columnGap: 4 };
    commands.push({
      type: "createNode",
      node: { id: `f${f}`, type: "frame", props: { name: `Frame ${f + 1}`, x: (f % 10) * 600, y: Math.floor(f / 10) * 400, width: 580, height: 380, cornerRadius: 8, fills: [solid(255, 255, 255)], padding: { top: 10, right: 10, bottom: 10, left: 10 }, ...container } },
      parent: page,
    });
    for (let i = 0; i < 99; i++) {
      commands.push({
        type: "createNode",
        node: { id: `n${f}-${i}`, type: i % 3 === 0 ? "ellipse" : "rectangle", props: { width: 40 + (i % 7) * 3, height: 20 + (i % 5) * 4, fills: [solid((f * 7) % 255, (i * 13) % 255, 160)] } },
        parent: `f${f}`,
      });
    }
  }
  doc.apply(commands, doc.actor("sample", "system"));
  return doc;
}
