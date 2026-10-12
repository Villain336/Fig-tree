# Conformance

Fig Tree lays out documents with its own CSS engine (`packages/layout`) and its own text engine (`packages/text`). This file records how both are checked against Chromium and what the results are: [layout](#layout-method) first, then [text](#text-method).

## Layout: method

Each conformance case is a tree of boxes described by plain CSS declarations (`packages/layout/conformance/case.ts`). The same tree is:

1. **Rendered in Chromium** as HTML: one `div` per box inside an 800 × 600 viewport `div`, at device pixel ratio 1. Every box's border box is recorded with `getBoundingClientRect()`, keeping fractional values.
2. **Laid out by our engine** from the same declarations, parsed by `parseStyle`.

A case passes when every box matches within **1 px** on x, y, width and height. The suite also counts boxes that match within **0.01 px**. Chromium snaps layout to 1/64 px (its `LayoutUnit`), so fractional results such as thirds can differ by a few hundredths of a pixel.

Boxes can be:
- empty `div`s;
- **text-like measured leaves**: "words" of fixed width and height, rendered in Chromium as `inline-block` spans in a `font-size: 0; line-height: 0` block. `WordsMeasurer` mirrors exactly how those break into lines and where their baselines are. This exercises the measure callback (min-content, max-content, height-for-width and baselines) without fonts;
- **replaced leaves**: a `<canvas>` with a natural size.

Every block container in a case is given `display: flow-root`, because the engine's block containers always establish an independent formatting context (see the architecture doc).

Two suites run this way:

| Suite | Cases | Source |
|---|---|---|
| Layout engine | 1,656: hand-written cases for every feature, plus seeded random flex and grid trees | `packages/layout/conformance/` |
| Document CSS | 128 documents built through the command API (8 hand-written, 120 seeded random) | `packages/document/test/conformance/` |

The document suite turns each node of a document into a `div` that carries exactly the CSS `cssDeclarations` states for it (minus `transform`, which does not affect layout). Chromium's boxes for that HTML must match both the engine run on that CSS and `DocumentLayout`, the bridge's layout of the document itself. The editor therefore draws what the exported CSS renders in a browser.

### Running it

| Command | What it does |
|---|---|
| `npm test` | Compares the engine against the stored Chromium results (`packages/layout/conformance/fixtures/chromium.json`, `packages/document/test/conformance/chromium.json`). No browser needed. Fails when a fixture is missing or was recorded from an older case definition. |
| `npm run conformance:update` | Re-renders every case in Playwright's Chromium and rewrites both fixture files. `CONFORMANCE_FILTER=<name part>` limits it to matching cases. |
| `npm run test:conformance` | The Playwright project: re-renders every case live, compares the engine with the live browser, and checks that the stored fixtures are still what this Chromium renders. CI runs it. |
| `CONFORMANCE_DEBUG=<name part> npx vitest run packages/layout` | Prints the matching cases' trees with the expected and actual boxes. |

A case the engine fails stays in the suite: `packages/layout/conformance/known-failures.ts` lists it with the reason. The test fails if a listed case starts passing, so the list cannot go stale. **The list is currently empty.**

Fixtures were recorded with Chromium 141.0.7390.37 (Playwright 1.56.1), headless, on Linux.

## Layout: results

All 1,656 layout cases and all 128 document cases pass.

| Area | Cases passing (within 1 px) | Boxes within 1 px | Boxes within 0.01 px |
|---|---|---|---|
| Flexbox, hand-written | 251 / 251 | 920 / 920 | 908 (98.7%) |
| Flexbox, random | 400 / 400 | 3,503 / 3,503 | 3,196 (91.2%) |
| **Flexbox** | **651 / 651** | **4,423 / 4,423** | **4,104 (92.8%)** |
| Grid, hand-written | 171 / 171 | 687 / 687 | 669 (97.4%) |
| Grid, random | 750 / 750 | 6,021 / 6,021 | 5,475 (90.9%) |
| **Grid** | **921 / 921** | **6,708 / 6,708** | **6,144 (91.6%)** |
| Box model and sizing | 25 / 25 | 70 / 70 | 67 |
| Block layout | 12 / 12 | 43 / 43 | 43 |
| Positioned layout | 47 / 47 | 106 / 106 | 106 |
| **All layout cases** | **1,656 / 1,656** | **11,350 / 11,350** | **10,464 (92.2%)** |
| Document CSS (engine and `DocumentLayout`) | 128 / 128 | 936 / 936 | 891 (95.2%) |

The boxes that match within 1 px but not within 0.01 px differ by Chromium's 1/64 px rounding of fractional sizes (thirds, percentages, `fr` shares, centering offsets).

### What the cases cover

- **Flexbox** (`cases/flex.ts`): row and column directions and their reverses; wrapping and `wrap-reverse`; `flex-grow`, `flex-shrink` (scaled by the inner base size) and `flex-basis` (lengths, percentages, `auto`, `content`, intrinsic keywords); the freeze loop with min and max violations and factor sums below 1; the automatic minimum size (text, `overflow`, specified sizes, aspect ratios); `gap`; every `justify-content` value including `safe` and the negative-free-space fallbacks; `align-items`/`align-self` including `stretch` with min/max, first and last baselines (in rows, columns and `wrap-reverse`) and `safe`/`unsafe`; `align-content`; auto margins on both axes; `order`; nested containers and percentage heights; aspect ratios and replaced items; intrinsic sizes of flex containers (§9.9.3 contributions, wrapping column containers); the static positions of absolutely positioned children.
- **Grid** (`cases/grid.ts`): every track sizing function (`px`, `%`, `fr`, `auto`, `min-content`, `max-content`, `minmax()`, `fit-content()`), `repeat()` with counts, `auto-fill` and `auto-fit` (collapsed tracks), line names, template areas and their implicit names; implicit tracks and `grid-auto-rows/columns` patterns, before and after the explicit grid; line-based placement with negative lines, spans, named spans and the conflict rules; auto-placement in both flows, sparse and dense; spanning items over intrinsic and flexible tracks; `fr` sizing in definite and indefinite space and with min/max sizes; percentages of indefinite heights; content and self alignment, auto margins, baseline alignment in rows; container intrinsic sizes; absolutely positioned children with grid areas as containing blocks and their static positions.
- **Positioned layout, box model and block layout** (`cases/position.ts`): insets, percentages and `calc()`, shrink-to-fit, over-constrained boxes, auto margins, aspect ratios, replaced boxes, nested containing blocks, static positions, `position: fixed`, the self-alignment of absolutely positioned boxes (Positioned Layout 3), relative offsets; `box-sizing`, min/max (including intrinsic keywords), `fit-content`, aspect ratios and their automatic minimum, `display: none`; block stacking with sibling margin collapsing.
- **Random generators** (`random.ts`): flex trees up to three levels deep with random directions, wrapping, alignment, gaps, padding, borders, sizes in px and %, flex factors and bases, min/max, margins (including `auto` and negative), `order`, text leaves and absolutely positioned children; grid containers with random track lists, `repeat()`, areas, auto rows and columns, flows, gaps, alignment, placements (numbers, negative lines, spans), nested flex and grid items, text leaves and absolutely positioned children.

### Where Chromium differs from a literal reading of the specs

Matching Chromium meant following it where it implements a different reading or an older version of a spec. Each item below came from a failing case and was confirmed with a targeted case that is now part of the suite:

- **Flex intrinsic sizes.** Chromium implements §9.9.3 item contributions (clamped by the flex base size when an item cannot grow or cannot shrink), starting from the item's ordinary contribution rather than "the larger of its content size and preferred size". It does not implement the §9.9.1 flex-fraction algorithm. A wrapping row container's min-content size is its largest *unclamped* contribution. A wrapping column container's max-content width adds up its columns.
- **Flex lines.** In a multi-line column container, items that do not stretch fit their width to their line's cross size, not the container's. A column item's flexed height counts as definite when its flex basis is definite, even in an auto-height container.
- **Baselines.** In a column container, items' baselines are synthesized at their left border edge. `wrap-reverse` packs first-baseline groups toward the bottom. For an absolutely positioned child's static position, `baseline` behaves as `start`.
- **Grid.** Rows are sized from column widths *after* `justify-content` (§11.1 step 2). An `auto` minimum takes the limited max-content contribution under a max-content constraint, and the minimum contribution otherwise, including under a min-content constraint. Items crossing flexible tracks are distributed together, as the spec says. Baseline shims apply to contributions that come from content, not to a zero minimum contribution, and items spanning several rows join their first row's baseline group. An axis without explicit tracks does not extend the implicit grid to line 1 when every item sits before it. With the grid as containing block, an absolutely positioned child's static position is aligned within its grid area.
- **Positioned layout.** Chromium implements Positioned Layout 3 self-alignment: a non-`normal` `justify-self`/`align-self` shrink-wraps the box and aligns it in the inset-modified containing block, then shifts it back inside the containing block unless the value is `unsafe`. The stretched size floors that block at 0 before subtracting margins.

## Text: method

Each text case (`packages/text/conformance/cases/`) is a tree of boxes with CSS declarations, some of which hold text: inline runs (each a `<span>` with its own declarations), or paragraphs (`<p>`s, optionally list items with an outside marker). The same tree is:

1. **Rendered in Chromium** as HTML with the vendored test fonts (`fixtures/fonts`, SIL OFL 1.1) loaded through `@font-face` rules from a Playwright route (`font-display: block`). Chromium's own fonts are never used: every case names its families, and characters those families lack fall back to nothing in both engines (the engine's script fallback is off for conformance). For every box we record its border box, and for every text leaf the rect of each grapheme cluster (a DOM `Range` over the grapheme, per DOM text node) plus the ascent of each run's first available font, which turns rect tops into baselines.
2. **Laid out by our engine**: `packages/layout` with a `TextBlock` as the measure callback of each text leaf, from the same declarations (`parseTextStyle`, `parseParagraphStyle`) and the same font files.

