"use client";

import { multiply, scaling, translation } from "@fig-tree/geometry";
import { Renderer, Scene, backendFromSearch, type FrameStats } from "@fig-tree/renderer";
import { AssetStore, CommandError, SceneBridge, type Command, type FigDocument } from "@fig-tree/document";
import { deletePage, Editor as CoreEditor, paste, placeImage, textSession, copySelection, cutSelection, type AnchorRect, type ClipboardIn } from "@fig-tree/editor-core";
import type { FontRegistry } from "@fig-tree/text";
import { useCallback, useEffect, useRef, useState } from "react";
import { Canvas, isPrintable, keyInput, takeInputs, type FrameSample } from "./editor/canvas";
import { PanelBoundary } from "./editor/boundary";
import { DesignPanel } from "./editor/design";
import { LayersPanel, PagesPanel } from "./editor/layers";
import { ContextMenu, PageMenu, ShortcutsSheet } from "./editor/menus";
import { EditorContext } from "./editor/state";
import { Toolbar } from "./editor/toolbar";
import { editorFonts } from "./fonts";
import { BLANK_BOUNDS, GRID_BOUNDS, SAMPLE_BOUNDS, buildBlankDocument, buildGridDocument, buildLayoutDocument, buildSampleDocument, buildTextDocument } from "./sample-document";

export interface EditorPixels {
  readonly backend: string;
  readonly width: number;
  readonly height: number;
  /** Base64 RGBA8, premultiplied, rows top to bottom. */
  readonly pixels: string;
}

/** Hooks for Playwright and the console. */
export interface EditorHarness {
  readonly backend: string;
  readonly doc: FigDocument;
  readonly bridge: SceneBridge;
  /** The framework-free editor (selection, tools, history, anchors). */
  readonly editor: CoreEditor;
  /** Applies commands as the local user; returns affected ids or an error message. */
  apply(commands: Command[]): { affected: readonly string[] } | { error: string };
  /** Renders the current view, waits for the GPU and returns the frame. */
  renderPixels(): Promise<EditorPixels>;
  /** CSS pixel position on the canvas of a world point. */
  toCanvas(x: number, y: number): { x: number; y: number };
  /** Renders one frame now (synchronously) and returns its stats. */
  renderFrame(): FrameStats;
  /** Resolves when the GPU finished submitted frames. */
  finish(): Promise<void>;
  /** Sets the view: world-to-canvas scale and translation. */
  setView(scale: number, x: number, y: number): void;
  /** A node's computed layout box (relative to its parent), or null. */
  box(id: string): { x: number; y: number; width: number; height: number } | null;
  /** Resolves when every font the document asked for has loaded and its text was laid out again. */
  fontsReady(): Promise<void>;
  /** Every registered UI anchor with its current rect (null when off screen). */
  anchors(): { id: string; kind: string; label: string; rect: AnchorRect | null }[];
  /** Input-to-frame samples recorded since the last call. */
  takeSamples(): FrameSample[];
  /** Selected node ids. */
  selection(): readonly string[];
}

declare global {
  interface Window {
    __figtree?: EditorHarness;
  }
}

function initialDocument(which: string | null): { doc: FigDocument; bounds: { x: number; y: number; width: number; height: number } } {
  switch (which) {
    case "grid10k":
      return { doc: buildGridDocument(), bounds: GRID_BOUNDS };
    case "layout10k":
      return { doc: buildLayoutDocument(), bounds: GRID_BOUNDS };
    case "text10k":
      return { doc: buildTextDocument(), bounds: GRID_BOUNDS };
    case "blank":
      return { doc: buildBlankDocument(), bounds: BLANK_BOUNDS };
    default:
      return { doc: buildSampleDocument(), bounds: SAMPLE_BOUNDS };
  }
}

const isField = (t: EventTarget | null): boolean => t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "SELECT" || (t.tagName === "TEXTAREA" && !t.hasAttribute("data-text-input")) || t.isContentEditable);

/**
 * The editor app: toolbar, pages and layers, the canvas (GPU renderer plus
 * overlay), and the design panel. The editor state and behaviour live in
 * `@fig-tree/editor-core`; this component wires it to the DOM.
 */
