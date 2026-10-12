# Layout conformance

Fig Tree lays out documents with its own CSS engine (`packages/layout`). This file records how that engine is checked against Chromium and what the results are.

## Method

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

## Results

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
