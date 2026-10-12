import { Path } from "@fig-tree/geometry";
import { harfbuzz } from "../hb";
import { decodeWoff, decodeWoff2 } from "./woff";
import { FontFormatError, Sfnt, detectFormat, readFontInfo, readNames, readVariations, type FontInfo, type FontNames, type NamedInstance, type VariationAxis } from "./sfnt";

type HbFace = InstanceType<ReturnType<typeof harfbuzz>["Face"]>;
type HbFont = InstanceType<ReturnType<typeof harfbuzz>["Font"]>;

/**
 * Positions from HarfBuzz are in font units times this factor, so variable
 * fonts and GPOS adjustments keep sub-unit precision.
 */
export const HB_SUBUNITS = 16;

let nextId = 1;

/** CSS font-style of a face: `normal`, `italic`, or `oblique` (with its angle). */
export type FaceStyle = "normal" | "italic" | "oblique";

/** OS/2 usWidthClass to CSS font-stretch percentages (CSS Fonts 4 §2.4). */
const WIDTH_CLASS_PERCENT = [100, 50, 62.5, 75, 87.5, 100, 112.5, 125, 150, 200];

/** Decodes a font file (TTF, OTF, WOFF, WOFF2) to SFNT bytes. */
export function decodeFontFile(bytes: Uint8Array): Uint8Array {
  switch (detectFormat(bytes)) {
    case "truetype":
    case "opentype":
      return bytes;
    case "woff":
      return decodeWoff(bytes);
    case "woff2":
      return decodeWoff2(bytes);
    case "collection":
      throw new FontFormatError("font collections (.ttc) are not supported");
    default:
      throw new FontFormatError("unrecognized font format");
  }
}

/**
 * One font face from a file: its tables, names, descriptive style values and
 * HarfBuzz face. Variable fonts are instanced with {@link instance}.
 */
export class Typeface {
  readonly id = nextId++;
  readonly sfnt: Sfnt;
  readonly info: FontInfo;
  readonly names: FontNames;
  readonly axes: readonly VariationAxis[];
  readonly namedInstances: readonly NamedInstance[];
  /** @internal */
  readonly hbFace: HbFace;
  private readonly instances = new Map<string, FontInstance>();
  private coverage: Uint32Array | null = null;
  /** A default-instance font for cmap lookups. */
  private probe: HbFont | null = null;

  /** Parses a font file. HarfBuzz must be loaded ({@link loadHarfBuzz}). */
  constructor(bytes: Uint8Array) {
    const sfntBytes = decodeFontFile(bytes);
    this.sfnt = new Sfnt(sfntBytes);
    this.info = readFontInfo(this.sfnt);
    this.names = readNames(this.sfnt);
    const v = readVariations(this.sfnt, this.names);
    this.axes = v.axes;
    this.namedInstances = v.instances;
    const hb = harfbuzz();
    this.hbFace = new hb.Face(new hb.Blob(sfntBytes));
  }

  get unitsPerEm(): number {
    return this.info.unitsPerEm;
  }

  /** The typographic family name (name ID 16, else 1). */
  get familyName(): string {
    return this.names.typographicFamily ?? this.names.family;
  }

  /** CSS font-weight of the default instance (OS/2 usWeightClass, or the wght axis default). */
  get weight(): number {
    const wght = this.axis("wght");
    return wght ? wght.default : this.info.weightClass;
  }

  get style(): FaceStyle {
    if (this.info.italic) return "italic";
    return this.info.italicAngle !== 0 ? "oblique" : "normal";
  }

  /** CSS font-stretch percentage of the default instance. */
  get stretch(): number {
    const wdth = this.axis("wdth");
    if (wdth) return wdth.default;
    return WIDTH_CLASS_PERCENT[Math.min(9, Math.max(1, this.info.widthClass))]!;
  }

  axis(tag: string): VariationAxis | undefined {
    return this.axes.find((a) => a.tag === tag);
  }

  get isVariable(): boolean {
    return this.axes.length > 0;
  }

  /** Whether the font maps code point `cp` to a glyph. */
  hasCodePoint(cp: number): boolean {
    this.probe ??= new (harfbuzz().Font)(this.hbFace);
    const g = this.probe.nominalGlyph(cp);
    return g !== undefined && g !== 0;
  }

  /** Every code point the font maps, sorted. */
  codePoints(): Uint32Array {
    this.coverage ??= this.hbFace.collectUnicodes().slice().sort();
    return this.coverage;
  }

  /**
   * The instance at variation coordinates (axis tag → value, clamped to the
   * axis range; missing axes take their default). Cached per coordinates.
   */
  instance(coords: Readonly<Record<string, number>> = {}): FontInstance {
    const resolved: [string, number][] = [];
    for (const a of this.axes) {
      const v = coords[a.tag];
      if (v === undefined || !Number.isFinite(v)) continue;
      const c = Math.min(a.max, Math.max(a.min, v));
      if (c !== a.default) resolved.push([a.tag, c]);
    }
    resolved.sort((x, y) => (x[0] < y[0] ? -1 : 1));
    const key = resolved.map(([t, v]) => `${t}=${v}`).join(",");
    let inst = this.instances.get(key);
    if (!inst) {
      inst = new FontInstance(this, Object.fromEntries(resolved), key);
      this.instances.set(key, inst);
    }
    return inst;
  }
}

/** Vertical metrics in font units (descender positive below the baseline). */
export interface InstanceMetrics {
  readonly ascender: number;
  readonly descender: number;
  readonly lineGap: number;
  readonly underlinePosition: number;
  readonly underlineThickness: number;
  readonly strikeoutPosition: number;
  readonly strikeoutSize: number;
  readonly xHeight: number;
  readonly capHeight: number;
}

