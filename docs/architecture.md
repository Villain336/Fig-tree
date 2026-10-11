# Architecture

This document covers what Modules 1 and 2 built: the geometry kernel, the GPU renderer and its benchmark (Module 1), and the CRDT document model with its command API, file format and renderer bridge (Module 2). It also covers how the next modules (layout, text) plug in.

```
apps/editor ──────────────┐  Next.js: editor (/), /bench, /render-test
  │ commands              ▼
  │                packages/document   FigDocument (Yjs) ──DocumentChange──► SceneBridge
  │                  │  commands ─► Draft ─► one Y transaction    │
  │                  │  propose() ─► fork ─► diff ─► accept/reject │
  │                  │  .figtree  (document.json + assets + history.yjs)
  │                  ▼                                             ▼
  └────────►  packages/renderer   Scene ─► DrawList ─► FramePlan ─► Backend (WebGPU | WebGL2)
                     │                          ▲
                     │        rbush index ──────┘ culling and hit-testing
                     ▼
              packages/geometry   Mat2D, Path, flatten, stroke, shapes  (no DOM, no GPU)
```

Dependencies point downward only:
- `geometry` is pure math and runs anywhere, including Node, a worker or a future WASM port.
- `renderer` depends on `geometry` and `rbush`.
- `document` depends on `geometry`, `renderer` (for the bridge only), `yjs`, `zod` and `fflate`. Nothing in it touches the DOM: it runs in Node for tests and in the editor.
- The app depends on all three.

All packages are TypeScript-strict internal workspace packages that export their sources. Next.js transpiles them, and Vitest and `tsc` read them directly.

## 1. Geometry (`packages/geometry`)

| Module | Notes |
|---|---|
| `matrix.ts` | Immutable 2×3 affine tuples (canvas/SVG convention). `maxScale` (the largest singular value) converts screen tolerances to local ones conservatively. |
| `path.ts` | Packed verbs plus `Float64Array` coordinates. `bounds()` is tight: it solves for curve extrema instead of using control points. |
| `flatten.ts` | Adaptive flattening with Wang's formula. The number of segments for each curve is `ceil(sqrt(k·M/tol))`, where `M` is the largest second difference of the control polygon and `k` is 1/4 for quadratics and 3/4 for cubics. `tol` is given in *output* space. Callers pass `screenTolerance / scale`, so the error bound holds in device pixels. Also provides winding numbers and point containment. |
| `stroke.ts` | The stroker emits closed polygons that are correct under the **nonzero** rule. Each contour becomes left-offset forward → cap → right-offset backward → cap (open contours), or two oppositely wound loops (closed contours). Joins: miter (falling back to bevel at the miter limit), round (arc steps from the chord-error tolerance) and bevel. The inner side of a join uses the offset-line intersection when it lies on both segments, and otherwise routes through the vertex, so the winding stays positive. Dashes follow SVG semantics: odd patterns repeat, a dash spanning the start of a closed contour is merged, and zero-length dashes with round or square caps draw dots. Stroking happens in local space, then the result is transformed, so non-uniform scales distort the pen like the canvas does. |
| `shapes.ts` | Rounded rectangles with per-corner radii, clamped like CSS `border-radius`. **Corner smoothing** is our own construction (below). Ellipses, and ellipse arcs: pies, ring segments and donuts (oppositely wound contours). Regular polygons and stars stretched to fill their box exactly, and polygons with every corner rounded by a tangent arc whose radius is clamped to half of each adjacent edge. |

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

`DrawList.sync` brings the draw list up to date. A structural change (tree, visibility, opacity, clips, a node gaining or losing a fill, stroke or path) recompiles it; a transform or geometry change only re-derives the matrices and bounds of the edited subtrees, the bounds of their enclosing layers and their R-tree entries (each drawn node keeps its item range). Moving one shape in a 10k-shape scene costs well under a millisecond instead of a full recompile. A compile walks the tree into paint order:
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
- Render targets for layers are created lazily, mid-frame. Their setup binds textures only on the layer compositing unit, so the entry, paint and gradient-stop textures on the other units stay bound. A clip's stencil and its compositing cover run under the layer's scissor rect, so stencil never outlives the cover that resets it. Both rules came from bugs found by the editor's sample document; each has a pixel test.

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

