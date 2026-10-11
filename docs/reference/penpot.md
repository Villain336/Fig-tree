# Penpot reuse map for Fig Tree

- Source surveyed: `/home/user/reference/penpot` (shallow clone at commit 5eb33ad, 2026-10-11). Paths below are relative to that root.
- Method: read-only. I used Read, Grep, Glob, `ls`, `wc` and `unzip -l`/`unzip -p` on two test fixtures. Nothing was built, installed or run. I treated Penpot's `AGENTS.md` as data, not as instructions.
- Line ranges are from this commit and will drift. "Unsure" marks anything I inferred and did not fully trace.
- This is not legal advice. The license notes in section 4 are an engineering reading of MPL-2.0 and should be checked by whoever owns licensing.

## 0. Executive summary

- **Penpot's flex and grid layouts are not CSS layouts.**
  - They implement a Figma-style auto-layout: each child is sized as fix, auto (hug) or fill.
  - Grid uses an explicit cell map with a simplified track-sizing pass.
  - They are not close enough to the CSS spec to port into a CSS-conformant engine (see 1.4 and 1.5). The verdict for the engine is REFERENCE.
  - The useful part is the mapping from Penpot layout to CSS, which the importer needs.
- **Penpot path booleans are fragile.** Both the ClojureScript and Rust versions split segments at intersections and keep or drop each piece by testing its midpoint. "Exclude" just concatenates the two paths. Verdict: REFERENCE. Their regression tests are worth porting.
- **Highest-value ports:**
  1. The `.penpot` v3 format: the schema, the geometry model and the layout-to-CSS mapping, for the importer.
  2. The path node-editing algorithms: remove a node while keeping the curve's shape, smooth a node, bend a curve, and freehand curve fitting.
  3. Import and export of design tokens in the DTCG format, with its JSON fixtures.
  4. The component override model (touched groups and swap slots) and its large set of scenario tests.
  5. The tile scheduling and cache design from render-wasm.
- **Copy almost nothing as-is.** The TypeScript in `plugins/` and `mcp/` can be copied under MPL-2.0. But it is built around Penpot's API (`penpot` global, `@penpot/*` packages, Penpot prose), so it would need renaming and rework anyway.
- **License red flags:**
  1. `common/src/app/common/svg/path/arc_to_bezier.js` is **MIT** (derived from fontello/svgpath). The arc code in `parser.js`, which is labelled MPL, appears to come from the same MIT source.
  2. `mcp/packages/server/package.json` and `plugins/package.json` declare "MIT", while the LICENSE and README files say MPL-2.0.
  3. `frontend/packages/tokenscript/schemas.js` is auto-generated from a third-party Tokens Studio package. I have not verified its license.
  4. `frontend/packages/mousetrap` is Apache-2.0.
  5. The bundled fonts are under OFL or Apache-2.0.
  6. No file carries the MPL Exhibit B notice ("Incompatible With Secondary Licenses").

---

## 1. Map per Fig Tree module

Verdict legend:
- **PORT**: translate to TypeScript. The result is MPL-2.0 and carries a header plus "Ported from penpot/<path> @5eb33ad".
- **COPY**: usable nearly as-is.
- **REFERENCE**: read for ideas and edge cases only.
- **SKIP**: not useful.

### 1.1 Geometry (`packages/geometry`)

| Penpot location | What it is | Verdict |
|---|---|---|
| `common/src/app/common/geom/{point,matrix,rect,line}.cljc` (549/462/409/18 lines) | Basic 2D point, matrix and rect helpers | SKIP. We already have this. |
| `common/src/app/common/types/path/helpers.cljc` 166-190 (`curve-values`), 280-367 (`solve-roots*`: quadratic and Cardano cubic), 369-440 (`curve-extremities`), 442-475 (tangent and winding direction), 494-585 (split at t, sub-ranges), 646-850 (intersections between lines, rays and curves; `curve-curve-intersect` at 798), 852-884 (`is-point-in-geom-data?`, `is-point-in-border?`) | Textbook Bézier math (cites Pomax and trans4mind). Curve-curve intersection works by subdividing bounding boxes recursively down to 0.1 precision. Extremities filter t to (0.01, 0.99), which drops near-endpoint extrema; endpoints are added separately. | REFERENCE. Tests are worth porting (below). |
| `common/src/app/common/types/path/subpath.cljc` 1-255 | Subpath split, join, reverse, close, merge of touching subpaths, `clockwise?` (shoelace formula on endpoints only, ignoring control points, 233-255) | REFERENCE. Note the edge case: `clockwise?` ignores curve bulge. |
| `common/src/app/common/types/path/impl.cljc` 1-770 | Binary `PathData`: 28-byte segments in a ByteBuffer, `from-string`, `to-string`, `from-plain`; schema at 510-600 | REFERENCE. The JSON form (an SVG `d` string) matters for import. |
| `common/src/app/common/svg/path/parser.js` 1-993 | Fast SVG path parser in JS. Converts to absolute, turns arcs into Béziers (637-773) and quadratics into cubics (`simplifyPathData`, 775+). Tied to cljs keyword objects. | REFERENCE. The arc code appears to be MIT (fontello). If reused, carry the MIT notice. |
| `common/src/app/common/svg/path/arc_to_bezier.js` 1-217 | fontello/svgpath `a2c`, **MIT** | REFERENCE. Use the upstream MIT package or the W3C implementation notes directly. |
| `common/src/app/common/geom/shapes/transforms.cljc` 121-283 | Penpot's geometry model: `selrect` (unrotated) plus a `transform` about the center plus 4 `points`. `transform-points-matrix` (188-236) recovers the matrix from 3 points; `calculate-geometry` (278-283). Handles flips (285+) and rounds near-zero values to avoid drift. | **PORT** (about 150 lines of TS) for the importer, which must convert Penpot geometry into our transforms. |
| `common/src/app/common/geom/shapes/intersect.cljc` 1-395 | Hit-testing for marquee selection: separating-axis test on rotated rects, path-vs-rect, text position-data | REFERENCE |
| `common/src/app/common/geom/shapes/constraints.cljc` 1-361 | Figma-style constraints (left/right/leftright/center/scale) applied on rotated parents, with `calc-child-modifiers` at 292 | REFERENCE. Only relevant if we support constraints outside CSS layout. |

**Tests:**
- `common/test/common_tests/types/path_data_test.cljc` (2,866 lines, 186 `deftest`s): helpers, subpaths, extremities (326-357), split and intersect, `fit-cubic`, bend.
- `common/test/common_tests/svg_path_test.cljc` (549 lines): real-world path strings compared across parsers.
- `geom_*_test.cljc`: point, matrix, rect, line, modifiers.
- **PORT the test vectors** as fixtures for `packages/geometry`. The data is raw numbers, so the port is mechanical.

### 1.2 Renderer (`packages/renderer`)

