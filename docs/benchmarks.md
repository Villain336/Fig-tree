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

A 10,001-node document: one page with 100 frames, each holding 99 shapes. A third of the shapes are ellipses and the rest rounded rectangles; a tenth have inside strokes and a seventh have gradient fills. The same document is built by the unit test (`packages/document/test/bridge.test.ts`) and by the editor at `/?doc=grid10k` (`e2e/document-bench.spec.ts`, run with `npm run bench`). The edit changes one property of one shape (a fill color, `x`, or `width`).

What one update costs, measured on 2026-10-11 on the machine above:

| Where | What is timed | Median | Max |
|---|---|---|---|
| Node 22 (Vitest), 3 runs × 41 updates per kind | `doc.apply` (zod validation, draft, one Yjs transaction), the change event, the bridge recompiling the one node, and `DrawList.sync` (incremental) | 0.13–0.30 ms | 2.7 ms |
| Chromium, 9–21 updates per kind and view | `apply` through the page harness, including the bridge (the draw list updates during the next frame) | 0.4–0.9 ms | 6.9 ms |

Every update recompiles exactly one node (`bridge.lastCompiled === 1`, asserted). The test requires the median to stay under 16 ms.

The frame after an update renders directly, because the tile cache is invalidated:

| Backend | View | Frame CPU median |
|---|---|---|
| WebGPU | zoomed in (one frame on screen) | 1.0 ms |
| WebGL2 | zoomed in | 1.3–1.9 ms |
| WebGPU | overview, all 10k nodes visible | 34–44 ms (frame planning of about 11k draws, plus encoding) |
| WebGL2 | overview | about 1,000 ms (blocked on SwiftShader; see below) |

At the overview, the WebGL2 frame waits on SwiftShader. Its 500 clip layers (100 clipping frames, and 400 inside strokes on ellipses, which need a clip) each resolve and composite an offscreen MSAA target. Rectangles' inside strokes need no layer since this module, which cut this frame from about 1,240 ms. Full-screen WebGL2 frames in `/bench` cost about the same.

Loading the same document: creating 10k nodes with one command batch takes about 0.7 s, building the scene through the bridge about 0.4 s, and the first draw-list compile about 0.15 s (Node). The editor page is ready in 1.2–1.4 s on WebGPU and 2.9–3.3 s on WebGL2.

Two renderer changes made these numbers possible:
- Transform and geometry edits update the draw list incrementally: 0.2–1.7 ms instead of an 80–130 ms recompile at 10k nodes.
- `SceneNode.replaceChildren` relinks a container's children in O(children).

## Pending: real-GPU numbers

The architecture is aimed at real GPUs:
- WebGPU: few dispatches per frame, all indirect where the size is GPU-determined; no per-draw state; occlusion culling per tile.
- WebGL2: multi-draw and instanced batches.

To fill in this table on hardware, run `npm run build && npm run bench` on a machine with a GPU. Drop the SwiftShader flags in `playwright.config.ts`, or open `/bench` in a desktop browser, where the HUD shows FPS, frame time and per-stage GPU time.

| Hardware | Backend | Pan + zoom avg / p95 | Sustained pan avg / p95 |
|---|---|---|---|
| (pending) | WebGPU | | |
| (pending) | WebGL2 | | |
