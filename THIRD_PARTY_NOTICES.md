# Third-party notices

Fig Tree is licensed under the GNU Affero General Public License v3.0 (see `LICENSE`).
Some files are ported from other open-source projects. They keep their original
license at file level, are marked with a header naming their origin, and live under
`src/ported/<project>/` directories so their provenance stays auditable.

## Penpot

- Project: Penpot, https://github.com/penpot/penpot
- License: Mozilla Public License 2.0 (`LICENSES/MPL-2.0.txt`)
- Copyright (c) KALEIDOS SUBSIDIARY SL
- Source revision: 5eb33ad

| Fig Tree file | Ported from | What was taken |
|---|---|---|
| `packages/renderer/src/ported/penpot/tiles.ts` | `render-wasm/src/tiles.rs` | Tile rect math, visible/interest viewbox, and pending-tile prioritization (visible first, center-out ordering, deferred interest ring, visible-only during interaction). |
| `packages/geometry/test/ported/penpot/path-vectors.test.ts` | `common/test/common_tests/types/path_data_test.cljc` | Path test vectors (sample contents, selrect regressions, transform cases); assertions rewritten for our API. |

These files remain available under MPL-2.0. Fig Tree's own code that imports them
forms a Larger Work (MPL-2.0 section 3.3) distributed under AGPL-3.0.

## npm dependencies

Runtime dependencies are installed from npm under their own licenses, all compatible with the AGPL-3.0:

| Package | License | Used by |
|---|---|---|
| `yjs` (and its dependency `lib0`) | MIT | `packages/document` (CRDT) |
| `zod` | MIT | `packages/document` (schemas, validation, JSON Schema generation) |
| `fflate` | MIT | `packages/document` (`.figtree` zip archives) |
| `rbush` | MIT | `packages/renderer` (spatial index) |
| `lucide-react` | ISC | `apps/editor` (icons) |
| `next`, `react`, `react-dom` | MIT | `apps/editor` |

Development-only tools (Vitest, Playwright, fast-check, ajv, pngjs, Tailwind CSS, TypeScript) are not shipped.

Module 2 (the document model) ports no Penpot code. It used Penpot's document invariants and component override model (`docs/reference/penpot.md` §1.3 and §1.9) only as a reference, to check that our schema leaves room for touched-group overrides.

Module 3 (the layout engine, `packages/layout`) is a clean-room implementation of the W3C specifications (CSS Box Model 3, CSS Sizing 3 and 4, Flexible Box Layout 1, Grid Layout 1, Box Alignment 3, Positioned Layout 3). No code from browser engines, Yoga, Taffy or Penpot was read or used. Penpot's flex and grid layout is Figma-style rather than CSS (`docs/reference/penpot.md` §1.4, §1.5) and was not ported. Where Chromium's behaviour differs from a literal reading of a spec, the behaviour was learned by rendering test cases in Chromium and comparing boxes (`docs/conformance.md`), not from its source. Module 3 adds no npm dependencies.

