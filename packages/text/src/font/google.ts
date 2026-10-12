import type { FaceDescriptor, FontFaceEntry, FontRegistry } from "./registry";

/**
 * Google Fonts as a font source: family metadata and font files from the
 * google/fonts repository (github.com/google/fonts), where every family is
 * a directory under its license (`ofl/`, `apache/` or `ufl/`) with a
 * `METADATA.pb` (protocol buffer text format) listing its font files,
 * styles, weights and variation axes. Only families under the SIL Open
 * Font License, the Apache License 2.0 or the Ubuntu Font Licence are
 * accepted. Fetched files are untrusted data: metadata is parsed as text,
 * fonts by the font decoders, and both are size-limited.
 */

export type GoogleFontsLicense = "OFL" | "APACHE2" | "UFL";

/** License directories of the repository, in lookup order, and the license each holds. */
const LICENSE_DIRS: readonly (readonly [dir: string, license: GoogleFontsLicense])[] = [
  ["ofl", "OFL"],
  ["apache", "APACHE2"],
  ["ufl", "UFL"],
];

export interface GoogleFontFile {
  readonly style: "normal" | "italic";
  /** Weight of the file's default instance (CSS font-weight). */
  readonly weight: number;
  readonly filename: string;
}

export interface GoogleFontAxis {
  readonly tag: string;
  readonly min: number;
  readonly max: number;
}

export interface GoogleFamily {
  readonly name: string;
  readonly license: GoogleFontsLicense;
  /** Repository directory, e.g. `ofl/inter`. */
  readonly directory: string;
  readonly category: string;
  readonly designer: string;
  readonly fonts: readonly GoogleFontFile[];
  readonly axes: readonly GoogleFontAxis[];
  readonly subsets: readonly string[];
}

export class GoogleFontsError extends Error {}

export interface GoogleFontsOptions {
  /** `fetch` to use (tests inject one); defaults to the global. */
  readonly fetch?: (url: string) => Promise<Response>;
  /** Repository root URL; defaults to the `main` branch on raw.githubusercontent.com. */
  readonly baseUrl?: string;
  /** Largest font file accepted, in bytes (default 32 MB). */
  readonly maxFontBytes?: number;
}

const DEFAULT_BASE = "https://raw.githubusercontent.com/google/fonts/main/";
const MAX_METADATA_BYTES = 1 << 20;

