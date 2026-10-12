import fc from "fast-check";
import { BlendMode, NODE_TYPES, PROPS, type NodeType, type TextContent } from "../src";

/**
 * fast-check generators for every stored property, keyed by property name
 * (a name means the same thing on every node type that has it). Used to
 * fuzz schemas, commands and the file format.
 */

const num = fc.double({ min: -1e5, max: 1e5, noNaN: true, noDefaultInfinity: true });
const nonneg = fc.double({ min: 0, max: 1e5, noNaN: true, noDefaultInfinity: true });
const unit = fc.double({ min: 0, max: 1, noNaN: true });
const signedUnit = fc.double({ min: -1, max: 1, noNaN: true });
const positive = fc.double({ min: 0.001, max: 1e4, noNaN: true, noDefaultInfinity: true });
const name = fc.string({ maxLength: 20 });
const color = fc.record({ r: unit, g: unit, b: unit, a: unit });
const point = fc.record({ x: num, y: num });
const blend = fc.constantFrom(...BlendMode.options);

/** Two tiny PNGs the fuzzer may reference, with their real SHA-256 ids. */
export const FUZZ_ASSET_BYTES: Record<string, string> = {
  "4637adf6e38fb59e0bac38aa91f52d0350b030ccb924e115ed9135fd0252b667": "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8DwnwGMgRQAH+4D/dJQfRoAAAAASUVORK5CYII=",
  "6bb46e7d1b7d527f8a7cbb904a8fb298f3aa6c08af32a4a248fce7d1696e27e8": "iVBORw0KGgoAAAANSUhEUgAAAAMAAAABCAIAAACUgoPjAAAADUlEQVR4nGNgaPgPQQATfgR+5W97sAAAAABJRU5ErkJggg==",
};
export const FUZZ_ASSETS = Object.keys(FUZZ_ASSET_BYTES);

const paintBase = { visible: fc.boolean(), opacity: unit, blendMode: blend };
const optional = { requiredKeys: [] as never[] };
const withBase = <T extends Record<string, fc.Arbitrary<unknown>>>(required: T) =>
  fc.tuple(fc.record(required), fc.record(paintBase, optional)).map(([r, b]) => ({ ...r, ...b }));
const stops = fc.array(fc.record({ position: unit, color }), { minLength: 2, maxLength: 5 });

export const paint = fc.oneof(
  withBase({ type: fc.constant("solid"), color }),
  withBase({ type: fc.constant("linear-gradient"), start: point, end: point, stops }),
  ...(["radial-gradient", "angular-gradient", "diamond-gradient"] as const).map((type) =>
    withBase({ type: fc.constant(type), center: point, radiusX: point, radiusY: point, stops }),
  ),
  fc.tuple(
    fc.record({ type: fc.constant("image"), asset: fc.constantFrom(...FUZZ_ASSETS), fit: fc.constantFrom("cover", "contain", "stretch", "tile", "crop") }),
    fc.record(
      {
        transform: fc.tuple(num, num, num, num, num, num),
        tileScale: positive,
        rotation: fc.constantFrom(0, 90, 180, 270),
        filters: fc.record({ exposure: signedUnit, contrast: signedUnit, saturation: signedUnit, temperature: signedUnit, tint: signedUnit, highlights: signedUnit, shadows: signedUnit }, optional),
      },
      optional,
    ),
    fc.record(paintBase, optional),
  ).map(([a, b, c]) => ({ ...a, ...b, ...c })),
  withBase({ type: fc.constant("shader"), shader: fc.string({ minLength: 1, maxLength: 12 }) }).chain((p) =>
    fc.record({ uniforms: fc.dictionary(fc.string({ maxLength: 6 }), fc.oneof(num, fc.array(num, { maxLength: 4 })), { maxKeys: 3 }) }, optional).map((u) => ({ ...p, ...u })),
  ),
);
const paints = fc.array(paint, { maxLength: 3 });

