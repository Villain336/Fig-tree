import { pathToNetwork, type VectorNetwork } from "@fig-tree/geometry";
import type { SceneBridge } from "./bridge";

/**
 * A text node's outlines as a vector network in its local space (one
 * region, nonzero, every glyph contour a loop), for flattening text: the
 * glyphs come from the bridge's text layout, so this needs its fonts. Null
 * when the text is not laid out.
 */
export function textToVectorNetwork(bridge: SceneBridge, id: string): VectorNetwork | null {
  const path = bridge.textOutlinePath(id);
  return path ? pathToNetwork(path, { mergeDistance: -1 }) : null;
}
