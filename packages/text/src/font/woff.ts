import { unzlibSync } from "fflate";
import { BrotliDecompressBuffer } from "./brotli";
import { buildSfnt, FontFormatError } from "./sfnt";

/**
 * WOFF 1.0 and WOFF 2.0 decoding to plain SFNT, written from the W3C
 * specifications (https://www.w3.org/TR/WOFF/, https://www.w3.org/TR/WOFF2/).
 * Font files are untrusted input: every offset and length is checked, and
 * the decoded size is capped.
 */

/** Largest decoded font accepted (bytes). */
export const MAX_FONT_BYTES = 64 << 20;

export function decodeWoff(bytes: Uint8Array): Uint8Array {
  const v = view(bytes);
  if (bytes.length < 44) throw new FontFormatError("truncated WOFF header");
  const flavor = v.getUint32(4);
  const numTables = v.getUint16(12);
  const totalSfntSize = v.getUint32(16);
  if (totalSfntSize > MAX_FONT_BYTES) throw new FontFormatError("WOFF font too large");
  const tables = new Map<string, Uint8Array>();
  for (let i = 0; i < numTables; i++) {
    const p = 44 + i * 20;
    if (p + 20 > bytes.length) throw new FontFormatError("truncated WOFF table directory");
    const tag = String.fromCharCode(bytes[p]!, bytes[p + 1]!, bytes[p + 2]!, bytes[p + 3]!);
    const offset = v.getUint32(p + 4);
    const compLength = v.getUint32(p + 8);
    const origLength = v.getUint32(p + 12);
    if (offset + compLength > bytes.length || origLength > MAX_FONT_BYTES) throw new FontFormatError(`WOFF table ${tag} out of bounds`);
    const data = bytes.subarray(offset, offset + compLength);
    const table = compLength < origLength ? unzlibSync(data, { out: new Uint8Array(origLength) }) : data.slice();
    if (table.length !== origLength) throw new FontFormatError(`WOFF table ${tag} has the wrong length`);
    tables.set(tag, table);
  }
  return buildSfnt(flavor, tables);
}

const KNOWN_TAGS = [
  "cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf", "loca", "prep", "CFF ", "VORG", "EBDT", "EBLC", "gasp",
  "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea", "vmtx", "BASE", "GDEF", "GPOS", "GSUB", "EBSC", "JSTF", "MATH", "CBDT", "CBLC", "COLR", "CPAL",
  "SVG ", "sbix", "acnt", "avar", "bdat", "bloc", "bsln", "cvar", "fdsc", "feat", "fmtx", "fvar", "gvar", "hsty", "just", "lcar", "mort", "morx",
  "opbd", "prop", "trak", "Zapf", "Silf", "Glat", "Gloc", "Feat", "Sill",
];

class Reader {
  pos = 0;
  private readonly v: DataView;
  constructor(readonly bytes: Uint8Array, readonly label: string) {
    this.v = view(bytes);
  }
  need(n: number): void {
    if (this.pos + n > this.bytes.length) throw new FontFormatError(`WOFF2: ${this.label} stream is truncated`);
  }
  u8(): number {
    this.need(1);
    return this.bytes[this.pos++]!;
  }
  u16(): number {
    this.need(2);
    const r = this.v.getUint16(this.pos);
    this.pos += 2;
    return r;
  }
  i16(): number {
    this.need(2);
    const r = this.v.getInt16(this.pos);
    this.pos += 2;
    return r;
  }
  u32(): number {
    this.need(4);
    const r = this.v.getUint32(this.pos);
    this.pos += 4;
    return r;
  }
  /** UIntBase128 (WOFF2 §4.1). */
  base128(): number {
    let acc = 0;
    for (let i = 0; i < 5; i++) {
      const b = this.u8();
      if (i === 0 && b === 0x80) throw new FontFormatError("WOFF2: UIntBase128 with a leading zero");
      if (acc & 0xfe000000) throw new FontFormatError("WOFF2: UIntBase128 overflow");
      acc = (acc << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) return acc >>> 0;
    }
    throw new FontFormatError("WOFF2: UIntBase128 longer than 5 bytes");
  }
  /** 255UInt16 (WOFF2 §4.2). */
  u255(): number {
    const code = this.u8();
    if (code === 253) return this.u16();
    if (code === 255) return this.u8() + 253;
    if (code === 254) return this.u8() + 506;
    return code;
  }
  bytesN(n: number): Uint8Array {
    this.need(n);
    const r = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return r;
  }
}

