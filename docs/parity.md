# Parity matrix

This table lists the core features Figma documents publicly, plus the features that make Paper distinctive. It records where Fig Tree stands on each and how we intend to differ.

**Status legend:**
- **done**: works end to end within this repository and is covered by tests.
- **partial**: the engine side exists and is tested, but the user-facing tool does not exist yet.
- **planned**: not started.

Module 1 built the geometry kernel and the renderer. Module 2 built the document model: a Yjs CRDT of CSS-semantic nodes, the command API, per-user undo, reviewable proposals, the `.figtree` format and the bridge that renders a document. Module 3 built our own CSS layout engine (box model, flexbox, grid, positioned layout), checked against Chromium, and wired it into the bridge. Module 4 built the text engine (fonts, HarfBuzz shaping, CSS line layout) and glyph rendering, checked against Chromium's geometry and pixels, and wired it into layout and the bridge. Most tools a designer touches are still planned. That is deliberate: this file only marks as done what actually works and is tested.

## Canvas and rendering

| Feature | Status | Fig Tree angle |
|---|---|---|
| Infinite canvas with pan and zoom | partial | The editor (`/`) renders a document through the bridge with wheel and drag pan, ctrl-wheel zoom and fit-to-page. Pan and zoom are benchmarked in `/bench`. The editor's pan and zoom interaction itself has no automated test yet. Panning uploads nothing, and a screen-tile cache only rasterizes newly exposed tiles. |
| GPU rendering of vector content | done | Our own renderer: a WebGPU compute rasterizer with exact analytic coverage, and a WebGL2 stencil-then-cover fallback with MSAA. No Skia or CanvasKit. |
| Anti-aliasing quality | done | WebGPU coverage matches exact area to within 8-bit rounding (max error 0.002 on a fractional rect). Curve accuracy is bounded by 0.1 px flattening. |
| Solid fills | done | Premultiplied src-over in sRGB space. |
| Linear and radial gradients | done | Any number of stops, interpolated unpremultiplied. Radial accepts an extra transform for elliptical gradients. Only pad spread. |
| Angular and diamond gradients | planned | Same per-pixel paint stage; a new parameter-space mapping. |
| Image fills | planned | Texture paint in the composite stage. |
| Strokes: joins, caps, dashes | done | Miter (with limit), round and bevel joins; butt, round and square caps; SVG-style dashes with offset, including zero-length dots. |
| Stroke alignment (inside/outside) | done | Rectangles and frames: an exact stroke on the inset or outset rectangle, with no layer. Other shapes: a double-width stroke clipped by the outline, or by its even-odd complement for outside strokes. Pixel tests on both backends and a property test that both constructions cover the same band. Per-side weights are stored but not drawn yet (recorded as unsupported). |
| Variable-width strokes and brushes | planned | |
| Nonzero and even-odd fill rules | done | Both backends. |
| Layer opacity (isolated groups) | done | Real isolation: overlapping children do not double-blend. Single-draw opacity is folded for free. |
| Clip content (frames) | done | Arbitrary clip paths, including rounded and rotated frames, with anti-aliased edges. Nested up to 8 layers deep. |
| Blend modes | planned | The composite stage already has an explicit layer stack. |
| Effects: drop and inner shadow, layer and background blur | planned | Will sample layer textures in compute. |
| Masks (alpha and luminance) | planned | Generalizes the clip layer: coverage from a rendered layer instead of a path. |
| Hit-testing and selection | partial | `Renderer.hitTest` returns the topmost node, honoring transforms, strokes and clips, using the same flattened geometry the GPU draws. The bridge maps scene nodes back to document nodes. In the editor, clicking the canvas selects that node in the layer list (tested). There are no selection handles or multi-select yet. |
| Pixel preview and pixel grid | planned | |
| Rulers, guides and snapping | planned | |

## Vector

