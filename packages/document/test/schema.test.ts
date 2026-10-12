import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  Effect,
  FORMAT_VERSION,
  FigtreeFile,
  NODE_TYPES,
  PROPS,
  Paint,
  PropsSchema,
  TextContent,
  VectorNetwork,
  canContain,
  defaultProp,
  isContainer,
  propSchema,
  type NodeType,
} from "../src";
import { fullPropsArb, propArb } from "./arbitraries";

/** Formats the first issue as "path: message", the way commands report it. */
function firstIssue(schema: z.ZodType, value: unknown): string {
  const r = schema.safeParse(value);
  if (r.success) return "(valid)";
  const i = r.error.issues[0]!;
  return `${i.path.join(".")}: ${i.message}`;
}

const red = { r: 1, g: 0, b: 0, a: 1 };

describe("node property schemas", () => {
  for (const type of NODE_TYPES) {
    it(`accepts every ${type} property at once`, () => {
      fc.assert(
        fc.property(fullPropsArb(type), (props) => {
          const r = PropsSchema[type].safeParse(props);
          if (!r.success) throw new Error(z.prettifyError(r.error));
        }),
        { numRuns: 60 },
      );
    });

    it(`rejects unknown ${type} properties`, () => {
      expect(firstIssue(PropsSchema[type], { notAProp: 1 })).toMatch(/Unrecognized key: "notAProp"/);
    });

    it(`has a default for every optional ${type} property that has one in CSS`, () => {
      for (const key of Object.keys(PROPS[type])) {
        const d = defaultProp(type, key);
        if (d === undefined) continue;
        expect(propSchema(type, key)!.safeParse(d).success, `${type}.${key} default ${JSON.stringify(d)}`).toBe(true);
      }
    });
  }

  it("generates every property of every type (arbitraries are complete)", () => {
    for (const type of NODE_TYPES) for (const key of Object.keys(PROPS[type])) expect(() => propArb(type, key)).not.toThrow();
  });

  it("defines which types hold children", () => {
    expect(NODE_TYPES.filter(isContainer)).toEqual(["page", "frame", "group", "component", "instance"]);
    expect(canContain(null, "page")).toBe(true);
    expect(canContain(null, "frame")).toBe(false);
    expect(canContain("frame", "page")).toBe(false);
    expect(canContain("group", "text")).toBe(true);
    expect(canContain("text", "rectangle")).toBe(false);
  });
});

interface Case {
  readonly type: NodeType;
  readonly props: Record<string, unknown>;
  readonly error: RegExp;
}

