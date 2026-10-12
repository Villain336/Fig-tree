"use client";

import type { Color, Paint } from "@fig-tree/document";
import { cssColor, hslToRgb, hsvToRgb, mixColors, parseHex, rgbToHsl, rgbToHsv, toHex } from "@fig-tree/editor-core";
import { Pipette, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { useAnchor, useEditor } from "./state";
import { IconButton, NumberField, SelectField } from "./ui";

export type EditablePaint = Extract<Paint, { type: "solid" | "linear-gradient" | "radial-gradient" }>;
type Stop = { position: number; color: Color };

export function paintCss(p: Paint): string {
  if (p.type === "solid") {
    // As a gradient so it can be layered over the transparency checkerboard.
    const c = cssColor(p.color, p.opacity ?? 1);
    return `linear-gradient(${c}, ${c})`;
  }
  if (p.type === "linear-gradient" || p.type === "radial-gradient" || p.type === "angular-gradient" || p.type === "diamond-gradient") {
    const stops = p.stops.map((s) => `${cssColor(s.color, p.opacity ?? 1)} ${Math.round(s.position * 100)}%`).join(", ");
    return p.type === "linear-gradient" ? `linear-gradient(90deg, ${stops})` : `radial-gradient(circle, ${stops})`;
  }
  return "#d6d3d1";
}

/** Converts a paint to another type, keeping its colors. */
export function convertPaint(p: EditablePaint, type: EditablePaint["type"]): EditablePaint {
  if (p.type === type) return p;
  const base = { ...(p.visible !== undefined ? { visible: p.visible } : {}), ...(p.opacity !== undefined ? { opacity: p.opacity } : {}) };
  const stops: Stop[] = p.type === "solid" ? [{ position: 0, color: p.color }, { position: 1, color: { ...p.color, a: 0 } }] : p.stops;
  if (type === "solid") return { type: "solid", color: stops[0]!.color, ...base };
  if (type === "linear-gradient") return { type, start: { x: 0, y: 0.5 }, end: { x: 1, y: 0.5 }, stops, ...base };
  return { type, center: { x: 0.5, y: 0.5 }, radiusX: { x: 1, y: 0.5 }, radiusY: { x: 0.5, y: 1 }, stops, ...base };
}

/** Pointer-drag helper: calls `f` with the pointer's fraction across the element, as one undo step. */
function useDrag(onFraction: (fx: number, fy: number) => void) {
  const editor = useEditor();
  const el = useRef<HTMLElement | null>(null);
  const at = (e: React.PointerEvent): void => {
    const r = el.current!.getBoundingClientRect();
    onFraction(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)));
  };
  return {
    ref: el,
    props: {
      onPointerDown: (e: React.PointerEvent) => {
        if (e.button !== 0) return;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        editor.history.begin();
        at(e);
      },
      onPointerMove: (e: React.PointerEvent) => {
        if ((e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) at(e);
      },
      onPointerUp: (e: React.PointerEvent) => {
        if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return;
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
        editor.history.end();
      },
    },
  };
}

/**
 * The color picker: paint type (solid, linear, radial), gradient stops (drag
 * to move, click the bar to add, delete the selected one), a
 * saturation/value area, hue and alpha sliders, hex/RGB/HSL fields, and the
 * browser's eyedropper where available. Gradient handles appear on the
 * canvas meanwhile (the caller sets `editor.paintEdit`).
 */
