/**
 * Minimal OpenType (SFNT) reading: the table directory and the few tables
 * the text engine needs for font matching and metrics (`head`, `hhea`,
 * `OS/2`, `post`, `name`, `fvar`). Written from the OpenType 1.9
 * specification. Glyph outlines, cmap lookups and shaping go through
 * HarfBuzz; this module only reads descriptive data.
 */

export class FontFormatError extends Error {
  override readonly name = "FontFormatError";
}

/** A font file's container format, from its first four bytes. */
export type FontFormat = "truetype" | "opentype" | "woff" | "woff2" | "collection" | "unknown";

export function detectFormat(bytes: Uint8Array): FontFormat {
  if (bytes.length < 4) return "unknown";
  const tag = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  if (tag === "wOFF") return "woff";
  if (tag === "wOF2") return "woff2";
  if (tag === "ttcf") return "collection";
  if (tag === "OTTO") return "opentype";
  if (tag === "true" || (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0)) return "truetype";
  return "unknown";
}

export interface TableRecord {
  readonly tag: string;
  readonly offset: number;
  readonly length: number;
}

/** The table directory of an SFNT font (TrueType or CFF flavoured). */
export class Sfnt {
  readonly tables = new Map<string, TableRecord>();
  private readonly view: DataView;

  constructor(readonly bytes: Uint8Array) {
    const fmt = detectFormat(bytes);
    if (fmt !== "truetype" && fmt !== "opentype") throw new FontFormatError(`not an SFNT font (${fmt})`);
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const numTables = this.view.getUint16(4);
    if (12 + numTables * 16 > bytes.length) throw new FontFormatError("truncated table directory");
    for (let i = 0; i < numTables; i++) {
      const p = 12 + i * 16;
      const tag = String.fromCharCode(bytes[p]!, bytes[p + 1]!, bytes[p + 2]!, bytes[p + 3]!);
      const offset = this.view.getUint32(p + 8);
      const length = this.view.getUint32(p + 12);
      if (offset + length > bytes.length) throw new FontFormatError(`table ${tag} runs past the end of the file`);
      this.tables.set(tag, { tag, offset, length });
    }
  }

  has(tag: string): boolean {
    return this.tables.has(tag);
  }

  /** A view of one table, or undefined when the font has none. */
  table(tag: string): DataView | undefined {
    const t = this.tables.get(tag);
    if (!t) return undefined;
    return new DataView(this.bytes.buffer, this.bytes.byteOffset + t.offset, t.length);
  }
}

/** Font-wide values from `head`, `hhea`, `OS/2` and `post`, in font units. */
export interface FontInfo {
  readonly unitsPerEm: number;
  /** `head.flags` and `head.macStyle`. */
  readonly headFlags: number;
  readonly macStyle: number;
  readonly hheaAscender: number;
  /** Negative below the baseline, as stored. */
  readonly hheaDescender: number;
  readonly hheaLineGap: number;
  readonly typoAscender: number | undefined;
  readonly typoDescender: number | undefined;
  readonly typoLineGap: number | undefined;
  readonly winAscent: number | undefined;
  readonly winDescent: number | undefined;
  /** OS/2 fsSelection bit 7: ascent and descent come from the typo metrics. */
  readonly useTypoMetrics: boolean;
  readonly weightClass: number;
  /** OS/2 usWidthClass 1..9 (5 normal). */
  readonly widthClass: number;
  /** fsSelection italic bit (or macStyle italic), or `post.italicAngle` non-zero. */
  readonly italic: boolean;
  readonly italicAngle: number;
  readonly xHeight: number | undefined;
  readonly capHeight: number | undefined;
  readonly strikeoutPosition: number | undefined;
  readonly strikeoutSize: number | undefined;
  /** `post.underlinePosition` (top of the underline, negative below the baseline) and thickness. */
  readonly underlinePosition: number;
  readonly underlineThickness: number;
  readonly isFixedPitch: boolean;
}

