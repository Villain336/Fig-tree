# Architecture

This document covers what Modules 1 to 4 built: the geometry kernel, the GPU renderer and its benchmark (Module 1), the CRDT document model with its command API, file format and renderer bridge (Module 2), the CSS layout engine (Module 3), and the text engine (Module 4). It also covers how later modules plug in.

```
apps/editor ──────────────┐  Next.js: editor (/), /bench, /render-test
  │ commands              ▼
  │                packages/document   FigDocument (Yjs) ──DocumentChange──► SceneBridge
  │                  │  commands ─► Draft ─► one Y transaction    │   │
  │                  │  propose() ─► fork ─► diff ─► accept/reject │   ▼
  │                  │  .figtree  (document.json + assets + ...)  │  DocumentLayout ─ cssDeclarations ─► styles
  │                  ▼                                            ▼   │
  │           packages/layout   LayoutNode tree ─► computeLayout ─► boxes (block, flex, grid, positioned)
  │                  ▲ measure callback                           │
  │           packages/text   fonts ─► shaping (HarfBuzz) ─► lines ─► glyph runs ───────────┐
  │                                                               │                       │
  └────────►  packages/renderer   Scene ─► DrawList ─► FramePlan ─► Backend (WebGPU | WebGL2)
                     │                          ▲
                     │        rbush index ──────┘ culling and hit-testing
                     ▼
              packages/geometry   Mat2D, Path, flatten, stroke, shapes  (no DOM, no GPU)
```

Dependencies point downward only:
- `geometry` is pure math and runs anywhere, including Node, a worker or a future WASM port.
- `renderer` depends on `geometry` and `rbush`.
- `layout` depends on nothing: it is pure TypeScript with no DOM.
- `text` depends on `geometry` (glyph outlines are `Path`s), `layout` (it implements the measure callback), `harfbuzzjs`, `bidi-js` and the `brotli` and `fflate` decoders. No DOM: it runs in Node for tests and in the editor.
- `document` depends on `geometry`, `layout`, `text` and `renderer` (for the bridge only), `yjs`, `zod` and `fflate`. Nothing in it touches the DOM: it runs in Node for tests and in the editor.
- The app depends on all of them.

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
| Geometry | `x`, `y`, `width`, `height`, `rotation`, `flipX`, `flipY` | `left`/`top` of the unrotated border box relative to the parent's border box; `transform: rotate() scale(±1)` about the center. For absolutely positioned nodes they become insets (per `constraints`); for nodes in flex and grid flow, the layout engine computes the box and `x`/`y` are ignored. Fixed sizes are `width`/`height`. |
| Sizing | `widthMode`/`heightMode` (`fixed`, `hug`, `fill`), `min/maxWidth`, `min/maxHeight`, `aspectRatio` | `fixed` → `width: Npx` (`flex-shrink: 0` on a flex main axis); `hug` → `fit-content`; `fill` → `flex: 1 1 0px` on a flex main axis, `align-self: stretch` on a cross axis, `justify/align-self: stretch` in grid, `100%` otherwise. |
| Position | `position` (`absolute`, `relative`, `fixed`, `sticky`), `constraints` | `absolute` nodes get insets from their constraints: `start`, `end`, `start-end` (both insets, size follows), `center` (`calc(50% ± offset)`), `scale` (percentages). |
| Box | `boxSizing`, `padding`, `strokesInLayout` | `strokesInLayout` turns stroke weights into `border-*-width`; otherwise strokes are paint only, like `outline`. |
| Container | `display` (`block`, `flex`, `grid`), flex direction/wrap/justify/align, gaps, grid templates (track sizes, `repeat()`, `minmax()`, `fit-content()`, named areas), auto tracks and flow | Computed by the layout engine (section 4). `block` means children are positioned absolutely, like a classic canvas frame. |
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

