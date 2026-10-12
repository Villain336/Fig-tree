/** Hooks the editor test pages expose to Playwright. */
interface RenderTestResult {
  readonly backend: string;
  readonly mode: string;
  readonly width: number;
  readonly height: number;
  readonly pixels: string;
}

interface BenchHarness {
  readonly backend: string;
  readonly shapes: number;
  /** Fits the whole scene in view again. */
  resetView(): void;
  /** Starts recording frame times. */
  startRecording(): void;
  /** Stops recording and returns frame intervals and per-frame CPU time (ms) plus bytes uploaded. */
  stopRecording(): { frameIntervals: number[]; cpuMs: number[]; uploadedBytes: number };
}

interface EditorHarness {
  readonly backend: string;
  readonly doc: { readonly tree: { readonly size: number } };
  readonly bridge: { readonly lastCompiled: number };
  apply(commands: unknown[]): { affected: readonly string[] } | { error: string };
  renderPixels(): Promise<RenderTestResult>;
  toCanvas(x: number, y: number): { x: number; y: number };
  renderFrame(): { cpuMs: number };
  finish(): Promise<void>;
  setView(scale: number, x: number, y: number): void;
  box(id: string): { x: number; y: number; width: number; height: number } | null;
}

interface Window {
  __renderTest?: RenderTestResult | { error: string };
  __bench?: BenchHarness;
  __figtree?: EditorHarness;
}
