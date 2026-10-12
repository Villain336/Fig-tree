import { Typeface, typefaceDescriptor, type FontRegistry } from "@fig-tree/text";
import type { FigDocument } from "../document";
import type { AssetStore } from "../format/assets";
import { sniffFont } from "../format/assets";
import type { Command } from "../commands";
import type { FontAssetDescriptor } from "../schema";

/**
 * Fonts uploaded into a document: font files become content-addressed
 * assets of the `.figtree` file (like images), described by the
 * `@font-face` descriptor read from the font's own tables, and every font
 * asset is a face of the document's font registry, so text naming its
 * family uses it.
 */

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** The `@font-face` descriptor of a font file (TTF, OTF, WOFF or WOFF2), from its name, OS/2 and fvar tables. Needs HarfBuzz loaded. */
export function fontAssetDescriptor(bytes: Uint8Array): FontAssetDescriptor {
  if (!sniffFont(bytes)) throw new Error("not a font file: expected TTF, OTF, WOFF or WOFF2");
  const d = typefaceDescriptor(new Typeface(bytes));
  const weight = (v: number): number => clamp(Math.round(v), 1, 1000);
  const stretch = (v: number): number => clamp(v, 50, 200);
  return {
    family: d.family.slice(0, 256) || "Untitled font",
    weight: typeof d.weight === "number" ? weight(d.weight) : [weight(d.weight[0]), weight(d.weight[1])],
    style: d.style,
    stretch: typeof d.stretch === "number" ? stretch(d.stretch) : [stretch(d.stretch[0]), stretch(d.stretch[1])],
  };
}

/**
 * Stores an uploaded font in `assets` and returns the command that adds it
 * to the document (apply it like any other command, so it syncs and undoes).
 */
export async function uploadFont(assets: AssetStore, bytes: Uint8Array, name?: string): Promise<{ id: string; descriptor: FontAssetDescriptor; command: Command }> {
  const descriptor = fontAssetDescriptor(bytes);
  const { id, meta } = await assets.add(bytes, name, descriptor);
  return { id, descriptor, command: { type: "addAsset", id, meta } };
}

/**
 * Registers the document's font assets with `registry` (each loads from
 * `assets` on first use) and keeps registering fonts added later, by this
 * client or a collaborator. Returns a function that stops watching.
 */
export function registerDocumentFonts(doc: FigDocument, assets: AssetStore, registry: FontRegistry): () => void {
  const registered = new Set<string>();
  const sync = (): void => {
    for (const [id, meta] of doc.assets()) {
      if (!meta.font || registered.has(id)) continue;
      registered.add(id);
      registry.add(meta.font, async () => {
        const bytes = assets.get(id);
        if (!bytes) throw new Error(`font asset ${id} has no bytes in the asset store`);
        return bytes;
      });
    }
  };
  sync();
  return doc.onChange((change) => {
    if (change.assets) sync();
  });
}