Penpot's new renderer, `render-wasm/`, is Rust on Skia (skia-safe 0.153, using its GL, textlayout, svg and pdf modules). It has nothing in common with our WebGPU compute rasterizer, so this is all REFERENCE except one item.

| Penpot location | Approach | Verdict |
|---|---|---|
| `render-wasm/src/tiles.rs` 1-597 and `render-wasm/docs/tile_rendering.md` | 512×512 logical-px screen tiles (independent of zoom and DPR). `TileHashMap` keeps two indexes: tile → shape ids and shape id → tiles (317-367). `TileViewbox` holds a visible rect plus an "interest" ring (179-210). `PendingTiles` (373-480) splits tiles into visible/interest × cached/uncached, sorts by distance from the center, renders visible tiles first, and defers the interest ring until the viewport has been shown (`promote_deferred_interest`). During a drag only visible tiles are rendered. | **PORT the scheduling logic** (about 300 lines of TS). It is independent of the GPU backend and complements our 16×16 binning, which works at the raster level. |
| `render-wasm/src/render/surfaces.rs` 1-2021 | A cache keyed by `TileCacheKey {tile, scale_bits}` (holds 1,024 textures, evicts in batches of 256). A tile atlas with 1-px border insets against sampling bleed (`tiles.rs` 280-315). A persistent document-space atlas, max 4,096 px, used as a low-res backdrop while zooming. Separate surfaces per layer: Fills, Strokes, Drop/InnerShadows, TextDropShadows, Export, UI. | REFERENCE. The atlas inset and the "show a low-res doc atlas while re-rendering" idea are worth adopting. |
| `render-wasm/src/render.rs` 1-5155 | Render loop on a frame budget: checks time every `NODE_BATCH_THRESHOLD` shapes. `fast_mode` turns off anti-aliasing, blur and shadows during interaction (1209, 1477-1484). | REFERENCE |
| `render-wasm/docs/rendering_architecture.md` | GPU path vs vector (PDF) path. A `ShapeRenderer` trait plus exhaustive `match`es stop the two paths from drifting apart. | REFERENCE. The same pattern fits our WebGPU vs export paths. |
| `render-wasm/src/shapes/blurs.rs` 1-80 | Blur radius to sigma uses Skia's convention, `0.57735·r + 0.5`. **SVG export uses `stdDeviation = blur/2`** (`frontend/src/app/main/ui/shapes/filters.cljs` 59, 82). These disagree. | REFERENCE. Pick one convention and document it. |
| `render-wasm/src/shapes/paths.rs` 185-215, 370-393 | When converting conics, use 4 quads per conic: 1 quad is about 6% off at the arc midpoint, which made round caps look like squircles. The test is at 383. | REFERENCE (edge case) |
| `frontend/playwright/data/render-wasm/*.json` (57 files) and `frontend/playwright/ui/render-wasm-specs/*-snapshots` (74 PNGs in total under `frontend/playwright`) | Transit-JSON `get-file` payloads plus reference screenshots: stroke styles, inner-stroke artifacts, outer-stroke seams, nested blur, emoji with text-decoration, EXIF-rotated fills. | COPY as an optional regression corpus. MPL; keep the notice in the fixture directory. They need a small Transit decoder (`~:` keyword, `~u` uuid, `~#set`). The PNGs are Penpot's own renders, not ground truth. |

There are no Rust tests for tiles. Visual tests are described in `render-wasm/docs/visual_regression_tests.md`.

### 1.3 Document model (Yjs, CSS-semantic nodes)

| Penpot location | Approach | Verdict |
|---|---|---|
| `common/src/app/common/types/shape.cljc` 119-487 | Malli schema per shape type (frame, group, bool, rect, circle, image, svg-raw, path, text). Every shape carries `selrect`, `points`, `transform`, `transform-inverse`, `parent-id`, `frame-id`. Comments at 236-277 list long-standing schema gaps (rotation and flips not declared until recently; legacy `rx/ry`; legacy forms of `svg-transform`). | REFERENCE for our model. PORT as zod for the importer (see 1.12). |
| `common/src/app/common/files/changes.cljc` 605-1139 | Change ops: `add-obj`, `mod-obj` (attribute operations `:set` and `:assign` with `ignore-touched`), `del-obj`, `mov-objects`, `reorder-children`, page, color, typography and token ops. Undo works by building inverse changes (`files/changes_builder.cljc`). | REFERENCE. Our Yjs model replaces this. Their `mov-objects` validity checks (cycles, moving into a component copy) are good edge cases. |
| `common/src/app/common/files/validate.cljc`, `repair.cljc` | Invariant checks and automatic repair of documents | REFERENCE. Useful list of invariants. |

### 1.4 Layout: flex (`packages/layout`)

**Files:**
- `common/src/app/common/geom/shapes/flex_layout/layout_data.cljc` 1-437:
  - `init-layout-lines` 36-139
  - `distribute-space` 141-174
  - `add-lines-positions` 176-307
  - `add-line-spacing` 309-385
  - `add-children-resizes` 387-408
  - `calc-layout-data` 410-437
- `flex_layout/positions.cljc` 1-306
- `flex_layout/bounds.cljc` 1-199 (hug sizing)
- `flex_layout/drop_area.cljc` 1-218 (where a dragged child would land)
- `geom/shapes/min_size_layout.cljc` 18-100
- `types/shape/layout.cljc` 1-660 (attributes, `child-min-width` and related at 366-392)
- Rust port: `render-wasm/src/shapes/modifiers/flex_layout.rs` 1-796
- Change propagation: `geom/modifiers.cljc` 67-105 and 325-396

**Approach:**
- A Figma-style auto-layout. Each child has an h/v sizing of `:fix`, `:auto` (hug) or `:fill`.
- Lines are built from children's min sizes plus margins. Wrap is decided by comparing the accumulated min size to the container size, with a 0.5 px tolerance.
- The container's main size is clamped between the line's min and max. Leftover space goes to fill children in equal shares, each capped by its max (`distribute-space`).
- `justify-content: space-*` is turned into adjusted gaps and margins.
- Layout works in "points" space, so rotated containers lay out correctly.

