"use client";

import { multiply, scaling, translation, type Mat2D } from "@fig-tree/geometry";
import { Renderer, Scene, backendFromSearch, type FrameStats } from "@fig-tree/renderer";
import { CommandError, SceneBridge, cssDeclarations, type Command, type ComputedBox, type FigDocument, type NodeType } from "@fig-tree/document";
import {
  Circle,
  Component,
  Diamond,
  File,
  Frame,
  Group,
  Hexagon,
  Image as ImageIcon,
  Maximize,
  Minus,
  PenTool,
  Square,
  Star,
  TriangleAlert,
  Type,
  type LucideIcon,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { editorFonts } from "./fonts";
import { GRID_BOUNDS, SAMPLE_BOUNDS, buildGridDocument, buildLayoutDocument, buildSampleDocument } from "./sample-document";

const ICONS: Record<NodeType, LucideIcon> = {
  page: File,
  frame: Frame,
  group: Group,
  rectangle: Square,
  ellipse: Circle,
  polygon: Hexagon,
  star: Star,
  line: Minus,
  vector: PenTool,
  text: Type,
  image: ImageIcon,
  component: Component,
  instance: Diamond,
};

interface Layer {
  readonly id: string;
  readonly type: NodeType;
  readonly name: string;
  readonly depth: number;
  readonly unsupported: readonly string[];
  readonly visible: boolean;
}

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
}

/** Layer rows shown in the dev panel; large documents are truncated. */
const MAX_LAYER_ROWS = 400;

declare global {
  interface Window {
    __figtree?: EditorHarness;
  }
}

function layersOf(doc: FigDocument, bridge: SceneBridge): Layer[] {
  const out: Layer[] = [];
  const walk = (id: string, depth: number): void => {
    // Top of the stack first, as layer panels list it.
    for (const c of [...doc.tree.childrenOf(id)].reverse()) {
      if (out.length >= MAX_LAYER_ROWS) return;
      out.push({
        id: c,
        type: doc.typeOf(c)!,
        name: doc.get<string>(c, "name"),
        depth,
        unsupported: [...(bridge.unsupported.get(c) ?? [])],
        visible: doc.get<boolean>(c, "visible"),
      });
      walk(c, depth + 1);
    }
  };
  walk(bridge.page, 0);
  return out;
}

const fmt = (v: number): string => String(Math.round(v * 100) / 100);

/** The computed box as inspector rows: position relative to the parent, size, and non-zero padding and border. */
function boxRows(b: ComputedBox): [string, string][] {
  const rows: [string, string][] = [
    ["x", fmt(b.x)],
    ["y", fmt(b.y)],
    ["w", fmt(b.width)],
    ["h", fmt(b.height)],
  ];
  const sides = (e: ComputedBox["padding"]): string => [e.top, e.right, e.bottom, e.left].map(fmt).join(" ");
  if (b.padding.top || b.padding.right || b.padding.bottom || b.padding.left) rows.push(["padding", sides(b.padding)]);
  if (b.border.top || b.border.right || b.border.bottom || b.border.left) rows.push(["border", sides(b.border)]);
  return rows;
}

