# Parity matrix

This table lists the core features Figma documents publicly, plus the features that make Paper distinctive. It records where Fig Tree stands on each and how we intend to differ.

**Status legend:**
- **done**: works end to end within this repository and is covered by tests.
- **partial**: the engine side exists and is tested, but the user-facing tool does not exist yet.
- **planned**: not started.

Module 1 built the geometry kernel and the renderer, so almost everything a designer touches is still planned. That is deliberate: this file only marks as done what actually works.

## Canvas and rendering

| Feature | Status | Fig Tree angle |
|---|---|---|
| Infinite canvas with pan and zoom | partial | Pan and zoom work in `/bench` (wheel and drag) with a retained renderer. The editor canvas is not wired up yet. Panning uploads nothing, and a screen-tile cache only rasterizes newly exposed tiles. |
| GPU rendering of vector content | done | Our own renderer: a WebGPU compute rasterizer with exact analytic coverage, and a WebGL2 stencil-then-cover fallback with MSAA. No Skia or CanvasKit. |
| Anti-aliasing quality | done | WebGPU coverage matches exact area to within 8-bit rounding (max error 0.002 on a fractional rect). Curve accuracy is bounded by 0.1 px flattening. |
| Solid fills | done | Premultiplied src-over in sRGB space. |
| Linear and radial gradients | done | Any number of stops, interpolated unpremultiplied. Radial accepts an extra transform for elliptical gradients. Only pad spread. |
| Angular and diamond gradients | planned | Same per-pixel paint stage; a new parameter-space mapping. |
| Image fills | planned | Texture paint in the composite stage. |
| Strokes: joins, caps, dashes | done | Miter (with limit), round and bevel joins; butt, round and square caps; SVG-style dashes with offset, including zero-length dots. |
| Stroke alignment (inside/outside) | planned | Clip a doubled-width stroke with the fill path, using the existing clip layers. |
| Variable-width strokes and brushes | planned | |
| Nonzero and even-odd fill rules | done | Both backends. |
| Layer opacity (isolated groups) | done | Real isolation: overlapping children do not double-blend. Single-draw opacity is folded for free. |
| Clip content (frames) | done | Arbitrary clip paths, including rounded and rotated frames, with anti-aliased edges. Nested up to 8 layers deep. |
| Blend modes | planned | The composite stage already has an explicit layer stack. |
| Effects: drop and inner shadow, layer and background blur | planned | Will sample layer textures in compute. |
| Masks (alpha and luminance) | planned | Generalizes the clip layer: coverage from a rendered layer instead of a path. |
| Hit-testing and selection | partial | `Renderer.hitTest`: topmost node, honoring transforms, strokes and clips, using the same flattened geometry the GPU draws. No selection UI yet. |
| Pixel preview and pixel grid | planned | |
| Rulers, guides and snapping | planned | |

## Vector

