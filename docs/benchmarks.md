# Renderer benchmarks

> **These are software-rendering numbers.** The machine has no GPU, so both WebGPU and WebGL2 run on SwiftShader, Chromium's CPU implementation of Vulkan/GL. They show relative costs and regressions, not what users will see. **Numbers on real GPUs are still to be measured** (see "Pending" below).

## Setup

| | |
|---|---|
| Scene | `/bench`: 10,000 shapes on a 6000×4000 world: rounded rects (per-corner radii, 30% smoothed), ellipses and cubic blobs. 30% have linear or radial gradients, 10% have strokes. In total: 11,037 draws and about 255k line segments at the overview zoom. |
| Viewport | 1280×720 CSS px, DPR 1, everything visible at the start (zoom ≈ 17%) |
| Browser | Chromium 141.0.7390.37 (Playwright 1.56.1), headless, `--enable-unsafe-webgpu --enable-features=Vulkan --use-vulkan=swiftshader --use-angle=swiftshader` |
| Machine | 4 vCPU Intel Xeon @ 2.80 GHz, no GPU |
| Frame loop | `render()` → wait for GPU completion (WebGPU `onSubmittedWorkDone`, WebGL2 fence) → next `requestAnimationFrame`. Frame time is the interval between frames, so it includes GPU work. |
| Harness | `npm run bench` (`e2e/bench.spec.ts`): real mouse input through Playwright, 5 s per scenario per backend |

Scenarios:
1. **Pan + zoom:** for 5 s, a drag-pan alternates with a wheel zoom in or out about the cursor. The zoom level changes about every other frame, so most frames re-rasterize the whole screen.
2. **Sustained pan:** from the overview with all 10k shapes visible, back-and-forth drags for 5 s at a fixed zoom. The screen-tile cache only rasterizes tiles that scroll into view.

## Results (2026-10-11, commit at the time of writing)

| Backend | Scenario | Frames in 5 s | Avg frame | p95 frame | Max frame | Median CPU per frame | Bytes uploaded |
|---|---|---|---|---|---|---|---|
| WebGPU | Pan + zoom | 14 | 421 ms | 1,850 ms | 1,850 ms | 0.9 ms | 2.9 MB (zoom re-flattening) |
| WebGPU | Sustained pan | 107 | 48 ms | 67 ms | 1,983 ms (first fill of the tile cache) | 0.4 ms | **0** |
| WebGL2 | Pan + zoom | 7 | 624 ms | 1,300 ms | 1,300 ms | 41 ms | 2.8 MB (zoom re-flattening) |
| WebGL2 | Sustained pan | 113 | 45 ms | 67 ms | 67 ms | 0.2 ms | **0** |

Repeated runs on this machine gave these averages: five runs of pan + zoom, and three of sustained pan since the pan phase starts from the overview.

| Backend | Pan + zoom avg | Sustained pan avg |
|---|---|---|
| WebGPU | 349–476 ms | 41–50 ms |
| WebGL2 | 487–624 ms | 44–47 ms |

Pan + zoom fits only 7–16 frames into 5 s on SwiftShader, so its p95 is close to the slowest frame.

A full-screen frame at the overview (all 11k draws rasterized), WebGPU on SwiftShader, from `timestamp-query`:

| Stage | GPU time |
|---|---|
| bin (255k segments → tile pieces) | 101–158 ms |
| tiles (backdrops, masks, bitmaps) + lists | 50–65 ms |
| coverage (exact area per edge-tile pixel) | 575–663 ms |
| composite (paint + blend per pixel) | 650–850 ms |
| **total** | **≈1.4 s** |

The same frame takes about 1.0 s in the WebGL2 fallback. SwiftShader runs GL rasterization through LLVM-compiled SIMD and handles fragment work more efficiently than it handles general compute dispatches. On real GPUs we expect the reverse, because the compute path does exact anti-aliasing with no MSAA bandwidth and no per-draw state changes.

### What the numbers show