interface Woff2Table {
  tag: string;
  transform: number;
  origLength: number;
  transformLength: number;
  data?: Uint8Array;
}

export function decodeWoff2(bytes: Uint8Array): Uint8Array {
  const r = new Reader(bytes, "header");
  if (r.u32() !== 0x774f4632) throw new FontFormatError("not a WOFF2 file");
  const flavor = r.u32();
  if (flavor === 0x74746366) throw new FontFormatError("WOFF2 font collections are not supported");
  r.u32(); // length
  const numTables = r.u16();
  r.u16(); // reserved
  const totalSfntSize = r.u32();
  const totalCompressedSize = r.u32();
  r.pos += 4 + 4 * 5; // version, meta and private blocks
  if (totalSfntSize > MAX_FONT_BYTES) throw new FontFormatError("WOFF2 font too large");
  const tables: Woff2Table[] = [];
  let total = 0;
  for (let i = 0; i < numTables; i++) {
    const flags = r.u8();
    const known = flags & 0x3f;
    let tag: string;
    if (known === 63) {
      const t = r.u32();
      tag = String.fromCharCode((t >>> 24) & 0xff, (t >>> 16) & 0xff, (t >>> 8) & 0xff, t & 0xff);
    } else {
      tag = KNOWN_TAGS[known] ?? "";
      if (!tag) throw new FontFormatError(`WOFF2: unknown table index ${known}`);
    }
    const transform = flags >>> 6;
    const origLength = r.base128();
    // glyf and loca are transformed unless the version is 3; other tables are transformed unless it is 0.
    const transformed = tag === "glyf" || tag === "loca" ? transform !== 3 : transform !== 0;
    const transformLength = transformed ? r.base128() : origLength;
    if (origLength > MAX_FONT_BYTES || transformLength > MAX_FONT_BYTES) throw new FontFormatError(`WOFF2 table ${tag} too large`);
    tables.push({ tag, transform: transformed ? transform : -1, origLength, transformLength });
    total += transformLength;
  }
  const compressed = bytes.subarray(r.pos, r.pos + totalCompressedSize);
  if (compressed.length !== totalCompressedSize) throw new FontFormatError("WOFF2: truncated compressed data");
  const stream = BrotliDecompressBuffer(compressed, total);
  if (stream.length < total) throw new FontFormatError("WOFF2: decompressed data is too short");
  let at = 0;
  for (const t of tables) {
    t.data = stream.subarray(at, at + t.transformLength);
    at += t.transformLength;
  }
  const out = new Map<string, Uint8Array>();
  const byTag = new Map(tables.map((t) => [t.tag, t]));
  const glyf = byTag.get("glyf");
  const loca = byTag.get("loca");
  let glyphInfo: { xMins: Int16Array; numGlyphs: number } | null = null;
  if (glyf && glyf.transform === 0) {
    if (!loca) throw new FontFormatError("WOFF2: transformed glyf without loca");
    const rebuilt = reconstructGlyf(glyf.data!);
    out.set("glyf", rebuilt.glyf);
    out.set("loca", rebuilt.loca);
    if (rebuilt.loca.length !== loca.origLength) throw new FontFormatError("WOFF2: reconstructed loca has the wrong size");
    glyphInfo = { xMins: rebuilt.xMins, numGlyphs: rebuilt.numGlyphs };
  }
  for (const t of tables) {
    if (out.has(t.tag)) continue;
    if (t.tag === "hmtx" && t.transform === 1) {
      if (!glyphInfo) throw new FontFormatError("WOFF2: transformed hmtx needs a transformed glyf");
      const hhea = out.get("hhea") ?? byTag.get("hhea")?.data;
      if (!hhea || hhea.length < 36) throw new FontFormatError("WOFF2: missing hhea");
      out.set("hmtx", reconstructHmtx(t.data!, view(hhea).getUint16(34), glyphInfo.numGlyphs, glyphInfo.xMins));
    } else if (t.transform > 0 || (t.transform === 0 && t.tag !== "glyf" && t.tag !== "loca")) {
      throw new FontFormatError(`WOFF2: unsupported transform ${t.transform} of ${t.tag}`);
    } else {
      out.set(t.tag, t.data!.slice());
    }
  }
  // head.flags bit 11: the font was transformed losslessly; checkSumAdjustment is left as is.
  return buildSfnt(flavor, out);
}

