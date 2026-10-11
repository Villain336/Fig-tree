"use client";

import { IDENTITY } from "@fig-tree/geometry";
import { Renderer, Scene, backendFromSearch } from "@fig-tree/renderer";
import { useEffect, useRef, useState } from "react";
import { testScenes } from "./scenes";

export interface RenderTestResult {
  readonly backend: string;
  readonly width: number;
  readonly height: number;
  /** Base64 RGBA8, premultiplied, rows top to bottom. */
  readonly pixels: string;
}

declare global {
  interface Window {
    __renderTest?: RenderTestResult | { error: string };
  }
}

export function RenderTest() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState("rendering");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const name = params.get("scene") ?? "mixed";
    const spec = testScenes[name];
    const canvas = canvasRef.current;
    if (!spec || !canvas) {
      window.__renderTest = { error: `unknown scene ${name}` };
      setStatus("error");
      return;
    }
    let renderer: Renderer | null = null;
    (async () => {
      renderer = await Renderer.create(canvas, { backend: backendFromSearch(window.location.search) });
      renderer.setSize(spec.width, spec.height, 1);
      const scene = new Scene();
      spec.build(scene);
      renderer.setScene(scene);
      await renderer.renderComplete({ transform: IDENTITY });
      const px = await renderer.readPixels();
      let binary = "";
      for (let i = 0; i < px.data.length; i += 0x8000) binary += String.fromCharCode(...px.data.subarray(i, i + 0x8000));
      window.__renderTest = { backend: renderer.backendKind, width: px.width, height: px.height, pixels: btoa(binary) };
      setStatus(`done (${renderer.backendKind})`);
    })().catch((err: unknown) => {
      window.__renderTest = { error: String(err) };
      setStatus("error");
    });
    return () => renderer?.destroy();
  }, []);

  return (
    <main className="p-4 font-mono text-sm">
      <canvas ref={canvasRef} style={{ imageRendering: "pixelated" }} />
      <p data-testid="status">{status}</p>
    </main>
  );
}
