import { z } from "zod";
import { NODE_TYPES, PROPS, isContainer, type NodePropsOf, type NodeType } from "./nodes";
import { AssetId, NodeId, optionalShape } from "./primitives";
import { TextContent } from "./text";

/** Current `.figtree` format version. Bump it with a migration in `format/migrations.ts`. */
export const FORMAT_VERSION = 1;

export const ASSET_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"] as const;

/** Metadata of an asset stored under `assets/` in the zip; the bytes are content-addressed by `AssetId`. */
export const AssetMeta = z.strictObject({
  mimeType: z.enum(ASSET_MIME_TYPES),
  byteLength: z.number().int().min(0),
  /** Natural pixel size, when known. */
  width: z.number().int().min(0).optional(),
  height: z.number().int().min(0).optional(),
  /** Original file name, for display. */
  name: z.string().max(1_000).optional(),
}).meta({ id: "AssetMeta" });
export type AssetMeta = z.infer<typeof AssetMeta>;

export type LayerType = Exclude<NodeType, "page">;

/** A layer in `document.json`: its stored properties, plus children (containers) and text (text nodes). */
export type LayerJson = {
  [T in LayerType]: { id: string; type: T; children?: LayerJson[]; text?: TextContent } & NodePropsOf<T>;
}[LayerType];
export type PageJson = { id: string; type: "page"; children: LayerJson[] } & NodePropsOf<"page">;

const layerSchemas = NODE_TYPES.filter((t): t is LayerType => t !== "page").map((type) =>
  z
    .strictObject({
      id: NodeId,
      type: z.literal(type),
      ...optionalShape(PROPS[type]),
      ...(isContainer(type) ? { children: z.lazy(() => z.array(LayerJson)).optional() } : {}),
      ...(type === "text" ? { text: TextContent.optional() } : {}),
    })
    .meta({ id: `${type[0]!.toUpperCase()}${type.slice(1)}Node` }),
);

export const LayerJson: z.ZodType<LayerJson> = z.discriminatedUnion(
  "type",
  layerSchemas as unknown as [z.ZodObject<{ type: z.ZodLiteral<LayerType> }>, ...z.ZodObject<{ type: z.ZodLiteral<LayerType> }>[]],
).meta({ id: "Layer" }) as unknown as z.ZodType<LayerJson>;

export const PageJson: z.ZodType<PageJson> = z.strictObject({
  id: NodeId,
  type: z.literal("page"),
  ...optionalShape(PROPS.page),
  children: z.array(LayerJson),
}).meta({ id: "PageNode" }) as unknown as z.ZodType<PageJson>;

/** Contents of `document.json`. */
export const FigtreeFile = z
  .strictObject({
    format: z.literal("figtree"),
    version: z.literal(FORMAT_VERSION),
    name: z.string().max(1_000),
    pages: z.array(PageJson),
    assets: z.record(AssetId, AssetMeta),
  })
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    const walk = (node: PageJson | LayerJson, path: (string | number)[]): void => {
      if (seen.has(node.id)) ctx.addIssue({ code: "custom", path: [...path, "id"], message: `duplicate node id "${node.id}"` });
      seen.add(node.id);
      for (const ref of assetRefs(node)) {
        if (!(ref in file.assets)) ctx.addIssue({ code: "custom", path, message: `asset ${ref} is not listed in "assets"` });
      }
      node.children?.forEach((c, i) => walk(c, [...path, "children", i]));
    };
    file.pages.forEach((p, i) => walk(p, ["pages", i]));
  });
export type FigtreeFile = z.infer<typeof FigtreeFile>;

/** Asset ids referenced by a node's own properties (image nodes and image paints). */
export function assetRefs(props: Record<string, unknown>): string[] {
  const refs: string[] = [];
  if (typeof props.asset === "string") refs.push(props.asset);
  const scan = (paints: unknown): void => {
    if (!Array.isArray(paints)) return;
    for (const p of paints) {
      if (p && typeof p === "object" && (p as { type?: unknown }).type === "image") refs.push((p as { asset: string }).asset);
    }
  };
  scan(props.fills);
  scan(props.strokes);
  const net = props.vectorNetwork as { regions?: { fills?: unknown }[] } | undefined;
  net?.regions?.forEach((r) => scan(r.fills));
  const text = props.text as { runs?: { style: { fills?: unknown } }[] } | undefined;
  text?.runs?.forEach((r) => scan(r.style.fills));
  return refs;
}