export function ColorPicker({ anchor, paint, onChange }: { anchor: string; paint: EditablePaint; onChange: (p: EditablePaint) => void }) {
  const [stopIndex, setStopIndex] = useState(0);
  const [mode, setMode] = useState<"hex" | "rgb" | "hsl">("hex");
  const stops: Stop[] | null = paint.type === "solid" ? null : paint.stops;
  const si = stops ? Math.min(stopIndex, stops.length - 1) : 0;
  const color = stops ? stops[si]!.color : (paint as Extract<Paint, { type: "solid" }>).color;
  // Hue and saturation survive gray and black colors while dragging.
  const [hsvMemo, setHsvMemo] = useState(() => rgbToHsv(color));
  const hsvFromColor = rgbToHsv(color);
  const hsv = toHex(hsvToRgb(hsvMemo)) === toHex(color) ? hsvMemo : hsvFromColor;

  const setColor = (c: Color): void => {
    if (paint.type === "solid") onChange({ ...paint, color: c });
    else onChange({ ...paint, stops: paint.stops.map((s, i) => (i === si ? { ...s, color: c } : s)) });
  };
  const setHsv = (h: { h: number; s: number; v: number }): void => {
    setHsvMemo(h);
    setColor(hsvToRgb(h, color.a));
  };
  const sv = useDrag((fx, fy) => setHsv({ h: hsv.h, s: fx, v: 1 - fy }));
  const hue = useDrag((fx) => setHsv({ ...hsv, h: Math.min(359.9, fx * 360) }));
  const alpha = useDrag((fx) => setColor({ ...color, a: Math.round(fx * 100) / 100 }));
  const bar = useRef<HTMLDivElement | null>(null);
  const svRef = useAnchor<HTMLDivElement>(`${anchor}.sv`, "slider", "Saturation and brightness");
  const hueRef = useAnchor<HTMLDivElement>(`${anchor}.hue`, "slider", "Hue");
  const alphaRef = useAnchor<HTMLDivElement>(`${anchor}.alpha`, "slider", "Opacity of the color");
  const barRef = useAnchor<HTMLDivElement>(`${anchor}.stops`, "slider", "Gradient stops (click to add)");
  const editor = useEditor();
  const dragStop = useRef<number | null>(null);
  const hsl = rgbToHsl(color);
  const eyedropper = typeof window !== "undefined" && "EyeDropper" in window;

  return (
    <div className="flex flex-col gap-2 p-2.5" data-testid="color-picker">
      <div className="flex items-center gap-1.5">
        <SelectField
          anchor={`${anchor}.type`}
          label="Paint type"
          value={paint.type}
          options={[
            ["solid", "Solid"],
            ["linear-gradient", "Linear"],
            ["radial-gradient", "Radial"],
          ]}
          onChange={(t) => onChange(convertPaint(paint, t))}
          testId="paint-type"
        />
        {stops && (
          <IconButton anchor={`${anchor}.removeStop`} label="Remove the selected stop" icon={Trash2} size={26} disabled={stops.length <= 2} onClick={() => {
            if (paint.type === "solid" || stops.length <= 2) return;
            onChange({ ...paint, stops: stops.filter((_, i) => i !== si) });
            setStopIndex(Math.max(0, si - 1));
          }} />
        )}
      </div>
      {stops && (
        <div
          ref={(el) => {
            bar.current = el;
            return barRef(el);
          }}
          className="relative h-6 cursor-copy rounded border border-stone-200"
          style={{ background: `${paintCss({ ...(paint as EditablePaint), type: "linear-gradient" } as Paint)}, repeating-conic-gradient(#e7e5e4 0 25%, #fff 0 50%) 0 0 / 8px 8px` }}
          data-testid="gradient-bar"
          onPointerDown={(e) => {
            if (e.target !== e.currentTarget || paint.type === "solid") return;
            const r = e.currentTarget.getBoundingClientRect();
            const pos = Math.round(((e.clientX - r.left) / r.width) * 1000) / 1000;
            const sorted = [...stops].sort((a, b) => a.position - b.position);
            const after = sorted.findIndex((s) => s.position >= pos);
            const a = sorted[Math.max(0, after - 1)] ?? sorted[0]!;
            const b = sorted[after < 0 ? sorted.length - 1 : after]!;
            const t = b.position === a.position ? 0 : (pos - a.position) / (b.position - a.position);
            onChange({ ...paint, stops: [...stops, { position: pos, color: mixColors(a.color, b.color, Math.max(0, Math.min(1, t))) }] });
            setStopIndex(stops.length);
          }}
        >
          {stops.map((s, i) => (
            <StopMarker
              key={i}
              anchor={`${anchor}.stop.${i}`}
              stop={s}
              selected={i === si}
              onPointerDown={(e) => {
                e.stopPropagation();
                setStopIndex(i);
                dragStop.current = i;
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                editor.history.begin();
              }}
              onPointerMove={(e) => {
                if (dragStop.current !== i || !bar.current || paint.type === "solid") return;
                const r = bar.current.getBoundingClientRect();
                const pos = Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * 1000) / 1000;
                onChange({ ...paint, stops: stops.map((x, k) => (k === i ? { ...x, position: pos } : x)) });
              }}
              onPointerUp={() => {
                if (dragStop.current === null) return;
                dragStop.current = null;
                editor.history.end();
              }}
            />
          ))}
        </div>
      )}
      <div
        ref={(el) => {
          sv.ref.current = el;
          return svRef(el);
        }}
        {...sv.props}
        className="relative h-36 cursor-crosshair rounded"
        style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent), hsl(${hsv.h}, 100%, 50%)` }}
        data-testid="picker-sv"
      >
        <span className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }} />
      </div>
      <div className="flex items-center gap-2">
        {eyedropper && (
          <IconButton anchor={`${anchor}.eyedropper`} label="Pick a color from the screen" icon={Pipette} size={26} onClick={async () => {
            try {
              const r = await (new (window as unknown as { EyeDropper: new () => { open(): Promise<{ sRGBHex: string }> } }).EyeDropper()).open();
              const c = parseHex(r.sRGBHex, color.a);
              if (c) setColor(c);
            } catch {
              // Cancelled.
            }
          }} />
        )}
        <div className="flex flex-1 flex-col gap-1.5">
          <div
            ref={(el) => {
              hue.ref.current = el;
              return hueRef(el);
            }}
            {...hue.props}
            className="relative h-3 cursor-pointer rounded-full"
            style={{ background: "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)" }}
            data-testid="picker-hue"
          >
            <span className="pointer-events-none absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow" style={{ left: `${(hsv.h / 360) * 100}%` }} />
          </div>
          <div
            ref={(el) => {
              alpha.ref.current = el;
              return alphaRef(el);
            }}
            {...alpha.props}
            className="relative h-3 cursor-pointer rounded-full"
            style={{ background: `linear-gradient(to right, transparent, ${cssColor({ ...color, a: 1 })}), repeating-conic-gradient(#e7e5e4 0 25%, #fff 0 50%) 0 0 / 6px 6px` }}
            data-testid="picker-alpha"
          >
            <span className="pointer-events-none absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow" style={{ left: `${color.a * 100}%` }} />
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1">
        <SelectField anchor={`${anchor}.mode`} label="Color format" value={mode} width={58} options={[["hex", "Hex"], ["rgb", "RGB"], ["hsl", "HSL"]]} onChange={setMode} />
        {mode === "hex" && <HexField anchor={`${anchor}.hex`} color={color} onChange={setColor} />}
        {mode === "rgb" &&
          (["r", "g", "b"] as const).map((k) => (
            <NumberField key={k} anchor={`${anchor}.${k}`} label={k.toUpperCase()} value={Math.round(color[k] * 255)} digits={0} min={0} max={255} onCommit={(f) => setColor({ ...color, [k]: Math.round(f(color[k] * 255)) / 255 })} />
          ))}
        {mode === "hsl" &&
          (["h", "s", "l"] as const).map((k) => (
            <NumberField
              key={k}
              anchor={`${anchor}.${k}`}
              label={k.toUpperCase()}
              value={k === "h" ? Math.round(hsl.h) : Math.round(hsl[k] * 100)}
              digits={0}
              min={0}
              max={k === "h" ? 360 : 100}
              onCommit={(f) => {
                const v = f(k === "h" ? hsl.h : hsl[k] * 100);
                setColor(hslToRgb({ ...hsl, [k]: k === "h" ? v % 360 : v / 100 }, color.a));
              }}
            />
          ))}
        <NumberField anchor={`${anchor}.alphaValue`} label="A" value={Math.round(color.a * 100)} digits={0} min={0} max={100} suffix="%" width={76} onCommit={(f) => setColor({ ...color, a: f(color.a * 100) / 100 })} />
      </div>
    </div>
  );
}

