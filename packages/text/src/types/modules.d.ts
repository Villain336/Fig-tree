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
    /** The closing bracket of an opening paired bracket (Bidi_Paired_Bracket_Type=Open), else null. */
    openingToClosingBracket(char: string): string | null;
    /** The opening bracket of a closing paired bracket, else null. */
    closingToOpeningBracket(char: string): string | null;
    /** The canonical equivalent of a bracket with a decomposition (U+2329 → U+3008), else null. */
    getCanonicalBracket(char: string): string | null;
  }
  export default function bidiFactory(): Bidi;
}
