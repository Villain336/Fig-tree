import type { AssetMeta } from "../schema";

/**
 * Asset bytes live outside the CRDT (the document only stores metadata
 * keyed by content hash), in an AssetStore owned by the app and written to
 * `assets/` in `.figtree` files.
 */
export class AssetStore {
  private readonly bytes = new Map<string, Uint8Array>();

  has(id: string): boolean {
    return this.bytes.has(id);
  }

  get(id: string): Uint8Array | undefined {
    return this.bytes.get(id);
  }

  ids(): string[] {
    return [...this.bytes.keys()].sort();
  }

  /** Stores bytes under their SHA-256 and returns the id with sniffed metadata. */
  async add(bytes: Uint8Array, name?: string): Promise<{ id: string; meta: AssetMeta }> {
    const sniffed = sniffImage(bytes);
    if (!sniffed) throw new Error("unsupported asset: expected a PNG, JPEG, GIF, WebP or SVG image");
    const id = await sha256Hex(bytes);
    this.bytes.set(id, bytes);
    const meta: AssetMeta = {
      mimeType: sniffed.mimeType,
      byteLength: bytes.length,
      ...(sniffed.width !== undefined ? { width: sniffed.width } : {}),
      ...(sniffed.height !== undefined ? { height: sniffed.height } : {}),
      ...(name !== undefined ? { name } : {}),
    };
    return { id, meta };
  }

  /** @internal Stores bytes already verified against `id`. */
  put(id: string, bytes: Uint8Array): void {
    this.bytes.set(id, bytes);
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export const EXTENSIONS: Record<AssetMeta["mimeType"], string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

const ascii = (bytes: Uint8Array, at: number, text: string): boolean => [...text].every((c, i) => bytes[at + i] === c.charCodeAt(0));

/** Detects the image type from magic bytes and reads the pixel size where the header gives it. */
export function sniffImage(bytes: Uint8Array): { mimeType: AssetMeta["mimeType"]; width?: number; height?: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && bytes[0] === 0x89 && ascii(bytes, 1, "PNG\r\n\x1a\n") && ascii(bytes, 12, "IHDR")) {
    return { mimeType: "image/png", width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length >= 10 && (ascii(bytes, 0, "GIF87a") || ascii(bytes, 0, "GIF89a"))) {
    return { mimeType: "image/gif", width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    // Walk JPEG segments to the first start-of-frame marker.
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) break;
      const marker = bytes[i + 1]!;
      const length = view.getUint16(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mimeType: "image/jpeg", height: view.getUint16(i + 5), width: view.getUint16(i + 7) };
      }
      i += 2 + length;
    }
    return { mimeType: "image/jpeg" };
  }
  if (bytes.length >= 30 && ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) {
    if (ascii(bytes, 12, "VP8X")) {
      const w = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
      const h = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
      return { mimeType: "image/webp", width: w, height: h };
    }
    if (ascii(bytes, 12, "VP8L")) {
      const b = view.getUint32(21, true);
      return { mimeType: "image/webp", width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (ascii(bytes, 12, "VP8 ")) return { mimeType: "image/webp", width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    return { mimeType: "image/webp" };
  }
  const head = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return { mimeType: "image/svg+xml" };
  return null;
}
