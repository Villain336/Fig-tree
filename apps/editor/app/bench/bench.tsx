"use client";

import { multiply, scaling, translation, type Mat2D } from "@fig-tree/geometry";
import { Renderer, backendFromSearch, rgba, type StageTimings } from "@fig-tree/renderer";
import { useEffect, useRef, useState } from "react";
import { WORLD_HEIGHT, WORLD_WIDTH, buildBenchScene } from "./scene";

const SHAPES = 10_000;
const HUD_INTERVAL_MS = 250;

interface Recording {
  frameIntervals: number[];
  cpuMs: number[];
  uploadedBytes: number;
}

declare global {
  interface Window {
    __bench?: {
      readonly backend: string;
      readonly shapes: number;
      resetView(): void;
      startRecording(): void;
      stopRecording(): Recording;
    };
  }
}

function gpuLine(t: StageTimings | null): string {
  if (!t) return "gpu timings unavailable";
  const f = (v: number): string => v.toFixed(1);
  return `gpu ${f(t.total)} ms  (bin ${f(t.bin)} · tiles ${f(t.tiles)} · coverage ${f(t.coverage)} · composite ${f(t.composite)})`;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

/**
 * 10k-shape renderer benchmark: drag to pan, wheel to zoom about the cursor.
 * Frames are rendered back to back, each waiting for the GPU to finish the
 * previous one, so the readout is true frame time rather than queue depth.
 */
export function Bench() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hudRef = useRef<HTMLPreElement>(null);
  const [backend, setBackend] = useState<string>("starting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    let disposed = false;
    let renderer: Renderer | null = null;
    let view: Mat2D = [1, 0, 0, 1, 0, 0];
    let dragging: { x: number; y: number } | null = null;
    const intervals: number[] = [];
    const cpu: number[] = [];
    let recording: Recording | null = null;
    let lastFrame = 0;
    let lastHud = 0;

    const fit = (): void => {
      const s = Math.min(canvas.clientWidth / WORLD_WIDTH, canvas.clientHeight / WORLD_HEIGHT) * 0.95;
      view = multiply(translation((canvas.clientWidth - WORLD_WIDTH * s) / 2, (canvas.clientHeight - WORLD_HEIGHT * s) / 2), scaling(s));
    };
    const resize = (): void => renderer?.setSize(canvas.clientWidth, canvas.clientHeight, window.devicePixelRatio || 1);

    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      view = multiply(multiply(translation(x, y), scaling(factor)), multiply(translation(-x, -y), view));
    };
    const onDown = (e: PointerEvent): void => {
      dragging = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent): void => {
      if (!dragging) return;
      view = multiply(translation(e.clientX - dragging.x, e.clientY - dragging.y), view);
      dragging = { x: e.clientX, y: e.clientY };
    };
    const onUp = (): void => {
      dragging = null;
    };

    const frame = async (now: number): Promise<void> => {
      if (disposed || !renderer) return;
      if (lastFrame > 0) {
        const dt = now - lastFrame;
        intervals.push(dt);
        if (intervals.length > 120) intervals.shift();
        recording?.frameIntervals.push(dt);
      }
      lastFrame = now;
      const stats = renderer.render({ transform: view });
      cpu.push(stats.cpuMs);
      if (cpu.length > 120) cpu.shift();
      if (recording) {
        recording.cpuMs.push(stats.cpuMs);
        recording.uploadedBytes += stats.uploadedBytes;
      }
      await renderer.finish();
      if (now - lastHud > HUD_INTERVAL_MS && hudRef.current) {
        lastHud = now;
        const avg = intervals.reduce((s, v) => s + v, 0) / Math.max(1, intervals.length);
        const zoom = Math.hypot(view[0], view[1]);
        hudRef.current.textContent = [
          `${renderer.backendKind}  ·  ${SHAPES.toLocaleString()} shapes`,
          `${avg > 0 ? (1000 / avg).toFixed(1) : "–"} fps   ${avg.toFixed(1)} ms avg   ${percentile(intervals, 95).toFixed(1)} ms p95`,
          `cpu ${percentile(cpu, 50).toFixed(1)} ms   ${stats.entries.toLocaleString()} draws   ${stats.segments.toLocaleString()} segments`,
          stats.mode === "tiles" ? `tiles: ${stats.tilesRendered} rasterized, rest cached` : "direct frame",
          gpuLine(renderer.gpuTimings),
          `zoom ${(zoom * 100).toFixed(0)}%`,
        ].join("\n");
      }
      requestAnimationFrame((t) => void frame(t));
    };

    (async () => {
      renderer = await Renderer.create(canvas, {
        backend: backendFromSearch(window.location.search),
        background: rgba(0.96, 0.96, 0.95, 1),
      });
      if (disposed) {
        renderer.destroy();
        return;
      }
      setBackend(renderer.backendKind);
      renderer.setScene(buildBenchScene(SHAPES));
      resize();
      fit();
      window.__bench = {
        backend: renderer.backendKind,
        shapes: SHAPES,
        resetView: fit,
        startRecording: () => {
          recording = { frameIntervals: [], cpuMs: [], uploadedBytes: 0 };
        },
        stopRecording: () => {
          const r = recording ?? { frameIntervals: [], cpuMs: [], uploadedBytes: 0 };
          recording = null;
          return r;
        },
      };
      requestAnimationFrame((t) => void frame(t));
    })().catch((err: unknown) => setError(String(err)));

    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    window.addEventListener("resize", resize);
    return () => {
      disposed = true;
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      window.removeEventListener("resize", resize);
      renderer?.destroy();
      delete window.__bench;
    };
  }, []);

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-neutral-100">
      <canvas ref={canvasRef} className="block h-full w-full touch-none cursor-grab active:cursor-grabbing" />
      <div className="pointer-events-none absolute left-3 top-3 rounded-md bg-neutral-900/85 px-3 py-2 text-neutral-100 shadow">
        <pre ref={hudRef} className="font-mono text-xs leading-5">
          {error ?? `${backend} · loading ${SHAPES.toLocaleString()} shapes`}
        </pre>
      </div>
      <nav className="absolute right-3 top-3 flex gap-2 text-xs">
        <a className="rounded-md bg-white px-2 py-1 shadow hover:bg-neutral-50" href="/bench?renderer=webgpu">WebGPU</a>
        <a className="rounded-md bg-white px-2 py-1 shadow hover:bg-neutral-50" href="/bench?renderer=webgl2">WebGL2</a>
      </nav>
    </div>
  );
}
