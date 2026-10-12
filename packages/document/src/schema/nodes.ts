import { z } from "zod";
import {
  boxProps,
  containerProps,
  cornerProps,
  geometryProps,
  itemProps,
  overflowProps,
  positionProps,
  sizingProps,
} from "./layout";
import {
  EffectStack,
  MiterLimit,
  PaintStack,
  StrokeAlign,
  StrokeCap,
  StrokeDashes,
  StrokeJoin,
  StrokeWeight,
} from "./paint";
import { AssetId, BlendMode, Color, NodeId, NonNegative, Num, Unit, optionalShape } from "./primitives";
import { textBoxProps, textStyleProps } from "./text";
import { VectorNetwork } from "./vector";

export const NODE_TYPES = [
  "page",
  "frame",
  "group",
  "rectangle",
  "ellipse",
  "polygon",
  "star",
  "line",
  "vector",
  "text",
  "image",
  "component",
  "instance",
] as const;
export const NodeType = z.enum(NODE_TYPES);
export type NodeType = z.infer<typeof NodeType>;

// ── Property groups ──────────────────────────────────────────────────────

/** Every layer (all types except pages). */
const layerProps = {
  name: z.string().max(1_000),
  visible: z.boolean(),
  locked: z.boolean(),
  opacity: Unit,
  /** CSS `mix-blend-mode` of the whole layer. */
  blendMode: BlendMode,
  /**
   * CSS `isolation`. With `auto` and blend mode `normal` the layer's children
   * blend straight into what is below the layer ("pass through").
   */
  isolation: z.enum(["auto", "isolate"]),
  effects: EffectStack,
  /**
   * Reserved for components (module 7): the id of the node in the main
   * component that this node mirrors, as in an instance's subtree.
   */
  componentRef: NodeId,
  /** Reserved for components: property groups overridden in this instance node. */
  overrides: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/).max(64)).max(64),
};

/** Layers that occupy a box in their parent. */
const placedProps = { ...geometryProps, ...sizingProps, ...positionProps, ...itemProps };

const strokeStyleProps = {
  strokes: PaintStack,
  strokeWeight: NonNegative,
  strokeAlign: StrokeAlign,
  strokeCap: StrokeCap,
  strokeJoin: StrokeJoin,
  strokeMiterLimit: MiterLimit,
  strokeDashes: StrokeDashes,
  strokeDashOffset: Num,
};

const paintProps = { fills: PaintStack, ...strokeStyleProps };

/** Rectangles and frames take per-side stroke weights, like CSS borders. */
const boxPaintProps = { ...paintProps, strokeWeight: StrokeWeight };

const frameProps = {
  ...layerProps,
  ...placedProps,
  ...boxPaintProps,
  ...boxProps,
  ...overflowProps,
  ...cornerProps,
  ...containerProps,
};

/** Reserved component property definitions (module 7). */
const ComponentPropertyDefinition = z.strictObject({
  type: z.enum(["boolean", "text", "instance-swap", "variant"]),
  default: z.union([z.string().max(10_000), z.boolean()]),
  /** Allowed values of a variant property. */
  options: z.array(z.string().max(1_000)).max(1_000).optional(),
});