const shadow = { color, offset: point, blur: nonneg, spread: num };
export const effect = fc.oneof(
  fc.tuple(fc.record({ type: fc.constant("drop-shadow"), ...shadow }), fc.record({ visible: fc.boolean(), blendMode: blend, showBehindNode: fc.boolean() }, optional)).map(([a, b]) => ({ ...a, ...b })),
  fc.tuple(fc.record({ type: fc.constant("inner-shadow"), ...shadow }), fc.record({ visible: fc.boolean(), blendMode: blend }, optional)).map(([a, b]) => ({ ...a, ...b })),
  fc.tuple(fc.record({ type: fc.constantFrom("layer-blur", "background-blur"), radius: nonneg }), fc.record({ visible: fc.boolean() }, optional)).map(([a, b]) => ({ ...a, ...b })),
);

const sides = <T>(v: fc.Arbitrary<T>) => fc.record({ top: v, right: v, bottom: v, left: v });
const breadth = fc.oneof(
  fc.record({ type: fc.constantFrom("px", "percent", "fr"), value: nonneg }),
  fc.record({ type: fc.constantFrom("auto", "min-content", "max-content") }),
);
const track = fc.oneof(breadth, fc.record({ type: fc.constant("minmax"), min: breadth, max: breadth }), fc.record({ type: fc.constant("fit-content"), value: nonneg }));
const trackList = fc.array(
  fc.oneof(track, fc.record({ type: fc.constant("repeat"), count: fc.oneof(fc.integer({ min: 1, max: 12 }), fc.constantFrom("auto-fill", "auto-fit")), tracks: fc.array(track, { minLength: 1, maxLength: 3 }) })),
  { maxLength: 4 },
);
const gridLine = fc.oneof(
  fc.integer({ min: -5, max: 5 }).filter((n) => n !== 0),
  fc.constant("auto"),
  fc.record({ span: fc.integer({ min: 1, max: 4 }) }),
  fc.record({ name: fc.constantFrom("header", "main", "side_bar") }),
);
const openTypeTag = fc.constantFrom("liga", "kern", "ss01", "tnum", "wght", "wdth", "opsz");

export const textStyle = {
  fontFamily: fc.constantFrom("Inter", "system-ui", "Georgia", "Noto Sans JP"),
  fontWeight: fc.integer({ min: 1, max: 1000 }),
  fontStyle: fc.constantFrom("normal", "italic", "oblique"),
  fontStretch: fc.double({ min: 50, max: 200, noNaN: true }),
  fontSize: positive,
  lineHeight: fc.oneof(fc.constant("normal"), fc.record({ unit: fc.constantFrom("px", "percent"), value: nonneg })),
  letterSpacing: fc.record({ unit: fc.constantFrom("px", "em"), value: num }),
  textDecoration: fc.constantFrom("none", "underline", "line-through"),
  textTransform: fc.constantFrom("none", "uppercase", "lowercase", "capitalize"),
  fontFeatures: fc.dictionary(openTypeTag, fc.integer({ min: 0, max: 20 }), { maxKeys: 3 }),
  fontVariations: fc.dictionary(openTypeTag, num, { maxKeys: 3 }),
  fills: paints,
  listStyle: fc.constantFrom("none", "bullet", "ordered"),
  listLevel: fc.integer({ min: 0, max: 8 }),
};

/** A valid vector network: a random polygon plus optional extra spokes. */
export const vectorNetwork = fc
  .tuple(fc.array(point, { minLength: 3, maxLength: 7 }), fc.boolean(), fc.constantFrom("nonzero", "evenodd"), fc.boolean())
  .map(([pts, curved, fillRule, spoke]) => {
    const vertices: Record<string, unknown>[] = pts.map((p) => ({ x: p.x, y: p.y }));
    const segments: Record<string, unknown>[] = pts.map((_, i) => ({
      start: i,
      end: (i + 1) % pts.length,
      ...(curved ? { tangentStart: { x: 10, y: 0 }, tangentEnd: { x: 0, y: -10 } } : {}),
    }));
    if (spoke) {
      vertices.push({ x: 0, y: 0, cornerRadius: 2, strokeCap: "round" });
      segments.push({ start: 0, end: pts.length });
    }
    return { vertices, segments, regions: [{ loops: [pts.map((_, i) => i)], fillRule }] };
  });