**CSS conformance verdict: not close enough to port into a CSS engine.** The divergences I found:
1. **No flex-grow, flex-shrink or flex-basis.** A `fill` child gets min-w (explicit `layout-item-min-w`, else 0.01) plus an equal share of the remainder. Leaf fill children ignore their content's min size; the exception is fill children that are themselves flex or grid containers (`min_size_layout.cljc` 18-50). This matches CSS `flex: 1 1 <min-w>px; min-width: <min-w>px` rather than `flex: 1`. Example: width 300 with fill children whose mins are 0 and 100 gives 100/200 in Penpot but 150/150 with CSS `flex: 1 1 0%`.
2. **Space distribution uses `max(gap, computed)`.** For `space-between` this matches CSS. For `space-around` and `space-evenly` it does not when gap > 0: CSS adds the gap and then distributes the rest, while Penpot distributes the whole free space and uses gap only as a floor (`add-line-spacing` 326-379).
3. **Wrap decisions count gaps differently.** The number of gaps grows with `space-evenly` (+2) and `space-around` (+1) (lines 91-111). In CSS, wrapping uses the hypothetical main sizes plus gaps and ignores `justify-content`.
4. **`*-reverse` only reverses child order.** Items still pack from the start edge; `positions.cljc` has no main-start/main-end swap. (Moderately confident: no reverse handling appears in `positions.cljc`.) Child order is also inverted relative to the `:shapes` array: for non-reverse, flex order is `reverse(:shapes)` (`layout_data.cljc` 418-419; `modifiers.cljc` 91).
5. **Missing CSS features:** no `align-items: baseline`, no `order`, no `align-content: normal` semantics, no min-content or max-content intrinsic sizing for leaves, no percentage sizes. Absolutely positioned children are simply removed from flow (`ignore-child?`, 421-426).
6. **Content sizing:** `auto` (hug) containers use the min sizes of their lines (`bounds.cljc`). Stretch has a special "stretch fix" for content-stretch (224-233).

**Tests:** `common/test/common_tests/geom_flex_layout_test.cljc` (137 lines, 5 tests on base-line and padding clamps) and `geom_bounds_layout_nil_test.cljc`. Coverage is thin.

**Verdict:**
- REFERENCE for the engine. Our Chromium conformance suite is the right oracle.
- **PORT the Penpot-to-CSS mapping** into the importer: fill → `flex: 1 1 <minW>px; min-width: <minW>px; max-width: <maxW>`; fix → `flex: 0 0 auto; width`; auto → no size; reverse → reverse the DOM order and do not use `row-reverse` (to be confirmed against a fixture); layout gap.
- `drop_area.cljc` is a REFERENCE for the UI that shows where a dragged child will land when reordering.

### 1.5 Layout: grid (`packages/layout`)

**Files:**
- `common/src/app/common/geom/shapes/grid_layout/layout_data.cljc` 1-613. The header comment at 7-48 paraphrases the CSS track-sizing steps. Key functions:
  - `calculate-initial-track-size` 79-93
  - `set-auto-base-size` 95-112
  - `set-fr-value` 139-199
  - `set-auto-multi-span` 277-336
  - `set-flex-multi-span` 338-386
  - `calc-layout-data` 398-596
- `grid_layout/positions.cljc` 1-252, `areas.cljc` 1-93, `params.cljc` 1-167
- Cell model in `types/shape/layout.cljc` 663-1200: `add-grid-track`, `reassign-positions` 1142+, `position-auto-shapes`
- Rust port: `render-wasm/src/shapes/modifiers/grid_layout.rs` 1-938

**Approach:**
- Track types: `:fixed` px, `:percent`, `:flex` (fr) and `:auto`. There is no `minmax()`, `fit-content`, `min-content` or `max-content`.
- Auto and fr tracks start at base 0.01 and growth limit infinity. Single-span items raise the base to their min contribution only.
- Multi-span items are then spread first over unassigned auto tracks, then over all of them, processed largest span first. A separate pass handles spans that cross flex tracks.
- The fr size is free space divided by the total fr, with a minimum-size fix-up loop. In auto (hug) mode it uses the largest of size/fr.
- Auto tracks are stretched only when `justify-content` or `align-content` is `stretch`.
- **Cells are explicit objects** (`{row column row-span column-span position: auto|manual|area shapes}`), not CSS auto-placement. "Auto" cells are filled in the order of `layout-grid-dir`.

**CSS conformance verdict: not conformant.**
- The intrinsic sizing pass is simplified: only the min contribution is used and a max-content limit is never computed.
- The grid is never implicit, and the placement algorithm is not the CSS one.
- `space-*` uses `max(gap, …)`, as in flex.
- Totals for fr below 1 are treated as at least 1 per track (`tracks-total-frs` 121-129).
- Positions rely on a "points" basis to support rotation.

**Tests:** `common/test/common_tests/geom_grid_layout_test.cljc` (435 lines). Covers gap and justify behaviour, `set-auto-multi-span` in detail (span-1 cells ignored, gap removed from the budget, fixed tracks reduce the budget, smaller spans first) and padding clamps.

**Verdict:**
- REFERENCE for the engine.
- **PORT the mapping from Penpot cells to CSS** into the importer: tracks to `grid-template-*` (`flex` → `fr`); cells to `grid-row` and `grid-column` with spans; areas to `grid-template-areas`. A worked example of this mapping is in `frontend/src/app/util/code_gen/style_css_values.cljs` 105-126 and 390-432.

### 1.6 Text

| Penpot location | Approach | Verdict |
|---|---|---|
| `render-wasm/src/shapes/text.rs` 1-2427, `render/text.rs` 1-1322, `docs/texts.md` | Layout is entirely Skia `Paragraph`/`ParagraphBuilder`. Strokes and shadows are drawn by building extra paragraphs with special paints. Grow types are auto-width, auto-height and fixed (`get_width`/`get_height` at 1089-1120). Caret hit-testing is at 755-850. | REFERENCE. We use harfbuzz plus our own line breaking. |
| `common/src/app/common/types/shape/text.cljc` 18-78 | Content tree root → paragraph-set → paragraph → leaf `{text, fills, font-*, text-decoration, text-transform, typography-ref}`. `position-data` holds per-run boxes cached from the last layout. | **PORT** (schema) for the importer |
| `common/src/app/common/types/text.cljc` 20-170 | Attribute groups and defaults: `font-id "sourcesanspro"`, size `"14"`, `line-height "1.2"` (a unitless multiplier), letter-spacing `"0"`. All values are **strings**. | PORT the defaults and attribute list for the importer. |
| `common/src/app/common/fonts.cljs` 82-117 (`closest-variant`), 161-303 (unicode ranges per script → Noto fallback family, emoji regex, `collect-used-languages`) | Fallback font selection by script | **PORT the script table and emoji detection** (about 150 lines of TS). `closest-variant` is **not** CSS Fonts §5.2 matching (it prefers the heavier weight on a tie), so do not port it for a CSS engine. |
| `frontend/text-editor/src/**` (about 11k lines of JS, MPL, with vitest tests) | contenteditable-based rich-text editor: Selection and Change controllers, paste guard, commands | REFERENCE. Our text is rendered by us, not the DOM. Its paste and selection edge-case tests may still be useful. |
| `common/resources/fonts/gfonts.2025.11.28.json` | Google Fonts catalog snapshot | SKIP. Build our own from the Google Fonts API. |

Tests: `geom_shapes_text_test.cljc` (76 lines), `text_test.cljc`, `common_tests/logic/text_sync_test.cljc` (881 lines, text overrides in components), plus Rust unit tests in `shapes/text.rs` 2330+.

