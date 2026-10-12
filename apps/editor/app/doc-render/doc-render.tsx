"use client";

import { AssetStore, SceneBridge, fromFigtreeJson } from "@fig-tree/document";
import { translation } from "@fig-tree/geometry";
import { Renderer, Scene, backendFromSearch } from "@fig-tree/renderer";
import { useEffect, useRef, useState } from "react";
import { BrowserImages } from "../images";

export interface DocRenderRequest {
  /** `document.json` contents. */
  readonly json: unknown;
  /** Asset bytes (base64) by id. */
  readonly assets: Record<string, string>;
  /** Canvas size in CSS px (DPR 1); the page's (0, 0) is the canvas' top-left. */
  readonly width: number;
  readonly height: number;
  /** Renderer clock in seconds (animated shader paints). */
  readonly time?: number;
  /** Pan the view by (x, y) first and back, so the final frame comes from the tile cache. */
  readonly tiled?: boolean;
}

export interface DocRenderResult {
  readonly backend: string;
  readonly width: number;
  readonly height: number;
  /** Base64 RGBA8, premultiplied, rows top to bottom. */
  readonly pixels: string;
  readonly mode: string;
  readonly cpuMs: number;
  readonly textureBytes: number;
  readonly unsupported: Record<string, string[]>;
}

declare global {
  interface Window {
    __renderDocument?: (req: DocRenderRequest) => Promise<DocRenderResult>;
  }
}

/** Renders documents through the bridge (layout, paints, effects, images) and returns their pixels. */
export function DocRender() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState("starting");

  useEffect(() => {
    const canvas = canvasRef.current!;
    let renderer: Renderer | null = null;
    let disposed = false;
    (async () => {
      await Promise.resolve();
      if (disposed) return;
      renderer = await Renderer.create(canvas, { backend: backendFromSearch(window.location.search) });
      if (disposed) {
        renderer.destroy();
        return;
      }
      const r = renderer;
      window.__renderDocument = async (req) => {
        const store = new AssetStore();
        for (const [id, b64] of Object.entries(req.assets)) store.put(id, Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
        const doc = fromFigtreeJson(req.json);
        const images = new BrowserImages((id) => store.get(id), (id) => doc.assets().get(id));
        const scene = new Scene();
        let bridge = new SceneBridge(doc, scene, { images });
        // Decode every image the page draws, then build the scene again with them.
        await images.settled();
        bridge.dispose();
        const final = new Scene();
        bridge = new SceneBridge(doc, final, { images });
        r.background = bridge.background;
        r.time = req.time ?? 0;
        r.setSize(req.width, req.height, 1);
        r.setScene(final);
        if (req.tiled) {
          await r.renderComplete({ transform: translation(-93, -41) });
          await r.renderComplete({ transform: translation(-93, -41) });
        }
        const stats = await r.renderComplete({ transform: translation(0, 0) });
        const px = await r.readPixels();
        let binary = "";
        for (let i = 0; i < px.data.length; i += 0x8000) binary += String.fromCharCode(...px.data.subarray(i, i + 0x8000));
        const unsupported: Record<string, string[]> = {};
        for (const [id, notes] of bridge.unsupported) unsupported[id] = [...notes];
        bridge.dispose();
        return { backend: r.backendKind, width: px.width, height: px.height, pixels: btoa(binary), mode: stats.mode, cpuMs: stats.cpuMs, textureBytes: stats.textureBytes, unsupported };
      };
      setStatus(`ready (${r.backendKind})`);
    })().catch((err: unknown) => setStatus(`error: ${String(err)}`));
    return () => {
      disposed = true;
      renderer?.destroy();
      delete window.__renderDocument;
    };
  }, []);

  return (
    <main className="p-4 font-mono text-sm">
      <canvas ref={canvasRef} />
      <p data-testid="status">{status}</p>
    </main>
  );
}