export function readFontInfo(sfnt: Sfnt): FontInfo {
  const head = sfnt.table("head");
  const hhea = sfnt.table("hhea");
  if (!head || !hhea) throw new FontFormatError("missing head or hhea table");
  const os2 = sfnt.table("OS/2");
  const post = sfnt.table("post");
  const unitsPerEm = head.getUint16(18);
  if (unitsPerEm < 16 || unitsPerEm > 16384) throw new FontFormatError(`invalid unitsPerEm ${unitsPerEm}`);
  const fsSelection = os2 && os2.byteLength >= 64 ? os2.getUint16(62) : 0;
  const macStyle = head.getUint16(44);
  const italicAngle = post && post.byteLength >= 8 ? post.getInt32(4) / 65536 : 0;
  const has = (v: DataView | undefined, end: number): v is DataView => v !== undefined && v.byteLength >= end;
  return {
    unitsPerEm,
    headFlags: head.getUint16(16),
    macStyle,
    hheaAscender: hhea.getInt16(4),
    hheaDescender: hhea.getInt16(6),
    hheaLineGap: hhea.getInt16(8),
    typoAscender: has(os2, 70) ? os2.getInt16(68) : undefined,
    typoDescender: has(os2, 72) ? os2.getInt16(70) : undefined,
    typoLineGap: has(os2, 74) ? os2.getInt16(72) : undefined,
    winAscent: has(os2, 76) ? os2.getUint16(74) : undefined,
    winDescent: has(os2, 78) ? os2.getUint16(76) : undefined,
    useTypoMetrics: (fsSelection & 0x80) !== 0,
    weightClass: has(os2, 6) ? os2.getUint16(4) : 400,
    widthClass: has(os2, 8) ? os2.getUint16(6) : 5,
    italic: (fsSelection & 1) !== 0 || (macStyle & 2) !== 0,
    italicAngle,
    xHeight: has(os2, 88) && os2.getUint16(0) >= 2 ? os2.getInt16(86) : undefined,
    capHeight: has(os2, 90) && os2.getUint16(0) >= 2 ? os2.getInt16(88) : undefined,
    strikeoutSize: has(os2, 28) ? os2.getInt16(26) : undefined,
    strikeoutPosition: has(os2, 30) ? os2.getInt16(28) : undefined,
    underlinePosition: post && post.byteLength >= 12 ? post.getInt16(8) : -Math.round(unitsPerEm / 10),
    underlineThickness: post && post.byteLength >= 12 ? post.getInt16(10) : Math.round(unitsPerEm / 20),
    isFixedPitch: post !== undefined && post.byteLength >= 16 && post.getUint32(12) !== 0,
  };
}

/** Names from the `name` table (Windows Unicode or Mac Roman English records). */
export interface FontNames {
  readonly family: string;
  readonly subfamily: string;
  /** Typographic family and subfamily (name IDs 16 and 17) when present. */
  readonly typographicFamily: string | undefined;
  readonly typographicSubfamily: string | undefined;
  readonly fullName: string;
  readonly postScriptName: string;
  readonly copyright: string;
  readonly license: string;
  /** Any name by ID. */
  readonly byId: ReadonlyMap<number, string>;
}

export function readNames(sfnt: Sfnt): FontNames {
  const t = sfnt.table("name");
  const byId = new Map<number, string>();
  if (t && t.byteLength >= 6) {
    const count = t.getUint16(2);
    const storage = t.getUint16(4);
    const rank = new Map<number, number>();
    for (let i = 0; i < count && 6 + i * 12 + 12 <= t.byteLength; i++) {
      const p = 6 + i * 12;
      const platform = t.getUint16(p);
      const encoding = t.getUint16(p + 2);
      const language = t.getUint16(p + 4);
      const nameId = t.getUint16(p + 6);
      const length = t.getUint16(p + 8);
      const offset = storage + t.getUint16(p + 10);
      if (offset + length > t.byteLength) continue;
      // Prefer Windows English (US), then any Windows Unicode, then Mac Roman English.
      let r = 0;
      if (platform === 3 && (encoding === 1 || encoding === 10)) r = language === 0x409 ? 3 : 2;
      else if (platform === 0) r = 2;
      else if (platform === 1 && encoding === 0 && language === 0) r = 1;
      if (r === 0 || (rank.get(nameId) ?? 0) >= r) continue;
      let s = "";
      if (platform === 1) for (let k = 0; k < length; k++) s += String.fromCharCode(t.getUint8(offset + k));
      else for (let k = 0; k + 1 < length; k += 2) s += String.fromCharCode(t.getUint16(offset + k));
      byId.set(nameId, s);
      rank.set(nameId, r);
    }
  }
  return {
    family: byId.get(1) ?? "",
    subfamily: byId.get(2) ?? "",
    typographicFamily: byId.get(16),
    typographicSubfamily: byId.get(17),
    fullName: byId.get(4) ?? "",
    postScriptName: byId.get(6) ?? "",
    copyright: byId.get(0) ?? "",
    license: byId.get(13) ?? "",
    byId,
  };
}