export const PROPS = {
  page: {
    name: z.string().max(1_000),
    /** Canvas color behind the page's content. */
    backgroundColor: Color,
  },
  frame: frameProps,
  group: { ...layerProps, ...positionProps, ...itemProps },
  rectangle: { ...layerProps, ...placedProps, ...boxPaintProps, ...cornerProps },
  ellipse: {
    ...layerProps,
    ...placedProps,
    ...paintProps,
    /** Start of the arc in degrees, clockwise from 3 o'clock. */
    arcStart: Num,
    /** Arc sweep in degrees; ±360 is a full ellipse. */
    arcSweep: z.number().min(-360).max(360),
    /** Inner radius as a fraction of the outer one (a donut when > 0). */
    innerRadius: Unit,
  },
  polygon: {
    ...layerProps,
    ...placedProps,
    ...paintProps,
    pointCount: z.number().int().min(3).max(120),
    cornerRadius: NonNegative,
  },
  star: {
    ...layerProps,
    ...placedProps,
    ...paintProps,
    pointCount: z.number().int().min(3).max(120),
    /** Inner vertices' distance from the center as a fraction of the tips'. */
    innerRadius: Unit,
    cornerRadius: NonNegative,
  },
  /** A straight line along the box's top edge: its length is `width`; rotate it to change direction. */
  line: { ...layerProps, ...placedProps, ...strokeStyleProps },
  vector: {
    ...layerProps,
    ...placedProps,
    ...paintProps,
    vectorNetwork: VectorNetwork,
    /** Default corner radius of vertices that do not set their own. */
    cornerRadius: NonNegative,
  },
  text: { ...layerProps, ...placedProps, ...paintProps, ...textStyleProps, ...textBoxProps },
  image: {
    ...layerProps,
    ...placedProps,
    ...boxPaintProps,
    ...cornerProps,
    asset: AssetId,
    /** CSS `object-fit` of the bitmap in the box. */
    objectFit: z.enum(["cover", "contain", "fill", "none", "scale-down"]),
  },
  component: {
    ...frameProps,
    description: z.string().max(100_000),
    propertyDefinitions: z.record(z.string().min(1).max(256), ComponentPropertyDefinition),
  },
  instance: {
    ...frameProps,
    /** Reserved for module 7: the main component this is an instance of. */
    componentId: NodeId,
    propertyValues: z.record(z.string().min(1).max(256), z.union([z.string().max(10_000), z.boolean()])),
  },
} as const satisfies Record<NodeType, Record<string, z.ZodType>>;

export type PropShapes = typeof PROPS;
export type NodePropsOf<T extends NodeType> = { -readonly [K in keyof PropShapes[T]]?: z.infer<PropShapes[T][K]> };
/** Properties of any node type (each key typed as in the types that accept it). */
export type AnyNodeProps = UnionToIntersection<{ [T in NodeType]: NodePropsOf<T> }[NodeType]>;
type UnionToIntersection<U> = (U extends unknown ? (u: U) => void : never) extends (i: infer I) => void ? I : never;

/** Strict schema of all of a type's stored properties (each optional). */
export const PropsSchema = Object.fromEntries(
  NODE_TYPES.map((t) => [t, z.strictObject(optionalShape(PROPS[t] as Record<string, z.ZodType>))]),
) as unknown as { [T in NodeType]: z.ZodType<NodePropsOf<T>> };

/** Whether a property key is valid for a node type. */
export function hasProp(type: NodeType, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(PROPS[type], key);
}

/** The schema of one property of one type, or undefined when the type does not have it. */
export function propSchema(type: NodeType, key: string): z.ZodType | undefined {
  return hasProp(type, key) ? (PROPS[type] as Record<string, z.ZodType>)[key] : undefined;
}

// ── Tree rules ───────────────────────────────────────────────────────────

const CONTAINERS: ReadonlySet<NodeType> = new Set(["page", "frame", "group", "component", "instance"]);

/** Whether nodes of this type may have children. */
export function isContainer(type: NodeType): boolean {
  return CONTAINERS.has(type);
}

/**
 * Whether a node of type `child` may live under `parent` (`null` = the
 * document root). Pages live only at the root, and only pages live there.
 */
export function canContain(parent: NodeType | null, child: NodeType): boolean {
  if (parent === null) return child === "page";
  if (child === "page") return false;
  return CONTAINERS.has(parent);
}

// ── Defaults ─────────────────────────────────────────────────────────────

const TYPE_LABELS: Record<NodeType, string> = {
  page: "Page",
  frame: "Frame",
  group: "Group",
  rectangle: "Rectangle",
  ellipse: "Ellipse",
  polygon: "Polygon",
  star: "Star",
  line: "Line",
  vector: "Vector",
  text: "Text",
  image: "Image",
  component: "Component",
  instance: "Instance",
};

