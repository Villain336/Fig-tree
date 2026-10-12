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
| Chromium, 9–21 updates per kind and view | `apply` through the page harness, including layout and the bridge (the draw list updates during the next frame) | 0.7–1.2 ms | 6.3 ms |

Before layout existed these were 0.13–0.30 ms in Node and 0.3–0.9 ms in Chromium. A fill edit skips layout entirely; an `x` or `width` edit restyles the shape and relays out its frame, where the other 98 shapes hit their caches. Every update still recompiles exactly one node (`bridge.lastCompiled === 1`, asserted). The test requires the median to stay under 16 ms.

The frame after an update renders directly, because the tile cache is invalidated:

| Backend | View | Frame CPU median |
|---|---|---|
| WebGPU | zoomed in (one frame on screen) | 0.9–1.1 ms |
| WebGL2 | zoomed in | 1.3–1.5 ms |
| WebGPU | overview, all 10k nodes visible | 33–37 ms (frame planning of about 11k draws, plus encoding) |
| WebGL2 | overview | 1,080–1,130 ms (blocked on SwiftShader; see below) |

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
| First layout | 339–340 ms (24,193 box layouts and 6,633 intrinsic-size computations; it includes JIT warm-up) |
| Full relayout after marking every node dirty | 166–195 ms |
| One property change (a child's width or flex factor), then relayout: median | 2.2–2.7 ms |
| Same, max over 41 changes | 8.4–12.4 ms |
| Boxes laid out again per change: median / max | 8 / 54 |

A change lays out only the node, its ancestors and the siblings whose constraints changed: the test asserts that no node outside the edited section is laid out again. The maximum (54) comes from grid sections, where one item's width can change the column sizes and so every item's area. The remaining per-change cost is mostly the root's flex pass over its 100 sections, which mostly hits caches.

### Documents (`packages/document/test/layout.test.ts`, `e2e/document-bench.spec.ts`)

A 10,001-node document of 100 auto-layout frames (alternately wrapping flex and 10-column grids, padding and gaps) of 99 shapes each. In the editor it is `/?doc=layout10k`.

| Where | Edit | Median | Max | Nodes recompiled (median) |
|---|---|---|---|---|
| Node: command, layout and bridge, plus `DrawList.sync` | a child's width | 1.5–1.9 ms | 9–13 ms | |
| Chromium, WebGPU / WebGL2 (`apply` through the page harness) | a child's width | 2.1 / 2.2 ms | 9.3 / 9.0 ms | 8 |
| | a frame's gap | 2.7 / 3.0 ms | 5.7 / 8.0 ms | 99 (every child moves) |
| | a frame's padding | 2.8 / 3.0 ms | 5.2 / 8.5 ms | 100 |

The next frame, zoomed in, takes 1.2–2.6 ms of CPU. Building this document's bridge (layout and scene) takes about 1.1 s in Node, and the editor page is ready in about 2.1 s on WebGPU and 2.8 s on WebGL2. Each edit relays out one frame: other frames keep their cached layout, and nothing outside the edited frame is recompiled (asserted).

### What could be faster

- **The initial build.** For each of 10k nodes it builds the CSS declarations from Yjs reads and parses them, which takes about half of the 0.6 s that layout adds to the bridge build. Building styles directly from stored properties would skip the string round trip, but would duplicate the CSS mapping. We chose one mapping, shared with code export, because it is the contract that conformance checks.
- **The first layout of a large tree** (about 0.34 s at 10k nodes) is JavaScript doing what browser engines do in C++. String cache keys and per-call style resolution show up in profiles.

## Pending: real-GPU numbers

The architecture is aimed at real GPUs:
- WebGPU: few dispatches per frame, all indirect where the size is GPU-determined; no per-draw state; occlusion culling per tile.
- WebGL2: multi-draw and instanced batches.

To fill in this table on hardware, run `npm run build && npm run bench` on a machine with a GPU. Drop the SwiftShader flags in `playwright.config.ts`, or open `/bench` in a desktop browser, where the HUD shows FPS, frame time and per-stage GPU time.

| Hardware | Backend | Pan + zoom avg / p95 | Sustained pan avg / p95 |
|---|---|---|---|
| (pending) | WebGPU | | |
| (pending) | WebGL2 | | |