/** One or more invalid inputs per property group, with the error a caller sees. */
const invalid: Record<string, Case[]> = {
  geometry: [
    { type: "rectangle", props: { width: -1 }, error: /^width: Too small: expected number to be >=0/ },
    { type: "frame", props: { x: Number.NaN }, error: /^x: Invalid input: expected number, received NaN/ },
    { type: "frame", props: { y: Number.POSITIVE_INFINITY }, error: /^y: / },
    { type: "ellipse", props: { flipX: "yes" }, error: /^flipX: Invalid input: expected boolean/ },
  ],
  sizing: [
    { type: "frame", props: { widthMode: "auto" }, error: /^widthMode: Invalid option: expected one of "fixed"\|"hug"\|"fill"/ },
    { type: "text", props: { minWidth: -5 }, error: /^minWidth: Too small/ },
    { type: "image", props: { aspectRatio: 0 }, error: /^aspectRatio: Too small: expected number to be >0/ },
  ],
  position: [
    { type: "rectangle", props: { position: "static" }, error: /^position: Invalid option/ },
    { type: "rectangle", props: { constraints: { horizontal: "left", vertical: "start" } }, error: /^constraints\.horizontal: Invalid option/ },
    { type: "rectangle", props: { constraints: { horizontal: "start" } }, error: /^constraints\.vertical: Invalid option/ },
  ],
  box: [
    { type: "frame", props: { padding: { top: 1, right: 1, bottom: -1, left: 1 } }, error: /^padding\.bottom: Too small/ },
    { type: "frame", props: { boxSizing: "padding-box" }, error: /^boxSizing: Invalid option/ },
    { type: "frame", props: { strokesInLayout: 1 }, error: /^strokesInLayout: Invalid input: expected boolean/ },
  ],
  overflowAndCorners: [
    { type: "frame", props: { overflowX: "scroll-x" }, error: /^overflowX: Invalid option/ },
    { type: "rectangle", props: { cornerRadius: { topLeft: 1, topRight: 1, bottomRight: 1 } }, error: /^cornerRadius: Invalid input/ },
    { type: "rectangle", props: { cornerSmoothing: 1.5 }, error: /^cornerSmoothing: Too big: expected number to be <=1/ },
  ],
  flexContainer: [
    { type: "frame", props: { display: "inline-flex" }, error: /^display: Invalid option/ },
    { type: "frame", props: { flexDirection: "horizontal" }, error: /^flexDirection: Invalid option/ },
    { type: "frame", props: { rowGap: -2 }, error: /^rowGap: Too small/ },
    { type: "frame", props: { justifyContent: "space-all" }, error: /^justifyContent: Invalid option/ },
  ],
  gridContainer: [
    { type: "frame", props: { gridTemplateColumns: [{ type: "fr", value: -1 }] }, error: /^gridTemplateColumns\.0\.value: Too small/ },
    { type: "frame", props: { gridTemplateColumns: [{ type: "repeat", count: 0, tracks: [{ type: "auto" }] }] }, error: /^gridTemplateColumns\.0\.count: Too small/ },
    { type: "frame", props: { gridTemplateAreas: ["header header", "a b!"] }, error: /^gridTemplateAreas\.1: rows are whitespace-separated area names or dots/ },
    { type: "frame", props: { gridAutoFlow: "dense" }, error: /^gridAutoFlow: Invalid option/ },
  ],
  layoutItem: [
    { type: "rectangle", props: { flexGrow: -1 }, error: /^flexGrow: Too small/ },
    { type: "rectangle", props: { flexBasis: "fill" }, error: /^flexBasis: Invalid input/ },
    { type: "rectangle", props: { gridColumn: { start: 0, end: 2 } }, error: /^gridColumn\.start: grid line 0 does not exist/ },
    { type: "rectangle", props: { order: 1.5 }, error: /^order: Invalid input: expected int/ },
    { type: "rectangle", props: { margin: { top: "auto", right: 0, bottom: 0, left: "1px" } }, error: /^margin\.left: Invalid input/ },
  ],
  layer: [
    { type: "frame", props: { opacity: 1.2 }, error: /^opacity: Too big: expected number to be <=1/ },
    { type: "group", props: { blendMode: "add" }, error: /^blendMode: Invalid option/ },
    { type: "group", props: { isolation: "isolated" }, error: /^isolation: Invalid option/ },
    { type: "rectangle", props: { componentRef: "root" }, error: /^componentRef: "root" is reserved/ },
    { type: "rectangle", props: { overrides: ["Fills"] }, error: /^overrides\.0: Invalid string/ },
  ],
  paints: [
    { type: "rectangle", props: { fills: [{ type: "solid", color: { r: 2, g: 0, b: 0, a: 1 } }] }, error: /^fills\.0\.color\.r: Too big/ },
    { type: "rectangle", props: { fills: [{ type: "linear-gradient", start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, stops: [{ position: 0, color: red }] }] }, error: /^fills\.0\.stops: a gradient needs at least two stops/ },
    { type: "rectangle", props: { fills: [{ type: "conic", color: red }] }, error: /^fills\.0\.type: Invalid discriminator value/ },
    { type: "rectangle", props: { fills: [{ type: "image", asset: "not-a-hash", fit: "cover" }] }, error: /^fills\.0\.asset: asset ids are lowercase hex SHA-256 digests/ },
    { type: "rectangle", props: { fills: [{ type: "image", asset: "a".repeat(64), fit: "cover", rotation: 45 }] }, error: /^fills\.0\.rotation: Invalid input/ },
    { type: "rectangle", props: { fills: [{ type: "shader", shader: "" }] }, error: /^fills\.0\.shader: Invalid discriminator/ },
    { type: "rectangle", props: { fills: [{ type: "solid", color: red, opacity: -0.1 }] }, error: /^fills\.0\.opacity: Too small/ },
  ],
  strokes: [
    { type: "rectangle", props: { strokeWeight: { top: 1, right: 1, bottom: 1, left: -1 } }, error: /^strokeWeight\.left: Too small/ },
    { type: "ellipse", props: { strokeWeight: { top: 1, right: 1, bottom: 1, left: 1 } }, error: /^strokeWeight: Invalid input: expected number/ },
    { type: "line", props: { strokeDashes: [4, -2] }, error: /^strokeDashes\.1: Too small/ },
    { type: "line", props: { strokeMiterLimit: 0.5 }, error: /^strokeMiterLimit: Too small: expected number to be >=1/ },
    { type: "vector", props: { strokeAlign: "middle" }, error: /^strokeAlign: Invalid option/ },
    { type: "line", props: { strokeCap: "arrow" }, error: /^strokeCap: Invalid option/ },
  ],
  effects: [
    { type: "frame", props: { effects: [{ type: "drop-shadow", color: red, offset: { x: 0, y: 4 }, blur: -1, spread: 0 }] }, error: /^effects\.0\.blur: Too small/ },
    { type: "frame", props: { effects: [{ type: "glow", radius: 2 }] }, error: /^effects\.0\.type: Invalid discriminator value/ },
    { type: "frame", props: { effects: [{ type: "layer-blur" }] }, error: /^effects\.0\.radius: Invalid input/ },
  ],
  typography: [
    { type: "text", props: { fontWeight: 0 }, error: /^fontWeight: Too small: expected number to be >=1/ },
    { type: "text", props: { fontSize: 0 }, error: /^fontSize: Too small: expected number to be >0/ },
    { type: "text", props: { lineHeight: { unit: "em", value: 1 } }, error: /^lineHeight: Invalid input/ },
    { type: "text", props: { fontFeatures: { ligatures: 1 } }, error: /^fontFeatures\.ligatures: Invalid key in record/ },
    { type: "text", props: { textAlign: "middle" }, error: /^textAlign: Invalid option/ },
    { type: "text", props: { maxLines: 0 }, error: /^maxLines: Too small/ },
  ],
  shapes: [
    { type: "polygon", props: { pointCount: 2 }, error: /^pointCount: Too small: expected number to be >=3/ },
    { type: "star", props: { innerRadius: 1.5 }, error: /^innerRadius: Too big/ },
    { type: "ellipse", props: { arcSweep: 400 }, error: /^arcSweep: Too big: expected number to be <=360/ },
    { type: "image", props: { objectFit: "cover-all" }, error: /^objectFit: Invalid option/ },
  ],
  vectorNetwork: [
    { type: "vector", props: { vectorNetwork: { vertices: [{ x: 0, y: 0 }], segments: [{ start: 0, end: 3 }], regions: [] } }, error: /^vectorNetwork\.segments\.0\.end: vertex 3 does not exist \(1 vertices\)/ },
    {
      type: "vector",
      props: { vectorNetwork: { vertices: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }], regions: [{ loops: [[0, 1]], fillRule: "nonzero" }] } },
      error: /^vectorNetwork\.regions\.0\.loops\.0: loop segments must connect end to end and close/,
    },
    { type: "vector", props: { vectorNetwork: { vertices: [], segments: [], regions: [{ loops: [[0]], fillRule: "nonzero" }] } }, error: /^vectorNetwork\.regions\.0\.loops\.0: segment 0 does not exist/ },
  ],
  page: [
    { type: "page", props: { backgroundColor: "#fff" }, error: /^backgroundColor: Invalid input: expected object/ },
    { type: "page", props: { x: 0 }, error: /Unrecognized key: "x"/ },
  ],
  reservedComponents: [
    { type: "instance", props: { componentId: "has space" }, error: /^componentId: ids are 1-64 characters/ },
    { type: "component", props: { propertyDefinitions: { size: { type: "number", default: 1 } } }, error: /^propertyDefinitions\.size\.type: Invalid option/ },
  ],
};

