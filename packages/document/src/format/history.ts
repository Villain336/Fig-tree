import { FigDocument, type DocumentOptions } from "../document";
import { FormatError } from "./migrations";

/**
 * Binary history snapshot: the full Yjs update (v2 encoding) behind a small
 * header. Unlike `document.json`, it keeps the CRDT history, so a loaded
 * snapshot can keep syncing with replicas of the same document.
 */
const MAGIC = [0x46, 0x54, 0x59, 0x48]; // "FTYH"
export const HISTORY_VERSION = 1;

export function encodeHistory(doc: FigDocument): Uint8Array {
  const update = doc.encodeState();
  const out = new Uint8Array(MAGIC.length + 1 + update.length);
  out.set(MAGIC, 0);
  out[MAGIC.length] = HISTORY_VERSION;
  out.set(update, MAGIC.length + 1);
  return out;
}

export function decodeHistory(bytes: Uint8Array, options: DocumentOptions = {}): FigDocument {
  if (bytes.length < MAGIC.length + 1 || MAGIC.some((b, i) => bytes[i] !== b)) throw new FormatError("not a Fig Tree history snapshot");
  const version = bytes[MAGIC.length]!;
  if (version !== HISTORY_VERSION) throw new FormatError(`unsupported history snapshot version ${version}`);
  return FigDocument.fromUpdate(bytes.subarray(MAGIC.length + 1), options);
}