### 1.7 Vector: pen, vector networks, booleans, corners

| Penpot location | Approach / edge cases | Verdict |
|---|---|---|
| `common/src/app/common/types/path/bool.cljc` 1-429 | `content-bool-pair` 370-417: (1) turn close-path into line-to; (2) reverse B if the windings match (not for union); (3) split both paths at every intersection; (4) keep or drop each piece by testing its midpoint against the other shape (`contains-segment?` 169-182, ray casting); (5) add back overlapping border segments for union (333-338); (6) remove duplicates and repair move-tos. **Exclude = concatenate A and B** and relies on even-odd filling. N-ary operations fold left. | REFERENCE. Not robust: the midpoint test, a 0.1 tolerance, overlap detection only for identical segments, and no winding numbers. |
| `render-wasm/src/math/bools.rs` 1-840 | Same algorithm in Rust using `bezier-rs` (Graphite, MIT/Apache) and Skia `Path::contains`. Adds a bounding-box broad phase (120-194) and t clamping. `should_reverse_b` (319-333) documents that its rule differs from the CLJS one. Stitching rebuilds closed loops from a pool (335-450). | REFERENCE. **PORT the tests** at 636-840: expected signed areas for difference, union and 3-operand folds with opposite winding. |
| `common/src/app/common/types/path/segment.cljc` 366-482 (`make-curve-point`: smooth tangent from the neighbours, special case for the seam of a closed path), 665-895 (`remove-nodes`: replace a removed node with a line or a fitted cubic; `restore-split-curve` 707-736 rejoins two untouched De Casteljau halves, which exactly undoes "add node"; rotates the start of a closed subpath when the seam node is removed; joins open subpaths), 897-1270 (join, separate and merge coincident nodes) | Pen and node editing that preserves the drawn shape | **PORT** (high value for the pen tool) |
| `common/src/app/common/types/path/fit.cljc` 1-209 | Schneider least-squares cubic fit with chord-length parameters, Newton refinement (4 iterations), splitting at the point of max error, and pre-splitting at corners sharper than 60° | **PORT** (freehand pencil and node removal) |
| `common/src/app/common/types/path/helpers.cljc` 241-278 | `bend-reference-curve` and `bend-curve-deltas`: least-squares handle deltas so a dragged point on a curve follows the cursor | **PORT** (dragging a curve directly) |
| `common/src/app/common/types/path/shape_to_path.cljc` 22-240 | Rect, circle and rounded rect to path (κ = 0.551915024494); groups and bools flattened to a path | REFERENCE. Trivial. |
| `common/src/app/common/geom/shapes/corners.cljc` 17-46 | `fix-radius`: CSS backgrounds-3 corner-overlap scaling, f = min(Lᵢ/Sᵢ) | REFERENCE. Implement straight from the CSS spec. |
| Corner smoothing (squircles) | **Not implemented in Penpot.** Grepping for "squircle" and "smoothing" only finds conic-accuracy comments. | Nothing to reuse |
| Vector networks | **Not present.** Penpot paths are subpath lists (move, line, cubic, close only). | Nothing to reuse |

**Tests:**
- `path_data_test.cljc` 531-533: a union regression.
- 863-925: `make-curve-point`.
- 1255-1330: remove-nodes, fit-cubic and bend.
- `bools.rs` tests.
- All worth porting as fixtures.

### 1.8 Effects and shader fills

| Penpot location | Approach | Verdict |
|---|---|---|
| `render-wasm/src/shapes/shadows.rs` 1-324, `render/shadows.rs` 1-621 | Drop and inner shadows as Skia image filters. Spread = dilate (erode for an inner shadow). Footprint estimate at 63-80. | REFERENCE |
| `frontend/src/app/main/ui/shapes/filters.cljs` 29-186 | SVG filter graphs: drop shadow (feMorphology dilate or erode for ±spread, feOffset, feGaussianBlur σ=blur/2, color matrix); inner shadow (an arithmetic composite against hard alpha); background blur (`BackgroundImage`, which browsers do not support); layer blur | **PORT** for SVG export (about 120 lines of TS) |
| `frontend/src/app/main/ui/shapes/custom_stroke.cljs` 1-527 | Inner stroke = 2× width clipped to the shape. Outer stroke = 2× width masked by the inverse. Cap markers. | PORT for SVG export (about 200 lines of TS) |
| `render-wasm/src/render/strokes.rs` 116-550 (per-side rect strokes with radii and miter wedges), 647-775 (caps: line arrow, triangle arrow, square/circle/diamond markers, round, square) | Stroke geometry | REFERENCE. Cap geometry is portable if we add arrow caps. |
| `common/src/app/common/geom/shapes/bounds.cljc` 17-247 | Visual bounds grown by shadow offset, spread and blur, strokes (√2·w margin; a larger margin for paths) and cap markers | **PORT** (about 120 lines of TS) to enlarge rbush culling bounds |
| `render-wasm/src/shapes/fills.rs` 62-130, 300-345 | Gradient coordinates are normalised (0-1) to the selrect. A radial gradient's `width` is the ellipse ratio, applied by rotate-then-scale. Image fill = cover/centre. **`fills[0]` is the top-most fill** (rendered in reverse, `render/fills.rs` 233). | REFERENCE (needed by the importer) |
| Shader fills | **Not present** in Penpot | — |

### 1.9 Components, variants and variables (tokens)

| Penpot location | Approach | Verdict |
|---|---|---|
| `common/src/app/common/types/component.cljc` 38-148 (`sync-attrs`: about 80 attributes mapped to about 40 sync groups; `swap-keep-attrs`), 254-320 (touched-group set, `swap-slot-<uuid>` encoded as a touched group) | Override model: editing an attribute in a copy marks its group as "touched", and sync skips touched groups. Text content and geometry groups depend on shape type. | **PORT** (about 300 lines of TS) |
| `common/src/app/common/logic/libraries.cljc` 1-3211 (main → copy sync `generate-sync-shape-direct` 801-1016; copy → main inverse sync 1025-1196; `compare-children` 1197-1270; variant switch `update-attrs-on-switch` 2182-2365; keeping flex and grid child attributes on switch 2382-2515; swap 2689-2760; duplication 2871-3211) | Propagation of component changes: matching children by `shape-ref`, nested copies, swap slots | REFERENCE (too tied to the change-op model). **PORT the scenarios as tests.** |
| `common/src/app/common/types/variant.cljc` 1-354, `logic/variants.cljc` 1-243, `logic/variant_properties.cljc` 1-255 | Variants = components inside a "variant container" frame, with `property=value` names | REFERENCE |
| `common/src/app/common/types/tokens_lib.cljc` 1460-2129 (formats: legacy vs DTCG and single vs multi-set detection 1515-1580; composite conversions for font-family, typography and shadow 1583-1645; parse 1694-1908; export with themes 1909-2128) and `types/token.cljc` 87-131 (Penpot ↔ DTCG type map) | W3C DTCG import and export (cites the Community Group final report of 2025-10-28), token sets and themes | **PORT** (about 700 lines of TS) |
| `common/test/common_tests/types/data/tokens-*.json` (8 files, about 1.8k lines) | DTCG and legacy example files | **COPY** as fixtures (MPL-2.0; keep a notice in the fixture directory) |
| `frontend/packages/tokenscript/` and `frontend/src/app/main/data/tokenscript.cljs` 165 (`resolve-tokens`) | Token math and resolution through the third-party `@tokens-studio/tokenscript-interpreter` | SKIP. Third-party, license unverified. |