const PROP_ARBS: Record<string, fc.Arbitrary<unknown>> = {
  name,
  visible: fc.boolean(),
  locked: fc.boolean(),
  opacity: unit,
  blendMode: blend,
  isolation: fc.constantFrom("auto", "isolate"),
  effects: fc.array(effect, { maxLength: 2 }),
  componentRef: fc.constantFrom("main-1", "main-2"),
  overrides: fc.array(fc.constantFrom("fills", "geometry", "text-content"), { maxLength: 2 }),
  x: num,
  y: num,
  width: nonneg,
  height: nonneg,
  rotation: fc.double({ min: -360, max: 360, noNaN: true }),
  flipX: fc.boolean(),
  flipY: fc.boolean(),
  widthMode: fc.constantFrom("fixed", "hug", "fill"),
  heightMode: fc.constantFrom("fixed", "hug", "fill"),
  minWidth: nonneg,
  maxWidth: nonneg,
  minHeight: nonneg,
  maxHeight: nonneg,
  aspectRatio: positive,
  position: fc.constantFrom("absolute", "relative", "fixed", "sticky"),
  constraints: fc.record({ horizontal: fc.constantFrom("start", "end", "start-end", "center", "scale"), vertical: fc.constantFrom("start", "end", "start-end", "center", "scale") }),
  flexGrow: nonneg,
  flexShrink: nonneg,
  flexBasis: fc.oneof(nonneg, fc.constantFrom("auto", "content")),
  alignSelf: fc.constantFrom("auto", "stretch", "center", "flex-end", "baseline"),
  justifySelf: fc.constantFrom("auto", "start", "end", "center"),
  order: fc.integer({ min: -10, max: 10 }),
  gridColumn: fc.record({ start: gridLine, end: gridLine }),
  gridRow: fc.record({ start: gridLine, end: gridLine }),
  margin: sides(fc.oneof(num, fc.constant("auto"))),
  strokes: paints,
  strokeAlign: fc.constantFrom("inside", "center", "outside"),
  strokeCap: fc.constantFrom("butt", "round", "square"),
  strokeJoin: fc.constantFrom("miter", "round", "bevel"),
  strokeMiterLimit: fc.double({ min: 1, max: 100, noNaN: true }),
  strokeDashes: fc.array(nonneg, { maxLength: 4 }),
  strokeDashOffset: num,
  boxSizing: fc.constantFrom("border-box", "content-box"),
  padding: sides(nonneg),
  strokesInLayout: fc.boolean(),
  overflowX: fc.constantFrom("visible", "hidden", "clip", "scroll", "auto"),
  overflowY: fc.constantFrom("visible", "hidden", "clip", "scroll", "auto"),
  cornerRadius: fc.oneof(nonneg, fc.record({ topLeft: nonneg, topRight: nonneg, bottomRight: nonneg, bottomLeft: nonneg })),
  cornerSmoothing: unit,
  display: fc.constantFrom("block", "flex", "grid"),
  flexDirection: fc.constantFrom("row", "row-reverse", "column", "column-reverse"),
  flexWrap: fc.constantFrom("nowrap", "wrap", "wrap-reverse"),
  justifyContent: fc.constantFrom("normal", "center", "space-between", "flex-end"),
  alignItems: fc.constantFrom("normal", "stretch", "center", "baseline"),
  alignContent: fc.constantFrom("normal", "stretch", "space-around"),
  justifyItems: fc.constantFrom("normal", "start", "center"),
  rowGap: nonneg,
  columnGap: nonneg,
  gridTemplateColumns: trackList,
  gridTemplateRows: trackList,
  gridAutoColumns: fc.array(track, { maxLength: 2 }),
  gridAutoRows: fc.array(track, { maxLength: 2 }),
  gridAutoFlow: fc.constantFrom("row", "column", "row dense", "column dense"),
  gridTemplateAreas: fc.array(fc.constantFrom("header header", "side main", ". main"), { maxLength: 3 }),
  ...textStyle,
  textAlign: fc.constantFrom("start", "end", "left", "right", "center", "justify"),
  verticalAlign: fc.constantFrom("top", "center", "bottom"),
  paragraphSpacing: nonneg,
  paragraphIndent: num,
  textOverflow: fc.constantFrom("clip", "ellipsis"),
  maxLines: fc.integer({ min: 1, max: 20 }),
  whiteSpace: fc.constantFrom("normal", "pre", "pre-wrap", "pre-line", "nowrap"),
  textWrap: fc.constantFrom("auto", "balance", "pretty"),
  direction: fc.constantFrom("ltr", "rtl", "auto"),
  arcStart: num,
  arcSweep: fc.double({ min: -360, max: 360, noNaN: true }),
  innerRadius: unit,
  pointCount: fc.integer({ min: 3, max: 120 }),
  vectorNetwork,
  asset: fc.constantFrom(...FUZZ_ASSETS),
  objectFit: fc.constantFrom("cover", "contain", "fill", "none", "scale-down"),
  description: fc.string({ maxLength: 30 }),
  propertyDefinitions: fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), fc.record({ type: fc.constantFrom("boolean", "text", "variant"), default: fc.oneof(fc.boolean(), fc.string({ maxLength: 8 })) }), { maxKeys: 2 }),
  componentId: fc.constantFrom("comp-1", "comp-2"),
  propertyValues: fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), fc.oneof(fc.boolean(), fc.string({ maxLength: 8 })), { maxKeys: 2 }),
  backgroundColor: color,
};