describe("invalid properties are rejected with a path and a reason", () => {
  for (const [group, cases] of Object.entries(invalid)) {
    it(group, () => {
      for (const c of cases) expect(firstIssue(PropsSchema[c.type], c.props), `${c.type} ${JSON.stringify(c.props)}`).toMatch(c.error);
    });
  }
});

describe("value schemas", () => {
  it("validates text runs against the content", () => {
    expect(firstIssue(TextContent, { content: "abc", runs: [{ start: 0, end: 5, style: { fontWeight: 700 } }] })).toMatch(/^runs\.0: run ends past the end of the text \(3\)/);
    expect(firstIssue(TextContent, { content: "abcdef", runs: [{ start: 0, end: 4, style: { fontWeight: 700 } }, { start: 2, end: 5, style: { fontWeight: 400 } }] })).toMatch(/^runs\.1: runs must be sorted and must not overlap/);
    expect(firstIssue(TextContent, { content: "abc", runs: [{ start: 1, end: 2, style: {} }] })).toMatch(/^runs\.0\.style: a run must override at least one property/);
    expect(firstIssue(TextContent, { content: "abc", runs: [{ start: 2, end: 2, style: { fontWeight: 700 } }] })).toMatch(/run end must be greater/);
    expect(firstIssue(TextContent, { content: "abc", runs: [{ start: 0, end: 1, style: { link: "not a url" } }] })).toMatch(/^runs\.0\.style\.link: Invalid URL/);
    expect(TextContent.safeParse({ content: "abc", runs: [{ start: 0, end: 1, style: { link: "https://example.com" } }] }).success).toBe(true);
  });

  it("accepts open paths and junctions in vector networks", () => {
    const net = {
      vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
      segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 0 }, { start: 0, end: 3 }, { start: 2, end: 3 }],
      regions: [{ loops: [[0, 1, 2]], fillRule: "evenodd" }, { loops: [[2, 4, 3]], fillRule: "nonzero" }],
    };
    expect(VectorNetwork.safeParse(net).success).toBe(true);
  });

  it("parses every paint and effect kind", () => {
    const stops = [{ position: 0, color: red }, { position: 1, color: { ...red, a: 0 } }];
    for (const p of [
      { type: "solid", color: red },
      { type: "linear-gradient", start: { x: 0, y: 0 }, end: { x: 1, y: 1 }, stops },
      { type: "radial-gradient", center: { x: 0.5, y: 0.5 }, radiusX: { x: 1, y: 0.5 }, radiusY: { x: 0.5, y: 1 }, stops },
      { type: "angular-gradient", center: { x: 0.5, y: 0.5 }, radiusX: { x: 1, y: 0.5 }, radiusY: { x: 0.5, y: 1 }, stops },
      { type: "diamond-gradient", center: { x: 0.5, y: 0.5 }, radiusX: { x: 1, y: 0.5 }, radiusY: { x: 0.5, y: 1 }, stops },
      { type: "image", asset: "f".repeat(64), fit: "tile", tileScale: 0.5 },
      { type: "shader", shader: "grain", seed: 4, speed: 1, params: { colorBack: red, colorFront: { ...red, r: 0 }, size: 2, density: 0.5 } },
      { type: "shader", shader: "mesh-gradient", params: { columns: 2, rows: 2, points: [0, 1, 2, 3].map((i) => ({ x: i % 2, y: i >> 1, color: red })) } },
      { type: "shader", shader: "halftone", params: { style: "dots", cmyk: true, colorBack: red, colorFront: red, cellSize: 6, angle: 45, source: "image", asset: "e".repeat(64) } },
      { type: "shader", shader: "fluted-glass", params: { fluteWidth: 12, angle: 0, distortion: 0.5, shading: 0.3, frost: 4, tint: red } },
      { type: "shader", shader: "liquid", params: { colors: [red, red, red], scale: 80, warp: 1, detail: 4 } },
      { type: "shader", shader: "dithering", params: { pattern: "bayer8", pixelSize: 2, colorBack: red, colorFront: red, source: "radial" } },
    ]) {
      expect(Paint.safeParse(p).success, p.type).toBe(true);
    }
    // Reserved free-form shaders are gone, and parameters are checked per shader.
    expect(Paint.safeParse({ type: "shader", shader: "noise", uniforms: { scale: 2 } }).success).toBe(false);
    expect(firstIssue(Paint, { type: "shader", shader: "mesh-gradient", params: { columns: 3, rows: 2, points: [0, 1, 2, 3].map((i) => ({ x: i, y: 0, color: red })) } })).toMatch(/columns × rows points/);
    expect(firstIssue(Paint, { type: "shader", shader: "grain", params: { colorBack: red, colorFront: red, size: 0, density: 0.5 } })).toMatch(/^params\.size: /);
    for (const e of [
      { type: "drop-shadow", color: red, offset: { x: 0, y: 2 }, blur: 4, spread: 0, showBehindNode: true },
      { type: "inner-shadow", color: red, offset: { x: 0, y: 2 }, blur: 4, spread: -1 },
      { type: "layer-blur", radius: 8 },
      { type: "background-blur", radius: 20 },
    ]) {
      expect(Effect.safeParse(e).success, e.type).toBe(true);
    }
  });
});