/** The triplet encoding of glyph coordinates (WOFF2 §5.2, the 128-entry table). */
function tripletEntry(flag: number): { bytes: number; xBits: number; yBits: number; dx: number; dy: number; xSign: number; ySign: number } {
  const f = flag & 0x7f;
  if (f < 10) return { bytes: 1, xBits: 0, yBits: 8, dx: 0, dy: (f >> 1) * 256, xSign: 0, ySign: f & 1 ? 1 : -1 };
  if (f < 20) {
    const j = f - 10;
    return { bytes: 1, xBits: 8, yBits: 0, dx: (j >> 1) * 256, dy: 0, xSign: j & 1 ? 1 : -1, ySign: 0 };
  }
  if (f < 84) {
    const j = f - 20;
    return { bytes: 1, xBits: 4, yBits: 4, dx: 1 + 16 * (j >> 4), dy: 1 + 16 * ((j >> 2) & 3), xSign: j & 1 ? 1 : -1, ySign: j & 2 ? 1 : -1 };
  }
  if (f < 120) {
    const j = f - 84;
    return { bytes: 2, xBits: 8, yBits: 8, dx: 1 + 256 * Math.floor(j / 12), dy: 1 + 256 * ((j % 12) >> 2), xSign: j & 1 ? 1 : -1, ySign: j & 2 ? 1 : -1 };
  }
  const j = f - (f < 124 ? 120 : 124);
  const bits = f < 124 ? 12 : 16;
  return { bytes: f < 124 ? 3 : 4, xBits: bits, yBits: bits, dx: 0, dy: 0, xSign: j & 1 ? 1 : -1, ySign: j & 2 ? 1 : -1 };
}

const TRIPLETS = Array.from({ length: 128 }, (_, i) => tripletEntry(i));