From the grapheme rects the comparison derives the lines (graphemes grouped by baseline), each line's first grapheme (the break positions), and the words. A case passes when **the line breaks are identical** (every line starts at the same grapheme), every baseline is within 1 px, and every box, grapheme and word rect is within **1 px**. On top of that, `npm test` requires every grapheme rect of every passing case to be within **one layout unit (1/64 px)**: DOM rects are in Chromium's layout units, so the engine's rects are snapped outwards to 1/64 px before comparing, and anything beyond one unit is a real difference.

Two suites run this way, plus a visual one:

| Suite | Cases | Source |
|---|---|---|
| Text engine | 164 hand-written cases in 16 areas | `packages/text/conformance/` |
| Document text | 56 documents built through the command API (26 hand-written, 30 seeded random), as the HTML `cssDeclarations` states for them (direction `auto` is `dir="auto"`) | `packages/document/test/conformance/text-cases.ts` |
| Visual | every text-engine case, drawn by our renderer and screenshotted from Chromium | `e2e/text-visual.spec.ts` |

The fixtures (`packages/text/conformance/fixtures/chromium.json`, `packages/document/test/conformance/text-chromium.json`) are written by `npm run conformance:update` along with the layout fixtures, and `npm run test:conformance` re-checks them live. Each fixture's hash covers the case and a digest of every font file, so a changed font makes the fixtures stale. `packages/text/conformance/known-failures.ts` lists failing cases with reasons; **it is empty**.

