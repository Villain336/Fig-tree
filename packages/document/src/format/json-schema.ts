import { z } from "zod";
import { FORMAT_VERSION, FigtreeFile } from "../schema";

/**
 * JSON Schema (draft 2020-12) of `document.json`, generated from the zod
 * schemas. Published at `docs/format/figtree.schema.json`; a test fails when
 * the committed file is stale (`UPDATE_SCHEMA=1 npm test` rewrites it).
 *
 * Cross-node rules that JSON Schema cannot express (unique ids, assets that
 * exist, closed vector-network loops, ordered text runs) are enforced by the
 * zod schemas only; they are listed in the schema's description.
 */
export function figtreeJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(FigtreeFile, { target: "draft-2020-12", unrepresentable: "throw" }) as Record<string, unknown>;
  return {
    $schema: generated.$schema,
    $id: `urn:fig-tree:format:document:${FORMAT_VERSION}`,
    title: "Fig Tree document (document.json)",
    description:
      "The document.json entry of a .figtree archive, format version " +
      FORMAT_VERSION +
      ". Additional rules checked by Fig Tree but not expressible here: node ids are unique; every asset a node references is listed in `assets`; vector network segments reference existing vertices and region loops close; text runs are sorted, non-overlapping and inside the content.",
    ...Object.fromEntries(Object.entries(generated).filter(([k]) => k !== "$schema")),
  };
}