| Feature | Status | Fig Tree angle |
|---|---|---|
| Paths (lines, quadratic and cubic Béziers) | done | `Path` with tight bounds and adaptive flattening (Wang's formula, screen-space tolerance). |
| Rectangle with per-corner radii | done | Radii are clamped like CSS `border-radius`. |
| Corner smoothing (squircle-like) | partial | Engine done: our own G2 construction, with property tests for continuity and curvature. No UI. |
| Ellipse | done | Arcs and pies are not done (see below). |
| Arcs and pie ellipses, polygons, stars | done | Arcs, pies, ring segments and donuts; regular polygons and stars that fill their box; rounded corners on any polygon. Stored as node properties, rendered through the bridge and tested at the geometry, bridge and pixel levels. No drawing tools yet. |
| Pen tool | partial | Engine done: `PenTool` in `@fig-tree/geometry` is a framework-free state machine. Clicks place corners and drags pull mirrored handles; Alt breaks the handles. Clicking a vertex or segment branches the network; clicking the first point closes the path and fills it. Shift constrains to 15°, a snapping hook takes grids and guides, and Backspace removes the last vertex. Scenario tests cover it. The editor's tool (module 5a) is not wired yet. |
| Vector networks (non-linear paths) | partial | The model and every editing operation are done and fuzz-tested: 12,000 random operations keep the network valid. The operations are: add, move, merge and disconnect vertices; split, bend, straighten and curve segments; handles with mirroring by angle or by angle and length; close a path; the fill tool (faces with holes). `editVector` applies them as commands. Vertex corner radii are drawn on both backends, and pixel tests cover branches, holes and rounded corners. Per-vertex caps are not drawn yet. The vector edit mode UI is module 5a. |
| Path editing: delete a point keeping the shape, smooth, bend, simplify | partial | Engine and commands done. A deleted point's two segments are refit by least squares, and the two halves of a split curve are restored exactly. Smooth and symmetric handles, least-norm bending and simplification within a tolerance are also done. Penpot's path-editing vectors pass, and the refit error is bounded by tests. No UI. |
| Pencil (freehand) | partial | Engine done: Schneider curve fitting with corner detection. Every input point stays within the tolerance (property-tested). Closed strokes become filled networks with smooth joints. No UI. |
| SVG path import and export | partial | `parseSvgPath` and `svgPathToNetwork` read every command, including arcs (W3C implementation notes). `networkToSvgPath` writes paths back; parse, serialize and parse again gives the same network within 1e-9 (property-tested). There is no file import UI yet. |
| Boolean operations | partial | Exact curve booleans: union, subtract, intersect and exclude on an arrangement of the curves, with winding numbers per operand and curves out. They pass 1,383 adversarial and random cases against an independent reference with 0 point-sampling mismatches. Penpot's regression vectors pass too. Live **boolean groups** in the document are re-evaluated per overlap cluster when a child changes (30–50 ms for an edit in a 1,000-child group) and drawn on both backends (pixel tests). Created through the `group` command; no UI yet. |
| Flatten, outline stroke | partial | `flatten` (every primitive shape, vectors with corner radii, groups and boolean groups; several nodes keep their fills per region) and `outlineStroke` (centered, inside and outside; curves out, cleaned by the boolean union) are tested commands. Text flattens through the bridge (`textToVectorNetwork`, glyph outlines from the text engine). No UI. |

## Text

Text is laid out by our own engine (`packages/text`) from the CSS each text node states, so text in the editor wraps, hugs and aligns like the exported CSS in a browser: 166 cases and 56 documents match Chromium's line breaks exactly and every glyph box to one layout unit (1/64 px), and the pixels to within 2% on 154 of 166 cases (`docs/conformance.md`). Most rows below are rendering features with no editing UI yet: they are set through the command API.

| Figma | Status | Fig Tree |
|---|---|---|
| Text layers rendered on the canvas | done | Glyph runs from a glyph atlas (exact-area coverage, 4 subpixel positions) on WebGPU and WebGL2; large or transformed text as outlines; fills from the paint stack (solid and gradients). Editor tests on both backends; per-case pixel comparison with Chromium. |
| Auto width, auto height, fixed size | done | `width: max-content`, `height: auto`, fixed sizes: text hugs, wraps and drives auto layout (conformance "sizing" cases, document cases, editor tests). |
| Truncate text, max lines | done | `text-overflow: ellipsis` and `-webkit-line-clamp`, matching Chromium's geometry. |
| Font family, weight, style, size | done | CSS Fonts 4 matching over registered faces, synthetic bold and oblique when a face is missing. No font picker yet. |
| Variable fonts (axes) | done | `wght`, `wdth`, `opsz`, `ital`, `slnt` from CSS properties, plus any axis through `fontVariations`. No axis sliders yet. |
| OpenType features (Details panel) | done | Kerning, ligatures, numeric styles, fractions, stylistic and contextual alternates through `fontFeatures` (`font-feature-settings`) and the `font-variant-*` mapping. |
| Line height, letter spacing, paragraph spacing, paragraph indent | done | CSS `line-height` (normal, number, px, %), `letter-spacing` (px, em), paragraph spacing between paragraphs, `text-indent`. |
| Horizontal and vertical alignment | done | `text-align` (left, center, right, justify, start, end) and top/center/bottom placement in fixed boxes. |
| Text case | partial | Upper, lower and title case (`text-transform`) done. Small caps only through the `smcp` feature: there is no synthesized small caps. |
| Decoration (underline, strikethrough) | done | Positioned like Chromium, skipping ink under descenders. The document has no decoration style, thickness or offset properties yet (the engine supports thickness and offset). |
| Lists (bulleted, numbered, nested) | done | `listStyle` and `listLevel` per paragraph: outside markers, 1.5 em per level, numbering per level (document conformance cases). |
| Links | partial | Stored per style run (`link`) and exported; not clickable or styled on the canvas. |
| Mixed styles in one text layer | done | Style runs are Yjs text formatting (concurrent typing and styling merge); each run is a CSS inline box. |
| Right-to-left and complex scripts | done | UAX #9 bidi (bidi-js), Arabic joining, Devanagari conjuncts, CJK line breaking, through HarfBuzz; direction `auto` follows the first strong character. |
| Script fallback | done | Per-character fallback through the family list, then a per-script table (ported from Penpot), then last-resort families. |
| Emoji | partial | Emoji keep one grapheme (ZWJ sequences, flags) for carets; without an emoji font they draw the font's missing-glyph box. Color fonts (COLR, CBDT, sbix, SVG) are not drawn in color. |
| Fonts: Google Fonts | partial | `GoogleFontsLoader` loads any OFL, Apache 2.0 or UFL family from github.com/google/fonts (tested offline, and live with `GOOGLE_FONTS_LIVE=1`). No font picker. |
| Fonts: uploaded and shared | partial | Uploaded font files are content-addressed assets in the `.figtree` file with their `@font-face` descriptor, used by every client that opens it (tested). No upload UI. |
| Missing fonts | partial | Text waits for a loading font and never lays out with faked metrics; a family nobody has falls back to the last-resort family. There is no missing-font warning or replace dialog. |
| Text editing (caret, selection, IME) | partial | Engine side: hit-testing (point to caret index) and caret rectangles per text node, and the `insertText`, `deleteText` and `formatText` commands. No editing UI. |
| Text styles | planned | Module 7: named styles resolved into the same text properties. |
| Vertical trim (leading trim), hanging punctuation | planned | CSS `text-box-trim` and `hanging-punctuation`. |
| Text strokes | planned | Reported as unsupported per node; not drawn. |
| Spell check | planned | |

## Layout

| Feature | Status | Fig Tree angle |
|---|---|---|
| Auto layout | done | We do not imitate auto layout: frames lay out with real **CSS flexbox**, computed by our own engine from the CSS each node states (`cssDeclarations`, the same CSS code export emits). The editor renders auto-layout frames, and edits made through the command API reflow them incrementally. This is covered by unit tests, Playwright pixel tests on both backends, and 651 flexbox cases plus 128 documents matching Chromium box for box (`docs/conformance.md`). There is no editing UI yet (next row). |
| Auto layout editing UI | planned | The inspector shows the computed box and CSS; there are no controls to change direction, gap or alignment, and no drag handles. |
| Grid layout | done | Real **CSS grid**, beyond Figma's grid auto layout: `fr`, `minmax()`, `fit-content()`, `min-content`/`max-content` tracks, `repeat()` with `auto-fill`/`auto-fit`, named lines and template areas, implicit tracks, sparse and dense auto-placement, spanning items, content and self alignment. 921 grid cases match Chromium. No editing UI yet. |
| Constraints | partial | Absolutely positioned children keep their constraints (start, end, start-end, center, scale) when layout resizes their parent, for example a fill or hug frame (tested). There is no resize tool yet, so resizing a frame in the document does not move its children. |
| Layout grids (column guides) | planned | |

### Figma auto layout, feature by feature

| Figma | CSS in Fig Tree | Status |
|---|---|---|
| Horizontal / vertical direction | `flex-direction: row` / `column` (also `row-reverse`, `column-reverse`) | done |
| Spacing between items | `column-gap` / `row-gap` | done |
| "Auto" spacing | `justify-content: space-between` (also `space-around`, `space-evenly`) | done |
| Padding, per side | `padding` | done |
| Alignment (9-point grid) | `justify-content` + `align-items` (also `baseline`, `stretch`, `safe`, per-item `align-self`) | done; baseline alignment of text waits for text shaping (module 4) |
| Hug contents | `width/height: fit-content` | done |
| Fill container | `flex: 1 1 0px` on the main axis, `align-self: stretch` on the cross axis, `100%` elsewhere | done |
| Fixed size | `width/height: Npx` (with `flex-shrink: 0` on the main axis) | done |
| Min / max width and height | `min-*` / `max-*` | done |
| Wrap | `flex-wrap: wrap` (also `wrap-reverse`, `align-content`) | done |
| Absolute position inside auto layout | `position: absolute` with insets from constraints | done |
| Strokes included in layout | `border-width` from stroke weights (`strokesInLayout`) | done |
| Aspect ratio lock | `aspect-ratio` | done |
| Grid auto layout | CSS grid (row above) | done, and beyond Figma |
| Text in auto layout | measured leaves | partial: text uses its stored box until module 4 shapes it |
| Item order | `order` (by default the layer order is the flow order) | done |

Where we exceed Figma: real CSS grid, `fr`/`minmax()`/`fit-content()` tracks and areas, reverse directions, `wrap-reverse` and `align-content`, baseline and `safe` alignment, per-item flex factors and bases, auto margins, and layout that is exactly the exported CSS (checked against Chromium).

## Components

| Feature | Status | Fig Tree angle |
|---|---|---|
| Components and instances, overrides | planned | Fields are reserved in the schema: `componentRef` and overridden property groups on any node, component and instance ids, property definitions and values. The behaviour is module 7. |
| Variants and component properties | planned | |
| Libraries and publishing | planned | |

## Variables

| Feature | Status | Fig Tree angle |
|---|---|---|
| Color, number, string and boolean variables | planned | Stored as CSS custom properties, with DTCG token import and export. |
| Modes (for example light and dark) | planned | |

## Collaboration

| Feature | Status | Fig Tree angle |
|---|---|---|
| Real-time multiplayer editing | partial | The document is a Yjs CRDT with deterministic tree repair for concurrent moves, cycles and deletes. A property test runs 50 seeds × 3 replicas × 2,000 random concurrent commands, with randomized delivery, and requires byte-identical results. The bridge applies remote updates incrementally. There is no network provider or server yet. |
| Cursors, presence and observation | planned | Rendered as an overlay scene, so they never invalidate document tiles. |
| Comments | planned | |
| Version history and branching | partial | Binary Yjs history snapshots (`history.yjs` in `.figtree`, `encodeHistory`) keep the full CRDT history and can keep syncing. Proposals are short-lived branches: fork, diff, then accept or reject. There is no history UI. |

## Prototyping

| Feature | Status | Fig Tree angle |
|---|---|---|
| Interactions, transitions, smart animate | planned | |
| Overflow scrolling, overlays | planned | |
| Presentation and mirror | planned | |

## Dev handoff

| Feature | Status | Fig Tree angle |
|---|---|---|
| Inspect panel (CSS, measurements) | partial | The editor's inspector shows the selected node's computed layout box (position, size, padding, border) and its CSS for layout, box, overflow, radii and compositing, from `cssDeclarations` (tested). Paints, effects and typography are not mapped to CSS yet. There are no on-canvas measurements. |
| Dev mode annotations and ready-for-dev status | planned | |
| Code Connect-style component mapping | planned | |

## Export

| Feature | Status | Fig Tree angle |
|---|---|---|
| PNG and JPG export | partial | `Renderer.readPixels()` returns exact frame pixels, and the test suite exports PNGs with them. There is no export UI or scale options. |
| SVG and PDF export | planned | Walks the document, not the GPU scene. |
| Code export (HTML/CSS, React) | planned | |

## AI

| Feature | Status | Fig Tree angle |
|---|---|---|
| AI generation and editing | planned | **Sprout**, our agentic cursor, edits the canvas through the same command API as people, visible as a collaborator. Its edits can arrive as reviewable proposals (fork, structured diff, accept or reject), which are built and tested. |
| Search and rename assistance | planned | |

## Paper-style code-native features

| Feature | Status | Fig Tree angle |
|---|---|---|
| Code-native canvas (HTML/CSS semantics) | partial | Every node property is CSS-semantic and validated (box model, sizing, positioning, flex and grid, overflow, radii, compositing, typography), with a tested mapping to CSS declarations. Layout is computed from exactly that CSS by our own engine, and 128 documents rendered from their CSS in Chromium match the editor's layout box for box. Text is module 4. |
| Shader fills and effects | planned | The WebGPU compute composite stage evaluates paints per pixel, so custom WGSL paints slot in there. |
| MCP server | planned | Will expose the command API and proposals: typed, validated commands with useful errors, atomic batches and per-agent undo, all tested. |

## Document and files

| Feature | Status | Fig Tree angle |
|---|---|---|
| Document model with typed, validated properties | done | zod schemas for every node type and property group, a published JSON Schema, and useful errors (path and reason). |
| Pages | done | Create, rename, reorder, delete (at least one page stays), and move nodes between pages keeping their canvas position. The editor shows the first page; there is no page switcher yet. |
| Layer operations | done | Create, update, rename, reparent (keeping canvas position through rotated and flipped parents), reorder, delete, duplicate, group and ungroup, through one command API with atomic batches. These are API-level and tested; the editor's only UI for them is the layer list. |
| Undo and redo per user | done | One undo stack per actor. Undo never reverts another person's or agent's edits (tested with interleaved edits and across replicas). |
| Reviewable AI edits (proposals) | done | A batch is applied to a fork, shown as a structured diff (created, deleted, moved and updated nodes with before and after values), then accepted as one undoable step or rejected without touching the document. |
| Save and open (`.figtree`) | partial | A deterministic zip of canonical JSON, content-addressed assets and optional CRDT history, with a migrations hook, a zip bomb guard and asset hash checks. Lossless round trips are fuzz-tested. There is no save or open UI in the editor yet. |
| Import from other tools | planned | See `docs/reference/penpot.md` §1.12 for the `.penpot` importer plan. |

## Document model limitations (honest list)

1. **Groups have no box.** Their children live in the group's parent space and join its layout as with `display: contents`; inside flex and grid frames, a group's children stay absolutely positioned.
2. **Not drawn yet, and listed per node instead:** text strokes, image bitmaps, angular, diamond, image and shader paints, blend modes (layer and paint), effects, per-side stroke weights, single-axis overflow (both axes clip), and vector vertex caps.
3. **Delete wins.** A node created inside a container that someone deleted concurrently is dropped. A node moved there goes back to its previous parent. Undoing your own creation of a container also hides what others put in it meanwhile, until redone.
4. **Undo can resurrect cycles.** Undo restores old placement values without re-validating them. If the restored placement conflicts with a concurrent move, tree repair resolves it deterministically, which can move the other user's node back.
5. **Structural edits rebuild the tree.** Creating, moving or deleting nodes rebuilds the effective tree in O(n) (milliseconds at 10k nodes). Property edits do not.
6. **Order keys grow** by about one digit per 30 appends to the same parent, and logarithmically for batches.

## Layout limitations (honest list)

1. **Horizontal, left-to-right boxes.** Writing modes and `direction: rtl` for box layout (flex and grid order) are not modelled. Text inside a box is laid out right to left where its direction says so.
2. **Block layout is simplified.** Every block container establishes an independent formatting context (`display: flow-root`): sibling margins collapse, but there is no parent–child margin collapsing, no collapsing through empty boxes, no floats and no inline formatting context. Text is a measured leaf. Documents only use block frames as canvases of absolutely positioned children, so this does not affect them.
3. **Text is a leaf.** Text boxes are measured by the text engine (min-content, max-content, height for width, baselines); there is no inline formatting context mixing text with other inline boxes.
4. **Grid gaps:** no subgrid (the stretch goal was not reached), no masonry, no baseline alignment in the column axis (`justify-self: baseline`), and no second column-sizing pass for items whose min-content width depends on row sizes (§11.1 step 3; it matters for orthogonal flows and aspect ratios).
5. **Units and values:** `px`, `%` and `calc()` of them only (no `em`, `rem` or viewport units). Not supported: `display: contents` and `inline-*` (inline variants lay out as block-level boxes), `position: sticky` (documents treat it as `relative`), anchor positioning, the areas form of the `grid-template` shorthand. `border-width` without a border style is taken as solid.
6. **Scrollbars take no space**: scroll containers lay out like `overflow: hidden`.
7. **`position: fixed`** uses the viewport; documents lay it out like `absolute`.
8. **Chromium is the only reference.** Matching it sometimes means following Chromium over a literal reading of the spec (listed in `docs/conformance.md`). Firefox and WebKit are not checked.
9. **Cost of opening large documents.** Layout adds about 0.6 s to building a 10,000-node document's bridge, half of it styles parsed from `cssDeclarations` (`docs/benchmarks.md`). Edits stay at a few milliseconds.

## Text limitations (honest list)

1. **Chromium is the reference.** Geometry and line breaking follow Chromium on Linux with the same font files; Firefox and Safari break and position text differently in places and are not checked. One unexplained difference: for a few fractional font sizes (16.3 px to 20.3 px) Chromium's advances are 1/64 px off from the rule the engine uses.
2. **Glyph coverage is exact area, not Chromium's.** Chromium applies a gamma and contrast curve to glyph coverage (thin strokes lighter); we draw exact-area coverage like every other shape, which is what the per-case pixel differences (1.4% of the text region on average, at most 3.0%) consist of. No hinting, no subpixel (LCD) anti-aliasing.
3. **No color glyphs.** COLR/CPAL, CBDT/CBLC, sbix and SVG glyphs are not drawn in color; emoji without a monochrome glyph show the missing-glyph box.
4. **Not implemented:** `hyphens: auto` (dictionary hyphenation; manual soft hyphens work), `text-box-trim`, `hanging-punctuation`, `text-wrap: pretty` beyond avoiding a one-word last line, `text-emphasis`, ruby, vertical writing modes, `text-decoration-style` other than solid, `font-synthesis` control, `font-palette`, and line breaking dictionaries for Thai, Lao, Khmer and Myanmar (they break as UAX #14 alone allows).
5. **Font loading is per face, all or nothing.** A font file loads completely before any glyph is used; there is no `unicode-range` subsetting of large CJK fonts beyond what the faces declare.
6. **Shaping cost.** A paragraph is shaped as a whole and re-shaped on every edit (about 0.25 ms for a short paragraph, 35–45 ms for 10,000 characters); there is no incremental re-shaping within a paragraph.

## Renderer limitations (honest list)

1. **Conflation seams (WebGPU).** Two separate draws that abut at a *fractional* pixel position leave a faint seam: a pixel 50% covered by each composites to 75% ink, measured at 64/255 on white. The test suite records this. Shared edges inside one path, and pixel-aligned edges between draws, have no seam. The WebGL2 MSAA path has none. Planned fix: sample-mask coverage for edge pixels, or merging abutting fills into one path at export and authoring time.
2. **WebGL2 anti-aliasing is 4x MSAA.** That gives 5 coverage levels per pixel instead of exact area: the worst pixel is off by 0.31 on a circle, against 0.10 on WebGPU. It is visibly fine at 1x DPR and good at 2x.
3. **Flattened curves.** Curves are rendered as polygons within 0.1 device px, chosen after a 0.2 px setting measured 0.19 coverage error on a circle. Coverage error at curved edges is up to about 0.1 (mean 0.04).
4. **Layer depth.** At most 8 nested isolated layers (group opacity and clips). Deeper groups lose isolation, and deeper clips are ignored, with a console warning.
5. **Tile-cache invalidation is all or nothing.** Any scene edit or zoom change re-renders directly and drops the cache. A per-shape tile index for targeted invalidation, as Penpot keeps, is the next step. The cache needs at most half the 256-slot atlas for the visible tiles, so very large canvases (about 4K at 2x DPR) always render directly.
6. **Snapped translation.** The view translation is snapped to whole device pixels, so tiles and direct frames match exactly. Sub-pixel panning is not shown.
7. **Single float precision on the GPU.** Local-space segments keep precision near each node. Extreme zoom on very large coordinates is untested beyond ±1e5.
8. **Not implemented in the renderer yet:** blend modes, effects, image fills, angular and diamond gradients, color glyphs and text strokes.
9. **Performance numbers are software-rendered.** All measurements come from SwiftShader on a CPU. Real-GPU numbers are pending; see `benchmarks.md`.
10. **WebGL2 layers are expensive on SwiftShader.** Each clip or group-opacity layer resolves and composites through an offscreen MSAA target. With hundreds of layers on screen (for example 100 clipping frames and 400 clipped ellipse strokes in the 10k-node document), a full WebGL2 frame blocks for about 1 s on this machine, most of it waiting for SwiftShader. WebGPU's CPU time for the same frame is about 0.04 s; its GPU time, also on SwiftShader, is not in that number. A stencil-only clip path (no offscreen target when there is no group opacity) is the planned fix.
11. **Very wide strokes on tight curves can leave holes.** The polygon stroker draws a closed contour as two loops. Where the stroke is wider than twice the radius of curvature (a 20 px stroke on a 5 px circle), the inner loop turns inside out and cancels the outer one under the nonzero rule, so pixels the stroke covers are left empty. The outline-stroke engine handles this case (it unions positively wound pieces), and its tests compare against the exact disk. The renderer's stroker still has the issue. The stroker's "round joins cover exactly the points within width/2" property test hits it occasionally on random input.
