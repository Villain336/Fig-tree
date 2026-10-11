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

Across five runs on this machine, the averages ranged as follows:

| Backend | Pan + zoom avg | Sustained pan avg |
|---|---|---|
| WebGPU | 349–476 ms | 41–50 ms |
| WebGL2 | 552–624 ms | 44–47 ms |

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

## Pending: real-GPU numbers

The architecture is aimed at real GPUs:
- WebGPU: few dispatches per frame, all indirect where the size is GPU-determined; no per-draw state; occlusion culling per tile.
- WebGL2: multi-draw and instanced batches.

To fill in this table on hardware, run `npm run build && npm run bench` on a machine with a GPU. Drop the SwiftShader flags in `playwright.config.ts`, or open `/bench` in a desktop browser, where the HUD shows FPS, frame time and per-stage GPU time.

| Hardware | Backend | Pan + zoom avg / p95 | Sustained pan avg / p95 |
|---|---|---|---|
| (pending) | WebGPU | | |
| (pending) | WebGL2 | | |