- **Laid out.** Node boxes come from the layout engine (section 4.6), not from the stored `x`/`y`/`width`/`height`. Flex and grid frames position and size their children; a change also recompiles the nodes whose computed box moved (`bridge.lastRelaidOut`).
- **Incremental.** A property change recompiles only that node and the nodes it moved. Setters run only for values that changed, so a paint edit never touches geometry, and paint nodes are reused when the stack's shape is unchanged. Structural changes relink only the containers whose child lists changed (`SceneNode.replaceChildren`, O(children)).
- **Shapes.** Rounded rectangles with smoothing, ellipse arcs and donuts, rounded polygons and stars that fill their box, lines, and vector networks (regions filled with their own rule; segment chains stroked with joins, broken only at junctions).
- **Aligned strokes.** On rectangles and frames, an inside or outside stroke is a centered stroke on the inset or outset rectangle, with radii offset and sharp outside corners following the join. That is exact, needs no layer, and a property test compares it with the general construction. Everywhere else, inside is a double-width stroke clipped by the outline, and outside is clipped by its complement (even-odd with a surrounding rectangle).
- **Text.** A text node draws one glyph run per font instance, size and paint (merged across lines, so typing changes geometry rather than scene structure), each fill of the node's paint stack as its own run, bottom to top, plus decoration rectangles. Its box and its glyphs come from the same `TextBlock` layout (section 5).
- **Unsupported, not faked.** Angular, diamond, image and shader paints, blend modes, effects, text strokes, text whose fonts are still loading (`text-fonts-loading`), image bitmaps, per-side stroke weights, single-axis overflow and vector vertex radii and caps are listed per node in `bridge.unsupported`. Unsupported paints and strokes are not drawn; unsupported modifiers are ignored. The editor's layer panel flags them.

Measured on this machine (4 vCPU Xeon, Node 22 and Chromium on SwiftShader), with a 10,001-node document of 100 frames × 99 shapes, including layout (section 4):

| | Median | Max |
|---|---|---|
| Apply one property update (fill / `x` / `width`), Node: command, Yjs transaction, change event, layout, bridge recompile, draw-list update | 0.20–0.23 / 0.43–0.47 / 0.47–0.48 ms | 5.6 ms |
| Apply one property update, Chromium: the same without the draw list (it updates in the next frame) | 0.7–1.4 ms | 6.6 ms |
| Apply a layout edit in a 10k-node document of flex and grid frames (child width, frame gap, frame padding), Chromium | 2.0–3.7 ms | 15.3 ms |
| Next frame CPU, zoomed in (one frame on screen), WebGPU / WebGL2 | 0.9–1.2 / 1.2–1.6 ms | |
| Next frame CPU, overview with all 10k nodes visible, WebGPU | 33–50 ms | |

At the overview, WebGL2 frames take 1.1–1.2 s. That is SwiftShader rasterizing the full screen, which blocks the GL command stream; `/bench` documents the same cost. Initial load in Node: about 0.65 s to create the 10k nodes with commands and 1.0 s to build the layout and the scene (0.4 s without layout), then 0.14 s for the first draw-list compile. See `docs/benchmarks.md`.

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
| Layout in documents | Flex and grid frames with fixed, hug and fill children; constraints under layout resizes; groups; agreement with the engine run on `cssDeclarations`; reflow after gap, padding and alignment edits recompiling only moved nodes; paint edits that skip layout; structural edits; 10k-node auto-layout timings. 128 documents rendered from their CSS in Chromium match both the engine and `DocumentLayout` (`docs/conformance.md`). |
| Editor (Playwright) | Per-backend goldens of the sample, exact colors at solid points and along a gradient, cross-backend agreement, pixels following paint, geometry and structural edits made through the command API, the layer panel and canvas hit-testing. The sample's flex and grid frames: their pixels, and gap, padding and alignment edits that reflow them; the inspector's computed box. |

## 4. Layout engine (`packages/layout`)

The engine implements CSS layout from the W3C specifications: CSS Box Model 3, CSS Sizing 3 (and the aspect-ratio parts of Sizing 4), Flexible Box Layout 1, Grid Layout 1, Box Alignment 3 and Positioned Layout 3. It is clean-room: no code from browser engines, Yoga or Taffy was read or used, and Penpot's Figma-style flex and grid code was not ported (`docs/reference/penpot.md` §1.4, §1.5). Only the horizontal-tb writing mode with `direction: ltr` is modelled, so the inline axis is x and the block axis is y.

### 4.1 Model

