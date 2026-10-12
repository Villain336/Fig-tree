# Parity matrix

This table lists the core features Figma documents publicly, plus the features that make Paper distinctive. It records where Fig Tree stands on each and how we intend to differ.

**Status legend:**
- **done**: works end to end within this repository and is covered by tests.
- **partial**: the engine side exists and is tested, but the user-facing tool does not exist yet.
- **planned**: not started.

Module 1 built the geometry kernel and the renderer. Module 2 built the document model: a Yjs CRDT of CSS-semantic nodes, the command API, per-user undo, reviewable proposals, the `.figtree` format and the bridge that renders a document. Module 3 built our own CSS layout engine (box model, flexbox, grid, positioned layout), checked against Chromium, and wired it into the bridge. Module 4 built the text engine (fonts, HarfBuzz shaping, CSS line layout) and glyph rendering, checked against Chromium's geometry and pixels, and wired it into layout and the bridge. Module 5a built the core editing UI: `packages/editor-core` (tools, selection, interaction state machines, hit-testing, snapping, text editing, clipboard, keyboard map, UI anchors) and the editor's panels (see "Core editing" below). This file only marks as done what actually works and is tested.

## Canvas and rendering

| Feature | Status | Fig Tree angle |
|---|---|---|
| Infinite canvas with pan and zoom | done | Wheel and trackpad scroll, ctrl/⌘-wheel and pinch zoom about the pointer, space-drag and the hand tool, zoom to fit, to selection and 100%, zoom steps (e2e `editing.spec.ts`). Panning uploads nothing, and a screen-tile cache only rasterizes newly exposed tiles (`/bench`). |
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
| Hit-testing and selection | done | `editor-core` hit-tests the bridge's scene geometry (fills by their fill rule, strokes and lines with a screen-space tolerance, frames, text and images by their box, clips honoured, hidden and locked nodes transparent). Selection rules, marquee and handles: see "Core editing". |
| Pixel preview and pixel grid | partial | The pixel grid shows at 800% and above, on the overlay (e2e); positions snap to whole pixels (unit tests). There is no pixel preview mode. |
| Rulers, guides and snapping | partial | Smart guides and snapping are done (below). Rulers (Shift+R) show coordinates and the selection's extent; there are no draggable ruler guides. |

## Core editing (Module 5a)

What a designer does in the first hour. Behaviour follows public documentation and ordinary use of design tools; the UI, its wording and its icons (Lucide) are our own. "Unit" means `packages/editor-core/test`, "e2e" means `e2e/editing.spec.ts` (real mouse and keyboard in Chromium, both backends where pixels are checked).