/**
 * A typeface at fixed variation coordinates: what shaping and drawing use.
 * Sizes are applied by the caller (font units × size / unitsPerEm).
 */
export class FontInstance {
  readonly id = nextId++;
  /** @internal */
  readonly hbFont: HbFont;
  private readonly paths = new Map<number, Path>();
  private readonly advances = new Map<number, number>();
  private _metrics: InstanceMetrics | null = null;

  constructor(
    readonly typeface: Typeface,
    readonly coords: Readonly<Record<string, number>>,
    /** Canonical coordinate string (empty for the default instance). */
    readonly key: string,
  ) {
    const hb = harfbuzz();
    this.hbFont = new hb.Font(typeface.hbFace);
    const upem = typeface.unitsPerEm;
    this.hbFont.setScale(upem * HB_SUBUNITS, upem * HB_SUBUNITS);
    const vars = Object.entries(coords).map(([t, v]) => new hb.Variation(t, v));
    if (vars.length) this.hbFont.setVariations(vars);
  }

  get unitsPerEm(): number {
    return this.typeface.unitsPerEm;
  }

  /**
   * Vertical metrics. Ascent and descent follow the OS/2 typo values when
   * USE_TYPO_METRICS is set and `hhea` otherwise (as FreeType-based
   * browsers do), with MVAR variations applied.
   */
  get metrics(): InstanceMetrics {
    if (this._metrics) return this._metrics;
    const hb = harfbuzz();
    const info = this.typeface.info;
    const s = HB_SUBUNITS;
    const ext = this.hbFont.hExtents();
    const metric = (tag: number, fallback: number): number => {
      const v = this.hbFont.getMetricPosition(tag);
      return v === undefined ? fallback : v / s;
    };
    const upem = info.unitsPerEm;
    this._metrics = {
      ascender: ext.ascender / s,
      descender: -ext.descender / s,
      lineGap: ext.lineGap / s,
      underlinePosition: metric(hb.MetricsTag.UNDERLINE_OFFSET, info.underlinePosition),
      underlineThickness: metric(hb.MetricsTag.UNDERLINE_SIZE, info.underlineThickness),
      strikeoutPosition: metric(hb.MetricsTag.STRIKEOUT_OFFSET, info.strikeoutPosition ?? Math.round(upem * 0.25)),
      strikeoutSize: metric(hb.MetricsTag.STRIKEOUT_SIZE, info.strikeoutSize ?? info.underlineThickness),
      xHeight: metric(hb.MetricsTag.X_HEIGHT, info.xHeight ?? Math.round(upem * 0.5)),
      capHeight: metric(hb.MetricsTag.CAP_HEIGHT, info.capHeight ?? Math.round(upem * 0.7)),
    };
    return this._metrics;
  }

  /** Nominal glyph for a code point (0 when missing). */
  glyph(cp: number): number {
    return this.hbFont.nominalGlyph(cp) ?? 0;
  }

  /** Horizontal advance in font units. */
  advance(gid: number): number {
    let a = this.advances.get(gid);
    if (a === undefined) {
      a = this.hbFont.glyphHAdvance(gid) / HB_SUBUNITS;
      this.advances.set(gid, a);
    }
    return a;
  }

  /**
   * The glyph outline in font units, y pointing **down** (screen
   * convention), origin at the glyph origin on the baseline. Cached.
   */
  path(gid: number): Path {
    let p = this.paths.get(gid);
    if (p) return p;
    p = new Path();
    drawTarget = p;
    try {
      this.hbFont.drawGlyph(gid, glyphDrawFuncs());
    } finally {
      drawTarget = null;
    }
    this.paths.set(gid, p);
    return p;
  }

  /** Glyph ink extents in font units (y down: `top` is negative above the baseline), or null for empty glyphs. */
  extents(gid: number): { left: number; top: number; right: number; bottom: number } | null {
    const e = this.hbFont.glyphExtents(gid);
    if (!e || e.width === 0 || e.height === 0) return null;
    const s = HB_SUBUNITS;
    return { left: e.xBearing / s, top: -e.yBearing / s, right: (e.xBearing + e.width) / s, bottom: (-e.yBearing - e.height) / s };
  }
}

let drawFuncs: InstanceType<ReturnType<typeof harfbuzz>["DrawFuncs"]> | null = null;
let drawTarget: Path | null = null;

/** HarfBuzz draw callbacks, created once, writing into {@link drawTarget} (font units, y flipped down). */
function glyphDrawFuncs(): InstanceType<ReturnType<typeof harfbuzz>["DrawFuncs"]> {
  if (drawFuncs) return drawFuncs;
  const k = 1 / HB_SUBUNITS;
  const f = new (harfbuzz().DrawFuncs)();
  f.setMoveToFunc((x, y) => void drawTarget!.moveTo(x * k, -y * k));
  f.setLineToFunc((x, y) => void drawTarget!.lineTo(x * k, -y * k));
  f.setQuadraticToFunc((cx, cy, x, y) => void drawTarget!.quadTo(cx * k, -cy * k, x * k, -y * k));
  f.setCubicToFunc((c1x, c1y, c2x, c2y, x, y) => void drawTarget!.cubicTo(c1x * k, -c1y * k, c2x * k, -c2y * k, x * k, -y * k));
  f.setClosePathFunc(() => void drawTarget!.close());
  drawFuncs = f;
  return f;
}
