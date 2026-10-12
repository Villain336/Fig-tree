# Fig Tree

Fig Tree is an open-source, collaborative interface design tool. It pairs the vector precision designers expect (pen tool, vector networks, booleans, components and variables) with a canvas that speaks code natively: frames lay out with real CSS flexbox and grid, text shapes like the browser shapes it, and every design can be read, diffed and exported as working code. Teams and AI agents work on the same document side by side. Our agentic cursor, Sprout, edits the canvas next to you through the same operations you use. The whole stack is ours and open: a GPU renderer written for this job, a CRDT document model, and our own layout and text engines. Fig Tree is licensed under the AGPL-3.0.

> Status: **Module 5c**. Modules 1 to 3 built the monorepo, geometry, the GPU renderer and its benchmark, the CRDT document model (command API, per-user undo, reviewable proposals, the `.figtree` format, the renderer bridge) and our own CSS layout engine, which matches Chromium box for box on 1,656 test cases. Module 4 added the text engine: font files and variable fonts, CSS font matching with script fallback, HarfBuzz shaping, bidi, CSS line breaking and paragraph layout, and glyph rendering from an atlas on both backends. It matches Chromium's line breaks on every one of 166 text cases and every glyph box to 1/64 px. Module 5a made the editor an editor: selection (click, deep, select-through, marquee), moving, resizing and rotating with smart guides and equal-spacing snapping, creation tools, text editing on the canvas with IME, copy and paste (including SVG and images), auto layout and grid editing, a design panel with a color picker and on-canvas gradient handles, pages and layers panels, context menus and a shortcuts sheet, all on a framework-free `packages/editor-core`. Module 5b added the vector toolkit (vector networks, exact curve booleans, shape-preserving path editing, curve fitting, outline stroke) and module 5c its editing UI: the pen and pencil, vector edit mode (points, handles with mirroring, bending, the paint bucket for faces with holes, per-point corner radius; shapes become vectors on their first edit), live boolean groups from menus and shortcuts, flatten, outline stroke, text to outlines and copy as SVG. See [`docs/parity.md`](docs/parity.md) for what works today.

![The editor: an auto-layout frame selected, with the design panel](docs/img/editor-auto-layout.png)

![Vector edit mode: a pen-drawn shape with a smooth point selected, its handles, and the point fields in the design panel](docs/img/editor-vector-edit.png)

![Benchmark: 10,000 shapes rendered with the WebGPU backend](docs/img/bench-webgpu.png)

## What is here