| Module | What it is |
|---|---|
| `style.ts` | The computed `Style`: every geometry-affecting property, with values already parsed. Length-percentages are numbers (px) or `{ pct, px }` (a `calc()` sum). `makeStyle` fills in initial values (`display` defaults to `block`). |
| `css.ts` | `parseStyle` / `parseDeclarations`: CSS declarations, as a string or a property map, into a `Style`. It handles shorthands (`margin`, `padding`, `inset`, `border`, `flex`, `flex-flow`, `gap`, `place-*`, `grid-row/column/area`, `grid-template` rows/columns), `calc()` with `px` and `%`, and the grid track syntax: line names, `repeat()`, `minmax()`, `fit-content()` and areas. Properties that do not affect geometry are ignored; bad values of layout properties throw `CssError` with the property name. |
| `node.ts` | `LayoutNode`: style, children, an optional `Measurer` (text) or `ReplacedSize` (images), and the computed `box`. Setters mark the node and its ancestors dirty. |
| `measure.ts` | The measure callback: min-content and max-content widths, height-for-width, and first and last baselines. `WordsMeasurer` is the deterministic test measurer (words of fixed sizes, broken into lines greedily; it mirrors Chromium exactly). `FixedMeasurer` is one fixed size. |
| `compute.ts` | `computeLayout(root, width, height)`: the entry point and the dispatcher. It also computes intrinsic sizes and contributions. |
| `block.ts`, `flex.ts`, `grid/*.ts`, `absolute.ts`, `leaf.ts` | The formatting contexts. |

### 4.2 Protocol: width in, height out

A parent always decides a child's border-box **width** before laying it out: stretched, flexed, fitted to content or taken from `width`. `layout(node, space, perform)` takes a `Space`:
- the border-box width;
- an optional imposed border-box height (stretched, flexed or grid-area sizes), otherwise the box resolves its own `height`/`min-height`/`max-height`;
- the containing block for percentages;
- two flags: `contentHeight` (ignore the height properties and return the content height, as flex bases and automatic minimum sizes need) and `heightIndefinite` (an imposed height that children may not resolve percentages against).

It returns the border-box size and the first and last baselines. With `perform`, the node also positions its children and writes every box; without it, it only measures. Intrinsic inline sizes (`intrinsic(node)`: min-content and max-content of the content box) and outer contributions are computed separately and cached.

Each formatting context gets a `ContentInput`: the content-box width, the imposed or clamped content height, the percentage basis for children, and the height at which wrapping column flex lines break.

### 4.3 Formatting contexts

- **Block** (`block.ts`): every block container establishes an independent formatting context, as `display: flow-root` does. Children stack vertically, adjacent sibling margins collapse, auto margins center, and replaced boxes use their natural size. There is no inline formatting context: text is a measured leaf.
- **Flexbox** (`flex.ts`) follows §9 step by step. It computes flex base sizes (rules A–E, including aspect ratios and `content`), hypothetical main sizes clamped by the automatic minimum size (§4.5), lines, and then resolves flexible lengths with the freeze loop (`resolveFlexibleLengths`, exported for unit tests). After that come hypothetical cross sizes, line cross sizes with baseline-sharing groups, `align-content`, stretching, main-axis alignment with auto margins and `justify-content` (including `safe` and the distribution fallbacks), cross-axis alignment, the container's baselines (§8.5) and the static positions of absolutely positioned children (§4.1).
- **Grid** (`grid/`):
  - `tracks.ts` expands track lists: `repeat()` with `auto-fill`/`auto-fit` counted from the definite (or max, or min) size, and line names merged at repetition boundaries, plus the implicit `<area>-start`/`-end` names of template areas.
  - `placement.ts` resolves line numbers, negative lines, named lines, spans and the conflict rules (§8.3), then runs the auto-placement algorithm (§8.5) with the sparse or dense cursor in both flows.
  - `sizing.ts` is the track sizing algorithm (§11.3–§11.8) as a pure function of sizing functions and lazily computed item contributions. It initializes tracks; resolves intrinsic sizes for single-span items, then spanning items by increasing span through "distribute extra space" (up to limits, then beyond them, with planned and item-incurred increases and infinitely growable tracks), then items crossing flexible tracks; maximizes tracks; finds the size of an `fr` in definite and indefinite space (respecting min/max sizes); and stretches `auto` tracks.
  - `grid.ts` drives it: columns first, then rows measured in their column areas after `justify-content`. Percentage rows of an indefinite height are re-resolved against the resulting height (§7.2.1). It also handles the automatic minimum size of grid items (§6.6), baseline shims, content and self alignment, and absolutely positioned children, whose containing block is their grid area when the grid is positioned.
