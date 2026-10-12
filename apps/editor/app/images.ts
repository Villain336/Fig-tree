"use client";

import type { AssetMeta, ImageProvider } from "@fig-tree/document";
import type { RenderImage } from "@fig-tree/renderer";

/** Decoded images larger than this on a side are scaled down when decoded. */
const MAX_SIDE = 8192;
/** CPU memory for decoded images; the least recently drawn are decoded again when needed. */
const BUDGET_BYTES = 512 << 20;

/**
 * Decodes document image assets for the renderer with the browser's own
 * decoders: PNG, JPEG, WebP and GIF (first frame) through
 * `createImageBitmap`, SVG through an <img> rasterized at its natural size
 * (at most 2048 px a side). Pixels are read back unpremultiplied and
 * premultiplied here. Decoding is asynchronous: `get` returns null until
 * an image is ready, then `onLoad` listeners run (the bridge redraws).
 */
export class BrowserImages implements ImageProvider {
  private readonly ready = new Map<string, RenderImage>();
  private readonly pending = new Set<string>();
  private readonly failed = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private bytes = 0;

  constructor(
    private readonly bytesOf: (asset: string) => Uint8Array | undefined,
    private readonly metaOf: (asset: string) => AssetMeta | undefined,
  ) {}

  get(asset: string): RenderImage | null {
    const img = this.ready.get(asset);
    if (img) {
      // Most recently used last.
      this.ready.delete(asset);
      this.ready.set(asset, img);
      return img;
    }
    if (!this.pending.has(asset) && !this.failed.has(asset)) this.decode(asset);
    return null;
  }

  onLoad(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves when every requested image has decoded (or failed). */
  async settled(): Promise<void> {
    while (this.pending.size > 0) await new Promise((r) => setTimeout(r, 10));
  }

  private decode(asset: string): void {
    const bytes = this.bytesOf(asset);
    if (!bytes) {
      this.failed.add(asset);
      return;
    }
    this.pending.add(asset);
    decodeImage(bytes, this.metaOf(asset)?.mimeType ?? "image/png", asset)
      .then((img) => {
        this.ready.set(asset, img);
        this.bytes += img.data.byteLength;
        while (this.bytes > BUDGET_BYTES && this.ready.size > 1) {
          const [oldest, old] = this.ready.entries().next().value as [string, RenderImage];
          this.ready.delete(oldest);
          this.bytes -= old.data.byteLength;
        }
      })
      .catch((err: unknown) => {
        console.warn(`fig-tree: could not decode image ${asset.slice(0, 8)}: ${String(err)}`);
        this.failed.add(asset);
      })
      .finally(() => {
        this.pending.delete(asset);
        for (const l of this.listeners) l();
      });
  }
}

export async function decodeImage(bytes: Uint8Array, mimeType: string, key: string): Promise<RenderImage> {
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeType });
  let source: CanvasImageSource;
  let width: number;
  let height: number;
  if (mimeType === "image/svg+xml") {
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const scale = Math.min(1, 2048 / Math.max(img.naturalWidth || 300, img.naturalHeight || 150));
      width = Math.max(1, Math.round((img.naturalWidth || 300) * scale));
      height = Math.max(1, Math.round((img.naturalHeight || 150) * scale));
      source = img;
    } finally {
      URL.revokeObjectURL(url);
    }
  } else {
    const probe = await createImageBitmap(blob);
    const scale = Math.min(1, MAX_SIDE / Math.max(probe.width, probe.height));
    width = Math.max(1, Math.round(probe.width * scale));
    height = Math.max(1, Math.round(probe.height * scale));
    probe.close();
    source = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none", ...(scale < 1 ? { resizeWidth: width, resizeHeight: height, resizeQuality: "high" as const } : {}) });
  }
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { colorSpace: "srgb" })!;
  ctx.drawImage(source, 0, 0, width, height);
  if ("close" in source && typeof source.close === "function") source.close();
  const pixels = ctx.getImageData(0, 0, width, height).data;
  const data = new Uint8Array(pixels.length);
  for (let i = 0; i < pixels.length; i += 4) {
    const a = pixels[i + 3]!;
    data[i] = Math.round((pixels[i]! * a) / 255);
    data[i + 1] = Math.round((pixels[i + 1]! * a) / 255);
    data[i + 2] = Math.round((pixels[i + 2]! * a) / 255);
    data[i + 3] = a;
  }
  return { key, width, height, data };
}