function StopMarker({ anchor, stop, selected, onPointerDown, onPointerMove, onPointerUp }: { anchor: string; stop: Stop; selected: boolean; onPointerDown: (e: React.PointerEvent) => void; onPointerMove: (e: React.PointerEvent) => void; onPointerUp: () => void }) {
  const ref = useAnchor<HTMLButtonElement>(anchor, "slider", `Gradient stop at ${Math.round(stop.position * 100)}%`);
  return (
    <button
      ref={ref}
      type="button"
      aria-label={`Gradient stop at ${Math.round(stop.position * 100)}%`}
      className={`absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-sm border-2 shadow ${selected ? "border-blue-600" : "border-white"}`}
      style={{ left: `${stop.position * 100}%`, background: cssColor(stop.color) }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  );
}

export function HexField({ anchor, color, onChange, width = "100%" }: { anchor: string; color: Color; onChange: (c: Color) => void; width?: number | string }) {
  const ref = useAnchor<HTMLInputElement>(anchor, "field", "Hex color");
  const [text, setText] = useState<string | null>(null);
  const shown = toHex(color);
  return (
    <input
      ref={ref}
      aria-label="Hex color"
      data-testid="hex"
      className="h-7 min-w-0 rounded-md border border-transparent bg-stone-100 px-2 font-mono text-[11px] uppercase outline-none hover:border-stone-200 focus:border-blue-500 focus:bg-white"
      style={{ width }}
      value={text ?? shown}
      onFocus={(e) => {
        setText(shown);
        e.target.select();
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const c = text !== null ? parseHex(text, color.a) : null;
        if (c && toHex(c) !== shown) onChange(c);
        setText(null);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setText(null);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}
