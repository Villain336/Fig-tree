# Architecture

This document covers what Module 1 built: the geometry kernel, the GPU renderer and the benchmark. It also covers how the next modules (document model, layout, text) plug into them.

```
apps/editor ─────────────┐   Next.js shell, /bench, /render-test
                         ▼
packages/renderer        Scene ─► DrawList ─► FramePlan ─► Backend (WebGPU | WebGL2)
                         │                          ▲
                         │        rbush index ──────┘ culling and hit-testing
                         ▼
packages/geometry        Mat2D, Path, flatten, stroke, shapes  (no DOM, no GPU)
```

Dependencies point downward only:
- `geometry` is pure math and runs anywhere, including Node, a worker or a future WASM port.
- `renderer` depends on `geometry` and `rbush`.
- The app depends on both.

Both packages are TypeScript-strict internal workspace packages that export their sources. Next.js transpiles them, and Vitest and `tsc` read them directly.

## 1. Geometry (`packages/geometry`)

| Module | Notes |
|---|---|
| `matrix.ts` | Immutable 2×3 affine tuples (canvas/SVG convention). `maxScale` (the largest singular value) converts screen tolerances to local ones conservatively. |
| `path.ts` | Packed verbs plus `Float64Array` coordinates. `bounds()` is tight: it solves for curve extrema instead of using control points. |
| `flatten.ts` | Adaptive flattening with Wang's formula. The number of segments for each curve is `ceil(sqrt(k·M/tol))`, where `M` is the largest second difference of the control polygon and `k` is 1/4 for quadratics and 3/4 for cubics. `tol` is given in *output* space. Callers pass `screenTolerance / scale`, so the error bound holds in device pixels. Also provides winding numbers and point containment. |
| `stroke.ts` | The stroker emits closed polygons that are correct under the **nonzero** rule. Each contour becomes left-offset forward → cap → right-offset backward → cap (open contours), or two oppositely wound loops (closed contours). Joins: miter (falling back to bevel at the miter limit), round (arc steps from the chord-error tolerance) and bevel. The inner side of a join uses the offset-line intersection when it lies on both segments, and otherwise routes through the vertex, so the winding stays positive. Dashes follow SVG semantics: odd patterns repeat, a dash spanning the start of a closed contour is merged, and zero-length dashes with round or square caps draw dots. Stroking happens in local space, then the result is transformed, so non-uniform scales distort the pen like the canvas does. |
| `shapes.ts` | Rounded rectangles with per-corner radii, clamped like CSS `border-radius`. **Corner smoothing** is our own construction (below). Also ellipses. |

### Corner smoothing

A corner of radius `r` with smoothing `s ∈ [0, 1]` keeps a circular core but shrinks it to an arc of `90° − 2φ`, where `φ = 45°·s`. On each side, a cubic connects the core to the edge.

Let the cubic run from P0 (on the edge) to P3 (on the core arc). P1 and P2 lie on the edge line, and P2→P3 is tangent to the arc. That gives:
- Curvature `0` at P0, because P0, P1 and P2 are collinear.
- Curvature `1/r` at P3. Solving the endpoint curvature formula gives `b = r·tan(φ/2)` for the handle length |P2P3| and `c = 3b²/(2r·sin φ)` for |P1P2|.

The free handle `a` is chosen so that the corner begins exactly `r(1+s)` from the vertex. The corner is therefore G2 at both joins, and `s = 0` reduces to the plain circular corner. When an edge is too short for `r(1+s)`, smoothing is reduced for that corner only; the radius is never reduced. Property tests check:
- tangent continuity at every joint;
- curvature values 0 and 1/r;
- tight bounds;
- that area shrinks monotonically as `s` grows.

## 2. Renderer (`packages/renderer`)

### 2.1 Retained scene → draw list

`Scene` and `SceneNode` hold `transform`, `path`, `fill` (solid, linear or radial gradient), `fillRule`, `stroke`, `opacity`, `clipsContent` and `visible`. Mutations bump separate versions:
- **structure**: tree, visibility, opacity, clip, presence of a fill or stroke;
- **transform**;
- **geometry**: path or stroke style;
- **paint**: lazy, checked when a paint is used.

A transform edit therefore never re-flattens, and a color edit never touches geometry buffers.

`DrawList.sync` compiles the tree into paint order:
- Each node emits its fill, then its children, then its stroke.
- Opacity on a node with a single draw is folded into that draw.
- Group opacity over more than one draw becomes an isolated **layer** (`BeginLayer`/`EndLayer`).
- `clipsContent` wraps the children in a layer clipped by the node's fill path.
- Up to 8 layers can be nested; beyond that, opacity is folded (not isolated) and clips are ignored, with a single console warning.

Each fill's world bounds are intersected with its ancestor clip rects and loaded into an **rbush** index. `GeometrySlot`s (the flattened data of a node and its role) survive recompiles, so a structural edit does not throw away flattened geometry or GPU uploads.

### 2.2 Frame planning