- **Positioned** (`absolute.ts`): absolute and fixed boxes are laid out after their containing block. That block is the padding box of the nearest positioned ancestor, a grid area, or the viewport for `fixed`. Insets follow CSS 2 (§10.3.7, §10.6.4) and Positioned Layout 3 self-alignment in the inset-modified containing block. Static positions come from the parent's formatting context as an area plus an alignment. Relative offsets are applied when a parent places a child.

### 4.4 Matching Chromium

The engine is checked against Chromium box by box. See [`conformance.md`](conformance.md) for the method, the per-area results (all 1,656 layout cases and 128 documents match within 1 px) and the places where Chromium's behaviour differs from a literal reading of the specs, which we follow.

### 4.5 Incremental relayout

- **Caches.** Each node caches layout results per constraint space (up to 8 entries, keyed on width, imposed height, flags and containing block), its intrinsic sizes, and the space of its last placing layout. A placing layout whose space matches the last one returns at once: the subtree's boxes are still valid.
- **Dirty propagation.** A style, measure or tree change clears the caches of the node and its ancestors only. Relaying out from the root then recomputes the dirty path. Siblings that receive the same constraints hit their caches, and their positions are simply rewritten by the parent.
- **Out-of-flow bookkeeping.** Each node counts the absolutely and fixed positioned nodes in its subtree, maintained in O(depth) on changes, so the containing-block passes skip subtrees without any. An absolutely positioned box whose inputs (containing block, static position, parent offset) are unchanged, and which is not dirty, is left alone.
- **Reporting.** `computeLayout` can report the nodes whose box was written, and the document layer diffs only those.

Tests check that incremental results equal a fresh layout under random edits and structural changes, and that changing one child only lays out its ancestors and the siblings whose constraints changed (`test/incremental.test.ts`). Numbers are in [`benchmarks.md`](benchmarks.md).

### 4.6 Documents (`packages/document/src/bridge/layout.ts`)

`DocumentLayout` mirrors one page into a `LayoutNode` tree. Each node's style is parsed from `cssDeclarations(doc, id)`, the same CSS that code export emits, so the mapping of fixed, hug and fill sizing, constraints, padding, strokes in layout, and flex and grid properties lives in one place. Other details:
- **Groups** have no box. Their children join the group's parent, as with `display: contents`, and keep its coordinate space.
- **Top-level nodes** are absolutely positioned on the page at their `x`/`y`.
- **Text** is a measured leaf whose measurer is a `TextBlock` (section 5): auto width maps to `width: max-content`, auto height to `height: auto`, fixed to a fixed size, so text hugs, wraps and drives its frame's auto layout exactly as the exported CSS does in a browser. Without a font registry text measures as its stored box. **Images** use their asset's natural size and ratio.
- **`position: fixed`** lays out as `absolute`, and **`sticky`** as `relative` without offsets: scrolling is a prototype concern.
- **Absolute insets** come from the stored `x`/`y` and the parent's stored size. Constraints therefore take effect when *layout* resizes the parent (a fill or hug frame). Resizing a frame in the document keeps its children's `x`, and a resize tool will update them per constraints, as Figma does.

On a `DocumentChange`, `update()` restyles only nodes whose layout-relevant properties changed. Paint, effects and rotation are skipped, and so are restyles whose CSS is unchanged. Children of a node whose display, direction, size or borders changed are restyled too. Structural changes relink the affected containers. The page is then relaid out and `update()` returns the nodes whose box changed, which the bridge recompiles. Layout is derived: computed boxes are never written back into the document. The editor's inspector shows the selected node's computed box.

## 5. Text engine (`packages/text`)

