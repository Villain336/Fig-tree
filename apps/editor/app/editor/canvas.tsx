"use client";

import { textSession, drawOverlay, LABEL_FONT, type Cursor, type Editor, type KeyInput, type PointerInput } from "@fig-tree/editor-core";
import { useEffect, useRef, useState } from "react";
import { Rulers } from "./rulers";
import { useAnchor, useEditor, useEditorTick } from "./state";

const CURSORS: Record<Cursor, string> = {
  default: "default",
  crosshair: "crosshair",
  text: "text",
  grab: "grab",
  grabbing: "grabbing",
  move: "move",
  copy: "copy",
  pointer: "pointer",
  "ew-resize": "ew-resize",
  "ns-resize": "ns-resize",
  "nesw-resize": "nesw-resize",
  "nwse-resize": "nwse-resize",
  // A rotation cursor drawn as an SVG (our own: a circular arrow), centered on its hotspot.
  rotate:
    "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'><path d='M6 14a6 6 0 1 0 2-7' fill='none' stroke='white' stroke-width='4'/><path d='M6 14a6 6 0 1 0 2-7' fill='none' stroke='black' stroke-width='1.5'/><path d='M5 4v4h4' fill='none' stroke='black' stroke-width='1.5'/></svg>\") 12 12, crosshair",
  // Our own drawings: a pen nib with its tip on the hotspot (top left), with a mark for adding or closing.
  pen: svgCursor("<path d='M2 2l12 4 4 8-4 4-8-4z' fill='white' stroke='black' stroke-width='1.2' stroke-linejoin='round'/><path d='M2 2l6 6' stroke='black' stroke-width='1.2'/><circle cx='8.5' cy='8.5' r='1.3' fill='black'/>", 2, 2),
  "pen-add": svgCursor("<path d='M2 2l12 4 4 8-4 4-8-4z' fill='white' stroke='black' stroke-width='1.2' stroke-linejoin='round'/><path d='M2 2l6 6' stroke='black' stroke-width='1.2'/><path d='M19 16v6M16 19h6' stroke='black' stroke-width='1.5'/>", 2, 2),
  "pen-close": svgCursor("<path d='M2 2l12 4 4 8-4 4-8-4z' fill='white' stroke='black' stroke-width='1.2' stroke-linejoin='round'/><path d='M2 2l6 6' stroke='black' stroke-width='1.2'/><circle cx='19' cy='19' r='2.6' fill='white' stroke='black' stroke-width='1.3'/>", 2, 2),
  pencil: svgCursor("<path d='M3 21l2-6L17 3l4 4L9 19z' fill='white' stroke='black' stroke-width='1.2' stroke-linejoin='round'/><path d='M3 21l2-6 4 4z' fill='black'/>", 3, 21),
  bend: svgCursor("<path d='M4 17C8 5 16 5 20 17' fill='none' stroke='white' stroke-width='4'/><path d='M4 17C8 5 16 5 20 17' fill='none' stroke='black' stroke-width='1.5'/><circle cx='12' cy='8' r='2' fill='white' stroke='black' stroke-width='1.2'/>", 12, 8),
  bucket: svgCursor("<path d='M6 9l7-6 8 8-7 7z' fill='white' stroke='black' stroke-width='1.2' stroke-linejoin='round'/><path d='M6 9c-2 3-4 6-4 8a2 2 0 0 0 4 0c0-2-1-4 0-8z' fill='black'/>", 4, 19),
};

function svgCursor(body: string, x: number, y: number): string {
  return `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>${body}</svg>") ${x} ${y}, crosshair`;
}

/** Modifier state of a DOM event in the editor's terms (⌘ on macOS, Ctrl elsewhere). */
export function mods(e: { shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean }, mac: boolean): { shift: boolean; alt: boolean; mod: boolean } {
  return { shift: e.shiftKey, alt: e.altKey, mod: mac ? e.metaKey : e.ctrlKey };
}

export function keyInput(e: KeyboardEvent | React.KeyboardEvent, mac: boolean): KeyInput {
  return { key: e.key, code: e.code, ...mods(e, mac), repeat: e.repeat };
}

/** Whether a key press types a character (it arrives as text input, not as a shortcut). */
export function isPrintable(e: KeyboardEvent | React.KeyboardEvent, mac: boolean): boolean {
  const mod = mac ? e.metaKey : e.ctrlKey;
  return e.key.length === 1 && !mod && !(mac ? false : e.altKey && e.ctrlKey);
}

