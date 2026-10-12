import Ajv2020 from "ajv/dist/2020";
import fc from "fast-check";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  AssetStore,
  CommandError,
  FigDocument,
  FigtreeFile,
  FORMAT_VERSION,
  FormatError,
  MIGRATIONS,
  NODE_TYPES,
  ROOT_ID,
  decodeHistory,
  encodeHistory,
  figtreeJsonSchema,
  fromFigtreeJson,
  isContainer,
  migrate,
  readFigtree,
  seededRandom,
  serializeFigtreeJson,
  sniffImage,
  toFigtreeJson,
  writeFigtree,
  type Command,
  type NodeType,
  type TextContent,
} from "../src";
import { FUZZ_ASSET_BYTES, propsArb, textContent } from "./arbitraries";
import { randomCommand } from "./convergence-harness";

const SCHEMA_PATH = join(__dirname, "../../../docs/format/figtree.schema.json");
const LAYER_TYPES = NODE_TYPES.filter((t) => t !== "page") as Exclude<NodeType, "page">[];

// Fail fast: with allErrors, oneOf would fully validate every node-type branch, recursively.
const ajv = new Ajv2020({ strict: false });
const validate = ajv.compile(figtreeJsonSchema());

function json(doc: FigDocument): string {
  return serializeFigtreeJson(toFigtreeJson(doc));
}

function assetStore(): AssetStore {
  const store = new AssetStore();
  for (const [id, b64] of Object.entries(FUZZ_ASSET_BYTES)) store.put(id, new Uint8Array(Buffer.from(b64, "base64")));
  return store;
}

interface NodeSpec {
  type: Exclude<NodeType, "page">;
  parent: number;
  props: Record<string, unknown>;
  text: TextContent;
}

/** A random document: 1-3 pages and up to 25 nodes of every type with random property subsets. */
const documentSpec = fc
  .tuple(fc.integer({ min: 1, max: 3 }), fc.array(fc.constantFrom(...LAYER_TYPES), { maxLength: 25 }), fc.string({ maxLength: 12 }))
  .chain(([pages, types, name]) =>
    fc.tuple(
      fc.constant(pages),
      fc.constant(name),
      fc.tuple(...types.map((type) => fc.record({ type: fc.constant(type), parent: fc.nat(), props: propsArb(type), text: textContent }))) as fc.Arbitrary<NodeSpec[]>,
    ),
  );

function buildDocument([pages, name, nodes]: [number, string, NodeSpec[]], seed = 1): FigDocument {
  const doc = FigDocument.create({ random: seededRandom(seed), clientId: 1 });
  const user = doc.actor("fuzz");
  const commands: Command[] = [{ type: "setDocumentName", name }];
  for (const [id, b64] of Object.entries(FUZZ_ASSET_BYTES)) commands.push({ type: "addAsset", id, meta: { mimeType: "image/png", byteLength: Buffer.from(b64, "base64").length } });
  const containers: string[] = [...doc.pages];
  for (let i = 1; i < pages; i++) {
    commands.push({ type: "createNode", node: { id: `page-${i}`, type: "page", props: { name: `Page ${i + 1}` } }, parent: ROOT_ID });
    containers.push(`page-${i}`);
  }
  nodes.forEach((n, i) => {
    const id = `n${i}`;
    commands.push({
      type: "createNode",
      node: { id, type: n.type, props: n.props, ...(n.type === "text" ? { text: n.text } : {}) },
      parent: containers[n.parent % containers.length]!,
    });
    if (isContainer(n.type)) containers.push(id);
  });
  doc.apply(commands, user);
  return doc;
}