/** Editor shell: the sample document rendered through the document bridge, a layer tree and a small inspector. */
export function Editor() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [layers, setLayers] = useState<Layer[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [inspect, setInspect] = useState<{ css: Record<string, string>; box: ComputedBox | undefined; unsupported: readonly string[] } | null>(null);
  const [status, setStatus] = useState("loading");
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const docRef = useRef<{ doc: FigDocument; bridge: SceneBridge; fit: () => void } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const which = new URLSearchParams(window.location.search).get("doc");
    const doc = which === "grid10k" ? buildGridDocument() : which === "layout10k" ? buildLayoutDocument() : buildSampleDocument();
    const bounds = which === "grid10k" || which === "layout10k" ? GRID_BOUNDS : SAMPLE_BOUNDS;
    const scene = new Scene();
    // Created once HarfBuzz is ready (text is laid out as the bridge builds the scene).
    let bridge!: SceneBridge;
    const user = doc.actor("local-user");
    let renderer: Renderer | null = null;
    let view: Mat2D = [1, 0, 0, 1, 0, 0];
    let disposed = false;
    let scheduled = false;
    let dragging: { x: number; y: number } | null = null;
    let lastCpu = 0;

    let panelsScheduled = false;
    const refreshPanels = (): void => {
      setLayers(layersOf(doc, bridge));
      setTotal(doc.tree.size - 1);
    };
    // Panels refresh on the next animation frame, outside the document change itself.
    const schedulePanels = (): void => {
      if (panelsScheduled || disposed) return;
      panelsScheduled = true;
      requestAnimationFrame(() => {
        panelsScheduled = false;
        if (!disposed) refreshPanels();
      });
    };
    const schedule = (): void => {
      if (scheduled || disposed) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        if (!renderer || disposed) return;
        renderer.background = bridge.background;
        lastCpu = renderer.render({ transform: view }).cpuMs;
        setStatus(`${renderer.backendKind} · ${doc.tree.size} nodes · last update compiled ${bridge.lastCompiled} · frame cpu ${lastCpu.toFixed(1)} ms`);
      });
    };
    const fit = (): void => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const s = Math.min(w / bounds.width, h / bounds.height) * 0.92;
      view = multiply(translation(Math.round((w - bounds.width * s) / 2), Math.round((h - bounds.height * s) / 2)), scaling(s));
      schedule();
    };
    const resize = (): void => {
      renderer?.setSize(canvas.clientWidth, canvas.clientHeight, window.devicePixelRatio || 1);
      fit();
    };
    const unsubscribe = doc.onChange(() => {
      schedulePanels();
      schedule();
    });

    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      if (e.ctrlKey || e.metaKey) {
        const f = Math.exp(-e.deltaY * 0.01);
        view = multiply(multiply(translation(x, y), scaling(f)), multiply(translation(-x, -y), view));
      } else {
        view = multiply(translation(-e.deltaX, -e.deltaY), view);
      }
      schedule();
    };
    const onDown = (e: PointerEvent): void => {
      dragging = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent): void => {
      if (!dragging) return;
      view = multiply(translation(e.clientX - dragging.x, e.clientY - dragging.y), view);
      dragging = { x: e.clientX, y: e.clientY };
      schedule();
    };
    const onUp = (e: PointerEvent): void => {
      const start = dragging;
      dragging = null;
      if (!renderer || !start) return;
      // A click (no drag) selects the node under the cursor.
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < 3) {
        const r = canvas.getBoundingClientRect();
        setSelected(bridge.nodeIdFor(renderer.hitTest({ x: e.clientX - r.left, y: e.clientY - r.top })) ?? null);
      }
    };

    (async () => {
      const fonts = await editorFonts();
      if (disposed) return;
      bridge = new SceneBridge(doc, scene, { fonts });
      // Fonts arriving lay text out again without a document change.
      bridge.onSync = () => {
        schedulePanels();
        schedule();
      };
      docRef.current = { doc, bridge, fit };
      renderer = await Renderer.create(canvas, { backend: backendFromSearch(window.location.search), background: bridge.background });
      if (disposed) {
        renderer.destroy();
        return;
      }
      renderer.setScene(scene);
      resize();
      refreshPanels();
      const r = renderer;
      window.__figtree = {
        backend: r.backendKind,
        doc,
        bridge,
        apply(commands) {
          try {
            return { affected: doc.apply(commands, user).affected };
          } catch (err) {
            if (err instanceof CommandError) return { error: err.message };
            throw err;
          }
        },
        async renderPixels() {
          r.background = bridge.background;
          await r.renderComplete({ transform: view });
          const px = await r.readPixels();
          let binary = "";
          for (let i = 0; i < px.data.length; i += 0x8000) binary += String.fromCharCode(...px.data.subarray(i, i + 0x8000));
          return { backend: r.backendKind, width: px.width, height: px.height, pixels: btoa(binary) };
        },
        toCanvas(x, y) {
          return { x: view[0] * x + view[2] * y + view[4], y: view[1] * x + view[3] * y + view[5] };
        },
        renderFrame() {
          r.background = bridge.background;
          return r.render({ transform: view });
        },
        finish() {
          return r.finish();
        },
        setView(scale, x, y) {
          view = [scale, 0, 0, scale, x, y];
          schedule();
        },
        box(id) {
          const b = bridge.box(id);
          return b ? { x: b.x, y: b.y, width: b.width, height: b.height } : null;
        },
        async fontsReady() {
          // Loads finishing lay text out again (on a microtask), which may ask for more fonts.
          for (;;) {
            await fonts.whenIdle();
            await new Promise((resolve) => setTimeout(resolve, 0));
            if (!fonts.entries().some((e) => e.state === "loading")) return;
          }
        },
      };
    })().catch((err: unknown) => setError(String(err)));

    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    window.addEventListener("resize", resize);
    return () => {
      disposed = true;
      unsubscribe();
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      window.removeEventListener("resize", resize);
      bridge?.dispose();
      renderer?.destroy();
      delete window.__figtree;
    };
  }, []);

  useEffect(() => {
    const ctx = docRef.current;
    if (!ctx || !selected || !ctx.doc.has(selected)) {
      setInspect(null);
      return;
    }
    setInspect({ css: cssDeclarations(ctx.doc, selected), box: ctx.bridge.box(selected), unsupported: [...(ctx.bridge.unsupported.get(selected) ?? [])] });
  }, [selected, layers]);

  const fitView = useCallback(() => docRef.current?.fit(), []);

  return (
    <div className="flex h-dvh flex-col bg-neutral-100 text-neutral-900">
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-neutral-200 bg-white px-4">
        <span className="text-sm font-semibold tracking-tight">Fig Tree</span>
        <nav className="flex items-center gap-4 text-sm text-neutral-600">
          <button type="button" onClick={fitView} className="flex items-center gap-1 hover:text-neutral-900" title="Fit the page in view">
            <Maximize size={14} aria-hidden /> Fit
          </button>
          <a className="hover:text-neutral-900" href="/bench">
            Renderer benchmark
          </a>
        </nav>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="w-64 shrink-0 overflow-y-auto border-r border-neutral-200 bg-white py-2" aria-label="Layers">
          <h2 className="px-3 pb-1 text-xs font-medium text-neutral-500">Layers</h2>
          <ul className="text-[13px]" data-testid="layers">
            {layers.map((l) => {
              const Icon = ICONS[l.type];
              return (
                <li key={l.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(l.id)}
                    className={`flex w-full items-center gap-1.5 py-1 pr-2 text-left ${selected === l.id ? "bg-sky-100" : "hover:bg-neutral-100"} ${l.visible ? "" : "text-neutral-400"}`}
                    style={{ paddingLeft: 12 + l.depth * 14 }}
                    data-node={l.id}
                  >
                    <Icon size={13} className="shrink-0 text-neutral-500" aria-hidden />
                    <span className="truncate">{l.name}</span>
                    {l.unsupported.length > 0 && (
                      <span className="ml-auto shrink-0 text-amber-600" title={`Not rendered yet: ${l.unsupported.join(", ")}`}>
                        <TriangleAlert size={12} aria-label="has unsupported features" />
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          {total > layers.length && <p className="px-3 py-1 text-[12px] text-neutral-400">{(total - layers.length).toLocaleString()} more layers not listed</p>}
        </aside>
        <main className="relative min-w-0 flex-1">
          <canvas ref={canvasRef} className="block h-full w-full touch-none" data-testid="canvas" />
          {error && <p className="absolute left-3 top-3 rounded bg-red-50 px-2 py-1 text-xs text-red-700">{error}</p>}
        </main>
        <aside className="w-64 shrink-0 overflow-y-auto border-l border-neutral-200 bg-white p-3 text-[12px]" aria-label="Inspector">
          {inspect?.box && (
            <>
              <h2 className="pb-1 text-xs font-medium text-neutral-500">Layout</h2>
              <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-3 font-mono text-[11px] leading-5 text-neutral-700" data-testid="box">
                {boxRows(inspect.box).map(([k, v]) => (
                  <Fragment key={k}>
                    <dt className="text-neutral-400">{k}</dt>
                    <dd>{v}</dd>
                  </Fragment>
                ))}
              </dl>
            </>
          )}
          <h2 className="pb-1 text-xs font-medium text-neutral-500">CSS</h2>
          {inspect ? (
            <>
              <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-5 text-neutral-700" data-testid="css">
                {Object.entries(inspect.css)
                  .map(([k, v]) => `${k}: ${v};`)
                  .join("\n")}
              </pre>
              {inspect.unsupported.length > 0 && (
                <>
                  <h2 className="pb-1 pt-3 text-xs font-medium text-neutral-500">Not rendered yet</h2>
                  <ul className="list-inside list-disc text-neutral-600">
                    {inspect.unsupported.map((u) => (
                      <li key={u}>{u}</li>
                    ))}
                  </ul>
                </>
              )}
            </>
          ) : (
            <p className="text-neutral-400">Select a layer.</p>
          )}
        </aside>
      </div>
      <footer className="h-7 shrink-0 border-t border-neutral-200 bg-white px-4 font-mono text-[11px] leading-7 text-neutral-500" data-testid="status">
        {status}
      </footer>
    </div>
  );
}