export function Editor() {
  const gpuRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [core, setCore] = useState<CoreEditor | null>(null);
  const [fonts, setFonts] = useState<FontRegistry | null>(null);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ where: "canvas" | "layers"; at: { x: number; y: number } } | null>(null);
  const [pageMenu, setPageMenu] = useState<{ page: string; at: { x: number; y: number } } | null>(null);
  const [shortcuts, setShortcuts] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const renderRef = useRef<() => void>(() => {});

  useEffect(() => {
    const canvas = gpuRef.current!;
    const params = new URLSearchParams(window.location.search);
    const { doc, bounds } = initialDocument(params.get("doc"));
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    const scene = new Scene();
    let bridge!: SceneBridge;
    let editor!: CoreEditor;
    let renderer: Renderer | null = null;
    let disposed = false;
    let scheduled = false;
    let samples: FrameSample[] = [];
    const assets = new AssetStore();

    const renderNow = (): FrameStats | null => {
      if (!renderer || disposed) return null;
      renderer.background = bridge.background;
      const inputs = takeInputs();
      const stats = renderer.render({ transform: editor.viewport.matrix });
      const now = performance.now();
      if (inputs.length) samples.push({ latency: now - Math.min(...inputs), frameCpu: stats.cpuMs, compiled: bridge.lastCompiled });
      if (samples.length > 5000) samples = samples.slice(-5000);
      setStatus(`${renderer.backendKind} · ${doc.tree.size} nodes · last update compiled ${bridge.lastCompiled} · frame cpu ${stats.cpuMs.toFixed(1)} ms · ${Math.round(editor.viewport.scale * 100)}%`);
      return stats;
    };
    const schedule = (): void => {
      if (scheduled || disposed) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        renderNow();
      });
    };
    renderRef.current = schedule;
    const fit = (): void => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const s = Math.min(w / bounds.width, h / bounds.height) * 0.92;
      const m = multiply(translation(Math.round((w - bounds.width * s) / 2), Math.round((h - bounds.height * s) / 2)), scaling(s));
      editor.viewport.set(m[0], m[4], m[5]);
    };
    const resize = (): void => {
      if (!renderer) return;
      renderer.setSize(canvas.clientWidth, canvas.clientHeight, window.devicePixelRatio || 1);
      editor.viewport.resize(canvas.clientWidth, canvas.clientHeight);
      schedule();
    };

    (async () => {
      const registry = await editorFonts();
      if (disposed) return;
      bridge = new SceneBridge(doc, scene, { fonts: registry });
      editor = new CoreEditor(doc, bridge, { platform: mac ? "mac" : "other", assets });
      editor.subscribe((changes) => {
        if (changes.has("view") || changes.has("document") || changes.has("page")) schedule();
      });
      // Fonts arriving lay text out again without a document change.
      bridge.onSync = () => {
        editor.emit("document");
        schedule();
      };
      editor.onRequest = (r) => {
        if (r.kind === "place-image") fileRef.current?.click();
        else if (r.kind === "rename") setRenaming(r.id);
        else if (r.kind === "shortcuts") setShortcuts(true);
      };
      renderer = await Renderer.create(canvas, { backend: backendFromSearch(window.location.search), background: bridge.background });
      if (disposed) {
        renderer.destroy();
        return;
      }
      renderer.setScene(scene);
      editor.viewport.resize(canvas.clientWidth, canvas.clientHeight);
      resize();
      fit();
      setFonts(registry);
      setCore(editor);
      const r = renderer;
      window.__figtree = {
        backend: r.backendKind,
        doc,
        bridge,
        editor,
        apply(commands) {
          try {
            return { affected: editor.history.applyOrThrow(commands).affected };
          } catch (err) {
            if (err instanceof CommandError) return { error: err.message };
            throw err;
          }
        },
        async renderPixels() {
          r.background = bridge.background;
          await r.renderComplete({ transform: editor.viewport.matrix });
          const px = await r.readPixels();
          let binary = "";
          for (let i = 0; i < px.data.length; i += 0x8000) binary += String.fromCharCode(...px.data.subarray(i, i + 0x8000));
          return { backend: r.backendKind, width: px.width, height: px.height, pixels: btoa(binary) };
        },
        toCanvas(x, y) {
          return editor.viewport.toScreen({ x, y });
        },
        renderFrame() {
          return renderNow()!;
        },
        finish() {
          return r.finish();
        },
        setView(scale, x, y) {
          editor.viewport.set(scale, x, y);
          editor.emit("view");
        },
        box(id) {
          const b = bridge.box(id);
          return b ? { x: b.x, y: b.y, width: b.width, height: b.height } : null;
        },
        async fontsReady() {
          for (;;) {
            await registry.whenIdle();
            await new Promise((resolve) => setTimeout(resolve, 0));
            if (!registry.entries().some((e) => e.state === "loading")) return;
          }
        },
        anchors() {
          return editor.anchors.list().map((a) => ({ ...a, rect: editor.anchors.rect(a.id) }));
        },
        takeSamples() {
          const out = samples;
          samples = [];
          return out;
        },
        selection() {
          return editor.selection;
        },
      };
    })().catch((err: unknown) => setError(String(err)));

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    // Keyboard: shortcuts go to the editor unless a panel field has focus; typed text goes through the canvas textarea.
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!editor || isField(e.target)) return;
      if (e.isComposing || e.key === "Process") return;
      if (textSession(editor) && isPrintable(e, mac)) return;
      if (editor.keyDown(keyInput(e, mac))) {
        e.preventDefault();
        schedule();
      }
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      if (!editor) return;
      editor.keyUp(keyInput(e, mac));
    };
    const onBlur = (): void => editor?.blur();
    const onCopy = (e: ClipboardEvent): void => {
      if (!editor || isField(e.target)) return;
      const out = e.type === "cut" ? cutSelection(editor) : copySelection(editor);
      if (!out) return;
      e.preventDefault();
      e.clipboardData?.setData("text/plain", out.text);
      if (out.html) e.clipboardData?.setData("text/html", out.html);
      schedule();
    };
    const onPaste = (e: ClipboardEvent): void => {
      if (!editor || isField(e.target)) return;
      e.preventDefault();
      void readTransfer(e.clipboardData).then((data) => paste(editor, data)).then(schedule);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCopy);
    document.addEventListener("paste", onPaste);
    return () => {
      disposed = true;
      ro.disconnect();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCopy);
      document.removeEventListener("paste", onPaste);
      editor?.dispose();
      bridge?.dispose();
      renderer?.destroy();
      delete window.__figtree;
    };
  }, []);

  const render = useCallback(() => renderRef.current(), []);
  const openCanvasMenu = useCallback((at: { x: number; y: number }) => setMenu({ where: "canvas", at }), []);

  return (
    <EditorContext.Provider value={core}>
      <div className="flex h-dvh flex-col bg-stone-100 text-stone-900" onDragOver={(e) => e.preventDefault()} onDrop={(e) => {
        e.preventDefault();
        if (!core) return;
        const host = (e.target as HTMLElement).closest("[data-testid=canvas-host]");
        const r = host?.getBoundingClientRect();
        void readTransfer(e.dataTransfer).then(async (data) => {
          const at = r ? core.viewport.toWorld({ x: e.clientX - r.left, y: e.clientY - r.top }) : undefined;
          const image = data.files?.find((f) => /^image\/(png|jpeg|gif|webp)$/.test(f.type));
          if (image && at) await placeImage(core, image.bytes, image.name, at);
          else await paste(core, data);
          render();
        });
      }}>
        {core ? (
          <PanelBoundary name="Toolbar">
            <Toolbar onShortcuts={() => setShortcuts(true)} />
          </PanelBoundary>
        ) : (
          <header className="h-11 shrink-0 border-b border-stone-200 bg-white" />
        )}
        <div className="flex min-h-0 flex-1">
          <aside className="flex w-64 shrink-0 flex-col border-r border-stone-200 bg-white" aria-label="Pages and layers">
            {core && (
              <PanelBoundary name="Layers">
                <PagesPanel onPageMenu={(page, at) => setPageMenu({ page, at })} />
                <LayersPanel onContextMenu={(at) => setMenu({ where: "layers", at })} renaming={renaming} setRenaming={setRenaming} />
              </PanelBoundary>
            )}
          </aside>
          <main className="relative min-w-0 flex-1">
            <canvas ref={gpuRef} className="block h-full w-full" data-testid="canvas" />
            {core && <Canvas onContextMenu={openCanvasMenu} render={render} />}
            {error && <p className="absolute left-3 top-3 rounded bg-red-50 px-2 py-1 text-xs text-red-700">{error}</p>}
          </main>
          {core ? (
            <PanelBoundary name="Design panel">
              <DesignPanel fonts={fonts} />
            </PanelBoundary>
          ) : (
            <aside className="w-64 shrink-0 border-l border-stone-200 bg-white" />
          )}
        </div>
        <footer className="h-7 shrink-0 border-t border-stone-200 bg-white px-4 font-mono text-[11px] leading-7 text-stone-500" data-testid="status">
          {status}
        </footer>
        {core && menu && <ContextMenu where={menu.where} at={menu.at} onClose={() => setMenu(null)} />}
        {core && pageMenu && (
          <PageMenu page={pageMenu.page} at={pageMenu.at} onClose={() => setPageMenu(null)} onRename={() => setRenaming(pageMenu.page)} onDelete={() => deletePage(core, pageMenu.page)} />
        )}
        {core && shortcuts && <ShortcutsSheet onClose={() => setShortcuts(false)} />}
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
          className="hidden"
          data-testid="image-input"
          aria-label="Image file"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!core) return;
            if (!file) {
              core.setTool("select");
              return;
            }
            const bytes = new Uint8Array(await file.arrayBuffer());
            if (file.type === "image/svg+xml") await paste(core, { files: [{ type: file.type, name: file.name, bytes }] });
            else await placeImage(core, bytes, file.name);
            core.setTool("select");
            render();
          }}
        />
      </div>
    </EditorContext.Provider>
  );
}

async function readTransfer(dt: DataTransfer | null): Promise<ClipboardIn> {
  if (!dt) return {};
  const files: { type: string; name: string; bytes: Uint8Array }[] = [];
  for (const f of Array.from(dt.files)) files.push({ type: f.type, name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
  const html = dt.getData("text/html");
  const text = dt.getData("text/plain");
  return { ...(html ? { html } : {}), ...(text ? { text } : {}), ...(files.length ? { files } : {}) };
}