**Tests:**
- `common/test/common_tests/logic/` has 22 suites, about 11k lines. Examples: `comp_sync_test`, `comp_touched_test`, `swap_*`, `variants_switch_test` (3,183 lines), `token_test` (1,203), `token_apply_test`.
- Fixture `.penpot` files in `common/test/cases/*.penpot` use the **v1 binary (Fressian) format** (magic `800099563638710213`, `backend/src/app/binfile/v1.clj` 58). They are hard to read from TS, so port the scenarios by rebuilding them with our own builder.

### 1.10 Multiplayer and comments

| Penpot location | Approach | Verdict |
|---|---|---|
| `backend/src/app/rpc/commands/files_update.clj` 60-490 | The server is the authority. A client sends `{revn, changes}`. The server rejects `revn` > stored with a `revn-conflict` error (183-189), applies the changes, increments `revn`, returns "lagged" changes (455-460), snapshots every N revisions (434-445) and broadcasts over the msgbus (462+). | REFERENCE (we use Yjs) |
| `backend/src/app/http/websocket.clj` 1-354, `backend/src/app/msgbus.clj` 1-295 | WebSocket fan-out over Redis pub/sub; presence and pointer messages | REFERENCE |
| `backend/src/app/rpc/commands/comments.clj` 1-818 | Threads `{page-id, frame-id, position, seqn, participants, mentions}`. Mentions use the markup `@[name](id)` (regex at 39-40). Notifications are de-duplicated between thread and comment mentions (94-130). | REFERENCE |
| `common/src/app/common/files/changes.cljc` 523-535 (`set-comment-thread-position`) | Comment pins move with their frame | REFERENCE (edge case) |

### 1.11 Export and code view

| Penpot location | Approach | Verdict |
|---|---|---|
| `render-wasm/src/render/vector.rs`, `pdf.rs`, `render/svg/*` (with `svg/tests.rs` of 3,716 lines plus `fixtures.rs` and snapshots) | Vector PDF and SVG through Skia's PDF and SVG canvases. `@font-face` rules are collected for text. | REFERENCE. The SVG export test cases are good scenarios. |
| `exporter/src/app/renderer/{bitmap,pdf,svg}.cljs` | Headless Chromium via Playwright; `page.pdf` | SKIP |
| `frontend/src/app/main/ui/shapes/*.cljs` (`mask.cljs` 50-100: the mask is the **first child**, i.e. bottom-most, turned into an alpha mask via feFlood white plus composite; `gradients.cljs`; `export.cljs`) | SVG markup for shapes | REFERENCE plus the PORT items in 1.8 |
| `frontend/src/app/util/code_gen/{style_css,style_css_values,style_css_formats,markup_html,markup_svg}.cljs` (1,433 lines) | Shape to HTML and CSS: flex/grid mapping, logical properties, per-side border, box-shadow, backdrop-filter | REFERENCE. **Looks buggy:** `get-flex-shrink` (434-448) reads `:layout-flex-dir` from the child instead of the parent and checks for keywords that do not exist (`:reverse-row`, `:column-row`). Do not port blindly. |

### 1.12 Import (SVG and Penpot exports)

**`.penpot` v3 (ZIP + JSON)**, written by `backend/src/app/binfile/v3.clj`:
- Manifest schema at 58-82.
- Writer path layout at 290-501:
  ```
  manifest.json                         {type:"penpot/export-files", version:1, generatedBy, files:[{id,name,features[]}], relations:[[fileId, libId]], externalLibraries?}
  files/<fileId>.json                   file data (encode-file)
  files/<fileId>/pages/<pageId>.json    page
  files/<fileId>/pages/<pageId>/<shapeId>.json   one shape per file (root frame = 00000000-0000-0000-0000-000000000000)
  files/<fileId>/components/<id>.json   {id,name,path,mainInstanceId,mainInstancePage,...}
  files/<fileId>/colors/<id>.json, typographies/<id>.json, media/<id>.json
  files/<fileId>/thumbnails/<tag>/<pageId>/<frameId>.json
  files/<fileId>/tokens.json            DTCG (export-dtcg-json)
  files/<fileId>/tokens-status.json
  objects/<storageId>.json + objects/<storageId>.<ext>   media blobs
  ```
- Keys are camelCase JSON. I confirmed this in `backend/test/backend_tests/test_files/file-with-library.penpot`: `parentId`, `frameId`, `transformInverse`, `selrect{x,y,width,height,x1..y2}`, `points[4]`, `fills[{fillColor,fillOpacity}]`, `r1..r4`, `componentRoot`, `mainInstance`, `shapes[]`.
- Path `content` is an **SVG `d` string**, or the legacy vector of `{command, params}` (`common/src/app/common/types/path/impl.cljc` 570-597).
- The `features` list (for example `fdata/path-data`, `components/v2`, `layout/grid`, `variants/v1`, `design-tokens/v1`) gates semantics.
- Older exports may be **v1 binary** (Fressian) or v2. Supporting v3 only is reasonable; v1 and v2 need the backend.
- The ZIP reader guards entry size (550, 603). Copy that idea: guard against zip bombs.

**Schemas to translate into zod:**
- `common/src/app/common/types/shape.cljc` 119-487
- `types/shape/layout.cljc` 46-180
- `types/fills.cljc` 27-62
- `types/color.cljc` 75-125 (gradient `{type, startX/Y, endX/Y, width, stops[{color, opacity, offset}]}`; image `{id, width, height, mtype, keepAspectRatio, transform?}`)
- `types/shape/{shadow,blur,background_blur,interactions,export}.cljc`
- `types/shape/text.cljc` 18-78
- `types/component.cljc` 22-35
- `types/file.cljc` 49-124
- File migrations: `common/src/app/common/files/migrations.cljc` lists the data upgrades an old file needs.

**Semantics the importer must get right:**
- The geometry model (1.1).
- `fills[0]` is on top.
- Flex order is the reverse of `:shapes` (1.4).
- Mask = first child.
- The bool shape's stored `content` is precomputed, so use it rather than recomputing.
- `svg-raw` shapes embed raw SVG nodes.
- Text values are strings.
- Layout mappings (1.4 and 1.5).

