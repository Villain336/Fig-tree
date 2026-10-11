import { expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PNG } from "pngjs";

export type BackendName = "webgpu" | "webgl2";
export const backends: BackendName[] = ["webgpu", "webgl2"];

export interface Image {
  readonly width: number;
  readonly height: number;
  /** RGBA8, rows top to bottom. */
  readonly data: Uint8Array;
}

/** Renders a scene from apps/editor/app/render-test/scenes.ts and returns its pixels. */
export async function renderScene(page: Page, scene: string, backend: BackendName): Promise<Image> {
  await page.goto(`/render-test?scene=${scene}&renderer=${backend}`);
  await page.waitForFunction(() => window.__renderTest !== undefined, null, { timeout: 90_000 });
  const result = await page.evaluate(() => window.__renderTest!);
  if ("error" in result) throw new Error(result.error);
  expect(result.backend).toBe(backend);
  return { width: result.width, height: result.height, data: new Uint8Array(Buffer.from(result.pixels, "base64")) };
}

export function pixel(img: Image, x: number, y: number): [number, number, number, number] {
  const i = (y * img.width + x) * 4;
  return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!, img.data[i + 3]!];
}

/** Coverage of a black shape on white, recovered from the red channel. */
export function coverageAt(img: Image, x: number, y: number): number {
  return 1 - pixel(img, x, y)[0] / 255;
}

export function writePng(path: string, img: Image): void {
  mkdirSync(dirname(path), { recursive: true });
  const png = new PNG({ width: img.width, height: img.height });
  Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength).copy(png.data);
  writeFileSync(path, PNG.sync.write(png));
}

export function readPng(path: string): Image {
  const png = PNG.sync.read(readFileSync(path));
  return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
}

export interface Diff {
  readonly maxDelta: number;
  readonly meanDelta: number;
  /** Fraction of pixels with any channel differing by more than `threshold`. */
  readonly fractionOver: number;
}

export function diff(a: Image, b: Image, threshold: number): Diff {
  expect([a.width, a.height]).toEqual([b.width, b.height]);
  let max = 0;
  let sum = 0;
  let over = 0;
  for (let p = 0; p < a.width * a.height; p++) {
    let worst = 0;
    for (let c = 0; c < 4; c++) worst = Math.max(worst, Math.abs(a.data[p * 4 + c]! - b.data[p * 4 + c]!));
    max = Math.max(max, worst);
    sum += worst;
    if (worst > threshold) over++;
  }
  const n = a.width * a.height;
  return { maxDelta: max, meanDelta: sum / n, fractionOver: over / n };
}

const goldenDir = join(__dirname, "goldens");

/**
 * Compares against e2e/goldens/<name>.png, or writes it when UPDATE_GOLDENS=1
 * (or when it is missing outside CI). GPUs differ in the last bits of float math, so the
 * comparison allows tiny per-channel deltas on a small fraction of pixels.
 */
export function expectGolden(name: string, img: Image): void {
  const path = join(goldenDir, `${name}.png`);
  if (process.env.UPDATE_GOLDENS === "1" || (!existsSync(path) && !process.env.CI)) {
    writePng(path, img);
    return;
  }
  const d = diff(img, readPng(path), 3);
  expect(d.fractionOver, `${name}: pixels differing by more than 3/255`).toBeLessThan(0.002);
  expect(d.maxDelta, `${name}: worst pixel delta`).toBeLessThan(96);
}