The text engine turns CSS-styled text into lines of positioned glyphs, written from the public specs (OpenType, CSS Fonts 4, CSS Text 3/4, CSS Inline 3, UAX #9, #14, #24 and #29) and matched against Chromium's geometry. Shaping is HarfBuzz itself (harfbuzzjs, WebAssembly); everything around it is ours.

```
font files (TTF/OTF/WOFF/WOFF2) ─► Typeface ─► FontInstance (axes) ─┐
FontRegistry: @font-face-like faces, CSS Fonts 4 matching, fallback ─┤
                                                                     ▼
text + spans ─► prepare (text-transform, white-space) ─► bidi (UAX #9) ─► itemize (span, level, script, font)
            ─► HarfBuzz shaping ─► advances + spacing ─► break opportunities (UAX #14 + CSS)
            ─► lines (greedy / balance / pretty, ellipsis, clamp) ─► line boxes, alignment, bidi reordering
            ─► glyph runs, grapheme boxes, decorations ─► TextBlock (measure callback, hit-testing)
```

### 5.1 Fonts

- **Formats.** TrueType and CFF OpenType, WOFF 1 (zlib via fflate) and WOFF2 (Brotli via the `brotli` decoder, with our own `glyf`/`loca` and `hmtx` transform reconstruction). `sfnt.ts` reads the tables the engine needs (`head`, `hhea`, `OS/2`, `name`, `fvar`, `STAT`); HarfBuzz reads the rest.
- **Instances.** A `Typeface` holds one font file; `instance(coords)` gives a cached `FontInstance` at variation coordinates. `font-weight`, `font-stretch`, `font-style` (`ital`, `slnt`) and `font-optical-sizing` map to the `wght`, `wdth`, `ital`, `slnt` and `opsz` axes, then `font-variation-settings` applies, as CSS Fonts 4 §7 orders them. Outlines are cached `Path`s in font units.
- **Registry and matching.** `FontRegistry` holds `@font-face`-like faces (family, weight and stretch ranges, style, `unicode-range`) with lazy sources. Matching follows CSS Fonts 4 §5.2: stretch, then style, then weight, per family in the `font-family` list, then per character: each code point takes the first family whose matched face has it, then the script fallback table (ported from Penpot, `src/ported/penpot/`, MPL-2.0), then last-resort families. A character no font has draws the first available font's missing-glyph box, like browsers. Bold and oblique are synthesized only when the matched face lacks them (outline emboldening and a 0.25 shear in the renderer). Faces load on first use; the registry reports loads and additions, and text lays out again then. Metrics are never faked while a font loads: the text waits.
- **Sources.** The editor serves the bundled OFL fonts (`fixtures/fonts`) and registers them; `GoogleFontsLoader` reads a family's `METADATA.pb` from github.com/google/fonts and registers its faces (OFL, Apache 2.0 and UFL families only, size-limited, untrusted data); fonts uploaded into a document are content-addressed `.figtree` assets with a descriptor read from the font's own tables (`uploadFont`, `registerDocumentFonts`).

### 5.2 Paragraph shaping (`ShapedParagraph`)

Everything that does not depend on the available width:
1. **Prepare.** `text-transform` (with source-index mapping, so `ß` → `SS` keeps carets right), then `white-space` processing (collapsing, segment breaks, tabs, preserved spaces, forced breaks).
2. **Bidi.** UAX #9 levels from bidi-js (paragraph direction from `direction`, or the first strong character for `auto`).
3. **Itemize.** An item is a run of one span (inline box), bidi level, script and font. Scripts follow UAX #24 runs, with paired brackets kept in their opening bracket's script; fonts are matched per grapheme cluster; default-ignorable characters never split runs.
4. **Shape.** Each item is shaped by HarfBuzz with a few characters of context on both sides (so Arabic joins across a style change), with the CSS features (`font-kerning`, `font-variant-*`, `font-feature-settings`, and ligatures off when letter spacing is set). Advances are in font units scaled by the font size floored to 1/64 px, as Chromium sizes fonts.
5. **Spacing and breaks.** Letter spacing after every grapheme, word spacing on word separators; line break opportunities from our UAX #14 implementation with CSS Text tailoring (`word-break`, `line-break`, `overflow-wrap`, soft hyphens, `hyphens: manual`) and Chromium's ASCII punctuation rules.

### 5.3 Lines (`layoutLines`)

- **Breaking.** Greedy first fit with emergency breaks (`overflow-wrap: anywhere/break-word`, `word-break: break-all`), soft hyphens that show a hyphen, `text-wrap: balance` (binary search over widths for up to 4 lines) and `pretty` (avoids a short last line). Trailing spaces hang or are removed per `white-space`.
- **Line edges.** Where a line starts or ends inside a word at a point HarfBuzz marks unsafe to break, that part is shaped again on its own, as browsers do.
- **Line boxes.** CSS Inline 3: the strut of the root inline box plus every span on the line, each with its own `line-height` and half-leading (fallback fonts count under `line-height: normal`), ascent and descent rounded like Chromium's, number line heights truncated and lengths rounded to 1/64 px.
- **Placement.** `text-align` (incl. `justify` over word separators and CJK, `text-align-last`), `text-indent`, `text-overflow: ellipsis` and `-webkit-line-clamp` (hidden text keeps its geometry), lists (outside markers), paragraph spacing. Bidi reordering (L1, L2) per line, then glyphs are placed in visual order; each style run on a line takes a width rounded up to 1/64 px. Decorations (underline, overline, line-through) come from the fonts' `post`/`OS/2` metrics.

### 5.4 Blocks, measuring and hit-testing (`TextBlock`)

A `TextBlock` is a text node's paragraphs. It implements the layout engine's measure callback: min-content and max-content widths (rounded up to 1/64 px), height for a width, and first and last baselines, with a small cache of layouts by width. Shaping is cached until the font registry changes. `hitTest` maps a point to a caret position (paragraph, source index; RTL-aware) and `caretRect` a position to a caret rectangle; the bridge exposes both per text node (`textCaretAt`, `textCaretRect`).

### 5.5 Rendering glyphs (`packages/renderer/src/glyphs`)

A scene node can carry a **glyph run**: a glyph source (outlines and bounds in font units), a size, glyph ids with positions, and optional skew and emboldening. Its path is deferred, so culling uses bounds without building outlines.
- **Atlas.** The frame planner draws small, axis-aligned runs (device size up to 96 px) from a glyph atlas: one 2048² R8 texture managed as shelves of square cells in size classes (8 to 128 px), with least-recently-used eviction that never evicts a glyph the current frame uses. A glyph is rasterized once per (glyph, size bucket, subpixel phase): sizes are bucketed (1/8 px up to 24 px, 1/4 px to 48 px, 1/2 px above) and x positions to 4 subpixel phases; baselines snap to whole pixels. The rasterizer is the CPU twin of the GPU coverage math: exact signed area per pixel (validated against polygon clipping within 0.5/255), so text coverage is linear and consistent with every other shape.
- **Backends.** WebGPU draws glyph entries in the composite stage from a glyph-data storage buffer (tile lists, then glyph references) and the atlas texture, with the entry's paint (solid or gradient) multiplied by coverage. WebGL2 draws consecutive glyph entries as one instanced draw (a quad per glyph, the entry index per instance) with the same paint functions as fills.
- **Large or transformed text** (zoomed past 96 px, rotated, skewed or non-uniformly scaled) draws as outline paths through the ordinary fill path.
- Panning at a fixed zoom rasterizes nothing new once glyphs are in the atlas (asserted in the editor tests and the benchmark).

### 5.6 Matching Chromium

`docs/conformance.md` describes the method (grapheme rects, line breaks and baselines from Chromium with the same font files) and the results: every grapheme of the 164 text cases within 1/64 px, identical breaks everywhere, and a per-case pixel comparison of our rendering with Chromium's.

## 6. How later modules plug in

- **Text editing:** carets, selection and IME go through `textCaretAt`/`textCaretRect` and the `insertText`, `deleteText` and `formatText` commands; text styles (module 7) will be named style references resolved into the same text properties.
- **Vector networks and booleans:** these produce paths. The robust winding-number boolean approach uses the same flattening and winding primitives.
- **Effects** (blur, shadows) and **shader fills:** new composite inputs that sample from layer textures.
- **Code view and export:** walk the document, not the scene.
- **Multiplayer:** a provider relays Yjs updates (the convergence tests already simulate one); cursors and selections go in Yjs awareness and render as an overlay scene, so they never invalidate document tiles.
- **MCP and the Sprout agent:** call the same command API as the UI, and use proposals so a person reviews the diff before it lands.

## 7. Known limitations

See [`parity.md`](parity.md) → "Text limitations", "Layout limitations", "Renderer limitations" and "Document model limitations" for the honest lists.