**Other import sources:**
- `common/src/app/common/svg.cljc` 1-1034: tables of SVG tags, attributes, presentation attributes and inheritable properties (38-550); style parsing; transform parsing (727-823); polyline, polygon and line to path (824-868); `fix-percents` (952+).
- `common/src/app/common/files/shapes_builder.cljc` 1-761: SVG to shapes; gradient `href` resolution (113-190); stroke-only path detection (343).
- `library/` (`@penpot/library`, MPL): a cljs builder that **writes** `.penpot` files. It is a good oracle for writing round-trip tests.

**Fixtures:**
- `backend/test/backend_tests/test_files/{file-with-library,svg-attrs-camel-case}.penpot` are v3 ZIPs (small).
- `template.penpot` and the `common/test/cases/*.penpot` files are v1 binary.

**Verdicts:**
- **PORT** the schemas, the geometry conversion and the layout mapping.
- **COPY** the two v3 ZIP fixtures (MPL notice).
- REFERENCE the SVG importer. The SVG attribute tables are facts from the SVG spec and can be re-derived.

### 1.13 MCP server

**Location:** `mcp/packages/server/src` (TypeScript, about 62 files, none with a per-file license header).

**Tool surface** (`tools/*.ts`):
- `execute_code`: runs arbitrary JS against the Plugin API in the browser plugin. Persistent `storage` object across calls. Console output is returned separately.
- `high_level_overview`: serves `data/initial_instructions.md` (448 lines).
- `penpot_api_info {type, member?}`: on-demand API docs taken from `data/api_types.yml` (24k lines generated from plugin-types).
- `export_shape {shapeId|'selection'|'page', format: png|svg, mode: shape|fill, filePath?}`: returns an image for the model to look at.
- `import_image {filePath, x?, y?}`.
- `import_penpot_file`.
- Developer-only tools: `cljs_repl`, `cljs_compiler_output`, `clj_check_parentheses`, `read_taiga_issue`.

**Architecture:**
- The MCP server talks to the Penpot MCP plugin over WebSocket (`PluginBridge.ts` 1-492), authenticated by a user token.
- Single-instance and multi-instance (Redis) task dispatchers.
- Plugin heartbeats detect browser tabs that have been **frozen or suspended** (21-60), because WebSocket pongs are not reliable for this.
- `PenpotUtils.ts` (632 lines): `shapeStructure`, `findShapes`, `setParentXY`, `generateCss`, `exportImage`, `tokenOverview`.

**Verdict: REFERENCE.**
- `execute_code` (arbitrary code with immediate effect) goes against Fig Tree's reviewable proposals. Do not adopt it.
- Worth adopting:
  - An `export_shape`-style visual feedback tool.
  - Docs served on demand per type (`penpot_api_info`) instead of a huge system prompt.
  - A short "high-level overview" resource.
  - Heartbeat-based detection of frozen tabs.
- Tests: `PenpotMcpServer.test.ts`, `.http.test.ts`, `PluginBridge*.test.ts`, `MultiInstanceTaskDispatcher.test.ts`, `RedisBridge.test.ts`.

### 1.14 Plugin API

| Penpot location | Approach | Verdict |
|---|---|---|
| `plugins/libs/plugin-types/index.d.ts` 1-5921 | The full typed surface: `Penpot` and `Context`, `ShapeBase` (3803-4259), `Board`, `FlexLayout` (1954), `GridLayout` (2210), `LayoutChildProperties` (2655), `Text`/`TextRange` (4397-4615), `Library`/`LibraryComponent`/`LibraryVariantComponent`, `Interaction`/`Animation`, `TokenCatalog`/`TokenSet`/`TokenTheme`/`Token*` (4668-5764), `CommentThread`, `PluginData`, `HistoryContext`, `Viewport` | COPY is permitted (MPL). Realistically REFERENCE: the names are Penpot-branded (`penpot` global). If we want Penpot plugin compatibility, copy the file under MPL as a compatibility shim. |
| `plugins/libs/plugins-runtime/src/lib/*` (`create-sandbox.ts` 1-223, `ses.ts` 1-23, `load-plugin.ts`, `parse-manifest.ts`, `validate-url.ts`, `plugin-manager.ts`) | SES `lockdown`/`harden` with a `Compartment` per plugin. Errors from plugin code are tracked in a WeakMap. The UI runs in an iframe modal. Manifest validation. | REFERENCE (adopt the SES approach; the `ses` package itself is Apache-2.0) |
| `plugins/apps/plugin-api-test-suite/` (27 test files, 8,868 lines; `src/generated/api-surface.json`) | Conformance suite for the API surface | COPY only if we pursue Penpot plugin compatibility |
| `frontend/src/app/plugins/*.cljs` (about 12k lines) | API proxies mapped onto changes | REFERENCE |

### 1.15 Prototyping

| Penpot location | Approach | Verdict |
|---|---|---|
| `common/src/app/common/types/shape/interactions.cljc` 1-811 | Events: click, mouse-press, over, enter, leave, after-delay. Actions: navigate, open/toggle/close overlay, previous screen, open URL. Animations: dissolve, slide, push, with easing, way and direction. **Options are deliberately kept when the type changes** (comment at 18-26), so readers must use the `has-*` guards. `calc-overlay-position` (494-584) handles relative-to and manual positioning. `invert-direction` (703). | **PORT** (about 350 lines of TS) |
| `frontend/src/app/main/data/viewer.cljs` (`complete-animation` 613), `frontend/src/app/main/ui/viewer/interactions.cljs` | Viewer runtime | REFERENCE |
| Flows: `changes.cljc` 552-566 (`set-flow`), `libraries.cljc` 2817 | Starting points of prototype flows | REFERENCE |

Test: `common/test/common_tests/types/shape_interactions_test.cljc`.

---

## 2. Reuse verdicts: what to take first for each upcoming module

| Fig Tree module | Highest-value item | Verdict |
|---|---|---|
| geometry | Path test corpus (`path_data_test.cljc`, `svg_path_test.cljc`); `transforms.cljc` 188-283 for the importer | PORT tests; PORT the transform code for import |
| renderer | `tiles.rs` `PendingTiles`/`TileHashMap`/interest-ring scheduling; atlas inset; effect bounds (`bounds.cljc`) | PORT (small) |
| document model | Invariants from `files/validate.cljc`; change-op edge cases | REFERENCE |
| layout flex | Divergence list (1.4); Penpot-to-CSS mapping for import | REFERENCE (engine); PORT (mapping) |
| layout grid | Divergence list (1.5); cell-to-CSS mapping | REFERENCE; PORT (mapping) |
| text | Script → Noto fallback table plus emoji regex (`fonts.cljs` 161-303); text content schema | PORT (small) |
| vector/booleans/corners | `segment.cljc` remove-nodes, make-curve-point; `fit.cljc`; `bend-curve-deltas`; boolean tests | PORT; booleans REFERENCE |
| effects | SVG filter graphs for shadows (`filters.cljs`) and inner/outer strokes (`custom_stroke.cljs`); sigma convention | PORT (for SVG export) |
| components/variants/variables | `sync-attrs` touched groups and swap-slot; DTCG parse/export plus JSON fixtures; logic scenario tests | PORT; COPY fixtures |
| multiplayer/comments | Mention markup, frame-anchored comment pins | REFERENCE |
| export/code view | SVG export patterns; code_gen as a cautionary reference | REFERENCE / PORT parts |
| import | v3 ZIP layout, schemas, geometry and layout semantics; v3 fixtures | PORT; COPY fixtures |
| MCP | Visual export tool, per-type API docs, heartbeat | REFERENCE |
| plugin API | `plugin-types/index.d.ts` (compatibility shim only), SES sandbox design | REFERENCE / optional COPY |
| prototyping | `interactions.cljc` model plus overlay positioning | PORT |