## 3. Document model (`packages/document`)

### 3.1 Storage

A document is a Yjs `Y.Doc` with three top-level maps:

| Map | Contents |
|---|---|
| `nodes` | Node id → `Y.Map` with `type`, `placement`, one key per stored property (plain JSON values), and `content` (a `Y.Text`) for text nodes. |
| `assets` | Asset id (SHA-256 of the bytes) → metadata (`mimeType`, `byteLength`, pixel size, name). Append-only; the bytes live in an `AssetStore` and in `.figtree` files, not in the CRDT. |
| `meta` | Document name. |

One key per property means concurrent edits to different properties of the same node merge, and edits to the same property resolve last-writer-wins (by Yjs' deterministic ordering). Values are deep-frozen when stored and when read, so a caller cannot mutate the document through a returned object.

Node ids are 16 random base-62 digits and are never reused, not even after a delete: undoing a delete restores the node under its id. `FigDocument.idUsed` checks Yjs' record of every key the map ever held.

### 3.2 Node types and CSS-semantic properties

Node types: `page`, `frame`, `group`, `rectangle`, `ellipse` (arc start, sweep and inner radius), `polygon`, `star`, `line`, `vector` (vector network), `text` (content plus style runs), `image` (asset reference with `object-fit`), and `component` / `instance` with reserved fields. Pages hang off the document root, only pages hang off the root, and only pages, frames, groups, components and instances have children.

Every property is defined once as a zod schema in `src/schema/`, grouped like CSS:

| Group | Properties | CSS meaning |
|---|---|---|
| Geometry | `x`, `y`, `width`, `height`, `rotation`, `flipX`, `flipY` | `left`/`top` of the unrotated border box relative to the parent's border box; `transform: rotate() scale(±1)` about the center. Until the layout engine exists, these hold the last laid-out box and drive rendering. |
| Sizing | `widthMode`/`heightMode` (`fixed`, `hug`, `fill`), `min/maxWidth`, `min/maxHeight`, `aspectRatio` | `fixed` → `width: Npx` (`flex-shrink: 0` on a flex main axis); `hug` → `fit-content`; `fill` → `flex: 1 1 0px` on a flex main axis, `align-self: stretch` on a cross axis, `justify/align-self: stretch` in grid, `100%` otherwise. |
| Position | `position` (`absolute`, `relative`, `fixed`, `sticky`), `constraints` | `absolute` nodes get insets from their constraints: `start`, `end`, `start-end` (both insets, size follows), `center` (`calc(50% ± offset)`), `scale` (percentages). |
| Box | `boxSizing`, `padding`, `strokesInLayout` | `strokesInLayout` turns stroke weights into `border-*-width`; otherwise strokes are paint only, like `outline`. |
| Container | `display` (`block`, `flex`, `grid`), flex direction/wrap/justify/align, gaps, grid templates (track sizes, `repeat()`, `minmax()`, `fit-content()`, named areas), auto tracks and flow | Stored now, computed by the layout engine (module 3). `block` means children are positioned absolutely, like a classic canvas frame. |
| Item | `flexGrow`, `flexShrink`, `flexBasis`, `alignSelf`, `justifySelf`, `order`, `gridColumn`, `gridRow`, `margin` | As in CSS. |
| Clip and corners | `overflowX`/`overflowY`, `cornerRadius` (uniform or per corner), `cornerSmoothing` | Anything but `visible` clips children. Radii clamp like `border-radius`. |
| Compositing | `opacity`, `blendMode` (`mix-blend-mode`), `isolation`, `visible`, `locked` | `isolation: auto` with blend mode `normal` is "pass through". |
| Paint | `fills`, `strokes` (paint stacks), `strokeWeight` (per side on boxes), `strokeAlign`, cap, join, miter limit, dashes, dash offset, `effects` | Stacks are in paint order (index 0 at the bottom; CSS `background` lists the top first, so export reverses them). Paints: solid; linear, radial, angular and diamond gradients with handles normalized to the node's box; image (`cover`, `contain`, `stretch`, `tile`, `crop`, filters); reserved `shader`. Effects: drop and inner shadows, layer and background blurs. |
| Typography | font family, weight (1–1000), style, size, line height, letter spacing, decoration, transform, OpenType features and variation axes, fills; text box: alignment, vertical alignment, paragraph spacing and indent, `text-overflow`, `line-clamp`, `white-space` | Node properties are the base style; runs override any subset per character range. |
| Components (reserved) | `componentRef` and `overrides` on any node, `componentId` and `propertyValues` on instances, `description` and `propertyDefinitions` on components | Room for the override model of module 7: a node in an instance points at the main node it mirrors and lists the property groups it overrides ("touched" groups). |

An unset property takes a default that follows CSS initial values, with one deliberate exception (`white-space: pre-wrap`, so typed text keeps its spaces and breaks). The command layer adds creation-time conveniences on top: names, a 100×100 size for shapes, `overflow: hidden` for new frames (designers expect frames to clip), and `position: relative` for children created inside flex and grid containers. `cssDeclarations(doc, id)` states the CSS of a node's layout and box properties and is unit-tested per case.

Vector networks store vertices, cubic segments (tangents relative to their vertices) and regions (loops of segments, each region with its own fill rule and optional fills). The schema checks that segments reference existing vertices and that every loop closes.

Text content is a `Y.Text`: style runs are Yjs formatting attributes, so concurrent typing and styling merge. Object-valued styles are stored as canonical JSON strings because Yjs merges adjacent formatting by value identity. The draft layer models Yjs' formatting rules (an insert without a style continues the style before it), and a property test checks the model against Yjs.

### 3.3 Tree: placements, order keys and repair

Each node stores one `placement` value: `{ parent, key, clock, prev }`. Writing parent and order key together makes a move one last-writer-wins write.

- **Order keys** are base-62 fractional strings. Siblings sort by `(key, id)`, so even equal keys from concurrent inserts order identically everywhere. A new key takes a random digit inside the gap plus random jitter digits. Appends step up from the bottom of an open gap (about one digit of key length per 30 appends), batches bisect, and siblings that tie with the left neighbour are re-keyed.
- **The effective tree** is computed from raw placements by `Tree` and is the same on every replica with the same Yjs state. Concurrent moves and deletes can leave raw placements that are not a tree, and they are repaired deterministically:
  - A node whose parent is gone (or cannot hold it) returns to its previous parent (`prev`); a node created inside a parent deleted concurrently is dropped (deletion wins). Undoing that delete brings the node back.
  - In a cycle, the member with the latest move (highest Lamport `clock`, then id) returns to its previous parent, then to the first page if that fails.
  Nodes that reach the root are final, so repair rounds only revisit unsettled nodes.
- The tree is rebuilt only on structural changes, and only when someone reads it or listens for changes. Listeners get a `TreeDelta` (added, removed, reparented nodes and the containers whose child lists changed).

### 3.4 Commands

`doc.apply(commands, actor)` is the only mutation path, shared by the UI, the MCP server (module 10) and Sprout (module 11). The commands are `createNode`, `updateProps` (`null` resets a property), `rename`, `setParent` (keeps canvas position through rotated or flipped parents by default), `reorder`, `delete`, `duplicate`, `group`, `ungroup` (groups and frames), `setPage`, `setText`, `insertText`, `deleteText`, `formatText`, `addAsset` and `setDocumentName`.

- **Validation.** Each command is parsed with zod, then checked against the document: existence, parent and child types, cycles, property applicability per type, values, assets that exist and text ranges. Errors carry the command's index in the batch and paths such as `rectangle r1: fills.0.color.a: Invalid input`.
- **Atomic batches.** Yjs cannot roll a transaction back, so commands run against a `Draft`: an overlay with its own placements, properties, text spans and incrementally maintained child lists. Only a fully valid batch is written, in one Yjs transaction whose origin is the actor. A rejected batch changes nothing.
- **Results.** Each command returns the ids it affected, created and deleted.

### 3.5 Undo and redo

Each actor (`doc.actor(id, kind)`, interned so origins compare by identity) gets a `Y.UndoManager` scoped to transactions whose origin is that actor. One `apply` call is one undo step. Undo never reverts another actor's changes. An undone property that someone else has since overwritten keeps their value. Remote updates and system actors are never tracked. Selection is not in the document.

Known consequence of delete-wins: undoing your own creation of a frame also hides what others put inside it in the meantime, until that undo is redone.

### 3.6 Proposals: fork and diff

`propose(doc, commands, author)` forks the document (a new `Y.Doc` with the same history and its own client id), applies the batch there and returns a `Proposal`:
- `diff`: created (with their properties and text), deleted, moved (from and to, with indices) and updated nodes (per-property before and after values, and text before and after), plus new assets and renames. It covers exactly the nodes the draft wrote. A property test checks it against a full comparison of both documents.
- `accept(by)`: merges the fork's update as one transaction attributed to `by`, which can undo it as one step. A stale proposal (the document moved on) still merges by CRDT rules.
- `rebase()`: replays the commands on a fresh fork.
- `reject()`: discards the fork; the document is untouched byte for byte.

### 3.7 Renderer bridge

`SceneBridge` projects one page into a renderer `Scene` and listens to `DocumentChange`s:

```
main         transform, opacity, visibility, outline, bottom fill, top center stroke
├ fills      further fills, bottom to top
├ host       containers' children; clips them when overflow is not visible
└ strokes    further strokes, and aligned strokes
```

- **Incremental.** A property change recompiles only that node. Setters run only for values that changed, so a paint edit never touches geometry, and paint nodes are reused when the stack's shape is unchanged. Structural changes relink only the containers whose child lists changed (`SceneNode.replaceChildren`, O(children)).
- **Shapes.** Rounded rectangles with smoothing, ellipse arcs and donuts, rounded polygons and stars that fill their box, lines, and vector networks (regions filled with their own rule; segment chains stroked with joins, broken only at junctions).
- **Aligned strokes.** On rectangles and frames, an inside or outside stroke is a centered stroke on the inset or outset rectangle, with radii offset and sharp outside corners following the join. That is exact, needs no layer, and a property test compares it with the general construction. Everywhere else, inside is a double-width stroke clipped by the outline, and outside is clipped by its complement (even-odd with a surrounding rectangle).
- **Unsupported, not faked.** Angular, diamond, image and shader paints, blend modes, effects, text, image bitmaps, per-side stroke weights, single-axis overflow and vector vertex radii and caps are listed per node in `bridge.unsupported`. Unsupported paints and strokes are not drawn; unsupported modifiers are ignored. The editor's layer panel flags them.

Measured on this machine (4 vCPU Xeon, Node 22 and Chromium on SwiftShader), with a 10,001-node document of 100 frames × 99 shapes:

| | Median | Max |
|---|---|---|
| Apply one property update, Node: command, Yjs transaction, change event, bridge recompile, draw-list update | 0.13–0.30 ms | 2.7 ms |
| Apply one property update, Chromium: the same without the draw list (it updates in the next frame) | 0.3–0.9 ms | 7.0 ms |
| Next frame CPU, zoomed in (one frame on screen), WebGPU / WebGL2 | 1.0 / 1.3–1.9 ms | |
| Next frame CPU, overview with all 10k nodes visible, WebGPU | 34–44 ms | |

At the overview, WebGL2 frames take 1.0–1.2 s. That is SwiftShader rasterizing the full screen, which blocks the GL command stream; `/bench` documents the same cost. Initial load: about 0.7 s to create the 10k nodes with commands, 0.4 s to build the scene, and 0.15 s for the first draw-list compile. See `docs/benchmarks.md`.

### 3.8 The `.figtree` format

A `.figtree` file is a zip archive:

```
document.json          canonical JSON of the effective tree (stored properties only, children in paint order, text with runs)
assets/<sha256>.<ext>  asset bytes, named by content hash
history.yjs            optional: the full Yjs update behind a small header, to keep CRDT history
```

- Writing is deterministic: keys sorted, entries sorted, fixed timestamps. Equal documents give identical bytes, and Y.Doc → `.figtree` → Y.Doc → `.figtree` is byte-identical.
- Readers:
  - check declared entry sizes and counts before inflating (zip bomb guard);
  - verify every asset against its hash;
  - run the migrations hook (`format/migrations.ts`; version 1 has none yet; a file from a newer version is refused with a clear message);
  - validate with the zod schemas, reporting every issue with its path.
- `docs/format/figtree.schema.json` (JSON Schema 2020-12) is generated from the zod schemas, and a test fails when it is stale (`UPDATE_SCHEMA=1 npm test` rewrites it). Rules JSON Schema cannot express are enforced by zod and listed in the schema's description: unique ids, assets that exist, closed loops, ordered runs.

### 3.9 Testing

| Area | Tests |
|---|---|
| Schemas | Every property of every node type at once (fuzzed); invalid input per property group, rejected with path and reason; file-level rules. |
| Commands | Every command, errors and atomicity (a rejected batch leaves the state bytes unchanged), canvas-preserving moves through rotated and flipped parents, Yjs text semantics. |
| Convergence | 50 seeds × 3 replicas × 2,000 applied commands (create, move, reorder, delete, duplicate, group, ungroup, property and text edits), delivered in random interleavings with 5% out-of-order updates, then a full sync. Every 40 steps, every replica's tree must be valid. At the end, every replica must have byte-identical `document.json` and equal state vectors. Plus 4 seeds × 5 replicas × 2,500 commands. |
| Tree repair | Orphans, cycles, fallbacks, and independence from input order (2,000 random cases). |
| Undo | Per-actor isolation with interleaved edits on shared nodes and properties, undo across synced replicas, text, moves and restored subtrees. |
| Proposals | Diff contents, accept equals the fork, accept is one undo step, reject leaves bytes unchanged, stale merges and rebase, random batches cross-checked against full diffs. |
| Format | Fuzzed documents round-trip byte-identically and validate with ajv against the published schema; archives are deterministic; history, migrations, asset tampering and size limits. |
| Bridge | Scene structure per feature, unsupported notes, single-node recompiles, relinks, remote updates and undo, incremental scene equals a fresh projection under random edits, aligned-stroke equivalence, and 10k-node timings. |
| Editor (Playwright) | Per-backend goldens of the sample, exact colors at solid points and along a gradient, cross-backend agreement, pixels following paint, geometry and structural edits made through the command API, the layer panel and canvas hit-testing. |

## 4. How the next modules plug in

### Layout (CSS flexbox and grid)

The layout engine is a pure function `(node styles, intrinsic sizes) → boxes` that sits between the document and the scene. It reads the stored CSS properties (`cssDeclarations` is the contract) and writes the resulting boxes, either back into `x`/`y`/`width`/`height` through commands or straight into the bridge. Its output sets the transforms and sizes of `SceneNode`s, and auto-sized frames feed path rebuilds through `roundedRectPath`.
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
- **Multiplayer:** a provider relays Yjs updates (the convergence tests already simulate one); cursors and selections go in Yjs awareness and render as an overlay scene, so they never invalidate document tiles.
- **MCP and the Sprout agent:** call the same command API as the UI, and use proposals so a person reviews the diff before it lands.

## 5. Known limitations

See [`parity.md`](parity.md) → "Renderer limitations" and "Document model limitations" for the honest lists.