- **The view-only path uploads nothing.** Panning at a fixed zoom uploads 0 bytes, and the benchmark asserts this. Geometry and paints live in persistent GPU arenas, and segments are in local space. The per-frame entry list (80 B per visible draw) is the only upload when the view changes.
- **Zoom re-flattens only past thresholds.** The 2.8–2.9 MB uploaded during pan + zoom comes from crossing power-of-two flattening levels as the view zooms in, not from every zoom step.
- **The tile cache dominates sustained panning.** Average frame time drops from about 1.4 s (WebGPU) and about 1.0 s (WebGL2) per full re-render to about 45–50 ms. The remaining cost is copying tiles and occasionally rasterizing a strip of new tiles. The one 2 s frame is the first fill of the cache after the view is reset.
- **The occlusion and list passes matter.** Before the per-tile list pass existed, composite re-scanned the z-order bitmap in every pixel invocation, and a full frame took **33.5 s** on SwiftShader. With the list pass it takes 1.4 s and produces identical pixels. Profiling with GPU timestamps found this (see the commit history).

## Document model and bridge (Module 2)

A 10,001-node document: one page with 100 frames, each holding 99 shapes. A third of the shapes are ellipses and the rest rounded rectangles; a tenth have inside strokes and a seventh have gradient fills. The same document is built by the unit test (`packages/document/test/bridge.test.ts`) and by the editor at `/?doc=grid10k` (`e2e/document-bench.spec.ts`, run with `npm run bench`). The edit changes one property of one shape (a fill color, `x`, or `width`). Since Module 3, every update also goes through layout: the frames lay their absolutely positioned shapes out from their CSS insets.

What one update costs, measured on 2026-10-12 on the machine above:

| Where | What is timed | Median | Max |
|---|---|---|---|
| Node 22 (Vitest), 3 runs × 41 updates per kind | `doc.apply` (zod validation, draft, one Yjs transaction), the change event, layout (restyle of the node, relayout of its frame), the bridge recompiling the node, and `DrawList.sync` (incremental) | fill 0.20–0.23 ms, `x` 0.43–0.47 ms, `width` 0.47–0.48 ms | 5.6 ms |
| Chromium, 9–21 updates per kind and view, two runs | `apply` through the page harness, including layout and the bridge (the draw list updates during the next frame) | 0.7–1.4 ms | 6.6 ms |

Before layout existed these were 0.13–0.30 ms in Node and 0.3–0.9 ms in Chromium. A fill edit skips layout entirely; an `x` or `width` edit restyles the shape and relays out its frame, where the other 98 shapes hit their caches. Every update still recompiles exactly one node (`bridge.lastCompiled === 1`, asserted). The test requires the median to stay under 16 ms.

The frame after an update renders directly, because the tile cache is invalidated:

| Backend | View | Frame CPU median |
|---|---|---|
| WebGPU | zoomed in (one frame on screen) | 0.9–1.2 ms |
| WebGL2 | zoomed in | 1.2–1.6 ms |
| WebGPU | overview, all 10k nodes visible | 33–50 ms (frame planning of about 11k draws, plus encoding) |
| WebGL2 | overview | 1,080–1,160 ms (blocked on SwiftShader; see below) |

At the overview, the WebGL2 frame waits on SwiftShader. Its 500 clip layers (100 clipping frames, and 400 inside strokes on ellipses, which need a clip) each resolve and composite an offscreen MSAA target. Rectangles' inside strokes need no layer since Module 2, which cut this frame from about 1,240 ms. Full-screen WebGL2 frames in `/bench` cost about the same.