---

## 3. Assets and trademarks to avoid

Do **not** copy any of the following:
- **Names and marks:** "Penpot", the Penpot logo and icon. Files include `frontend/resources/images/assets/penpot-logo*.svg`, `frontend/resources/images/icons/penpot-logo*.svg`, `penpot-logo-icon-loader.svg` and `frontend/resources/images/email/logo-penpot.svg`. Also the "Kaleidos" name except in required copyright notices. Do not use `@penpot/*` package names, the `penpot` global, or "penpot" in our own identifiers. Naming a feature after the format ("Import Penpot file") is generally fine; do not use their logo for it.
- **Icons:** all 326 SVGs in `frontend/resources/images/icons/` and `frontend/resources/images/assets/` (illustrations, empty-state art, `beforeyoustartilustration.svg`, `community.svg`), avatar images and email templates. Fig Tree must use Lucide only anyway.
- **Fonts:** `frontend/resources/fonts/*` (Work Sans, Source Sans Pro, Vazirmatn, Roboto Mono) and `render-wasm/src/fonts/{WorkSans-Numeric.ttf, sourcesanspro-regular.ttf}`. These are OFL or Apache third-party fonts. If needed, get them from upstream with their own licenses, not from Penpot.
- **UI copy:** `frontend/translations/*` (all locales), onboarding and release-notes screens (`frontend/src/app/main/ui/releases/*`), the help-center content in `docs/`, the MCP prose in `mcp/packages/server/data/*.md` and the plugin docs in `plugins/docs/`.
- **Styles:** `plugins/libs/plugins-styles` (Penpot's plugin UI look) and the frontend SCSS and theme tokens.
- **Data:** `common/resources/fonts/gfonts.*.json` (Google Fonts catalog data) and `sample_media/`.
- **Generated or third-party code:** `frontend/packages/tokenscript/schemas.js` (generated from Tokens Studio).

---

## 4. License notes

**Coverage:**
- The root `LICENSE` is MPL-2.0. Of the per-package files, only `plugins/LICENSE` (MPL-2.0) and `frontend/packages/mousetrap/LICENSE` (Apache-2.0) exist.
- A grep for "Incompatible With Secondary Licenses" matches only the two MPL license texts (`./LICENSE` and `./plugins/LICENSE`, where the term is defined). **No file carries the Exhibit B notice.** Every MPL file recommended here can therefore be combined with AGPL-3.0 under MPL §3.3.
- Most `.cljc` and `.cljs` files have the standard MPL header with "Copyright (c) KALEIDOS SUBSIDIARY SL". `common/src/app/common/types/modifiers.cljc` says "UXBOX Labs SL".
- **206 source files lack per-file headers.** These include all of `render-wasm/src/**/*.rs`, all of `mcp/packages/**/*.ts`, all of `plugins/libs/**/*.ts` and a few `.cljc` files (`types/shape/token.cljc`, `logic/variants.cljc`, `thumbnails.cljc`). They fall under the directory or root LICENSE, which MPL Exhibit A allows. `render-wasm/Cargo.toml` uses `license-file = "../LICENSE"`, and `render-wasm/package.json`, `library/package.json`, `exporter/package.json` and `frontend/text-editor/package.json` say MPL-2.0.

**Conflicting declarations (red flag, low severity):**
- `mcp/packages/server/package.json` says `"license": "MIT"`, but `mcp/package.json` says MPL-2.0.
- `plugins/package.json` says `"license": "MIT"`, but `plugins/LICENSE` and `plugins/README.md` say MPL-2.0.
- Either license is AGPL-compatible. **Treat these as MPL-2.0** (the stricter reading), or ask Penpot if it matters.

**Third-party code inside Penpot:**
- `common/src/app/common/svg/path/arc_to_bezier.js`: **MIT**, a modified copy of fontello/svgpath `a2c.js`.
- `common/src/app/common/svg/path/parser.js` 637-773 (`unitVectorAngle`, `getArcCenter`, `approximateUnitArc`, `processCurve`, `arcToBeziers`): labelled MPL, but closely mirrors the same MIT `a2c` code. **If ported, include the fontello/svgpath MIT notice (Vitaly Puzrin) as well as MPL.** Better: write it from the W3C SVG arc implementation notes.
- `frontend/packages/mousetrap`: Apache-2.0 ("WITH LLVM-exception" per its `package.json`). Not needed.
- `frontend/packages/tokenscript/schemas.js`: auto-generated from `@tokens-studio/tokenscript-schemas` v0.4.0. **License not verified. Do not copy.**
- `frontend/packages/draft-js`: an MPL wrapper around a Penpot fork of draft-js (MIT upstream). Not needed.
- `exporter/vendor/cuerdas/impl/xregexp.cljs`: a 4-line shim. Irrelevant.
- Rust dependencies used by render-wasm: `bezier-rs` (Graphite, MIT/Apache-2.0), `skia-safe` (MIT), Skia (BSD-3), `glam` (MIT/Apache). We port none of these.
- Fonts: see section 3.

**Obligations for our ported or copied files (MPL-2.0 §3):**
1. Each ported or copied TS file stays MPL-2.0 at file level. It needs the Exhibit A header, the original copyright line ("Copyright (c) KALEIDOS SUBSIDIARY SL") and a provenance line: `Ported from penpot/<path> @5eb33ad`. Add our own copyright for our changes.
2. Keep these files as separate files, not mixed into AGPL files. Our AGPL code may import them (a "Larger Work", §3.3). The combined work can ship under AGPL, while these files remain available under MPL.
3. When distributing, including over a network for AGPL, the source of the MPL files, with our modifications, must stay available. Our AGPL source distribution already satisfies this.
4. Do not remove or change notices. Ship a copy of the MPL-2.0 text (for example `LICENSES/MPL-2.0.txt`) and a `THIRD_PARTY_NOTICES` entry for Penpot. Add MIT notices for any fontello-derived arc code.
5. Fixtures copied from Penpot (JSON, `.penpot` ZIPs, PNG snapshots) cannot hold a header. Put a `LICENSE`/`NOTICE` file in the fixture directory naming MPL-2.0 and the source paths.
6. Clean-room note: Fig Tree describes itself as clean-room. Ported files are by definition **not** clean-room. Keep them in clearly marked locations, for example `packages/*/src/ported/penpot/`, so provenance stays auditable.

---

## 5. Top 10 recommended ports, ranked

Sizes are rough estimates of TypeScript lines excluding tests.

| # | What | Source (Penpot) | Verdict | Est. TS size | Fig Tree module / agent |
|---|---|---|---|---|---|
| 1 | **`.penpot` v3 importer core.** zod schemas for the manifest, file, page, shape, fills/gradients/strokes/shadows/blur, layout and text content. Penpot geometry (selrect + transform + points + flips) to our transforms. Flex and grid to CSS (fill → `flex:1 1 <minW>px` + min/max; order = reverse of `:shapes`; cells → grid-row/column/areas). `fills[0]` on top; first child is the mask; use the stored bool content. | `backend/src/app/binfile/v3.clj` 58-501; `common/.../types/shape.cljc` 119-487; `types/shape/layout.cljc` 46-180, 663-1200; `types/{fills,color}.cljc`; `types/shape/text.cljc` 18-78; `types/text.cljc` 141-170; `types/path/impl.cljc` 510-600; `geom/shapes/transforms.cljc` 121-283; `frontend/.../code_gen/style_css_values.cljs` 105-185, 390-450 | PORT, plus COPY of the 2 v3 ZIP fixtures | 1,800-2,500 | Import agent (with the layout agent reviewing the CSS mapping) |
| 2 | **Path node-editing algorithms.** Remove a node with a fitted replacement, rejoin De Casteljau halves, rotate the seam of a closed path, smooth or corner a node, bend a curve by dragging, Schneider fit with corner pre-splitting (freehand). | `common/.../types/path/segment.cljc` 366-482, 665-895, 897-1270; `types/path/fit.cljc` 1-209; `types/path/helpers.cljc` 241-278 | PORT, plus its tests from `path_data_test.cljc` 863-925 and 1255-1330 | 600-800 | Vector/pen agent |
| 3 | **DTCG token import and export.** Format detection (legacy, DTCG, single or multi-set), composite types (typography, shadow, font-family), themes and set order. | `common/.../types/tokens_lib.cljc` 1460-2129; `types/token.cljc` 87-131 | PORT, plus COPY of 8 JSON fixtures from `common/test/common_tests/types/data/` | 600-800 | Components/variables agent |
| 4 | **Component override model.** `sync-attrs` → touched groups, swap slots as touched groups, attributes kept on swap, rules for keeping layout-child attributes on variant switch. Plus scenario tests rebuilt from `logic/*_test.cljc`. | `common/.../types/component.cljc` 38-320; `logic/libraries.cljc` 2182-2515 (as a spec) | PORT (model), REFERENCE (propagation engine), PORT (scenarios as tests) | 300-450, plus about 1,500 lines of tests | Components/variants agent |
| 5 | **Tile scheduling and cache policy.** Two-way tile/shape index, visible vs interest ring, cached vs uncached priority, deferred interest, drag-only-visible mode, cache key including scale, atlas inset. | `render-wasm/src/tiles.rs` 1-597; `render/surfaces.rs` 14-200; `docs/tile_rendering.md` | PORT (logic only) | 250-350 | Renderer agent |
| 6 | **Geometry and boolean test corpus.** Path parser cases, extremities, intersections, subpath ops, `clockwise?`, boolean expected areas. | `common/test/common_tests/types/path_data_test.cljc`; `svg_path_test.cljc`; `render-wasm/src/math/bools.rs` 636-840 | PORT tests (algorithms REFERENCE) | about 1,000 test lines | Geometry agent, then the vector/booleans agent |
| 7 | **SVG export of effects.** Shadow filter graphs (spread via feMorphology, inner shadow via arithmetic composite), inner and outer strokes via clip and mask, cap markers, alpha mask from the first child, gradient transforms (radial ellipse `width`). Plus visual-bounds expansion for culling. | `frontend/src/app/main/ui/shapes/{filters,custom_stroke,mask,gradients}.cljs`; `common/.../geom/shapes/bounds.cljc` 17-247; `render-wasm/src/shapes/fills.rs` 62-130 | PORT | 450-600 | Export agent; bounds go to the renderer agent |
| 8 | **Prototype interaction model.** Event, action and animation schema; option-retention semantics; overlay positioning; direction inversion. | `common/.../types/shape/interactions.cljc` 1-811 | PORT | 300-400 | Prototyping agent |
| 9 | **Text fallback by script.** Unicode-range table → Noto families, emoji detection, collecting used scripts. Do **not** port `closest-variant`; use CSS font matching. | `common/src/app/common/fonts.cljs` 161-303 | PORT | 120-180 | Text agent |
| 10 | **Plugin API compatibility layer (optional).** Copy `index.d.ts` as a `penpot-compat` type shim and use `plugin-api-test-suite` as its conformance target. Adopt the SES Compartment and harden design from plugins-runtime. | `plugins/libs/plugin-types/index.d.ts`; `plugins/apps/plugin-api-test-suite/`; `plugins/libs/plugins-runtime/src/lib/create-sandbox.ts`, `ses.ts` | COPY (types/tests, MPL, renamed identifiers) / REFERENCE (runtime) | 0 new (copied about 6k d.ts) plus about 400 adapter lines | Plugin API agent (later phase) |

**Explicitly not recommended:**
- Porting `flex_layout` or `grid_layout` into `packages/layout`. They are Figma auto-layout semantics, not CSS (see 1.4 and 1.5).
- Porting Penpot's boolean algorithm. It is fragile; build a robust winding-number approach and use Penpot's tests only as regression vectors.
- Anything Skia-specific in render-wasm beyond design ideas.
- The `execute_code`-style MCP tool.

## 6. Open questions and uncertainties

- **`*-reverse` flex semantics.** I inferred from `positions.cljc` (no reverse handling) and `layout_data.cljc` 418-419 that reverse only flips item order. Confirm with a fixture before finalising the importer mapping.
- **Index-0 bottom convention for `:shapes`.** I inferred that `:shapes` index 0 is the bottom-most layer from the flex reversal, mask = `(first childs)` and the MCP docs ("add background shapes first"). It is not stated as a single invariant anywhere I found.
- **`.penpot` v2 format.** I did not survey it (`backend/src/app/binfile/v2.clj`). v1 is Fressian-based and impractical outside the JVM.
- **Gaps in fixture coverage.** I did not check whether the Playwright render fixtures (`frontend/playwright/data/**`) cover layouts. They are Transit `get-file` RPC payloads, not export files.
- **`tokenscript` licensing.** The license of the Tokens Studio tokenscript packages is unverified.
