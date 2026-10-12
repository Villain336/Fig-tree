"use client";

import { IDENTITY, Path, translation, type Rect } from "@fig-tree/geometry";
import { Renderer, Scene, backendFromSearch, type GlyphSource } from "@fig-tree/renderer";
import { useEffect, useRef, useState } from "react";

/** A laid-out text case as plain data (see packages/text/conformance/visual.ts). */
export interface GlyphSceneData {
  readonly width: number;
  readonly height: number;
  readonly sources: Record<string, { readonly unitsPerEm: number; readonly glyphs: Record<number, number[]> }>;
  readonly runs: readonly { readonly source: string; readonly size: number; readonly glyphs: readonly number[]; readonly skew: number; readonly embolden: number }[];
  readonly rects: readonly { readonly x: number; readonly y: number; readonly width: number; readonly height: number }[];
}

export interface TextRenderResult {
  readonly backend: string;
  readonly width: number;
  readonly height: number;
  /** Base64 RGBA8, premultiplied, rows top to bottom. */
  readonly pixels: string;
}

declare global {
  interface Window {
    __renderGlyphScene?: (scene: GlyphSceneData) => Promise<TextRenderResult>;
  }
}

function decodePath(data: readonly number[]): Path {
  const p = new Path();
  for (let i = 0; i < data.length; ) {
    const verb = data[i++]!;
    const c = (k: number): number => data[i + k]!;
    if (verb === 0) p.moveTo(c(0), c(1));
    else if (verb === 1) p.lineTo(c(0), c(1));
    else if (verb === 2) p.quadTo(c(0), c(1), c(2), c(3));
    else if (verb === 3) p.cubicTo(c(0), c(1), c(2), c(3), c(4), c(5));
    else p.close();
    i += [2, 2, 4, 6, 0][verb]!;
  }
  return p;
}

const black = { type: "solid" as const, color: { r: 0, g: 0, b: 0, a: 1 } };

/** Draws glyph scenes black on white with the renderer, one at a time, for Playwright. */
export function TextRender() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState("starting");

  useEffect(() => {
    const canvas = canvasRef.current!;
    let renderer: Renderer | null = null;
    let disposed = false;
    (async () => {
      renderer = await Renderer.create(canvas, { backend: backendFromSearch(window.location.search), background: { r: 1, g: 1, b: 1, a: 1 } });
      if (disposed) {
        renderer.destroy();
        return;
      }
      const r = renderer;
      window.__renderGlyphScene = async (data) => {
        const sources = new Map<string, GlyphSource>();
        for (const [key, s] of Object.entries(data.sources)) {
          const paths = new Map<number, Path>();
          const path = (gid: number): Path => {
            let p = paths.get(gid);
            if (!p) {
              p = decodePath(s.glyphs[gid] ?? []);
              paths.set(gid, p);
            }
            return p;
          };
          sources.set(key, {
            key,
            unitsPerEm: s.unitsPerEm,
            path,
            bounds: (gid): Rect | null => (path(gid).isEmpty() ? null : path(gid).bounds()),
          });
        }
        const scene = new Scene();
        for (const run of data.runs) {
          scene.root.appendChild(scene.createNode({ glyphs: { source: sources.get(run.source)!, size: run.size, glyphs: Float64Array.from(run.glyphs), skew: run.skew, embolden: run.embolden }, fill: black }));
        }
        for (const d of data.rects) {
          const rect = new Path().moveTo(0, 0).lineTo(d.width, 0).lineTo(d.width, d.height).lineTo(0, d.height).close();
          scene.root.appendChild(scene.createNode({ path: rect, fill: black, transform: translation(d.x, d.y) }));
        }
        r.setSize(data.width, data.height, 1);
        r.setScene(scene);
        await r.renderComplete({ transform: IDENTITY });
        const px = await r.readPixels();
        let binary = "";
        for (let i = 0; i < px.data.length; i += 0x8000) binary += String.fromCharCode(...px.data.subarray(i, i + 0x8000));
        return { backend: r.backendKind, width: px.width, height: px.height, pixels: btoa(binary) };
      };
      setStatus(`ready (${r.backendKind})`);
    })().catch((err: unknown) => setStatus(`error: ${String(err)}`));
    return () => {
      disposed = true;
      renderer?.destroy();
      delete window.__renderGlyphScene;
    };
  }, []);

  return (
    <main className="p-4 font-mono text-sm">
      <canvas ref={canvasRef} />
      <p data-testid="status">{status}</p>
    </main>
  );
}
