import type { Mat2D, Point } from "@fig-tree/geometry";
import { clamp, type Box } from "./math";

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 256;

/** Zoom steps used by zoom in / zoom out (as fractions, 1 = 100%). */
export const ZOOM_STEPS = [0.02, 0.03, 0.05, 0.0625, 0.1, 0.125, 0.25, 0.333, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 128, 256];

/**
 * The view onto the canvas: a uniform scale and a translation, mapping world
 * (page) coordinates to canvas CSS pixels: `screen = world · scale + offset`.
 */
export class Viewport {
  scale = 1;
  x = 0;
  y = 0;
  /** Canvas size in CSS pixels. */
  width = 800;
  height = 600;
  /** Bumped on every change. */
  version = 0;

  get matrix(): Mat2D {
    return [this.scale, 0, 0, this.scale, this.x, this.y];
  }

  set(scale: number, x: number, y: number): void {
    const s = clamp(scale, MIN_ZOOM, MAX_ZOOM);
    if (s === this.scale && x === this.x && y === this.y) return;
    this.scale = s;
    this.x = x;
    this.y = y;
    this.version++;
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.version++;
  }

  toScreen(p: Point): Point {
    return { x: p.x * this.scale + this.x, y: p.y * this.scale + this.y };
  }

  toWorld(p: Point): Point {
    return { x: (p.x - this.x) / this.scale, y: (p.y - this.y) / this.scale };
  }

  /** The visible world rectangle. */
  get visibleWorld(): Box {
    return { x: -this.x / this.scale, y: -this.y / this.scale, width: this.width / this.scale, height: this.height / this.scale };
  }

  panBy(dx: number, dy: number): void {
    this.set(this.scale, this.x + dx, this.y + dy);
  }

  /** Zooms to `scale`, keeping the world point under screen point `at` fixed. */
  zoomAt(scale: number, at: Point): void {
    const s = clamp(scale, MIN_ZOOM, MAX_ZOOM);
    const w = this.toWorld(at);
    this.set(s, at.x - w.x * s, at.y - w.y * s);
  }

  /** Multiplies the zoom by `factor` about a screen point (pinch and ctrl-wheel). */
  zoomBy(factor: number, at: Point): void {
    this.zoomAt(this.scale * factor, at);
  }

  /** Next zoom step in or out, about the canvas center or a screen point. */
  zoomStep(direction: 1 | -1, at: Point = { x: this.width / 2, y: this.height / 2 }): void {
    const s = this.scale;
    const next = direction > 0 ? ZOOM_STEPS.find((z) => z > s * 1.001) : [...ZOOM_STEPS].reverse().find((z) => z < s / 1.001);
    this.zoomAt(next ?? s, at);
  }

  /** Fits a world box into the canvas with a margin (CSS px), never zooming past `maxScale`. */
  fit(box: Box, margin = 48, maxScale = 1): void {
    const w = Math.max(box.width, 1);
    const h = Math.max(box.height, 1);
    const s = clamp(Math.min((this.width - margin * 2) / w, (this.height - margin * 2) / h, maxScale), MIN_ZOOM, MAX_ZOOM);
    this.set(s, Math.round(this.width / 2 - (box.x + box.width / 2) * s), Math.round(this.height / 2 - (box.y + box.height / 2) * s));
  }

  /** Centers a world point at the current zoom. */
  centerOn(p: Point): void {
    this.set(this.scale, Math.round(this.width / 2 - p.x * this.scale), Math.round(this.height / 2 - p.y * this.scale));
  }

  /** Zoom to 100% keeping the canvas center fixed. */
  actualSize(): void {
    this.zoomAt(1, { x: this.width / 2, y: this.height / 2 });
  }
}