| Feature | Status | Fig Tree |
|---|---|---|
| Click, Shift-click, ⌘/Ctrl deep select | done | Top-level frames act as boards (their children are picked directly; the board by its name label or once selected); groups select as a whole until entered; siblings of the selection are picked directly (unit, e2e). |
| Double-click select-through, Enter/Shift+Enter, Tab, Escape | done | Into groups and frames one level at a time; double-click on text edits it; Enter selects children, Shift+Enter the parent, Tab the next sibling, Escape goes up (unit). |
| Marquee selection | done | Intersection for layers, containment for boards (a marquee crossing a board selects inside it), ⌘/Ctrl for the deepest layers, Shift adds (unit). |
| Hover outlines | done | The outline of what a click would select (its shape for ellipses, polygons, stars and vectors), on an overlay canvas (unit for the target; drawn by the app). |
| Move: drag, arrow nudge (1 px, Shift 10 px) | done | One undo step per drag; Shift constrains to an axis; positions snap to whole pixels; dropping over a frame reparents into it, dropping on the canvas moves out, keeping the place on screen (unit, e2e). |
| Reorder inside auto layout by dragging or arrows | done | With a drop indicator line; the layout places the nodes (unit, e2e). |
| Resize handles (8 + edges) | done | Corners and edge midpoints (when there is room) plus the whole edge; Shift keeps the aspect ratio (or a locked ratio always), Alt resizes from the center; dragging past the anchor mirrors (flip); rotated nodes resize along their own axes; text switches to fixed width with auto height (unit, e2e). |
| Rotate | done | Zones just outside the corners; Shift snaps to 15°; about the center, or the selection's center for several nodes (unit, e2e). |
| Multi-selection transforms | done | Resizing scales every node in the selection box (exact for unrotated nodes), rotation turns them about its center (unit). |
| Line endpoints | done | Drag either end; Shift snaps to 45° (unit). |
| Smart guides and snapping | done | Edges and centers of siblings on screen, the parent's edges, center and padding box, equal spacing (centered between two neighbours, or repeating a gap), pixel grid; guide lines and spacing marks; ⌘/Ctrl disables while moving (unit for the math and the gestures). |
| Distance measurement (Alt-hover) | done | Gaps to the hovered layer, or the inside distances to a container (unit for the math). |
| Duplicate (Alt-drag, ⌘/Ctrl+D) | done | (unit, e2e) |
| Copy, cut, paste | done | Our clipboard format (subtrees, world placements, assets with their bytes) travels as HTML next to plain text; pastes in place, into a selected frame, on another page or into another document (unit, e2e). |
| Paste SVG, plain text and images | done | SVG becomes a frame of shapes, groups and vector networks with fills, strokes and transforms (our own XML and path parser; gradients, masks, filters, `<use>` and CSS classes are not imported); text becomes a text node; images become image nodes backed by content-addressed assets (unit, e2e). HTML paste is module 9. |
| Delete, group/ungroup, frame selection (⌘/Ctrl+Alt+G) | done | Each one undo step (unit, e2e for menus). |
| Bring forward/backward, to front/back | done | (unit) |
| Lock and hide | done | Locked and hidden layers are transparent to the canvas; toggles in the layers panel (unit, e2e). |
| Flip horizontal/vertical | done | About the selection's center (unit). |
| Align and distribute | done | To the selection, or a single layer to its parent frame (unit, e2e). |
| Zoom tools and pan | done | See "Canvas and rendering". |
| Pixel grid at high zoom, rulers | partial | See above. |
| Creation tools: frame (with device presets), rectangle, ellipse, polygon, star, line, text, image | done | Click for a default size (or a preset), drag to size; Shift for squares and 45° lines, Alt from the center; created inside the frame under the pointer; a frame drawn around layers adopts them; numbered names; the image tool places a file as an asset (unit, e2e). Preset names are generic device classes. |
| Text editing on the canvas | done | Double-click or Enter to edit; caret and selection from the text engine's hit-testing; arrows by grapheme, ⌘/Ctrl or Alt by word, Home/End or ⌘ by line, paragraph and document moves, Shift extends (macOS and other bindings); mouse click, drag, double-click word, triple-click paragraph, Shift-click; typing, deleting by grapheme cluster, word and line; IME composition through a hidden textarea (the composed text is in the document while composing, one undo step); plain-text copy and paste; bold, italic, underline and every typography field apply to the selection as style runs, or to the next typed text; runs of typing are one undo step; empty text is removed when editing ends (unit with real fonts, e2e). |
| Text resizing: auto width, auto height, fixed | done | Panel and handles (unit, e2e). |
| Layers panel | done | Tree with collapse, rename, drag to reorder and reparent with drop indicators (before, after, inside), lock and hide toggles, Shift range and ⌘/Ctrl toggle selection synced with the canvas, hover sync, context menu (e2e). Very large documents start collapsed (rows are capped at 2,000). |
| Pages panel | done | Add, switch, rename, delete (e2e for add and switch). |
| Design panel: position, size, rotation, sizing modes, min/max, aspect lock, constraints | done | Number fields take math (`12*2`), relative edits (`+10`, `*2`), percentages, arrow keys (Shift ×10) and label scrubbing (one undo step), and show "Mixed" for multi-selections (e2e). |
| Design panel: auto layout and grid | done | See "Layout". |
| Design panel: corner radius (per corner), smoothing, opacity, blend mode, clip content | done | (e2e; blend modes are stored and listed as not drawn yet) |
| Fills and strokes paint stacks, color picker | done | Add, remove, hide, reorder by stack, hex and opacity per paint; the picker has solid, linear and radial paints, a saturation/brightness area, hue and alpha sliders, Hex/RGB/HSL fields and the browser's eyedropper where supported (e2e). Stroke weight, position, ends, corners and dashes. |
| Gradient editing on the canvas | done | Handles for linear (start, end) and radial (center, two radii) gradients and a marker per stop, draggable (unit); stops are added, moved and removed in the picker (e2e). Angular and diamond gradients are not drawn yet, so they have no handles. |
| Typography panel | done | Family (searchable picker), weight, size, line height, letter spacing, alignment, vertical alignment, decoration, case, resizing, truncation with max lines (e2e). |
| Effects | planned | The section lists stored effects; shadows and blurs are module 6. |
| Keyboard shortcuts and the shortcuts sheet | done | One keyboard map (physical keys, so layouts do not matter), shown in a searchable sheet (⌘/Ctrl+/) and in menus (unit, e2e). |
| Context menus (canvas, layers, pages) | done | (e2e) |
| UI anchors for Sprout | done | Every toolbar button, panel field, menu item, list row and canvas handle registers a stable id and a rect (`editor.anchors`); an e2e test checks every interactive control in many UI states. |
| Undo/redo per user | done | Every edit goes through the command API with the user's actor; gestures, scrubs and typing runs are single steps; Escape cancels a gesture without leaving a redo (unit, e2e). |
| Selection and hover in presence | done | Local state shaped as an awareness payload (page, selection, hover, text caret, cursor), never in the document (unit). Showing other people's presence is module 8. |
| Image fills drawn | planned | Image nodes show a placeholder outline: the renderer does not draw bitmaps yet. |

