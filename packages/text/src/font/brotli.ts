/// <reference path="../types/modules.d.ts" />
import decompress from "brotli/decompress";

/** Brotli decompression (RFC 7932) for WOFF2, through the `brotli` package's JavaScript decoder. */
export function BrotliDecompressBuffer(data: Uint8Array, outputSize?: number): Uint8Array {
  return decompress(data, outputSize);
}