describe(".figtree JSON", () => {
  it("publishes an up-to-date JSON Schema (UPDATE_SCHEMA=1 rewrites it)", () => {
    const text = JSON.stringify(figtreeJsonSchema(), null, 2) + "\n";
    if (process.env.UPDATE_SCHEMA === "1" || !existsSync(SCHEMA_PATH)) {
      mkdirSync(dirname(SCHEMA_PATH), { recursive: true });
      writeFileSync(SCHEMA_PATH, text);
    }
    expect(readFileSync(SCHEMA_PATH, "utf8"), "docs/format/figtree.schema.json is stale: run UPDATE_SCHEMA=1 npm test").toBe(text);
  });

  it("round-trips fuzzed documents losslessly: Y.Doc → JSON → Y.Doc → byte-identical JSON, valid against the schema", () => {
    fc.assert(
      fc.property(documentSpec, (spec) => {
        const doc = buildDocument(spec);
        const first = json(doc);
        const parsed = JSON.parse(first);
        if (!validate(parsed)) throw new Error(ajv.errorsText(validate.errors));
        expect(FigtreeFile.safeParse(parsed).success).toBe(true);
        const again = fromFigtreeJson(first);
        expect(json(again)).toBe(first);
        // Every stored property survived (not just "something equal after a second pass").
        for (const id of doc.tree.ids()) {
          expect(again.storedProps(id)).toEqual(JSON.parse(JSON.stringify(doc.storedProps(id))));
          if (doc.typeOf(id) === "text") expect(again.text(id)).toEqual(doc.text(id));
        }
      }),
      { numRuns: 150 },
    );
  }, 60_000);

  it("round-trips documents shaped by random edits (moves, deletes, groups, text)", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const doc = FigDocument.create({ random: seededRandom(seed), clientId: 1 });
      const user = doc.actor("u");
      const random = seededRandom(seed * 7);
      for (let i = 0; i < 150; i++) {
        try {
          doc.apply([randomCommand(doc, random)], user);
        } catch (e) {
          if (!(e instanceof CommandError)) throw e;
        }
      }
      const first = json(doc);
      expect(validate(JSON.parse(first)), ajv.errorsText(validate.errors)).toBe(true);
      expect(json(fromFigtreeJson(first))).toBe(first);
    }
  }, 60_000);

  it("reports every problem in invalid files", () => {
    const bad = {
      format: "figtree",
      version: FORMAT_VERSION,
      name: "x",
      pages: [{ id: "p", type: "page", children: [{ id: "r", type: "rectangle", opacity: 7, fills: [{ type: "solid" }] }] }],
      assets: {},
    };
    // The published JSON Schema rejects it too, as it does other malformed documents.
    expect(validate(bad)).toBe(false);
    const page = (children: unknown[]) => ({ ...bad, pages: [{ id: "p", type: "page", children }] });
    expect(validate(page([{ id: "r", type: "rectangle", children: [] }]))).toBe(false);
    expect(validate(page([{ id: "t", type: "text", text: { content: "a" } }]))).toBe(false);
    expect(validate(page([{ id: "f", type: "frame", children: [{ id: "p2", type: "page", children: [] }] }]))).toBe(false);
    expect(validate(page([{ id: "f", type: "frame", gridTemplateColumns: [{ type: "fr", value: -1 }] }]))).toBe(false);
    expect(validate(page([{ id: "v", type: "vector", unknownKey: 1 }]))).toBe(false);
    expect(validate(page([{ id: "f", type: "frame", children: [{ id: "e", type: "ellipse", arcSweep: 90 }] }]))).toBe(true);
    try {
      fromFigtreeJson(bad);
      throw new Error("expected a FormatError");
    } catch (e) {
      expect(e).toBeInstanceOf(FormatError);
      expect((e as FormatError).issues).toEqual(
        expect.arrayContaining([expect.stringMatching(/^pages\.0\.children\.0\.opacity: Too big/), expect.stringMatching(/^pages\.0\.children\.0\.fills\.0\.color: Invalid input/)]),
      );
    }
    expect(() => fromFigtreeJson("{")).toThrow(/not valid JSON/);
    expect(() => fromFigtreeJson({ format: "other" })).toThrow(/not a Fig Tree document/);
  });
});

