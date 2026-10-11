/** Hooks the editor test pages expose to Playwright. */
interface RenderTestResult {
  readonly backend: string;
  readonly width: number;
  readonly height: number;
  readonly pixels: string;
}

interface BenchHarness {
  readonly backend: string;
  readonly shapes: number;
  /** Starts recording frame times. */
  startRecording(): void;
  /** Stops recording and returns frame intervals (ms) and GPU-complete latencies (ms). */
  stopRecording(): { frameIntervals: number[]; cpuMs: number[]; uploadedBytes: number };
}

interface Window {
  __renderTest?: RenderTestResult | { error: string };
  __bench?: BenchHarness;
}