describe("document.json schema", () => {
  const page = (children: unknown[] = []) => ({ id: "p", type: "page", children });
  const file = (pages: unknown[], assets: Record<string, unknown> = {}) => ({ format: "figtree", version: FORMAT_VERSION, name: "Doc", pages, assets });

  it("accepts a minimal document", () => {
    expect(FigtreeFile.safeParse(file([page()])).success).toBe(true);
  });

  it("rejects duplicate ids, dangling assets, misplaced children and text", () => {
    expect(firstIssue(FigtreeFile, file([page([{ id: "a", type: "rectangle" }, { id: "a", type: "ellipse" }])]))).toMatch(/duplicate node id "a"/);
    expect(firstIssue(FigtreeFile, file([page([{ id: "i", type: "image", asset: "c".repeat(64) }])]))).toMatch(/asset c+ is not listed in "assets"/);
    expect(firstIssue(FigtreeFile, file([page([{ id: "r", type: "rectangle", children: [] }])]))).toMatch(/Unrecognized key: "children"/);
    expect(firstIssue(FigtreeFile, file([page([{ id: "r", type: "frame", text: { content: "", runs: [] } }])]))).toMatch(/Unrecognized key: "text"/);
    expect(firstIssue(FigtreeFile, file([page([{ id: "x", type: "page", children: [] }])]))).toMatch(/pages\.0\.children\.0\.type: Invalid discriminator value/);
    expect(firstIssue(FigtreeFile, { ...file([page()]), version: FORMAT_VERSION + 1 })).toMatch(new RegExp(`^version: Invalid input: expected ${FORMAT_VERSION}`));
  });
});