Loading the same document: creating 10k nodes with one command batch takes about 0.65 s, building the layout and the scene through the bridge about 1.0 s (0.4 s of it is the scene; the layout tree's styles, parsed from `cssDeclarations`, and its first layout take the rest), and the first draw-list compile about 0.14 s (Node). The editor page is ready in about 1.6 s on WebGPU and 3.5 s on WebGL2 (1.1–1.4 s and 2.9–3.3 s before layout).

Two renderer changes made these numbers possible:
- Transform and geometry edits update the draw list incrementally: 0.2–1.7 ms instead of an 80–130 ms recompile at 10k nodes.
- `SceneNode.replaceChildren` relinks a container's children in O(children).

## Layout engine (Module 3)

Measured on 2026-10-12 on the machine above, Node 22, each test file run alone (three runs; ranges are across runs).

### Engine only (`packages/layout/test/incremental.test.ts`)

A 10,001-node tree: a column flex container of 100 sections, alternately wrapping flex rows and `repeat(auto-fill, minmax(60px, 1fr))` grids, with 99 children each (a quarter of them text-like measured leaves with `flex: 1 1 0px`).

| What | Time |
|---|---|
| First layout | 153–222 ms (21,751 box layouts and 6,633 intrinsic-size computations; it includes JIT warm-up) |
| Full relayout after marking every node dirty | 136–169 ms |
| One property change (a child's width or flex factor), then relayout: median | 1.5–2.6 ms |
| Same, max over 41 changes | 5.0–6.9 ms |
| Boxes laid out again per change: median / max | 8 / 54 |

Re-measured after Module 4: a leaf without percentages now keys its layout cache without its containing block's size, which removed about 2,400 box layouts from the first layout (it was 339–340 ms, 24,193 layouts, and 2.2–2.7 ms per change).

A change lays out only the node, its ancestors and the siblings whose constraints changed: the test asserts that no node outside the edited section is laid out again. The maximum (54) comes from grid sections, where one item's width can change the column sizes and so every item's area. The remaining per-change cost is mostly the root's flex pass over its 100 sections, which mostly hits caches.

### Documents (`packages/document/test/layout.test.ts`, `e2e/document-bench.spec.ts`)

A 10,001-node document of 100 auto-layout frames (alternately wrapping flex and 10-column grids, padding and gaps) of 99 shapes each. In the editor it is `/?doc=layout10k`.

| Where | Edit | Median | Max | Nodes recompiled (median) |
|---|---|---|---|---|
| Node: command, layout and bridge, plus `DrawList.sync` | a child's width | 1.5–1.9 ms | 9–13 ms | |
| Chromium, WebGPU / WebGL2 (`apply` through the page harness), two runs | a child's width | 2.1–2.2 / 2.0–2.2 ms | 15.3 / 11.2 ms | 8 |
| | a frame's gap | 2.7–2.8 / 2.6–3.0 ms | 13.7 / 8.3 ms | 99 (every child moves) |
| | a frame's padding | 2.8–3.7 / 2.6–3.0 ms | 5.8 / 8.5 ms | 100 |

The next frame, zoomed in, takes 1.2–2.7 ms of CPU. Building this document's bridge (layout and scene) takes about 1.1 s in Node, and the editor page is ready in about 2.1 s on WebGPU and 2.8–2.9 s on WebGL2. Each edit relays out one frame: other frames keep their cached layout, and nothing outside the edited frame is recompiled (asserted).

### What could be faster

- **The initial build.** For each of 10k nodes it builds the CSS declarations from Yjs reads and parses them, which takes about half of the 0.6 s that layout adds to the bridge build. Building styles directly from stored properties would skip the string round trip, but would duplicate the CSS mapping. We chose one mapping, shared with code export, because it is the contract that conformance checks.
- **The first layout of a large tree** (about 0.34 s at 10k nodes) is JavaScript doing what browser engines do in C++. String cache keys and per-call style resolution show up in profiles.

## Text engine (Module 4)

Measured on 2026-10-12 on the machine above. Node 22 numbers come from each test file run alone, twice; Chromium numbers from `npm run bench`, where both backends run on SwiftShader.

### A 10,000-character paragraph (`packages/text/test/perf.test.ts`)

Inter 16 px with about 40 style runs (alternating regular and bold), laid out at 600 px (138 lines):

| What | Time |
|---|---|
| Shaping: `text-transform` and white space, bidi, itemization and font matching, HarfBuzz, spacing and line break opportunities | 31–46 ms median (110–145 ms the first time, with JIT warm-up) |
| Line layout at 600 px (breaking, line boxes, alignment, glyph placement, grapheme boxes) | 20–28 ms |
| Relayout at another width (shaping cached) | 18–32 ms |
| `text-wrap: pretty` | 24–32 ms |
| Min-content and max-content widths | 22–28 ms |

### A 10,001-node document with 2,000 text nodes (`packages/document/test/text-perf.test.ts`, `/?doc=text10k`)

100 auto-layout cards (580 × 380, a flex column) each hold a heading, a hugging flex row of six text labels, thirteen wrapping paragraphs (fill width, 12 px, 130% line height) and a wrapping frame of 77 swatches. An edit inserts text into one paragraph or one label through the command API.

| Where | What is timed | Median | Max |
|---|---|---|---|
| Node | Building the bridge: layout (2,000 paragraphs shaped once each) and the scene | 2.1–2.4 s (build), then 0.10–0.18 s for the first draw-list compile | |
| Node | A paragraph edit: command, Yjs, text layout, layout, bridge, `DrawList.sync` | 2.4–3.0 ms | 7–11 ms |
| Node | A label edit (the row and its card reflow) | 2.3–3.2 ms | 4–6 ms |
| Chromium WebGPU / WebGL2 | A paragraph edit through the page harness | 2.0–2.3 / 2.2–2.6 ms | 5.6–15.7 / 12–14 ms |
| Chromium WebGPU / WebGL2 | A label edit | 2.2–2.4 / 2.5–2.9 ms | 3.8–4.5 / 5.3–8.4 ms |
| Chromium WebGPU / WebGL2 | The next frame's CPU after an edit, zoomed in on four cards | 3.5–5.5 / 2.5–4.6 ms | |
| Chromium WebGPU / WebGL2 | A steady-state pan frame's CPU (second sweep over the same ground, 40 frames) | 0.3–0.4 / 0.1–0.2 ms | 3.0–8.2 / 0.6–1.8 ms |

What the tests assert, and what the numbers show:
- **An edit touches one text.** Each edit shapes exactly one paragraph (`ShapedParagraph.shapedCount`), lays out again at most the edited text and its ancestors (every node's `layoutRuns` is compared before and after: the paragraph and its card; for a label, the label, its row and its card), and recompiles one scene node for a paragraph (the label edit also moves its row's other labels: 5–7 nodes). The siblings of a growing label stay cached because a text leaf's layout does not depend on its containing block's size.
- **Typing changes geometry, not structure.** A text node draws one glyph run per font, size and paint, merged across its lines, and reuses its scene nodes, so typing (even when it rewraps lines) updates geometry and the draw list syncs incrementally. Before this, every keystroke recompiled the draw list (60 ms per edit at this size).
- **Panning rasterizes no glyphs.** On a second sweep over the same ground at a fixed zoom, both backends rasterize **0** glyphs (asserted); after the edits above, the first sweep needed none either, because the cards share their glyphs. Zooming rasterizes each glyph once per size bucket and subpixel phase (the editor test asserts this too).
- **The overview.** Rendering the whole document directly at 12.5% zoom (all 2,000 texts, 168 glyph bitmaps at that size) takes 139–200 ms of CPU on WebGPU, mostly frame planning (glyph placement for about 150,000 glyphs). On WebGL2 the same frame blocks for 2.7–2.8 s, about as long without drawing any glyphs (measured by skipping them): it is SwiftShader rendering 100 clipping cards and 7,700 swatches through the MSAA path, as in the other 10k-node documents. Consecutive glyph entries draw as one instanced draw.
- **Opening.** The editor page is ready, with its fonts loaded and every text laid out, in 3.4–3.8 s on WebGPU and 4.4–5.6 s on WebGL2. Shaping is about a quarter of the build: 2,000 paragraphs at about 0.25 ms each.

### Glyph atlas

Unit tests (`packages/renderer/test/glyphs.test.ts`) check the coverage rasterizer against exact polygon areas (within 8-bit rounding), caching (a glyph is rasterized once per size bucket and subpixel phase), eviction (least recently used first, never a glyph of the current frame), that panning re-rasterizes nothing, and that rotated or zoomed-in runs draw as outline paths.

## Editing (Module 5a)

Measured on 2026-10-12 on the machine above (`e2e/editing-bench.spec.ts`, part of `npm run bench`; `packages/editor-core/test/perf.test.ts` for Node). Real mouse and keyboard input through Playwright on 10,000-node documents, zoomed in so a few frames are on screen. Each input waits for the frame that shows it. Ranges are over four runs; p95 varies most (an occasional garbage collection or SwiftShader stall lands on a frame).

**Input-to-frame latency (CPU)** is the CPU work from an input event to the end of the frame that shows it: handling the input (the editor's state machine, the command with its zod validation and Yjs transaction, layout, the bridge recompiling what changed) plus the frame's render CPU (draw-list update, frame planning, encoding). GPU time is not in it: here every frame is rasterized by SwiftShader on the CPU, and the wall clock from input to the end of the frame's CPU work is dominated by waiting for SwiftShader to finish the previous frame (both are reported).

| Scenario | Backend | Input-to-frame CPU, median / p95 | Input handling (median) | Frame CPU (median) | Wall clock (median) | Nodes recompiled per frame (max, counted per frame) |
|---|---|---|---|---|---|---|
| Drag one shape (`/?doc=grid10k`, 30 steps) | WebGPU | 5.4–7.3 / 9–27 ms | 3.0–3.7 ms | 2.3–2.8 ms | 300–390 ms | 1 |
| | WebGL2 | 5.4–6.3 / 10–13 ms | 2.5–3.1 ms | 2.4–3.1 ms | 165–187 ms | 1 |
| Resize one shape with its corner handle | WebGPU | 2.9–4.0 / 6–9 ms | 1.2–1.4 ms | 1.5–2.6 ms | 287–349 ms | 1 |
| | WebGL2 | 3.6–5.0 / 7–9 ms | 1.1–1.2 ms | 2.1–3.0 ms | 166–188 ms | 1 |
| Type 45 characters into a paragraph (`/?doc=text10k`, 2,000 texts) | WebGPU | 14.5–15.8 / 25–30 ms | 2.4–3.3 ms | 11.9–12.5 ms | 292–373 ms | 1 |
| | WebGL2 | 8.5–10.7 / 19–29 ms | 2.7–3.4 ms | 5.2–7.1 ms | 201–236 ms | 1 |

What the numbers and the assertions show:
- **Edits touch one node.** A drag or resize step recompiles exactly the dragged node, and a keystroke the edited text (asserted: at most 2 for gestures and well under the card's size for typing; measured 1 in every frame). Gestures write to the document on every pointer move (that is what collaborators see), and all the steps of a gesture are one undo step.
- **Where the time goes.** Handling one pointer move takes about 1–4 ms (the command layer and layout dominate; hit-testing is not involved during a drag). Typing pays for shaping and laying out the paragraph again (about 3 ms with the editor around it) and a frame with more glyph work (5–13 ms CPU, the WebGPU encoder doing more per glyph entry than WebGL2's instanced draw).
- **Wall clock.** Between 0.17 and 0.4 s per frame here, almost all of it SwiftShader. When the GPU is idle at the moment of input (the first measurements, which waited for the GPU between inputs) the wall clock was 6–12 ms for drags and resizes.

In Node (`perf.test.ts`, 100 frames × 99 shapes): picking the node under the pointer (hover) takes 0.8 ms median, a marquee over seven frames 3 ms, and a drag step through the editor 3–4 ms (no rendering). Hover runs on every pointer move, so this is the budget that matters at 10k nodes.

## Pending: real-GPU numbers

The architecture is aimed at real GPUs:
- WebGPU: few dispatches per frame, all indirect where the size is GPU-determined; no per-draw state; occlusion culling per tile.
- WebGL2: multi-draw and instanced batches.

To fill in this table on hardware, run `npm run build && npm run bench` on a machine with a GPU. Drop the SwiftShader flags in `playwright.config.ts`, or open `/bench` in a desktop browser, where the HUD shows FPS, frame time and per-stage GPU time.

| Hardware | Backend | Pan + zoom avg / p95 | Sustained pan avg / p95 |
|---|---|---|---|
| (pending) | WebGPU | | |
| (pending) | WebGL2 | | |
