"use client";

import { useEffect, useRef } from "react";
import { useEditor } from "./state";

const SIZE = 20;

/** A tick spacing (world units) that keeps labels at least ~60 px apart on screen. */
function tickStep(scale: number): number {
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000];
  return steps.find((s) => s * scale >= 60) ?? 10000;
}

/** Top and left rulers in canvas coordinates (shown with Shift+R), with the selection's extent marked. */
export function Rulers() {
  const editor = useEditor();
  const top = useRef<HTMLCanvasElement>(null);
  const left = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let frame = 0;
    const draw = (): void => {
      frame = 0;
      const vp = editor.viewport;
      const sel = editor.geometry.boundsOf(editor.selection);
      for (const [c, horizontal] of [[top.current, true], [left.current, false]] as const) {
        if (!c) continue;
        const dpr = window.devicePixelRatio || 1;
        const w = c.clientWidth;
        const h = c.clientHeight;
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
        const ctx = c.getContext("2d")!;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = "#fafaf9";
        ctx.fillRect(0, 0, w, h);
        if (sel) {
          ctx.fillStyle = "rgba(37, 99, 235, 0.15)";
          const a = horizontal ? sel.x * vp.scale + vp.x : sel.y * vp.scale + vp.y;
          const b = horizontal ? (sel.x + sel.width) * vp.scale + vp.x : (sel.y + sel.height) * vp.scale + vp.y;
          if (horizontal) ctx.fillRect(a, 0, b - a, h);
          else ctx.fillRect(0, a, w, b - a);
        }
        ctx.strokeStyle = "#a8a29e";
        ctx.fillStyle = "#78716c";
        ctx.font = "9px system-ui, sans-serif";
        const step = tickStep(vp.scale);
        const length = horizontal ? w : h;
        const offset = horizontal ? vp.x : vp.y;
        const first = Math.floor(-offset / vp.scale / step) * step;
        ctx.beginPath();
        for (let v = first; v * vp.scale + offset <= length; v += step / 5) {
          const p = Math.round(v * vp.scale + offset) + 0.5;
          const major = Math.abs(v / step - Math.round(v / step)) < 1e-6;
          const tick = major ? SIZE : 5;
          if (horizontal) {
            ctx.moveTo(p, SIZE);
            ctx.lineTo(p, SIZE - tick);
            if (major) ctx.fillText(String(Math.round(v)), p + 3, 9);
          } else {
            ctx.moveTo(SIZE, p);
            ctx.lineTo(SIZE - tick, p);
            if (major) {
              ctx.save();
              ctx.translate(9, p - 3);
              ctx.rotate(-Math.PI / 2);
              ctx.fillText(String(Math.round(v)), 0, 0);
              ctx.restore();
            }
          }
        }
        ctx.stroke();
      }
    };
    const off = editor.subscribe(() => {
      if (!frame) frame = requestAnimationFrame(draw);
    });
    frame = requestAnimationFrame(draw);
    return () => {
      off();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [editor]);
  return (
    <>
      <canvas ref={top} className="pointer-events-none absolute left-0 right-0 top-0 border-b border-stone-200" style={{ height: SIZE, width: "100%" }} data-testid="ruler-top" />
      <canvas ref={left} className="pointer-events-none absolute bottom-0 left-0 top-0 border-r border-stone-200" style={{ width: SIZE, height: "100%" }} data-testid="ruler-left" />
    </>
  );
}