| Package | What it is |
|---|---|
| [`packages/geometry`](packages/geometry) | Affine matrices, paths, tight bounds, adaptive flattening (screen-space tolerance), stroking (miter/round/bevel joins, butt/round/square caps, dashes), rounded rects with per-corner radii and G2 corner smoothing, ellipses. The vector toolkit: exact curve intersection, robust boolean operations on curves (union, subtract, intersect, exclude, with curves out), vector networks and their editing operations, faces and the fill tool, rounded vertex corners, SVG path data with arcs, curve fitting for freehand input, shape-preserving point deletion, the pen tool as a state machine, and outline stroke. |
| [`packages/renderer`](packages/renderer) | Retained-mode scene renderer. **WebGPU:** compute-shader tile binning and exact analytic coverage (nonzero and even-odd), plus a compositing pass. **WebGL2 fallback:** stencil-then-cover with 4x MSAA. Both share an rbush spatial index, per-node GPU buffer caching and a screen-tile cache for panning. |
| [`packages/layout`](packages/layout) | Our own CSS layout engine, written from the W3C specs: box model and sizing (`box-sizing`, percentages, min/max, intrinsic keywords, `aspect-ratio`), block layout, **flexbox** (the full §9 algorithm, baselines, automatic minimum sizes), **grid** (track sizing with spanning items and `fr`, `repeat()` with `auto-fill`/`auto-fit`, named lines and areas, dense auto-placement, alignment) and positioned layout. Includes a CSS declaration parser, a measure callback for text, and incremental relayout with per-node caches. Checked against Chromium (`docs/conformance.md`). |
| [`packages/text`](packages/text) | Our own text engine, written from the specs around HarfBuzz (harfbuzzjs): TrueType/CFF, WOFF and WOFF2 decoding, variable font instances, a font registry with CSS Fonts 4 matching, per-character and per-script fallback, a Google Fonts loader; Unicode line breaking (UAX #14 with CSS tailoring), grapheme clusters (UAX #29) and bidi (UAX #9); CSS paragraph layout (`white-space`, `overflow-wrap`, `word-break`, soft hyphens, `text-align` incl. justify, `text-indent`, letter and word spacing, `line-height` and line boxes per CSS Inline 3, `text-wrap: balance`/`pretty`, ellipsis and line clamp, `text-transform`, decorations, lists); the layout engine's measure callback and hit-testing. Checked against Chromium (`docs/conformance.md`). |
| [`packages/document`](packages/document) | The document: a Yjs CRDT of nodes with CSS-semantic properties validated by zod schemas (box model, sizing, positioning, flex and grid, paint stacks, strokes, effects, typography, vector networks, text runs). Also: a command API with atomic batches (the single mutation path for the UI, agents and the MCP server), per-user undo, fork-and-diff proposals, the `.figtree` file format with a published JSON Schema, and the incremental bridge to the renderer, which lays pages out with `packages/layout` from each node's CSS and draws text with `packages/text`; fonts uploaded into a document travel in its file. |
| [`packages/editor-core`](packages/editor-core) | The editor without a UI framework: tools and a tool registry, an edit-mode API, selection and hover as awareness-ready presence, hit-testing, interaction state machines (select, marquee, move, resize, rotate, create), smart guides and snapping, text editing (carets, selection, IME), vector editing (the pen and pencil, vector edit mode, booleans, flatten, outline stroke, copy as SVG), the clipboard format and SVG import, actions, the keyboard map, the overlay model and the UI anchor registry. Runs in Node; unit-tested with real documents and fonts. |
| [`apps/editor`](apps/editor) | Next.js app: the editor (`/`: the sample document; `/?doc=blank` an empty page; `/?doc=grid10k`, `/?doc=layout10k` and `/?doc=text10k` open 10,000-node documents, the last with 2,000 text nodes) with its toolbar, canvas overlay, pages and layers panels, design panel and CSS tab; the bundled OFL fonts (`/fonts`), the 10k-shape renderer benchmark (`/bench`) and render-test harnesses (`/render-test`, `/text-render`). |

Read [`docs/architecture.md`](docs/architecture.md) for how the renderer, the document model, the layout engine, the text engine and the editor work. The file format is described there and in [`docs/format/figtree.schema.json`](docs/format/figtree.schema.json). Benchmark numbers are in [`docs/benchmarks.md`](docs/benchmarks.md), and layout and text conformance results in [`docs/conformance.md`](docs/conformance.md).

## Getting started

Requires Node.js 20.9+ (CI uses 22).

```bash
npm install
npm run dev -w @fig-tree/editor     # http://localhost:3000, benchmark at /bench
```

`/bench?renderer=webgl2` forces the WebGL2 fallback, and `/bench?renderer=webgpu` requires WebGPU. Without a parameter, the renderer uses WebGPU when the browser supports it.

## Scripts

| Command | What it does |
|---|---|
| `npm run typecheck` | Strict TypeScript across packages, e2e tests and the app. Run it with `NODE_OPTIONS=--max-old-space-size=8192`. |
| `npm test` | Vitest unit and property tests: the editor core (selection, gestures, snapping, text editing, vector editing, clipboard, actions), geometry, tiling math, scene and draw list, tile cache, the glyph atlas, the layout engine, the text engine and the document model. Layout tests cover the CSS parser, the flex freeze loop, grid track sizing and placement, incremental relayout, and the Chromium conformance suite against stored fixtures. Text tests cover font decoding and matching, shaping against HarfBuzz, the Unicode test files (UAX #14, #29, #9), paragraph layout, the Google Fonts loader and the text conformance suite. Document tests cover schemas, commands, 50-seed CRDT convergence, undo, proposals, the file format, the bridge, document layout and text. |
| `npm run build` | Production build of the editor. |
| `npm run test:render` | Playwright pixel-quality suite on both backends, the editor tests (rendering, typography and text edits), the editing flows (drawing, layout, transforms, undo/redo, layers, text, clipboard, every design panel field, UI anchors), vector editing (pen, pencil, vector edit mode, booleans, flatten, outline stroke, SVG paste and copy) and the visual text comparison with Chromium. Run `npm run build` first. |
| `npm run bench` | Playwright benchmarks on both backends: pan and zoom over 10k shapes, single-property updates on a 10k-node document, layout edits on a 10k-node auto-layout document, and text edits and panning on a 10k-node document with 2,000 text nodes, and input-to-frame latency of dragging, resizing, typing, drawing with the pen and dragging vector points with real input. Writes `test-results/bench.json`, `test-results/document-bench.json` and `test-results/editing-bench.json`. |
| `npm run test:conformance` | Re-renders every layout and text conformance case in Playwright's Chromium and checks the engines and the stored fixtures against it. Needs no build. |
| `npm run conformance:update` | Regenerates the Chromium fixtures after adding or changing cases. |

Playwright launches Chromium with `--enable-unsafe-webgpu` and SwiftShader flags (see `playwright.config.ts`), so the GPU tests run on machines without a GPU. Useful environment variables:
- `UPDATE_GOLDENS=1` rewrites `e2e/goldens/`.
- `UPDATE_SCHEMA=1 npm test` regenerates `docs/format/figtree.schema.json` after a schema change (a test fails while it is stale).
- `UPDATE_DOCS=1` refreshes the screenshots in `docs/img/`.
- `E2E_PORT` points the tests at an already running server.

## License

Fig Tree is licensed under the [GNU Affero General Public License v3.0](LICENSE). A few files are ported from other open-source projects and keep their original license. They are listed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

Fig Tree is an independent project. It is not affiliated with Figma or Paper.