## Vector

| Feature | Status | Fig Tree angle |
|---|---|---|
| Paths (lines, quadratic and cubic Béziers) | done | `Path` with tight bounds and adaptive flattening (Wang's formula, screen-space tolerance). |
| Rectangle with per-corner radii | done | Radii are clamped like CSS `border-radius`. |
| Corner smoothing (squircle-like) | done | Our own G2 construction, with property tests for continuity and curvature; edited in the design panel (e2e). |
| Ellipse | done | Arcs and pies are not done (see below). |
| Arcs and pie ellipses, polygons, stars | done | Arcs, pies, ring segments and donuts; regular polygons and stars that fill their box; rounded corners on any polygon. Stored as node properties, rendered through the bridge and tested at the geometry, bridge and pixel levels. Polygon and star tools, point count and star ratio in the panel; arc editing has no UI yet. |
| Pen tool | planned | Module 5b. `editor-core` has a tool registry and an edit-mode API for it to plug into. |
| Vector networks (non-linear paths) | partial | Data model done: vertices, Bézier segments, regions with their own fill rule and fills, validated loops. Rendering: regions are filled, and segment chains are stroked with joins, broken only at junctions. Per-vertex radii and caps are not drawn yet. There is no editing tool. |
| Boolean operations | planned | A robust winding-number approach on our flattening and winding primitives. Penpot's booleans are fragile, so we use their tests only as regression vectors. |
| Flatten, outline stroke | partial | Engine only: `flattenPath` and `strokePath` produce the polygons. No command exists to turn them into document geometry. |

## Text

Text is laid out by our own engine (`packages/text`) from the CSS each text node states, so text in the editor wraps, hugs and aligns like the exported CSS in a browser: 166 cases and 56 documents match Chromium's line breaks exactly and every glyph box to one layout unit (1/64 px), and the pixels to within 2% on 154 of 166 cases (`docs/conformance.md`). Most rows below are rendering features with no editing UI yet: they are set through the command API.

| Figma | Status | Fig Tree |
|---|---|---|
| Text layers rendered on the canvas | done | Glyph runs from a glyph atlas (exact-area coverage, 4 subpixel positions) on WebGPU and WebGL2; large or transformed text as outlines; fills from the paint stack (solid and gradients). Editor tests on both backends; per-case pixel comparison with Chromium. |
| Auto width, auto height, fixed size | done | `width: max-content`, `height: auto`, fixed sizes: text hugs, wraps and drives auto layout (conformance "sizing" cases, document cases, editor tests). |
| Truncate text, max lines | done | `text-overflow: ellipsis` and `-webkit-line-clamp`, matching Chromium's geometry. |
| Font family, weight, style, size | done | CSS Fonts 4 matching over registered faces, synthetic bold and oblique when a face is missing. A font picker over the registry (searchable), weight from the family's faces, size (e2e). |
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
| Fonts: Google Fonts | partial | `GoogleFontsLoader` loads any OFL, Apache 2.0 or UFL family from github.com/google/fonts (tested offline, and live with `GOOGLE_FONTS_LIVE=1`). The font picker lists popular Google families and loads one on demand; that path needs the network and is not covered by the e2e tests. |
| Fonts: uploaded and shared | partial | Uploaded font files are content-addressed assets in the `.figtree` file with their `@font-face` descriptor, used by every client that opens it (tested). No upload UI. |
| Missing fonts | partial | Text waits for a loading font and never lays out with faked metrics; a family nobody has falls back to the last-resort family. There is no missing-font warning or replace dialog. |
| Text editing (caret, selection, IME) | done | On the canvas: see "Core editing". |
| Text styles | planned | Module 7: named styles resolved into the same text properties. |
| Vertical trim (leading trim), hanging punctuation | planned | CSS `text-box-trim` and `hanging-punctuation`. |
| Text strokes | planned | Reported as unsupported per node; not drawn. |
| Spell check | planned | |

## Layout

| Feature | Status | Fig Tree angle |
|---|---|---|
| Auto layout | done | We do not imitate auto layout: frames lay out with real **CSS flexbox**, computed by our own engine from the CSS each node states (`cssDeclarations`, the same CSS code export emits). The editor renders auto-layout frames, and edits made through the command API reflow them incrementally. This is covered by unit tests, Playwright pixel tests on both backends, and 651 flexbox cases plus 128 documents matching Chromium box for box (`docs/conformance.md`). There is no editing UI yet (next row). |
| Auto layout editing UI | done | Add (Shift+A, guessing direction, gap and padding from the children) and remove; direction, wrap, gap, padding, the 3×3 alignment matrix, space between, hug/fill/fixed per axis, min/max; children reorder by dragging on the canvas or with the arrow keys (unit and e2e). There are no on-canvas gap or padding handles. |
| Grid layout | done | Real **CSS grid**, beyond Figma's grid auto layout: `fr`, `minmax()`, `fit-content()`, `min-content`/`max-content` tracks, `repeat()` with `auto-fill`/`auto-fit`, named lines and template areas, implicit tracks, sparse and dense auto-placement, spanning items, content and self alignment. 921 grid cases match Chromium. The panel edits track lists (fr, px, %, auto, min-content, max-content), gaps, padding and item alignment (e2e); `repeat()`, `minmax()` and areas show read-only, and items' grid placement has no UI yet. |
| Constraints | done | Absolutely positioned children keep their constraints (start, end, start-end, center, scale) when layout resizes their parent, and when the user resizes it with handles or the panel; ⌘/Ctrl while resizing ignores them (unit tests). Set in the design panel (e2e). |
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
| Inspect panel (CSS, measurements) | partial | The CSS tab shows the selected node's computed layout box and its CSS from `cssDeclarations` (tested); typography is mapped, paints and effects not yet. Alt-hover measures distances on the canvas (unit-tested math; drawn on the overlay). |
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
| Pages | done | Create, rename, reorder, delete (at least one page stays), and move nodes between pages keeping their canvas position. The pages panel adds, switches, renames and deletes pages (e2e); reordering pages has no UI yet. |
| Layer operations | done | Create, update, rename, reparent (keeping canvas position through rotated and flipped parents), reorder, delete, duplicate, group and ungroup, through one command API with atomic batches; all reachable from the canvas, menus, shortcuts and the layers panel (see "Core editing"). |
| Undo and redo per user | done | One undo stack per actor. Undo never reverts another person's or agent's edits (tested with interleaved edits and across replicas). |
| Reviewable AI edits (proposals) | done | A batch is applied to a fork, shown as a structured diff (created, deleted, moved and updated nodes with before and after values), then accepted as one undoable step or rejected without touching the document. |
| Save and open (`.figtree`) | partial | A deterministic zip of canonical JSON, content-addressed assets and optional CRDT history, with a migrations hook, a zip bomb guard and asset hash checks. Lossless round trips are fuzz-tested. There is no save or open UI in the editor yet. |
| Import from other tools | planned | See `docs/reference/penpot.md` §1.12 for the `.penpot` importer plan. |

## Editing limitations (honest list)

1. **Pen, vector point editing and boolean operations** are module 5b; they plug into the tool registry and edit-mode API. Vector nodes from SVG paste can be moved, resized and rotated but not edited point by point yet.
2. **Bitmaps are not drawn.** Placed and pasted images are image nodes backed by assets, shown with a placeholder outline until the renderer draws image paints.
3. **Rotated multi-selections** scale each node along its own axes: exact for unrotated nodes, approximate (no skew) for rotated ones. Resizing a single rotated node is exact.
4. **Snapping** considers siblings, the parent and its padding box, not other frames' children or layout grids; resizing snaps only axis-aligned boxes; equal spacing is offered while moving, not while resizing.
5. **Text editing:** no spell check, no rich-text paste (plain text only; HTML paste is module 9), no list toggles in the panel (lists render from stored properties), the caret does not blink, and up/down in mixed-direction (bidi) lines moves by the visual x of the caret, which can surprise in right-to-left runs. IME is tested with composition event sequences (unit) and Playwright typing, not with real input methods.
6. **Pasting SVG** imports shapes, paths, groups, presentation attributes and inline styles; gradients, patterns, masks, filters, `<use>`, `<image>`, CSS classes and `em`/`%` lengths are ignored.
7. **Panels:** no blend modes or effects on the canvas (stored, listed as not drawn), no grid placement of items (row/column spans), no `repeat()`/`minmax()` editing in the track editor (shown read-only), no font upload UI (the engine and file format support uploaded fonts), Google Fonts only through the picker's popular list or a typed family name (needs the network).
8. **Very large documents:** hit-testing, hover and marquee walk the page's tree (fast enough at 10k nodes, about a millisecond); the layers panel starts collapsed and lists at most 2,000 rows.
9. **Latency numbers are CPU only.** On this machine every frame is rasterized by SwiftShader; the wall-clock time between frames is dominated by it (see `benchmarks.md`).

## Document model limitations (honest list)

1. **Groups have no box.** Their children live in the group's parent space and join its layout as with `display: contents`; inside flex and grid frames, a group's children stay absolutely positioned.
2. **Not drawn yet, and listed per node instead:** text strokes, image bitmaps, angular, diamond, image and shader paints, blend modes (layer and paint), effects, per-side stroke weights, single-axis overflow (both axes clip), and vector vertex radii and caps.
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
