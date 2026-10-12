declare module "brotli/decompress" {
  /** Decompresses a Brotli stream; `outputSize` preallocates the result. */
  export default function decompress(data: Uint8Array, outputSize?: number): Uint8Array;
}

declare module "bidi-js" {
  export interface EmbeddingLevels {
    /** Resolved level per UTF-16 code unit. */
    readonly levels: Uint8Array;
    readonly paragraphs: readonly { readonly start: number; readonly end: number; readonly level: number }[];
  }
  export interface Bidi {
    getEmbeddingLevels(text: string, explicitDirection?: "ltr" | "rtl"): EmbeddingLevels;
    getReorderSegments(text: string, embeddingLevels: EmbeddingLevels, start?: number, end?: number): [number, number][];
    getMirroredCharactersMap(text: string, embeddingLevels: EmbeddingLevels, start?: number, end?: number): Map<number, string>;
    getMirroredCharacter(char: string): string | null;
    getBidiCharTypeName(char: string): string;
  }
  export default function bidiFactory(): Bidi;
}
