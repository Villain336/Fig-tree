export * from "./schema";
export { FigDocument, REMOTE, type Actor, type DocumentChange, type DocumentOptions, type TreeDelta } from "./document";
export {
  Command,
  CommandError,
  applyCommands,
  type ApplyOptions,
  type ApplyResult,
  type CommandResult,
  type CommandType,
  type TypedCommand,
} from "./commands";
export { Tree, type Placement, type Repair } from "./tree";
export { keyBetween, keysBetween, spacedKeys, isOrderKey, compareOrder, type Random } from "./order";
export { newId, seededRandom, cryptoRandom } from "./ids";
export { canonicalJson, jsonEqual } from "./json";
export { boxMatrix, boxFromMatrix, type BoxTransform } from "./transform";
export {
  Proposal,
  diffDocuments,
  isEmptyDiff,
  propose,
  type DocumentDiff,
  type Location,
  type PropertyChange,
  type ProposalStatus,
} from "./proposal";
export { fromFigtreeJson, parseFigtreeJson, serializeFigtreeJson, toFigtreeJson, type ImportOptions } from "./format/json";
export { FormatError, MIGRATIONS, migrate, type Migration } from "./format/migrations";
export { AssetStore, sha256Hex, sniffImage } from "./format/assets";
export { decodeHistory, encodeHistory } from "./format/history";
export { DEFAULT_LIMITS, readFigtree, writeFigtree, type FigtreeArchive, type ReadLimits, type ReadOptions, type WriteOptions } from "./format/zip";
export { figtreeJsonSchema } from "./format/json-schema";
export { SceneBridge } from "./bridge/bridge";
export { fontAssetDescriptor, registerDocumentFonts, uploadFont } from "./bridge/fonts";
export { DocumentLayout, type ComputedBox } from "./bridge/layout";
export { cssDeclarations } from "./css";
export { VectorOp, applyVectorOps } from "./vector-commands";
export {
  booleanContours,
  booleanPath,
  isBooleanGroup,
  nodeFillShapes,
  nodeNetwork,
  storedBox,
  type GeometryOptions,
  type GeometrySource,
} from "./vector-geometry";
export { textToVectorNetwork } from "./bridge/vector";