/** The repository directory name of a family: lowercase letters and digits only ("Noto Sans" → "notosans"). */
export function googleFamilyDirectory(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** A message of the protocol buffer text format: field name → values (fields may repeat). */
export type TextProtoMessage = Map<string, (string | number | TextProtoMessage)[]>;

/** Parses protocol buffer text format (as in METADATA.pb) into nested messages. */
export function parseTextProto(text: string): TextProtoMessage {
  let i = 0;
  const n = text.length;
  const fail = (what: string): never => {
    throw new GoogleFontsError(`METADATA.pb: ${what} at offset ${i}`);
  };
  const skip = (): void => {
    while (i < n) {
      const c = text[i]!;
      if (c === "#") while (i < n && text[i] !== "\n") i++;
      else if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === ",") i++;
      else break;
    }
  };
  const ident = (): string => {
    const m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(text.slice(i, i + 256));
    if (!m) fail("expected a field name");
    i += m![0].length;
    return m![0];
  };
  const string = (): string => {
    const quote = text[i]!;
    i++;
    let out = "";
    let escapedBytes = false;
    while (i < n && text[i] !== quote) {
      let c = text[i++]!;
      if (c === "\\") {
        const e = text[i++] ?? "";
        if (e === "n") c = "\n";
        else if (e === "t") c = "\t";
        else if (e === "r") c = "\r";
        else if (/[0-7]/.test(e)) {
          let oct = e;
          while (oct.length < 3 && /[0-7]/.test(text[i] ?? "")) oct += text[i++];
          c = String.fromCharCode(parseInt(oct, 8));
          escapedBytes = true;
        } else if (e === "x") {
          const hex = /^[0-9a-fA-F]{1,2}/.exec(text.slice(i, i + 2))?.[0] ?? fail("bad escape");
          i += hex.length;
          c = String.fromCharCode(parseInt(hex, 16));
          escapedBytes = true;
        } else c = e;
      }
      out += c;
    }
    if (i >= n) fail("unterminated string");
    i++;
    // Strings are UTF-8: bytes written as escapes are decoded (raw text already is).
    if (escapedBytes && !/[^\x00-\xff]/.test(out)) out = decodeLatin1Utf8(out);
    // Adjacent string literals concatenate.
    skip();
    if (text[i] === '"' || text[i] === "'") out += string();
    return out;
  };
  const message = (depth: number): TextProtoMessage => {
    if (depth > 16) fail("nesting too deep");
    const fields: TextProtoMessage = new Map();
    for (;;) {
      skip();
      if (i >= n || text[i] === "}") return fields;
      const name = ident();
      skip();
      let value: string | number | TextProtoMessage;
      if (text[i] === ":") {
        i++;
        skip();
      }
      const c = text[i];
      if (c === "{" || c === "<") {
        const close = c === "{" ? "}" : ">";
        i++;
        value = message(depth + 1);
        skip();
        if (text[i] !== close) fail(`expected "${close}"`);
        i++;
      } else if (c === '"' || c === "'") value = string();
      else {
        const m = /^[^\s,{}<>#]+/.exec(text.slice(i, i + 64));
        if (!m) fail("expected a value");
        i += m![0].length;
        const num = Number(m![0]);
        value = Number.isFinite(num) ? num : m![0];
      }
      const list = fields.get(name) ?? [];
      list.push(value);
      fields.set(name, list);
    }
  };
  const root = message(0);
  skip();
  if (i < n) fail("unexpected }");
  return root;
}

function decodeLatin1Utf8(s: string): string {
  const bytes = Uint8Array.from(s, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

const str = (m: TextProtoMessage, k: string): string => {
  const v = m.get(k)?.[0];
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
};
const num = (m: TextProtoMessage, k: string): number => {
  const v = m.get(k)?.[0];
  return typeof v === "number" ? v : Number(v);
};
const messages = (m: TextProtoMessage, k: string): TextProtoMessage[] => (m.get(k) ?? []).filter((v): v is TextProtoMessage => v instanceof Map);

/**
 * A family from its METADATA.pb, found in `directory`. Throws when the
 * family's license is not one of the accepted ones, or the metadata is not
 * a usable family.
 */
export function googleFamilyFromMetadata(text: string, directory: string): GoogleFamily {
  const m = parseTextProto(text);
  const name = str(m, "name");
  const license = str(m, "license");
  if (!name) throw new GoogleFontsError(`${directory}: METADATA.pb has no family name`);
  if (license !== "OFL" && license !== "APACHE2" && license !== "UFL") throw new GoogleFontsError(`${name}: license ${license || "(none)"} is not accepted (only OFL, Apache 2.0 and UFL)`);
  const expected = LICENSE_DIRS.find(([, l]) => l === license)![0];
  if (!directory.startsWith(`${expected}/`)) throw new GoogleFontsError(`${name}: METADATA.pb says ${license} but the family is in ${directory}`);
  const fonts: GoogleFontFile[] = [];
  for (const f of messages(m, "fonts")) {
    const filename = str(f, "filename");
    // File names are plain names inside the family directory.
    if (!/^[A-Za-z0-9_\-[\],.]+\.(ttf|otf)$/.test(filename) || filename.includes("..")) throw new GoogleFontsError(`${name}: unexpected font file name ${JSON.stringify(filename)}`);
    const style = str(f, "style") === "italic" ? "italic" : "normal";
    const weight = num(f, "weight");
    fonts.push({ style, weight: Number.isFinite(weight) && weight >= 1 && weight <= 1000 ? weight : 400, filename });
  }
  if (fonts.length === 0) throw new GoogleFontsError(`${name}: METADATA.pb lists no font files`);
  const axes = messages(m, "axes")
    .map((a) => ({ tag: str(a, "tag"), min: num(a, "min_value"), max: num(a, "max_value") }))
    .filter((a) => /^[\x20-\x7e]{4}$/.test(a.tag) && Number.isFinite(a.min) && Number.isFinite(a.max) && a.min <= a.max);
  const subsets = (m.get("subsets") ?? []).filter((v): v is string => typeof v === "string");
  return { name, license, directory, category: str(m, "category"), designer: str(m, "designer"), fonts, axes, subsets };
}

/** The `@font-face` descriptor of one of a family's files (variable axes become ranges). */
export function googleFaceDescriptor(family: GoogleFamily, file: GoogleFontFile): FaceDescriptor {
  const wght = family.axes.find((a) => a.tag === "wght");
  const wdth = family.axes.find((a) => a.tag === "wdth");
  // Axes are per family: a static file in a family with axes has none of its own.
  const variable = /\[[^\]]+\]\.(ttf|otf)$/.test(file.filename);
  return {
    family: family.name,
    style: file.style,
    weight: variable && wght ? [wght.min, wght.max] : file.weight,
    stretch: variable && wdth ? [wdth.min, wdth.max] : 100,
  };
}

/** Loads Google Fonts families (metadata and files) into a {@link FontRegistry}. */
export class GoogleFontsLoader {
  private readonly fetchFn: (url: string) => Promise<Response>;
  readonly baseUrl: string;
  private readonly maxFontBytes: number;
  private readonly families = new Map<string, Promise<GoogleFamily>>();

  constructor(options: GoogleFontsOptions = {}) {
    this.fetchFn = options.fetch ?? ((url) => globalThis.fetch(url));
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE;
    this.maxFontBytes = options.maxFontBytes ?? 32 << 20;
  }

  /** The family's metadata (looked up under each accepted license directory; cached). */
  family(name: string): Promise<GoogleFamily> {
    const dir = googleFamilyDirectory(name);
    if (!dir) return Promise.reject(new GoogleFontsError(`not a family name: ${JSON.stringify(name)}`));
    let p = this.families.get(dir);
    if (!p) {
      p = this.lookup(name, dir);
      p.catch(() => this.families.delete(dir));
      this.families.set(dir, p);
    }
    return p;
  }

  private async lookup(name: string, dir: string): Promise<GoogleFamily> {
    for (const [licenseDir] of LICENSE_DIRS) {
      const directory = `${licenseDir}/${dir}`;
      const res = await this.fetchFn(`${this.baseUrl}${directory}/METADATA.pb`);
      if (res.status === 404) continue;
      if (!res.ok) throw new GoogleFontsError(`${name}: HTTP ${res.status} for ${directory}/METADATA.pb`);
      const bytes = await readLimited(res, MAX_METADATA_BYTES, `${directory}/METADATA.pb`);
      return googleFamilyFromMetadata(new TextDecoder().decode(bytes), directory);
    }
    throw new GoogleFontsError(`${name}: no such family in Google Fonts (looked in ${LICENSE_DIRS.map(([d]) => `${d}/${dir}`).join(", ")})`);
  }

  /** URL of one of a family's font files. */
  fileUrl(family: GoogleFamily, file: GoogleFontFile): string {
    return `${this.baseUrl}${family.directory}/${encodeURIComponent(file.filename)}`;
  }

  /** Downloads one font file. */
  async fontFile(family: GoogleFamily, file: GoogleFontFile): Promise<Uint8Array> {
    const res = await this.fetchFn(this.fileUrl(family, file));
    if (!res.ok) throw new GoogleFontsError(`${family.name}: HTTP ${res.status} for ${file.filename}`);
    return readLimited(res, this.maxFontBytes, file.filename);
  }

  /**
   * Registers every face of a family with `registry`, each loading its file
   * on first use (like `@font-face` rules). Returns the new entries.
   */
  async register(registry: FontRegistry, name: string): Promise<FontFaceEntry[]> {
    const family = await this.family(name);
    return family.fonts.map((file) => registry.add(googleFaceDescriptor(family, file), () => this.fontFile(family, file)));
  }
}

async function readLimited(res: Response, limit: number, what: string): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new GoogleFontsError(`${what}: ${declared} bytes is over the ${limit}-byte limit`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > limit) throw new GoogleFontsError(`${what}: ${bytes.length} bytes is over the ${limit}-byte limit`);
  return bytes;
}