## Text: results

All 164 text cases and all 56 document text cases pass.

| Area | Cases | Line breaks identical | Boxes within 1 px | Graphemes within 1 px | Graphemes within 0.01 px | Graphemes within 1/64 px | Words within 1 px | Lines |
|---|---|---|---|---|---|---|---|---|
| Basic (sizes, weights, italics, runs, WOFF2) | 23 / 23 | 23 / 23 | 45 / 45 | 1,821 / 1,821 | 1,770 | 1,821 | 318 / 318 | 77 |
| White space (all `white-space` values, tabs) | 16 / 16 | 16 / 16 | 17 / 17 | 850 / 850 | 833 | 850 | 137 / 137 | 35 |
| Breaking (UAX #14, `overflow-wrap`, `word-break`, soft hyphens) | 14 / 14 | 14 / 14 | 17 / 17 | 483 / 483 | 475 | 483 | 86 / 86 | 49 |
| Spacing (letter, word, `text-indent`) | 12 / 12 | 12 / 12 | 12 / 12 | 961 / 961 | 945 | 961 | 197 / 197 | 39 |
| Line height (normal, numbers, lengths, %, mixed fonts and sizes) | 15 / 15 | 15 / 15 | 15 / 15 | 1,092 / 1,092 | 1,079 | 1,092 | 225 / 225 | 51 |
| Alignment (`text-align` incl. justify, `text-align-last`) | 11 / 11 | 11 / 11 | 11 / 11 | 817 / 817 | 808 | 817 | 163 / 163 | 33 |
| Fonts (matching, variable axes, optical size, family lists) | 7 / 7 | 7 / 7 | 30 / 30 | 506 / 506 | 487 | 506 | 77 / 77 | 25 |
| OpenType features (kerning, ligatures, numerals, fractions) | 7 / 7 | 7 / 7 | 17 / 17 | 198 / 198 | 192 | 198 | 50 / 50 | 12 |
| Bidi (UAX #9, RTL paragraphs, numbers, neutrals) | 7 / 7 | 7 / 7 | 10 / 10 | 361 / 361 | 361 | 361 | 70 / 70 | 16 |
| Arabic (joining, weights, fallback) | 7 / 7 | 7 / 7 | 11 / 11 | 388 / 388 | 370 | 388 | 73 / 73 | 18 |
| Devanagari (conjuncts, weights) | 4 / 4 | 4 / 4 | 7 / 7 | 174 / 174 | 172 | 174 | 51 / 51 | 12 |
| CJK (Chinese, Japanese, `line-break`, `word-break: keep-all`) | 7 / 7 | 7 / 7 | 7 / 7 | 220 / 220 | 59 | 220 | 34 / 34 | 29 |
| `text-transform` | 4 / 4 | 4 / 4 | 4 / 4 | 161 / 161 | 160 | 161 | 30 / 30 | 8 |
| Truncation (`text-overflow: ellipsis`, `-webkit-line-clamp`) | 8 / 8 | 8 / 8 | 8 / 8 | 516 / 516 | 494 | 516 | 106 / 106 | 20 |
| `text-wrap: balance` and `pretty` | 10 / 10 | 10 / 10 | 10 / 10 | 642 / 642 | 624 | 642 | 121 / 121 | 31 |
| Sizing (text in flex and grid, intrinsic sizes, baselines) | 12 / 12 | 12 / 12 | 41 / 41 | 711 / 711 | 684 | 711 | 145 / 145 | 59 |
| **All text cases** | **164 / 164** | **164 / 164** | **262 / 262** | **9,901 / 9,901** | **9,513 (96.1%)** | **9,901** | **1,883 / 1,883** | **514** |
| Document text (`DocumentLayout` and the bridge) | 56 / 56 | 56 / 56 | 243 / 243 (226 within 0.01 px) | 5,231 / 5,231 | | 5,218 | | 339 |

The largest difference in the text suite is one layout unit (0.0156 px). In the document suite it is two units (0.031 px): the boxes of flex items next to hugging text, whose intrinsic widths differ from Chromium's by a unit in the last float digit. CJK glyphs agree to one unit rather than 0.01 px because their advances (1 em) put many rect edges exactly on the rounding boundary.

Unicode algorithms are also tested against the Unicode test files (Unicode 15.1, `packages/text/test/fixtures`): UAX #14 line breaking matches all 3,425 cases of a `LineBreakTest.txt` subset (plain UAX #14, plus Chromium's tailoring of ASCII punctuation pairs checked separately), UAX #29 grapheme clusters all 1,187 cases of `GraphemeBreakTest.txt`, and the bidi levels (bidi-js) all 1,147 cases of a `BidiCharacterTest.txt` subset. Shaping is compared with HarfBuzz directly (kerning, variable instances, ligatures, Arabic joining, Devanagari conjuncts, context across style changes).

### Visual comparison

`e2e/text-visual.spec.ts` (the `render` project) lays every text case out in Node, draws it with our renderer (glyph atlas, exact-area coverage) on both backends, and compares the pixels with Chromium's screenshot of the same HTML, with box borders and backgrounds hidden so only text is compared. Per case it measures, over the text region (the bounding box of every pixel either image inks, plus 2 px), the fraction of pixels whose channels differ by more than 25/255, the mean absolute difference and the largest one. Results (WebGPU and WebGL2 agree to within 0.1%):

| Area | Cases ≤ 2% | Mean fraction > 25/255 | Worst case | Mean \|Δ\| (of 255) | Max \|Δ\| |
|---|---|---|---|---|---|
| Basic | 21 / 23 | 1.34% | 2.43% | 1.76 | 83 |
| White space | 14 / 16 | 1.53% | 2.83% | 1.82 | 67 |
| Breaking | 13 / 14 | 1.54% | 2.34% | 1.81 | 125 |
| Spacing | 12 / 12 | 1.26% | 1.49% | 1.54 | 72 |
| Line height | 15 / 15 | 1.21% | 1.89% | 1.58 | 81 |
| Alignment | 11 / 11 | 1.40% | 1.51% | 1.68 | 72 |
| Fonts | 7 / 7 | 1.06% | 1.50% | 1.54 | 114 |
| OpenType features | 7 / 7 | 1.36% | 1.89% | 1.66 | 70 |
| Bidi | 7 / 7 | 0.85% | 1.34% | 1.15 | 94 |
| Arabic | 7 / 7 | 0.74–0.81% | 0.94% | 1.28 | 103 |
| Devanagari | 3 / 4 | 1.66–1.86% | 2.32–2.64% | 2.36–2.40 | 172 |
| CJK | 2 / 7 | 2.17% | 3.02% | 2.24 | 129 |
| `text-transform` | 4 / 4 | 1.46% | 1.66% | 1.88 | 75 |
| Truncation | 7 / 8 | 1.56% | 2.60% | 1.89 | 60 |
| Wrap style | 10 / 10 | 1.75% | 1.98% | 2.02 | 72 |
| Sizing | 12 / 12 | 1.12% | 2.00% | 1.42 | 89 |
| **All** | **152 / 164** | **1.37%** | **3.02%** | **1.71** | **172** |

The target is at most 2% of a case's text region differing by more than 25/255; the test gates at 4%. Glyph positions agree (the geometry above), so the differences are in coverage at glyph edges: Chromium's rasterizer adjusts glyph coverage with a gamma and contrast curve (thin strokes come out lighter, and our total ink is about 3% higher in dense CJK text), while we draw exact-area coverage, the same as every other shape. The twelve cases between 2% and 3% are dense scripts (five CJK cases, Devanagari weights) and cases whose text region is tiny (a single short line, the ellipsis case), where a few hundred edge pixels are a large fraction. The single largest pixel difference (172) is on a Devanagari conjunct edge.

### Where Chromium differs from a literal reading of the specs (text)

Matching Chromium's geometry meant following these behaviours, each found by a failing case and kept as a case:

- **Font sizes and metrics.** Advances scale with the font size floored to 1/64 px (FreeType's 26.6 sizes). Ascent and descent are rounded to whole pixels separately (from `hhea`, or `OS/2` typo metrics when `USE_TYPO_METRICS` is set); `line-height: normal` is their sum plus the line gap. Half-leading puts `floor((L − (A + D)) / 2)` above. A number `line-height` times the font size is truncated to 1/64 px, a length or percentage is rounded. Fallback fonts enlarge a line box only under `line-height: normal`.
- **Layout units.** Each text item on a line (a style run at one bidi level) takes a width rounded up to 1/64 px, so the next run starts on the 1/64 grid. Intrinsic widths round up to 1/64 px.
- **Shaping boundaries.** Script runs keep paired brackets with their opening bracket's script (so `(b)` after Arabic text shapes in the Arabic run, without Latin kerning). Default-ignorable characters (soft hyphen, ZWJ) do not split runs, so kerning applies across an unused soft hyphen. A line that starts or ends inside a word at a point HarfBuzz marks unsafe to break is shaped again on its own: no kerning or ligature across the break.
- **Line breaking.** UAX #14 with CSS Text tailoring: `line-break: strict/loose` only change anything for Chinese, Japanese and Korean (`lang`), and otherwise CJ characters break like ideographs. Chromium also forbids or allows breaks around ASCII punctuation in ways UAX #14 does not (for example around hyphens between digits); the engine learned these pairs from Chromium (14,711 random positions agree).
- **White space.** Trailing preserved spaces before a forced break hang only when they would overflow (`pre-wrap`); tab stops closer than half a space are skipped; hanging spaces in RTL lines hang on the left.
- **Letter spacing** is added after every grapheme, including the last one on the line. **Truncated text** (ellipsis, line clamp) keeps its geometry: hidden graphemes still have DOM rects. **Optical size** `auto` uses the font size in px.
- **Direction `auto`** in documents is HTML `dir="auto"` on the text element: every paragraph takes the direction of the text's first strong character.

One difference remains unexplained: for a few fractional font sizes (16.3 px to 20.3 px), Chromium's advances are 1/64 px off from `floor(size × 64) / 64`. No case uses those sizes; the conformance cases use 10.3 and 12.5 px, which agree.