export function typeLabel(type: NodeType): string {
  return TYPE_LABELS[type];
}

const ZERO_SIDES = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * Values a property has when it is not stored. Most follow CSS initial
 * values. Files store only explicitly set properties, so these defaults are
 * part of the format: changing one needs a format migration.
 */
const COMMON_DEFAULTS: Record<string, unknown> = {
  visible: true,
  locked: false,
  opacity: 1,
  blendMode: "normal",
  isolation: "auto",
  effects: [],
  overrides: [],
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  rotation: 0,
  flipX: false,
  flipY: false,
  widthMode: "fixed",
  heightMode: "fixed",
  position: "absolute",
  constraints: { horizontal: "start", vertical: "start" },
  flexGrow: 0,
  flexShrink: 1,
  flexBasis: "auto",
  alignSelf: "auto",
  justifySelf: "auto",
  order: 0,
  gridColumn: { start: "auto", end: "auto" },
  gridRow: { start: "auto", end: "auto" },
  margin: ZERO_SIDES,
  fills: [],
  strokes: [],
  strokeWeight: 1,
  strokeAlign: "inside",
  strokeCap: "butt",
  strokeJoin: "miter",
  strokeMiterLimit: 4,
  strokeDashes: [],
  strokeDashOffset: 0,
  boxSizing: "border-box",
  padding: ZERO_SIDES,
  strokesInLayout: false,
  overflowX: "visible",
  overflowY: "visible",
  cornerRadius: 0,
  cornerSmoothing: 0,
  display: "block",
  flexDirection: "row",
  flexWrap: "nowrap",
  justifyContent: "normal",
  alignItems: "normal",
  alignContent: "normal",
  justifyItems: "normal",
  rowGap: 0,
  columnGap: 0,
  gridTemplateColumns: [],
  gridTemplateRows: [],
  gridAutoColumns: [],
  gridAutoRows: [],
  gridAutoFlow: "row",
  gridTemplateAreas: [],
  // Text: CSS initial values, except white-space, which preserves what is typed.
  fontFamily: "sans-serif",
  fontWeight: 400,
  fontStyle: "normal",
  fontStretch: 100,
  fontSize: 16,
  lineHeight: "normal",
  letterSpacing: { unit: "px", value: 0 },
  textDecoration: "none",
  textTransform: "none",
  fontFeatures: {},
  fontVariations: {},
  textAlign: "start",
  verticalAlign: "top",
  paragraphSpacing: 0,
  paragraphIndent: 0,
  textOverflow: "clip",
  whiteSpace: "pre-wrap",
  textWrap: "auto",
  direction: "auto",
  listStyle: "none",
  listLevel: 0,
  // Shapes
  arcStart: 0,
  arcSweep: 360,
  innerRadius: 0,
  pointCount: 3,
  vectorNetwork: { vertices: [], segments: [], regions: [] },
  objectFit: "cover",
  description: "",
  propertyDefinitions: {},
  propertyValues: {},
  backgroundColor: { r: 0.96, g: 0.96, b: 0.95, a: 1 },
};

const TYPE_DEFAULTS: Partial<Record<NodeType, Record<string, unknown>>> = {
  line: { strokeAlign: "center" },
  vector: { strokeAlign: "center" },
  text: { widthMode: "hug", heightMode: "hug" },
  star: { pointCount: 5, innerRadius: 0.382 },
  polygon: { pointCount: 3 },
};

/** The value of `key` on a node of `type` when nothing is stored. */
export function defaultProp(type: NodeType, key: string): unknown {
  if (key === "name") return TYPE_LABELS[type];
  const typed = TYPE_DEFAULTS[type];
  if (typed && key in typed) return typed[key];
  return COMMON_DEFAULTS[key];
}
