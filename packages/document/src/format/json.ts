import * as Y from "yjs";
import { FigDocument, type DocumentOptions } from "../document";
import { canonicalJson, frozenCopy } from "../json";
import { spacedKeys } from "../order";
import { FORMAT_VERSION, FigtreeFile, ROOT_ID, isContainer, type LayerJson, type PageJson, type TextContent } from "../schema";
import { contentToSpans, writeSpans } from "../text";
import { FormatError, migrate, type Migration } from "./migrations";

/**
 * `document.json`: the effective tree as nested JSON. Nodes list only their
 * stored properties (unset ones take schema defaults), containers list
 * their children in paint order, and text nodes carry content plus runs.
 * Order keys, clocks and Yjs history are not part of it.
 */
export function toFigtreeJson(doc: FigDocument): FigtreeFile {
  const tree = doc.tree;
  const node = (id: string): PageJson | LayerJson => {
    const type = doc.typeOf(id)!;
    const out: Record<string, unknown> = { id, type, ...doc.storedProps(id) };
    if (type === "page" || isContainer(type)) {
      const children = tree.childrenOf(id).map((c) => node(c) as LayerJson);
      if (type === "page" || children.length > 0) out.children = children;
    }
    if (type === "text") out.text = doc.text(id);
    return out as PageJson | LayerJson;
  };
  return {
    format: "figtree",
    version: FORMAT_VERSION,
    name: doc.name,
    pages: tree.pages.map((p) => node(p) as PageJson),
    assets: Object.fromEntries([...doc.assets()].sort(([a], [b]) => (a < b ? -1 : 1))),
  };
}

/** Canonical bytes of `document.json`: sorted keys, two-space indent, trailing newline. */
export function serializeFigtreeJson(file: FigtreeFile): string {
  return canonicalJson(file, true) + "\n";
}

export interface ImportOptions extends DocumentOptions {
  /** Migrations to apply (defaults to the built-in list). */
  readonly migrations?: readonly Migration[];
}

/** Validates (after migrating) a `document.json` value. Throws {@link FormatError} with every issue. */
export function parseFigtreeJson(json: unknown, migrations?: readonly Migration[]): FigtreeFile {
  const migrated = migrate(json, migrations);
  const r = FigtreeFile.safeParse(migrated);
  if (!r.success) {
    throw new FormatError(
      "invalid document.json",
      r.error.issues.slice(0, 50).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  return r.data;
}

/** Builds a new document from `document.json` (as text or parsed JSON). */
export function fromFigtreeJson(input: string | unknown, options: ImportOptions = {}): FigDocument {
  let json: unknown = input;
  if (typeof input === "string") {
    try {
      json = JSON.parse(input);
    } catch (e) {
      throw new FormatError(`document.json is not valid JSON: ${(e as Error).message}`);
    }
  }
  const file = parseFigtreeJson(json, options.migrations);
  const doc = FigDocument.empty(options);
  const origin = doc.actor("import", "system");
  doc.transact(() => {
    doc.meta.set("name", file.name);
    for (const [id, meta] of Object.entries(file.assets)) doc.assetsMap.set(id, frozenCopy(meta));
    const add = (n: PageJson | LayerJson, parent: string, key: string): void => {
      const { id, type, children, text, ...props } = n as Record<string, unknown> & { id: string; type: string; children?: LayerJson[]; text?: TextContent };
      const map = new Y.Map<unknown>();
      map.set("type", type);
      map.set("placement", { parent, key, clock: 0 });
      for (const [k, v] of Object.entries(props)) if (v !== undefined) map.set(k, frozenCopy(v));
      if (type === "text") map.set("content", new Y.Text());
      doc.nodes.set(id, map);
      if (type === "text" && text) writeSpans(map.get("content") as Y.Text, contentToSpans(text));
      const kids = children ?? [];
      const keys = spacedKeys(kids.length);
      kids.forEach((c, i) => add(c, id, keys[i]!));
    };
    const pageKeys = spacedKeys(file.pages.length);
    file.pages.forEach((p, i) => add(p, ROOT_ID, pageKeys[i]!));
  }, origin);
  return doc;
}