function reconstructGlyf(data: Uint8Array): { glyf: Uint8Array; loca: Uint8Array; xMins: Int16Array; numGlyphs: number } {
  const h = new Reader(data, "glyf header");
  h.u16(); // reserved
  const optionFlags = h.u16();
  const numGlyphs = h.u16();
  const indexFormat = h.u16();
  const sizes = Array.from({ length: 7 }, () => h.u32());
  let at = h.pos;
  const streams = sizes.map((n, i) => {
    if (at + n > data.length) throw new FontFormatError(`WOFF2: glyf stream ${i} out of bounds`);
    const s = new Reader(data.subarray(at, at + n), ["nContour", "nPoints", "flag", "glyph", "composite", "bbox", "instruction"][i]!);
    at += n;
    return s;
  });
  const [nContours, nPoints, flagStream, glyphStream, compositeStream, bboxStream, instructionStream] = streams as [Reader, Reader, Reader, Reader, Reader, Reader, Reader];
  // The bbox stream starts with the bbox bitmap (4-byte aligned bits per glyph).
  const bitmapLen = ((numGlyphs + 31) >> 5) << 2;
  const bboxBitmap = bboxStream.bytesN(bitmapLen);
  let overlapBitmap: Uint8Array | null = null;
  if (optionFlags & 1) {
    const n = (numGlyphs + 7) >> 3;
    if (at + n > data.length) throw new FontFormatError("WOFF2: overlap bitmap out of bounds");
    overlapBitmap = data.subarray(at, at + n);
  }
  const parts: Uint8Array[] = [];
  const offsets = new Uint32Array(numGlyphs + 1);
  const xMins = new Int16Array(numGlyphs);
  let size = 0;
  const bit = (bm: Uint8Array, i: number): boolean => (bm[i >> 3]! & (0x80 >> (i & 7))) !== 0;
  for (let g = 0; g < numGlyphs; g++) {
    offsets[g] = size;
    const nc = nContours.i16();
    const explicitBbox = bit(bboxBitmap, g);
    let glyph: Uint8Array;
    if (nc === 0) {
      if (explicitBbox) throw new FontFormatError("WOFF2: empty glyph with a bounding box");
      glyph = new Uint8Array(0);
    } else if (nc === -1) {
      if (!explicitBbox) throw new FontFormatError("WOFF2: composite glyph without a bounding box");
      const start = compositeStream.pos;
      let haveInstructions = false;
      for (;;) {
        const flags = compositeStream.u16();
        compositeStream.u16(); // glyph index
        compositeStream.bytesN(flags & 1 ? 4 : 2); // ARG_1_AND_2_ARE_WORDS
        if (flags & 8) compositeStream.bytesN(2); // WE_HAVE_A_SCALE
        else if (flags & 0x40) compositeStream.bytesN(4); // X_AND_Y_SCALE
        else if (flags & 0x80) compositeStream.bytesN(8); // TWO_BY_TWO
        if (flags & 0x100) haveInstructions = true;
        if (!(flags & 0x20)) break; // MORE_COMPONENTS
      }
      const comp = compositeStream.bytes.subarray(start, compositeStream.pos);
      const instrLen = haveInstructions ? glyphStream.u255() : 0;
      const instr = instructionStream.bytesN(instrLen);
      const bbox = bboxStream.bytesN(8);
      glyph = new Uint8Array(10 + comp.length + (haveInstructions ? 2 + instrLen : 0));
      const gv = view(glyph);
      gv.setInt16(0, -1);
      glyph.set(bbox, 2);
      glyph.set(comp, 10);
      if (haveInstructions) {
        gv.setUint16(10 + comp.length, instrLen);
        glyph.set(instr, 12 + comp.length);
      }
      xMins[g] = view(bbox).getInt16(0);
    } else if (nc > 0) {
      const endPts: number[] = [];
      let total = 0;
      for (let c = 0; c < nc; c++) {
        total += nPoints.u255();
        endPts.push(total - 1);
      }
      const xs = new Int32Array(total);
      const ys = new Int32Array(total);
      const on = new Uint8Array(total);
      let x = 0;
      let y = 0;
      for (let p = 0; p < total; p++) {
        const flag = flagStream.u8();
        const t = TRIPLETS[flag & 0x7f]!;
        on[p] = flag & 0x80 ? 0 : 1;
        const b = glyphStream.bytesN(t.bytes);
        let dx = 0;
        let dy = 0;
        if (t.xBits === 0) dy = b[0]!;
        else if (t.yBits === 0) dx = b[0]!;
        else if (t.xBits === 4) {
          dx = b[0]! >> 4;
          dy = b[0]! & 15;
        } else if (t.xBits === 8) {
          dx = b[0]!;
          dy = b[1]!;
        } else if (t.xBits === 12) {
          dx = (b[0]! << 4) | (b[1]! >> 4);
          dy = ((b[1]! & 15) << 8) | b[2]!;
        } else {
          dx = (b[0]! << 8) | b[1]!;
          dy = (b[2]! << 8) | b[3]!;
        }
        x += t.xSign * (dx + t.dx);
        y += t.ySign * (dy + t.dy);
        xs[p] = x;
        ys[p] = y;
      }
      const instrLen = glyphStream.u255();
      const instr = instructionStream.bytesN(instrLen);
      let xMin: number, yMin: number, xMax: number, yMax: number;
      if (explicitBbox) {
        const bv = view(bboxStream.bytesN(8));
        xMin = bv.getInt16(0);
        yMin = bv.getInt16(2);
        xMax = bv.getInt16(4);
        yMax = bv.getInt16(6);
      } else {
        xMin = yMin = Infinity;
        xMax = yMax = -Infinity;
        for (let p = 0; p < total; p++) {
          xMin = Math.min(xMin, xs[p]!);
          xMax = Math.max(xMax, xs[p]!);
          yMin = Math.min(yMin, ys[p]!);
          yMax = Math.max(yMax, ys[p]!);
        }
      }
      glyph = encodeSimpleGlyph(endPts, xs, ys, on, instr, [xMin, yMin, xMax, yMax], overlapBitmap !== null && bit(overlapBitmap, g));
      xMins[g] = xMin;
    } else {
      throw new FontFormatError(`WOFF2: invalid contour count ${nc}`);
    }
    parts.push(glyph);
    size += (glyph.length + 3) & ~3; // 4-byte aligned glyphs work for both loca formats
  }
  offsets[numGlyphs] = size;
  if (size > MAX_FONT_BYTES) throw new FontFormatError("WOFF2: glyf too large");
  const glyf = new Uint8Array(size);
  parts.forEach((p, g) => glyf.set(p, offsets[g]!));
  const loca = new Uint8Array((numGlyphs + 1) * (indexFormat ? 4 : 2));
  const lv = view(loca);
  for (let g = 0; g <= numGlyphs; g++) {
    if (indexFormat) lv.setUint32(g * 4, offsets[g]!);
    else lv.setUint16(g * 2, offsets[g]! / 2);
  }
  return { glyf, loca, xMins, numGlyphs };
}