/** Arbitrary for one property of one node type. */
export function propArb(type: NodeType, key: string): fc.Arbitrary<unknown> {
  if (key === "strokeWeight") {
    const perSide = type === "frame" || type === "rectangle" || type === "image" || type === "component" || type === "instance";
    return perSide ? fc.oneof(nonneg, sides(nonneg)) : nonneg;
  }
  if (key === "cornerRadius" && (type === "polygon" || type === "star" || type === "vector")) return nonneg;
  const arb = PROP_ARBS[key];
  if (!arb) throw new Error(`no arbitrary for property ${key}`);
  return arb;
}

/** A random subset of a type's properties. `required` keys are always present. */
export function propsArb(type: NodeType, required: readonly string[] = []): fc.Arbitrary<Record<string, unknown>> {
  const shape: Record<string, fc.Arbitrary<unknown>> = {};
  for (const key of Object.keys(PROPS[type])) shape[key] = propArb(type, key);
  return fc.record(shape, { requiredKeys: required as never[] });
}

/** Every property of a type set at once. */
export function fullPropsArb(type: NodeType): fc.Arbitrary<Record<string, unknown>> {
  return propsArb(type, Object.keys(PROPS[type]));
}

export const textContent: fc.Arbitrary<TextContent> = fc
  .tuple(fc.string({ maxLength: 40 }), fc.array(fc.tuple(fc.nat(), fc.nat(), fc.record(textStyle, optional)), { maxLength: 4 }))
  .map(([content, raw]) => {
    // Turn random ranges into sorted, non-overlapping runs within the content.
    const cuts = raw.map(([a, b]) => [a % (content.length + 1), b % (content.length + 1)].sort((x, y) => x - y) as [number, number]);
    cuts.sort((x, y) => x[0] - y[0]);
    const runs: TextContent["runs"] = [];
    let last = 0;
    cuts.forEach(([s, e], i) => {
      const style = raw[i]![2];
      const start = Math.max(s, last);
      if (e > start && Object.keys(style).length > 0) {
        runs.push({ start, end: e, style: style as TextContent["runs"][number]["style"] });
        last = e;
      }
    });
    return { content, runs };
  });

export const ALL_TYPES = NODE_TYPES;