| Feature | Status | Fig Tree angle |
|---|---|---|
| Paths (lines, quadratic and cubic Béziers) | done | `Path` with tight bounds and adaptive flattening (Wang's formula, screen-space tolerance). |
| Rectangle with per-corner radii | done | Radii are clamped like CSS `border-radius`. |
| Corner smoothing (squircle-like) | partial | Engine done: our own G2 construction, with property tests for continuity and curvature. No UI. |
| Ellipse | done | Arcs and pies are not done (see below). |
| Arcs and pie ellipses, polygons, stars | planned | |
| Pen tool | planned | |
| Vector networks (non-linear paths) | planned | |
| Boolean operations | planned | A robust winding-number approach on our flattening and winding primitives. Penpot's booleans are fragile, so we use their tests only as regression vectors. |
| Flatten, outline stroke | partial | Engine only: `flattenPath` and `strokePath` produce the polygons. No command exists to turn them into document geometry. |

## Text

| Feature | Status | Fig Tree angle |
|---|---|---|
| Text layers with shaping | planned | harfbuzzjs shaping plus a glyph atlas rasterized by our own coverage engine. Text fits CSS semantics, so the code view matches the canvas. |
| Text styles, OpenType features, variable fonts | planned | |
| Lists, links, rich text | planned | |

## Layout

| Feature | Status | Fig Tree angle |
|---|---|---|
| Auto layout | planned | We do not imitate auto layout: we implement real **CSS flexbox and grid**, checked against a Chromium conformance suite, so layout exports as working CSS. |
| Constraints | planned | Expressed through CSS positioning. |
| Layout grids | planned | |

## Components

| Feature | Status | Fig Tree angle |
|---|---|---|
| Components and instances, overrides | planned | |
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
| Real-time multiplayer editing | planned | Yjs CRDT document; the scene is a projection with per-aspect change tracking. |
| Cursors, presence and observation | planned | Rendered as an overlay scene, so they never invalidate document tiles. |
| Comments | planned | |
| Version history and branching | planned | CRDT snapshots and branches. |

## Prototyping

| Feature | Status | Fig Tree angle |
|---|---|---|
| Interactions, transitions, smart animate | planned | |
| Overflow scrolling, overlays | planned | |
| Presentation and mirror | planned | |

## Dev handoff

| Feature | Status | Fig Tree angle |
|---|---|---|
| Inspect panel (CSS, measurements) | planned | Code is the document's native form, not a translation. |
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
| AI generation and editing | planned | **Sprout**, our agentic cursor, edits the canvas through the same document operations as people, visible as a collaborator. |
| Search and rename assistance | planned | |

## Paper-style code-native features

| Feature | Status | Fig Tree angle |
|---|---|---|
| Code-native canvas (HTML/CSS semantics) | planned | Layout and text follow CSS. The renderer was designed so that layout output (transforms and sizes) needs nothing new from it. |
| Shader fills and effects | planned | The WebGPU compute composite stage evaluates paints per pixel, so custom WGSL paints slot in there. |
| MCP server | planned | Exposes document operations to external agents. |

## Renderer limitations (honest list)

1. **Conflation seams (WebGPU).** Two separate draws that abut at a *fractional* pixel position leave a faint seam: a pixel 50% covered by each composites to 75% ink, measured at 64/255 on white. The test suite records this. Shared edges inside one path, and pixel-aligned edges between draws, have no seam. The WebGL2 MSAA path has none. Planned fix: sample-mask coverage for edge pixels, or merging abutting fills into one path at export and authoring time.
2. **WebGL2 anti-aliasing is 4x MSAA.** That gives 5 coverage levels per pixel instead of exact area: the worst pixel is off by 0.31 on a circle, against 0.10 on WebGPU. It is visibly fine at 1x DPR and good at 2x.
3. **Flattened curves.** Curves are rendered as polygons within 0.1 device px, chosen after a 0.2 px setting measured 0.19 coverage error on a circle. Coverage error at curved edges is up to about 0.1 (mean 0.04).
4. **Layer depth.** At most 8 nested isolated layers (group opacity and clips). Deeper groups lose isolation, and deeper clips are ignored, with a console warning.
5. **Tile-cache invalidation is all or nothing.** Any scene edit or zoom change re-renders directly and drops the cache. A per-shape tile index for targeted invalidation, as Penpot keeps, is the next step. The cache needs at most half the 256-slot atlas for the visible tiles, so very large canvases (about 4K at 2x DPR) always render directly.
6. **Snapped translation.** The view translation is snapped to whole device pixels, so tiles and direct frames match exactly. Sub-pixel panning is not shown.
7. **Single float precision on the GPU.** Local-space segments keep precision near each node. Extreme zoom on very large coordinates is untested beyond ±1e5.
8. **Not implemented in the renderer yet:** blend modes, effects, image fills, angular and diamond gradients, and text.
9. **Performance numbers are software-rendered.** All measurements come from SwiftShader on a CPU. Real-GPU numbers are pending; see `benchmarks.md`.
