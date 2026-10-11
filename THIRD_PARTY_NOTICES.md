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