`planFrame` runs once per frame:
1. Queries the index with the viewport (in world space).
2. Sorts the hits into paint order.
3. Re-opens only the layers that contain visible content.
4. For every entry, produces a **local → device matrix** and device bounds clipped to the target.

Geometry is requested at a **flattening level**: `L = ceil(log2(scale))`, with local tolerance `0.1 px / 2^L`. A cached level is reused while it is between 0 and 2 levels finer than needed. Zooming therefore re-flattens only when it crosses a power-of-two threshold, and panning never re-flattens.

Segments are stored in **local space**. This has two effects:
- Moving, rotating or scaling a node changes only its 24-byte matrix in the per-frame entry list, never its uploaded segments.
- Float32 precision stays local, which avoids precision loss far from the world origin.

### 2.3 WebGPU backend: tiled analytic coverage

All rasterization runs in WGSL compute shaders (`src/webgpu/shaders.ts`). The CPU uploads a compact entry list each frame (80 bytes per visible draw: matrix, flags, tile box, offsets). Geometry and paints live in persistent arenas (`RangeAllocator` with coalescing free lists) keyed by upload id, and are swept when nodes leave the scene.

| Stage | Dispatch | Work |
|---|---|---|
| **bin** | 1 thread per segment | Transform to device space, clip to the entry's 16×16 tile box, split into per-tile pieces (tile-local coordinates) and push them onto per-tile linked lists. Record the crossings of each tile row's top edge for backdrops. |
| **tiles** | 1 thread per (entry, tile row) | Prefix-sum the backdrops along the row. Allocate an 8-bit coverage mask for each tile that has pieces. Set the entry's bit in that screen tile's z-order bitmap (256 entries per chunk). |
| **lists** | 1 thread per screen tile | Scan the bitmap once and write a compact, ordered entry list. **Occlusion culling:** the list starts at the topmost opaque solid fill (not inside a layer) whose tile is fully covered. |
| **coverage** | 1 workgroup per edge tile (indirect dispatch) | Each invocation computes 4 pixels: the exact integral of the winding number over the pixel, then the nonzero or even-odd rule, then packs the result into the mask. |
| **composite** | 1 workgroup per screen tile | Walk the tile's list. Evaluate solid, linear and radial paints (gradient stops interpolated unpremultiplied, then premultiplied) and blend them src-over in premultiplied alpha. A register stack of 8 handles layers: clip coverage × group opacity. A clip layer whose tile is empty skips its whole subtree. |

#### Coverage math

The coverage of pixel `p` is `∫ winding(x, y) dA`. Winding is counted with leftward rays: an edge heading down contributes +1 to points on its right.

For a tile, `winding = backdrop + (crossings of the tile's left edge above y) + (in-tile pieces)`:
- **Backdrop** is the winding just below the tile's top-left corner. It is the exclusive prefix sum, along the row, of the edges that cross the row's top line.
- **Left-edge crossings**: when the path crosses a tile's left edge strictly inside the band, the piece in that tile carries `yEdge` and `δ = −sign(dx)`. That adds `δ·clamp(py+1−yEdge, 0, 1)` to every pixel row below it.
- **In-tile pieces** are clipped to the pixel's row. Their contribution to the right of the edge, inside `[px, px+1]`, is integrated exactly with the antiderivative of `clamp(px+1−x, 0, 1)`.

Getting the boundary cases right took several rules, all found by property tests:
- **Left projection.** Geometry left of the entry's box (for example, offscreen) is projected onto the box's left edge.
- **Top crossings.** A crossing of the band's top line belongs to the column whose piece first *leaves* that line. This makes crossings that round onto the line consistent.
- **Vertical pieces on column lines.** A vertical piece lying exactly on an interior column line is assigned to the column on its left, so every move between "left of" and "inside" a column shows up as a piece endpoint at local `x = 0`.

`test/tile-reference.ts` is a line-for-line TypeScript mirror of `bin` and `coverage`. It is property-tested against exact per-pixel polygon clipping (Sutherland–Hodgman area) on random self-intersecting polygons and clipped boxes. It passed 6,000 random cases after these fixes.

Shared edges inside one path cancel exactly, so there are no cracks. Separate draws that abut at a *fractional* pixel position composite as `1 − (1−a)(1−b)`. This conflation artifact is shared with other analytic-AA renderers and is tracked in `parity.md`.

#### Capacity and robustness

- Pieces and masks are allocated with atomics against a fixed capacity. The counters are read back asynchronously. If a frame overflows, capacities grow and `renderComplete()` re-renders.
- Path tiles and lists are sized exactly from the CPU plan.
- If the z-order bitmaps would exceed 64 MB, the frame is split into several passes. Splits happen only between top-level steps, and each pass composites over the previous one with ping-pong textures.
- Optional `timestamp-query` timings per stage are exposed as `Renderer.gpuTimings` and shown on the benchmark HUD.

### 2.4 WebGL2 fallback: stencil-then-cover

