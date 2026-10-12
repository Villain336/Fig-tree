/**
 * Loads HarfBuzz (harfbuzzjs, a WebAssembly build of HarfBuzz) once. The
 * module instantiates its wasm with top-level await, so it is imported
 * dynamically: call {@link loadHarfBuzz} before shaping or loading fonts.
 */
export type HarfBuzz = typeof import("harfbuzzjs");

let module: HarfBuzz | null = null;
let loading: Promise<HarfBuzz> | null = null;

export function loadHarfBuzz(): Promise<HarfBuzz> {
  loading ??= import("harfbuzzjs").then((m) => (module = m));
  return loading;
}

/** The loaded HarfBuzz module; throws when {@link loadHarfBuzz} has not resolved yet. */
export function harfbuzz(): HarfBuzz {
  if (!module) throw new Error("fig-tree text: HarfBuzz is not loaded yet (await loadHarfBuzz())");
  return module;
}

export function harfbuzzLoaded(): boolean {
  return module !== null;
}
