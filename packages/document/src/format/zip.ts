import { unzipSync, zipSync, type Zippable } from "fflate";
import type { FigDocument } from "../document";
import type { AssetMeta } from "../schema";
import { AssetStore, EXTENSIONS, sha256Hex } from "./assets";
import { decodeHistory, encodeHistory } from "./history";
import { fromFigtreeJson, serializeFigtreeJson, toFigtreeJson, type ImportOptions } from "./json";
import { FormatError } from "./migrations";

/**
 * `.figtree` files are zip archives:
 *
 *     document.json          canonical JSON (see json.ts), validated by docs/format/figtree.schema.json
 *     assets/<sha256>.<ext>  asset bytes, named by content hash
 *     history.yjs            optional binary history snapshot (see history.ts)
 *
 * Writing is deterministic: entries are sorted, timestamps fixed, so equal
 * documents produce identical bytes. Readers ignore unknown entries.
 */

export const DOCUMENT_ENTRY = "document.json";
export const HISTORY_ENTRY = "history.yjs";

/** Fixed DOS timestamp, built in local time so the encoded fields match in every time zone. */
const EPOCH = new Date(1980, 0, 1, 0, 0, 0);
const STORED: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export interface WriteOptions {
  /** Include the binary Yjs history snapshot. Default false. */
  readonly includeHistory?: boolean;
}

export function writeFigtree(doc: FigDocument, assets: AssetStore, options: WriteOptions = {}): Uint8Array {
  const files: Zippable = {};
  const add = (name: string, data: Uint8Array, level: 0 | 6): void => {
    files[name] = [data, { level, mtime: EPOCH }];
  };
  const json = toFigtreeJson(doc);
  const entries: [string, Uint8Array, 0 | 6][] = [[DOCUMENT_ENTRY, new TextEncoder().encode(serializeFigtreeJson(json)), 6]];
  for (const [id, meta] of Object.entries(json.assets)) {
    const bytes = assets.get(id);
    if (!bytes) throw new FormatError(`asset ${id} is referenced by the document but missing from the asset store`);
    entries.push([assetPath(id, meta), bytes, STORED.has(meta.mimeType) ? 0 : 6]);
  }
  if (options.includeHistory) entries.push([HISTORY_ENTRY, encodeHistory(doc), 6]);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [name, data, level] of entries) add(name, data, level);
  return zipSync(files);
}

export function assetPath(id: string, meta: AssetMeta): string {
  return `assets/${id}.${EXTENSIONS[meta.mimeType]}`;
}

export interface ReadLimits {
  /** Maximum number of zip entries. */
  readonly maxEntries: number;
  /** Maximum uncompressed size of one entry, in bytes. */
  readonly maxEntryBytes: number;
  /** Maximum total uncompressed size, in bytes. */
  readonly maxTotalBytes: number;
}

export const DEFAULT_LIMITS: ReadLimits = { maxEntries: 100_000, maxEntryBytes: 512 * 2 ** 20, maxTotalBytes: 2 * 2 ** 30 };

export interface ReadOptions extends ImportOptions {
  /** Load the document from `history.yjs` (keeping CRDT history) instead of `document.json`, when present. */
  readonly useHistory?: boolean;
  readonly limits?: Partial<ReadLimits>;
}

export interface FigtreeArchive {
  readonly doc: FigDocument;
  readonly assets: AssetStore;
}

/**
 * Reads a `.figtree` archive. Declared entry sizes are checked against
 * limits before anything is inflated (zip bomb guard), every asset is
 * verified against its content hash, and `document.json` is migrated and
 * validated.
 */
export async function readFigtree(bytes: Uint8Array, options: ReadOptions = {}): Promise<FigtreeArchive> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  let count = 0;
  let total = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        if (++count > limits.maxEntries) throw new FormatError(`archive has more than ${limits.maxEntries} entries`);
        if (f.originalSize > limits.maxEntryBytes) throw new FormatError(`entry ${f.name} is too large (${f.originalSize} bytes)`);
        total += f.originalSize;
        if (total > limits.maxTotalBytes) throw new FormatError(`archive expands to more than ${limits.maxTotalBytes} bytes`);
        return f.name === DOCUMENT_ENTRY || f.name === HISTORY_ENTRY || f.name.startsWith("assets/");
      },
    });
  } catch (e) {
    if (e instanceof FormatError) throw e;
    throw new FormatError(`not a valid .figtree archive: ${(e as Error).message}`);
  }
  const json = files[DOCUMENT_ENTRY];
  if (!json) throw new FormatError(`archive has no ${DOCUMENT_ENTRY}`);
  const fromJson = fromFigtreeJson(new TextDecoder("utf-8", { fatal: true }).decode(json), options);
  let doc = fromJson;
  if (options.useHistory && files[HISTORY_ENTRY]) {
    doc = decodeHistory(files[HISTORY_ENTRY], options);
    if (serializeFigtreeJson(toFigtreeJson(doc)) !== serializeFigtreeJson(toFigtreeJson(fromJson))) {
      throw new FormatError(`${HISTORY_ENTRY} does not match ${DOCUMENT_ENTRY}`);
    }
    fromJson.destroy();
  }
  const assets = new AssetStore();
  for (const [id, meta] of doc.assets()) {
    const path = assetPath(id, meta);
    const data = files[path];
    if (!data) throw new FormatError(`archive is missing ${path}`);
    if (data.length !== meta.byteLength) throw new FormatError(`${path} has ${data.length} bytes, document.json says ${meta.byteLength}`);
    if ((await sha256Hex(data)) !== id) throw new FormatError(`${path} does not match its content hash`);
    assets.put(id, data);
  }
  return { doc, assets };
}