The fallback uses the same `FramePlan`:
- **Stencil pass:** each fill's segments are uploaded once as triangles fanned from an anchor (in local space). The stencil is incremented on front faces and decremented on back faces for nonzero, or inverted for even-odd.
- **Cover pass:** instanced bounding quads with `NOTEQUAL 0`, which also reset the stencil.
- **Batching:** consecutive fills with the same rule and non-overlapping bounds (checked on a 32 px occupancy grid) are drawn with one `WEBGL_multi_draw` stencil call and one instanced cover call.
- **Data textures:** per-draw matrices and paints come from RGBA32F textures, so batches need no uniform changes.
- **Anti-aliasing:** 4x MSAA renderbuffers, resolved with a blit.
- **Layers:** an MSAA FBO stack. A clip composites the resolved layer through the clip path's stencil.
- `settle()` polls a `fenceSync`, so benchmark frame times include GPU completion.

### 2.5 Screen-tile cache

Adapted from Penpot's tile scheduler (`src/ported/penpot/tiles.ts`, MPL-2.0): visible and interest tile rects, center-out priority, and an interest ring deferred until the viewport is done.

`TileCache` stores 256 px device tiles in a 4096 px atlas:
- Eviction is least-recently-used and never evicts a visible tile.
- The grid is anchored to the world origin, and the view translation is snapped to whole device pixels. A pan therefore moves cached tiles exactly and rasterizes only the tiles that scroll into view.
- Uncached tiles are grouped into a few rectangles (row runs merged downward), so a diagonal pan renders two strips instead of the whole screen.
- Pre-rendering of the interest ring happens a strip at a time, only while the view is idle.

The `Renderer` renders **directly** on frames where the scale or the scene changed, since every tile would be invalid then. It uses the cache only while both are stable. A pixel test checks that a panned, tile-cached frame matches direct rendering on both backends.

### 2.6 Hit-testing

`Renderer.hitTest` queries the rbush index at the point and walks the hits from top to bottom. For each one it checks:
- containment in the flattened geometry, in local space, with the item's fill rule; strokes are tested against their outline polygons;
- every ancestor clip.

Hits agree with pixels to within the flattening tolerance.

### 2.7 Testing

| Layer | Tests |
|---|---|
| Geometry | Property tests: flatten error ≤ tolerance, tight bounds, stroke coverage equals distance to the spine (round joins and caps), dash lengths, corner smoothing invariants. Ported Penpot path vectors. |
| Tiling math | Reference-mirror property tests against exact polygon clipping. |
| Renderer CPU | Scene versions, draw-list ordering and layers, culling, zoom-level hysteresis, paint caching, hit-testing, the range allocator, the tile cache. |
| GPU (Playwright) | Exact analytic coverage (fractional rect, circle), crack-free shared edges, gradients against reference stop math, even-odd, isolated group opacity and clips, occlusion, tiled vs direct, goldens per backend, cross-backend agreement. |
| Benchmark (Playwright) | 5 s of mixed pan and zoom, plus 5 s of sustained pan, per backend. Asserts that panning uploads 0 bytes. |

## 3. How the next modules plug in

### Document model (Yjs CRDT)

The document is a Yjs structure: maps of nodes keyed by stable ids, with ordered child arrays. The renderer's `Scene` is a *projection* of it:
- A sync layer observes Yjs deep events and applies them to `SceneNode` setters.
- The per-aspect versions mean that remote edits re-derive only what they touch.
- Multiplayer cursors and selections render as an overlay scene on top of the document scene, so they never invalidate document tiles.
- Paths are stored as compact SVG-like strings or arrays and become `Path` objects at the boundary.

### Layout (CSS flexbox and grid)

The layout engine is a pure function `(node styles, intrinsic sizes) → boxes` that sits between the document and the scene. Its output sets the transforms and sizes of `SceneNode`s, and auto-sized frames feed path rebuilds through `roundedRectPath`.
- It runs incrementally: dirty subtrees only.
- It is tested against a Chromium conformance suite (render the same HTML in Chromium, compare boxes).
- The renderer needs nothing new, because layout only produces transforms and geometry.

### Text (harfbuzzjs and a glyph atlas)

Shaping produces glyph runs through harfbuzzjs. The renderer will gain one new entry kind, a **glyph-run fill**:
- At small sizes, glyphs come from a coverage atlas built by the same analytic rasterizer (each glyph's outline is binned once into an atlas tile).
- At large zoom, glyphs fall back to outline paths through the existing fill path.

The composite stage already has the per-entry paint and layer machinery that text decorations and text fills need.

### Later modules

- **Vector networks and booleans:** these produce paths. The robust winding-number boolean approach uses the same flattening and winding primitives.
- **Effects** (blur, shadows) and **shader fills:** new composite inputs that sample from layer textures.
- **Code view and export:** walk the document, not the scene.
- **MCP and the Sprout agent:** call the same document operations as the UI.

## 4. Known limitations

See [`parity.md`](parity.md) → "Renderer limitations" for the honest list.