/** A TrueType simple glyph, with flag repeats and short coordinates. */
function encodeSimpleGlyph(endPts: number[], xs: Int32Array, ys: Int32Array, on: Uint8Array, instr: Uint8Array, bbox: number[], overlap: boolean): Uint8Array {
  const n = xs.length;
  const flags: number[] = [];
  const xBytes: number[] = [];
  const yBytes: number[] = [];
  let px = 0;
  let py = 0;
  for (let p = 0; p < n; p++) {
    let f = on[p] ? 1 : 0;
    if (p === 0 && overlap) f |= 0x40;
    const dx = xs[p]! - px;
    const dy = ys[p]! - py;
    px = xs[p]!;
    py = ys[p]!;
    if (dx === 0) f |= 0x10;
    else if (dx >= -255 && dx <= 255) {
      f |= 0x02 | (dx > 0 ? 0x10 : 0);
      xBytes.push(Math.abs(dx));
    } else xBytes.push((dx >> 8) & 0xff, dx & 0xff);
    if (dy === 0) f |= 0x20;
    else if (dy >= -255 && dy <= 255) {
      f |= 0x04 | (dy > 0 ? 0x20 : 0);
      yBytes.push(Math.abs(dy));
    } else yBytes.push((dy >> 8) & 0xff, dy & 0xff);
    flags.push(f);
  }
  // Repeat runs of equal flags.
  const packed: number[] = [];
  for (let i = 0; i < flags.length; ) {
    let run = 1;
    while (i + run < flags.length && flags[i + run] === flags[i] && run < 256) run++;
    if (run > 1) {
      packed.push(flags[i]! | 0x08, run - 1);
    } else packed.push(flags[i]!);
    i += run;
  }
  const len = 10 + endPts.length * 2 + 2 + instr.length + packed.length + xBytes.length + yBytes.length;
  const out = new Uint8Array(len);
  const v = view(out);
  v.setInt16(0, endPts.length);
  bbox.forEach((b, i) => v.setInt16(2 + i * 2, b));
  let p = 10;
  for (const e of endPts) {
    v.setUint16(p, e);
    p += 2;
  }
  v.setUint16(p, instr.length);
  p += 2;
  out.set(instr, p);
  p += instr.length;
  out.set(packed, p);
  p += packed.length;
  out.set(xBytes, p);
  p += xBytes.length;
  out.set(yBytes, p);
  return out;
}

/** hmtx transform version 1 (WOFF2 §5.4): side bearings omitted where they equal the glyph's xMin. */
function reconstructHmtx(data: Uint8Array, numHMetrics: number, numGlyphs: number, xMins: Int16Array): Uint8Array {
  const r = new Reader(data, "hmtx");
  const flags = r.u8();
  const advances: number[] = [];
  for (let i = 0; i < numHMetrics; i++) advances.push(r.u16());
  const lsbs: number[] = [];
  for (let i = 0; i < numHMetrics; i++) lsbs.push(flags & 1 ? xMins[i]! : r.i16());
  for (let i = numHMetrics; i < numGlyphs; i++) lsbs.push(flags & 2 ? xMins[i]! : r.i16());
  const out = new Uint8Array(numHMetrics * 4 + (numGlyphs - numHMetrics) * 2);
  const v = view(out);
  for (let i = 0; i < numHMetrics; i++) {
    v.setUint16(i * 4, advances[i]!);
    v.setInt16(i * 4 + 2, lsbs[i]!);
  }
  for (let i = numHMetrics; i < numGlyphs; i++) v.setInt16(numHMetrics * 4 + (i - numHMetrics) * 2, lsbs[i]!);
  return out;
}

function view(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}