export interface FrameSample {
  /** Wall clock from the earliest input of the frame to the end of the frame's CPU work (includes waiting for the GPU and the next animation frame). */
  readonly wall: number;
  /** CPU time from input to frame: handling the frame's inputs (editor, commands, Yjs, layout, bridge) plus the frame's render CPU. */
  readonly latency: number;
  /** Handling the frame's inputs only. */
  readonly input: number;
  /** The frame's render CPU. */
  readonly frameCpu: number;
  /** Nodes the bridge recompiled since the previous frame. */
  readonly compiled: number;
  /** Font faces that arrived before this frame (their text was laid out again). */
  readonly fonts: readonly string[];
  /** CPU time spent building and drawing the overlay (selection, handles, vector points) since the previous frame. */
  readonly overlay: number;
}

/**
 * The canvas input layer over the GPU-rendered document: an overlay canvas for selection,
 * guides and carets, and a hidden textarea that receives typed text and
 * IME composition while text is edited. Input is normalized and handed to
 * the editor; frames render on the next animation frame after a change.
 */
export function Canvas({ onContextMenu, render }: { onContextMenu: (at: { x: number; y: number }) => void; render: () => void }) {
  const editor = useEditor();
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [cursor, setCursor] = useState("default");
  const canvasAnchor = useAnchor<HTMLDivElement>("canvas", "canvas", "Canvas");
  useEditorTick(["session", "settings"]);
  const mac = editor.platform === "mac";

  // Overlay drawing: on every editor change, coalesced per frame.
  useEffect(() => {
    let frame = 0;
    const draw = (): void => {
      frame = 0;
      const c = overlayRef.current;
      if (!c) return;
      const dpr = window.devicePixelRatio || 1;
      const w = c.clientWidth;
      const h = c.clientHeight;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
      const ctx = c.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const t0 = performance.now();
      ctx.clearRect(0, 0, w, h);
      drawOverlay(ctx as unknown as Parameters<typeof drawOverlay>[0], editor.overlay(), w, h);
      markOverlay(performance.now() - t0);
      setCursor(CURSORS[editor.cursor]);
      positionTextInput(editor, textRef.current);
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

  // Measure overlay labels with the real font.
  useEffect(() => {
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.font = LABEL_FONT;
    editor.measureText = (t) => ctx.measureText(t).width;
    editor.canvasOrigin = () => {
      const r = hostRef.current?.getBoundingClientRect();
      return { x: r?.x ?? 0, y: r?.y ?? 0 };
    };
  }, [editor]);

  // Pointer and wheel input.
  useEffect(() => {
    const host = hostRef.current!;
    const point = (e: PointerEvent | MouseEvent, clickCount = 1): PointerInput => {
      const r = host.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top, button: e.button, ...mods(e, mac), clickCount };
    };
    let clicks = { n: 0, t: 0, x: 0, y: 0 };
    const onDown = (e: PointerEvent): void => {
      if (e.button === 2) return;
      // Panel fields lose focus (and commit) when the canvas is used.
      const active = document.activeElement as HTMLElement | null;
      if (active && active !== textRef.current && active !== document.body) active.blur();
      host.setPointerCapture(e.pointerId);
      const now = performance.now();
      const near = Math.hypot(e.clientX - clicks.x, e.clientY - clicks.y) < 5;
      clicks = { n: now - clicks.t < 400 && near ? clicks.n + 1 : 1, t: now, x: e.clientX, y: e.clientY };
      timed(e.timeStamp, () => editor.pointerDown(point(e, Math.min(clicks.n, 3))));
      render();
      if (textSession(editor)) setTimeout(() => textRef.current?.focus({ preventScroll: true }));
    };
    const onMove = (e: PointerEvent): void => {
      // Coalesced events: the editor only needs the latest position of a frame's batch.
      timed(e.timeStamp, () => editor.pointerMove(point(e)));
      render();
    };
    const onUp = (e: PointerEvent): void => {
      if (e.button === 2) return;
      timed(e.timeStamp, () => editor.pointerUp(point(e, Math.min(clicks.n, 3))));
      render();
      if (textSession(editor)) textRef.current?.focus({ preventScroll: true });
    };
    const onLeave = (): void => editor.pointerLeave();
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const r = host.getBoundingClientRect();
      const scale = e.deltaMode === 1 ? 16 : 1;
      timed(e.timeStamp, () => editor.wheel({ x: e.clientX - r.left, y: e.clientY - r.top, deltaX: e.deltaX * scale, deltaY: e.deltaY * scale, zoom: e.ctrlKey || e.metaKey, shift: e.shiftKey }));
      render();
    };
    const onContext = (e: MouseEvent): void => {
      e.preventDefault();
      editor.pointerDown(point(e));
      editor.pointerUp(point(e));
      onContextMenu({ x: e.clientX, y: e.clientY });
    };
    host.addEventListener("pointerdown", onDown);
    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerup", onUp);
    host.addEventListener("pointerleave", onLeave);
    host.addEventListener("wheel", onWheel, { passive: false });
    host.addEventListener("contextmenu", onContext);
    return () => {
      host.removeEventListener("pointerdown", onDown);
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerup", onUp);
      host.removeEventListener("pointerleave", onLeave);
      host.removeEventListener("wheel", onWheel);
      host.removeEventListener("contextmenu", onContext);
    };
  }, [editor, mac, onContextMenu, render]);

  // The hidden textarea: typed text, IME composition and keys while editing text.
  useEffect(() => {
    const ta = textRef.current!;
    const onBeforeInput = (e: InputEvent): void => {
      const s = textSession(editor);
      if (!s) return;
      if (e.inputType === "insertText" && e.data) {
        e.preventDefault();
        timed(e.timeStamp, () => s.insert(e.data!));
        render();
      } else if (e.inputType === "insertCompositionText") {
        // Handled by composition events.
      } else if (e.inputType !== "insertFromComposition") {
        e.preventDefault();
      }
    };
    const onCompStart = (): void => {
      textSession(editor)?.compositionStart();
      render();
    };
    const onCompUpdate = (e: CompositionEvent): void => {
      textSession(editor)?.compositionUpdate(e.data);
      render();
    };
    const onCompEnd = (e: CompositionEvent): void => {
      textSession(editor)?.compositionEnd(e.data);
      ta.value = "";
      render();
    };
    ta.addEventListener("beforeinput", onBeforeInput);
    ta.addEventListener("compositionstart", onCompStart);
    ta.addEventListener("compositionupdate", onCompUpdate);
    ta.addEventListener("compositionend", onCompEnd);
    return () => {
      ta.removeEventListener("beforeinput", onBeforeInput);
      ta.removeEventListener("compositionstart", onCompStart);
      ta.removeEventListener("compositionupdate", onCompUpdate);
      ta.removeEventListener("compositionend", onCompEnd);
    };
  }, [editor, render]);

  // Focus the textarea when a text session starts (not on every render: panel fields may have focus).
  const sessionNode = textSession(editor)?.nodeId ?? null;
  useEffect(() => {
    if (sessionNode) textRef.current?.focus({ preventScroll: true });
  }, [sessionNode]);

  return (
    <div ref={(el) => { hostRef.current = el; return canvasAnchor(el); }} className="absolute inset-0 touch-none select-none overflow-hidden" style={{ cursor }} data-testid="canvas-host">
      <canvas ref={overlayRef} className="pointer-events-none absolute inset-0 h-full w-full" data-testid="overlay" />
      {editor.settings.rulers && <Rulers />}
      <textarea
        ref={textRef}
        aria-label="Text input"
        data-text-input=""
        className="pointer-events-none absolute h-5 w-px resize-none overflow-hidden border-0 bg-transparent p-0 text-transparent caret-transparent outline-none"
        style={{ left: -100, top: -100, fontSize: 16 }}
        autoCapitalize="off"
        autoComplete="off"
        spellCheck={false}
        tabIndex={-1}
      />
    </div>
  );
}

function positionTextInput(editor: Editor, ta: HTMLTextAreaElement | null): void {
  if (!ta) return;
  const s = textSession(editor);
  if (!s) {
    ta.style.left = "-100px";
    ta.style.top = "-100px";
    return;
  }
  const r = s.inputRect();
  ta.style.left = `${Math.round(r.x)}px`;
  ta.style.top = `${Math.round(r.y)}px`;
  ta.style.height = `${Math.max(12, Math.round(r.height))}px`;
}

/** Overlay CPU time (build and draw) since the last frame. */
let overlayCpu = 0;
export function markOverlay(ms: number): void {
  overlayCpu += ms;
}
export function takeOverlay(): number {
  const v = overlayCpu;
  overlayCpu = 0;
  return v;
}

/** Inputs waiting for a frame (for input-to-frame latency): event timestamp and handling time. */
const pendingInputs: { at: number; cpu: number }[] = [];
export function markInput(timeStamp: number, cpu = 0): void {
  pendingInputs.push({ at: timeStamp, cpu });
}
export function takeInputs(): { at: number; cpu: number }[] {
  return pendingInputs.splice(0);
}

/** Runs an input handler and records its timestamp and CPU time. */
export function timed(timeStamp: number, fn: () => void): void {
  const t0 = performance.now();
  fn();
  markInput(timeStamp, performance.now() - t0);
}