export interface VariationAxis {
  readonly tag: string;
  readonly min: number;
  readonly default: number;
  readonly max: number;
  readonly hidden: boolean;
}

export interface NamedInstance {
  readonly name: string;
  readonly coordinates: Readonly<Record<string, number>>;
}

/** Variation axes and named instances from `fvar`. */
export function readVariations(sfnt: Sfnt, names: FontNames): { axes: VariationAxis[]; instances: NamedInstance[] } {
  const t = sfnt.table("fvar");
  if (!t || t.byteLength < 16) return { axes: [], instances: [] };
  const axesOffset = t.getUint16(4);
  const axisCount = t.getUint16(8);
  const axisSize = t.getUint16(10);
  const instanceCount = t.getUint16(12);
  const instanceSize = t.getUint16(14);
  const axes: VariationAxis[] = [];
  for (let i = 0; i < axisCount; i++) {
    const p = axesOffset + i * axisSize;
    if (p + 20 > t.byteLength) break;
    const tag = String.fromCharCode(t.getUint8(p), t.getUint8(p + 1), t.getUint8(p + 2), t.getUint8(p + 3));
    axes.push({ tag, min: t.getInt32(p + 4) / 65536, default: t.getInt32(p + 8) / 65536, max: t.getInt32(p + 12) / 65536, hidden: (t.getUint16(p + 16) & 1) !== 0 });
  }
  const instances: NamedInstance[] = [];
  const instStart = axesOffset + axisCount * axisSize;
  for (let i = 0; i < instanceCount; i++) {
    const p = instStart + i * instanceSize;
    if (p + 4 + axisCount * 4 > t.byteLength) break;
    const coordinates: Record<string, number> = {};
    axes.forEach((a, k) => (coordinates[a.tag] = t.getInt32(p + 4 + k * 4) / 65536));
    instances.push({ name: names.byId.get(t.getUint16(p)) ?? "", coordinates });
  }
  return { axes, instances };
}

/** Writes an SFNT file from tables (sorted by tag, 4-byte aligned, with checksums). */
export function buildSfnt(flavor: number, tables: ReadonlyMap<string, Uint8Array>): Uint8Array {
  const tags = [...tables.keys()].sort();
  const n = tags.length;
  let size = 12 + n * 16;
  for (const t of tags) size += (tables.get(t)!.length + 3) & ~3;
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  v.setUint32(0, flavor);
  v.setUint16(4, n);
  let p2 = 1;
  let log = 0;
  while (p2 * 2 <= n) {
    p2 *= 2;
    log++;
  }
  v.setUint16(6, p2 * 16);
  v.setUint16(8, log);
  v.setUint16(10, n * 16 - p2 * 16);
  let offset = 12 + n * 16;
  tags.forEach((tag, i) => {
    const data = tables.get(tag)!;
    const p = 12 + i * 16;
    for (let k = 0; k < 4; k++) out[p + k] = tag.charCodeAt(k);
    out.set(data, offset);
    v.setUint32(p + 4, checksum(out, offset, data.length));
    v.setUint32(p + 8, offset);
    v.setUint32(p + 12, data.length);
    offset += (data.length + 3) & ~3;
  });
  return out;
}

function checksum(bytes: Uint8Array, offset: number, length: number): number {
  let sum = 0;
  const end = offset + ((length + 3) & ~3);
  for (let i = offset; i < end; i += 4) {
    sum = (sum + (((bytes[i] ?? 0) << 24) | ((bytes[i + 1] ?? 0) << 16) | ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0))) >>> 0;
  }
  return sum;
}
