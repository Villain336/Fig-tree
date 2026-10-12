import type { LayoutNode } from "@fig-tree/layout";
import { SYNTHETIC_OBLIQUE_SKEW, syntheticBoldStrength, type FontInstance } from "../src/index";
import { TEXT_VIEWPORT, type EngineTree, type TextCase } from "./case";

/**
 * A laid-out text case as plain data for the renderer: glyph runs at
 * absolute positions, their outlines (font units, y down, packed as
 * `[verb, ...coords]` per command) and text decoration rectangles. The
 * visual conformance test (e2e/text-visual.spec.ts) renders it on the
 * renderer's backends and compares the pixels with Chromium's rendering of
 * the same case. Text is black on white, like the conformance pages.
 */
export interface GlyphScene {
  readonly width: number;
  readonly height: number;
  readonly sources: Record<string, { readonly unitsPerEm: number; readonly glyphs: Record<number, number[]> }>;
  readonly runs: readonly {
    readonly source: string;
    readonly size: number;
    /** Packed glyph id, x, y triples in absolute px (y is the baseline). */
    readonly glyphs: readonly number[];
    readonly skew: number;
    readonly embolden: number;
  }[];
  readonly rects: readonly { readonly x: number; readonly y: number; readonly width: number; readonly height: number }[];
}

function encodePath(font: FontInstance, gid: number): number[] {
  const out: number[] = [];
  for (const cmd of font.path(gid).commands()) {
    out.push(cmd.verb);
    if (cmd.verb === 2) out.push(cmd.x1, cmd.y1, cmd.x, cmd.y);
    else if (cmd.verb === 3) out.push(cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y);
    else if (cmd.verb !== 4) out.push(cmd.x, cmd.y);
  }
  return out;
}

function absolute(n: LayoutNode): [number, number] {
  let x = 0;
  let y = 0;
  for (let p: LayoutNode | null = n; p; p = p.parent) {
    x += p.out.x;
    y += p.out.y;
  }
  return [x, y];
}

/** The glyph scene of a case whose engine tree has been laid out (by `engineResult`). */
export function glyphScene(c: TextCase, tree: EngineTree): GlyphScene {
  const [width, height] = c.viewport ?? TEXT_VIEWPORT;
  const sources: Record<string, { unitsPerEm: number; glyphs: Record<number, number[]> }> = {};
  const runs: GlyphScene["runs"][number][] = [];
  const rects: GlyphScene["rects"][number][] = [];
  for (const t of tree.texts) {
    const n = t.node;
    const [x0, y0] = absolute(n);
    const cx = x0 + n.out.border.left + n.out.padding.left;
    const cy = y0 + n.out.border.top + n.out.padding.top;
    const contentWidth = n.out.width - n.out.border.left - n.out.border.right - n.out.padding.left - n.out.padding.right;
    const layout = t.block.layout(contentWidth);
    for (const p of layout.paragraphs) {
      for (const line of p.layout.lines) {
        if (line.hidden) continue;
        for (const r of line.runs) {
          const key = `${r.font.typeface.id}/${r.font.key}`;
          const source = (sources[key] ??= { unitsPerEm: r.font.unitsPerEm, glyphs: {} });
          const glyphs: number[] = [];
          for (let i = 0; i + 2 < r.glyphs.length; i += 3) {
            const gid = r.glyphs[i]!;
            source.glyphs[gid] ??= encodePath(r.font, gid);
            glyphs.push(gid, cx + r.glyphs[i + 1]!, cy + p.top + r.glyphs[i + 2]!);
          }
          runs.push({ source: key, size: r.size, glyphs, skew: r.syntheticOblique ? SYNTHETIC_OBLIQUE_SKEW : 0, embolden: r.syntheticBold ? syntheticBoldStrength(r.size) : 0 });
        }
      }
      for (const d of p.layout.decorations) rects.push({ x: cx + d.x, y: cy + p.top + d.y, width: d.width, height: d.thickness });
    }
  }
  return { width, height, sources, runs, rects };
}