describe("migrations", () => {
  const v0 = { format: "figtree", version: 0, title: "Old", pages: [{ id: "p", type: "page", children: [] }] };
  const rename = { from: 0, to: 1, description: "title → name, add assets", migrate: (d: Record<string, unknown>) => ({ format: d.format, version: 1, name: d.title, pages: d.pages, assets: {} }) };

  it("upgrades old files through the hook", () => {
    const doc = fromFigtreeJson(v0, { migrations: [rename, ...MIGRATIONS] });
    expect(doc.name).toBe("Old");
    expect(migrate(v0, [rename, ...MIGRATIONS])).toMatchObject({ version: FORMAT_VERSION, name: "Old" });
  });

  it("reads version 1 files (before boolean groups) unchanged", () => {
    const v1 = { format: "figtree", version: 1, name: "One", pages: [{ id: "p", type: "page", children: [{ id: "g", type: "group", children: [{ id: "r", type: "rectangle" }] }] }], assets: {} };
    const doc = fromFigtreeJson(v1);
    expect(doc.get("g", "booleanOperation")).toBe("none");
    expect(toFigtreeJson(doc).version).toBe(2);
  });

  it("refuses files it cannot read", () => {
    expect(() => fromFigtreeJson(v0)).toThrow(/no migration from format version 0/);
    expect(() => fromFigtreeJson({ ...v0, version: 99 })).toThrow(/written by a newer version of Fig Tree \(format 99/);
    expect(() => fromFigtreeJson({ ...v0, version: "1" })).toThrow(/invalid format version/);
  });
});

describe(".figtree archives", () => {
  it("round-trip fuzzed documents with assets, deterministically", async () => {
    await fc.assert(
      fc.asyncProperty(documentSpec, async (spec) => {
        const doc = buildDocument(spec);
        const store = assetStore();
        const bytes = writeFigtree(doc, store);
        expect(writeFigtree(doc, store)).toEqual(bytes);
        const { doc: loaded, assets } = await readFigtree(bytes);
        expect(json(loaded)).toBe(json(doc));
        // A document read back writes the same archive bytes.
        expect(writeFigtree(loaded, assets)).toEqual(bytes);
      }),
      { numRuns: 40 },
    );
  }, 60_000);

  it("keeps CRDT history when asked", async () => {
    const doc = buildDocument([1, "History", [{ type: "frame", parent: 0, props: { x: 5 }, text: { content: "", runs: [] } }]]);
    doc.apply([{ type: "rename", id: "n0", name: "Renamed" }], doc.actor("u"));
    const bytes = writeFigtree(doc, assetStore(), { includeHistory: true });
    const { doc: restored } = await readFigtree(bytes, { useHistory: true });
    expect(restored.stateVector()).toEqual(doc.stateVector());
    expect(json(restored)).toBe(json(doc));
    // The restored replica keeps syncing with the original.
    restored.apply([{ type: "updateProps", id: "n0", props: { y: 9 } }], restored.actor("v"));
    doc.applyUpdate(restored.encodeState(doc.stateVector()));
    expect(doc.get("n0", "y")).toBe(9);
  });

  it("encodes binary history snapshots", () => {
    const doc = buildDocument([2, "Snap", []]);
    const snap = encodeHistory(doc);
    expect(Array.from(snap.subarray(0, 4))).toEqual([0x46, 0x54, 0x59, 0x48]);
    expect(json(decodeHistory(snap))).toBe(json(doc));
    expect(() => decodeHistory(new Uint8Array([1, 2, 3, 4, 5]))).toThrow(/not a Fig Tree history snapshot/);
  });

  it("verifies assets and guards against oversized archives", async () => {
    const doc = buildDocument([1, "A", [{ type: "image", parent: 0, props: { asset: Object.keys(FUZZ_ASSET_BYTES)[0] }, text: { content: "", runs: [] } }]]);
    const store = assetStore();
    const good = writeFigtree(doc, store);
    await expect(readFigtree(good)).resolves.toBeDefined();
    const tampered = assetStore();
    const id = Object.keys(FUZZ_ASSET_BYTES)[0]!;
    const bytes = new Uint8Array(store.get(id)!);
    bytes[bytes.length - 1]! ^= 1;
    tampered.put(id, bytes);
    await expect(readFigtree(writeFigtree(doc, tampered))).rejects.toThrow(/does not match its content hash/);
    expect(() => writeFigtree(doc, new AssetStore())).toThrow(/missing from the asset store/);
    await expect(readFigtree(good, { limits: { maxEntryBytes: 100 } })).rejects.toThrow(/too large/);
    await expect(readFigtree(good, { limits: { maxEntries: 1 } })).rejects.toThrow(/more than 1 entries/);
    await expect(readFigtree(new Uint8Array([1, 2, 3]))).rejects.toThrow(/not a valid \.figtree archive/);
    await expect(readFigtree(zipSync({ "other.txt": new Uint8Array([1]) }))).rejects.toThrow(/has no document\.json/);
  });

  it("sniffs image types and sizes", async () => {
    const [id, b64] = Object.entries(FUZZ_ASSET_BYTES)[0]!;
    const bytes = new Uint8Array(Buffer.from(b64, "base64"));
    expect(sniffImage(bytes)).toEqual({ mimeType: "image/png", width: 2, height: 2 });
    expect(sniffImage(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toEqual({ mimeType: "image/svg+xml" });
    expect(sniffImage(new Uint8Array([71, 73, 70, 56, 57, 97, 5, 0, 7, 0]))).toEqual({ mimeType: "image/gif", width: 5, height: 7 });
    expect(sniffImage(new Uint8Array([1, 2, 3]))).toBeNull();
    const store = new AssetStore();
    expect(await store.add(bytes, "red.png")).toEqual({ id, meta: { mimeType: "image/png", byteLength: bytes.length, width: 2, height: 2, name: "red.png" } });
  });
});
