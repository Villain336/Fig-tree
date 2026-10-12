import { fallbackFamilyFor } from "../ported/penpot/fallback";
import { isEmojiPresentation } from "../unicode/props";
import { FontInstance, Typeface, type FaceStyle } from "./face";

/**
 * The fonts available to text layout, grouped by CSS family name, with the
 * CSS Fonts 4 §5.2 font matching algorithm, per-character fallback through
 * the family list and then a per-script fallback table, and asynchronous
 * loading: a face is loaded the first time layout needs it, and listeners
 * are told when it arrives so layout can run again with real metrics.
 */

/** What a style asks for (computed CSS values). */
export interface FontRequest {
  /** CSS font-weight, 1–1000. */
  readonly weight: number;
  readonly style: FaceStyle;
  /** CSS font-stretch as a percentage (100 normal). */
  readonly stretch: number;
}

export const NORMAL_REQUEST: FontRequest = { weight: 400, style: "normal", stretch: 100 };

/** An `@font-face`-like description of a face. Ranges are inclusive. */
export interface FaceDescriptor {
  readonly family: string;
  readonly weight?: number | readonly [number, number];
  readonly style?: FaceStyle;
  readonly stretch?: number | readonly [number, number];
  /** Code point ranges the face is used for (CSS `unicode-range`). */
  readonly unicodeRange?: readonly (readonly [number, number])[];
}

export type FontSource = Uint8Array | (() => Promise<Uint8Array>);

export type FaceState = "unloaded" | "loading" | "loaded" | "error";

let nextFaceId = 1;

/** A registered face: its descriptor, source and load state. */
export class FontFaceEntry {
  readonly id = nextFaceId++;
  state: FaceState = "unloaded";
  typeface: Typeface | null = null;
  error: unknown = null;
  readonly weight: readonly [number, number];
  readonly stretch: readonly [number, number];
  readonly style: FaceStyle;
  readonly family: string;
  readonly unicodeRange: readonly (readonly [number, number])[] | null;
  /** @internal */
  promise: Promise<void> | null = null;

  constructor(
    descriptor: FaceDescriptor,
    /** @internal */
    readonly source: FontSource | null,
  ) {
    this.family = descriptor.family;
    const w = descriptor.weight ?? 400;
    this.weight = typeof w === "number" ? [w, w] : [Math.min(w[0], w[1]), Math.max(w[0], w[1])];
    const s = descriptor.stretch ?? 100;
    this.stretch = typeof s === "number" ? [s, s] : [Math.min(s[0], s[1]), Math.max(s[0], s[1])];
    this.style = descriptor.style ?? "normal";
    this.unicodeRange = descriptor.unicodeRange ?? null;
  }

  covers(cp: number): boolean {
    if (!this.unicodeRange) return true;
    for (const [a, b] of this.unicodeRange) if (cp >= a && cp <= b) return true;
    return false;
  }
}

/** A face chosen for a request, with the variation coordinates and synthesis CSS asks for. */
export interface MatchedFont {
  readonly entry: FontFaceEntry;
  readonly typeface: Typeface;
  /** Synthesize bold (the face is lighter than asked) or oblique (the face is upright). */
  readonly syntheticBold: boolean;
  readonly syntheticOblique: boolean;
}

/** Options for resolving a family list to faces. */
export interface ResolveOptions {
  /** CSS font-family list, e.g. `["Inter", "sans-serif"]`. */
  readonly families: readonly string[];
  readonly request: FontRequest;
}

const GENERIC_FAMILIES = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "ui-rounded", "emoji", "math", "fangsong"]);

export class FontRegistry {
  private readonly families = new Map<string, FontFaceEntry[]>();
  private readonly listeners = new Set<(entry: FontFaceEntry) => void>();
  /** Bumped whenever a face is added or finishes loading; layout caches key on it. */
  version = 0;
  /** Generic family name → concrete family names, tried in order. */
  readonly generics = new Map<string, string[]>();
  /** Families tried after the requested ones and the script fallback, for any character (the "last resort"). */
  lastResort: string[] = [];
  /** Whether to use the per-script fallback table (ported from Penpot). */
  scriptFallback = true;

  /** Registers a face whose bytes are available now or come from a loader. */
  add(descriptor: FaceDescriptor, source: FontSource): FontFaceEntry {
    const entry = new FontFaceEntry(descriptor, source);
    const key = familyKey(descriptor.family);
    const list = this.families.get(key) ?? [];
    list.push(entry);
    this.families.set(key, list);
    this.version++;
    return entry;
  }

  /**
   * Registers a parsed typeface. Unless overridden, the descriptor comes from
   * the font: its family name, and for variable fonts the weight and width
   * ranges of their `wght` and `wdth` axes.
   */
  addTypeface(typeface: Typeface, descriptor: Partial<FaceDescriptor> = {}): FontFaceEntry {
    const wght = typeface.axis("wght");
    const wdth = typeface.axis("wdth");
    const entry = new FontFaceEntry(
      {
        family: descriptor.family ?? typeface.familyName,
        weight: descriptor.weight ?? (wght ? [wght.min, wght.max] : typeface.weight),
        style: descriptor.style ?? typeface.style,
        stretch: descriptor.stretch ?? (wdth ? [wdth.min, wdth.max] : typeface.stretch),
        ...(descriptor.unicodeRange ? { unicodeRange: descriptor.unicodeRange } : {}),
      },
      null,
    );
    entry.state = "loaded";
    entry.typeface = typeface;
    const key = familyKey(entry.family);
    const list = this.families.get(key) ?? [];
    list.push(entry);
    this.families.set(key, list);
    this.version++;
    return entry;
  }

  /** Every registered face. */
  entries(): FontFaceEntry[] {
    return [...this.families.values()].flat();
  }

  hasFamily(family: string): boolean {
    return this.families.has(familyKey(family));
  }

  /** Called when a face finishes loading (or fails). Returns an unsubscribe function. */
  onLoad(listener: (entry: FontFaceEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Starts loading a face (no-op when loaded or loading); resolves when done. */
  load(entry: FontFaceEntry): Promise<void> {
    if (entry.state === "loaded" || entry.state === "error") return Promise.resolve();
    if (entry.promise) return entry.promise;
    entry.state = "loading";
    const source = entry.source!;
    entry.promise = (async () => {
      try {
        const bytes = source instanceof Uint8Array ? source : await source();
        entry.typeface = new Typeface(bytes);
        entry.state = "loaded";
      } catch (err) {
        entry.state = "error";
        entry.error = err;
      }
      this.version++;
      for (const l of this.listeners) l(entry);
    })();
    return entry.promise;
  }

  /** Resolves when every face that is loading has finished. */
  async whenIdle(): Promise<void> {
    for (;;) {
      const pending = this.entries().filter((e) => e.state === "loading").map((e) => e.promise!);
      if (pending.length === 0) return;
      await Promise.all(pending);
    }
  }

  /**
   * The faces of one family that CSS font matching selects for `request`
   * (§5.2 step 4: stretch, then style, then weight). Faces that only differ
   * in `unicode-range` all match, forming a composite face.
   */
  matchFamily(family: string, request: FontRequest): FontFaceEntry[] {
    const faces = this.families.get(familyKey(family));
    if (!faces || faces.length === 0) return [];
    let set = faces;
    set = narrow(set, (f) => stretchDistance(f.stretch, request.stretch));
    set = narrow(set, (f) => styleRank(f.style, request.style));
    set = narrow(set, (f) => weightDistance(f.weight, request.weight));
    return set;
  }

  /** Concrete family names for a family list entry (expanding generic families). */
  expand(family: string): string[] {
    const key = familyKey(family);
    if (GENERIC_FAMILIES.has(key)) return this.generics.get(key) ?? [];
    return [family];
  }

  /**
   * The font for code point `cp` (CSS Fonts 4 §5.2 per-character matching):
   * the first family in the list, then the script fallback, then the last
   * resort families, whose matched face covers `cp` and has a glyph for it.
   * Faces that are needed but not loaded start loading, and `pending` is
   * set so the caller lays out again when they arrive. Returns null when no
   * loaded face has the character.
   */
  fontFor(cp: number, options: ResolveOptions, pending?: { value: boolean }): MatchedFont | null {
    const tryFamily = (family: string): MatchedFont | null => {
      for (const entry of this.matchFamily(family, options.request)) {
        if (!entry.covers(cp)) continue;
        if (entry.state !== "loaded") {
          if (entry.state !== "error") {
            void this.load(entry);
            if (pending) pending.value = true;
          }
          continue;
        }
        if (!entry.typeface!.hasCodePoint(cp)) continue;
        return this.matched(entry, options.request);
      }
      return null;
    };
    for (const f of options.families) for (const name of this.expand(f)) {
      const m = tryFamily(name);
      if (m) return m;
    }
    if (this.scriptFallback) {
      const fb = isEmojiPresentation(cp) ? [...(this.generics.get("emoji") ?? [])] : [];
      const scriptFamily = fallbackFamilyFor(cp);
      if (scriptFamily) fb.push(scriptFamily);
      for (const name of fb) {
        const m = tryFamily(name);
        if (m) return m;
      }
    }
    for (const name of this.lastResort) {
      const m = tryFamily(name);
      if (m) return m;
    }
    return null;
  }

  /** The first available font of a family list (CSS "first available font"), used for the strut and metrics. */
  primaryFont(options: ResolveOptions, pending?: { value: boolean }): MatchedFont | null {
    // The first face whose unicode-range includes U+0020 (CSS Fonts 4 §5.4).
    const m = this.fontFor(0x20, options, pending);
    if (m) return m;
    for (const f of options.families) for (const name of this.expand(f)) {
      for (const entry of this.matchFamily(name, options.request)) {
        if (entry.state === "loaded") return this.matched(entry, options.request);
        if (entry.state === "unloaded") {
          void this.load(entry);
          if (pending) pending.value = true;
        }
      }
    }
    for (const name of this.lastResort) for (const entry of this.matchFamily(name, options.request)) if (entry.state === "loaded") return this.matched(entry, options.request);
    return null;
  }

  private matched(entry: FontFaceEntry, request: FontRequest): MatchedFont {
    const tf = entry.typeface!;
    const wght = tf.axis("wght");
    const maxWeight = wght ? Math.min(wght.max, entry.weight[1]) : entry.weight[1];
    return {
      entry,
      typeface: tf,
      // CSS Fonts 4 §5.5: synthesize bold for weights of 600 and up when the face is not bold.
      syntheticBold: request.weight >= 600 && maxWeight < 600,
      syntheticOblique: request.style !== "normal" && entry.style === "normal" && !tf.axis("ital") && !tf.axis("slnt"),
    };
  }
}

/** Variation settings and instance for a matched face under a style (CSS Fonts 4 §7.1 order of operations). */
export function instanceFor(
  m: MatchedFont,
  request: FontRequest,
  fontSize: number,
  opticalSizing: "auto" | "none",
  variationSettings: Readonly<Record<string, number>>,
): FontInstance {
  const tf = m.typeface;
  const coords: Record<string, number> = {};
  if (tf.axis("wght")) coords.wght = clamp(request.weight, m.entry.weight[0], m.entry.weight[1]);
  if (tf.axis("wdth")) coords.wdth = clamp(request.stretch, m.entry.stretch[0], m.entry.stretch[1]);
  if (request.style === "italic" && tf.axis("ital")) coords.ital = 1;
  if (request.style !== "normal" && tf.axis("slnt") && !(request.style === "italic" && tf.axis("ital"))) coords.slnt = -14;
  if (opticalSizing === "auto" && tf.axis("opsz")) coords.opsz = fontSize;
  Object.assign(coords, variationSettings);
  return tf.instance(coords);
}

function familyKey(family: string): string {
  return family.trim().replace(/^["']|["']$/g, "").toLowerCase();
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Keeps the faces with the smallest key (compared lexicographically). */
function narrow(faces: FontFaceEntry[], key: (f: FontFaceEntry) => readonly [number, number]): FontFaceEntry[] {
  let best: readonly [number, number] | null = null;
  let out: FontFaceEntry[] = [];
  for (const f of faces) {
    const k = key(f);
    const cmp = best === null ? -1 : k[0] - best[0] || k[1] - best[1];
    if (cmp < 0) {
      best = k;
      out = [f];
    } else if (cmp === 0) out.push(f);
  }
  return out;
}

/** §5.2 font-stretch: a range containing the value wins; then narrower first at or below 100%, wider first above. */
function stretchDistance(range: readonly [number, number], want: number): [number, number] {
  if (want >= range[0] && want <= range[1]) return [0, 0];
  const below = range[1] < want;
  const d = below ? want - range[1] : range[0] - want;
  if (want <= 100) return below ? [1, d] : [2, d];
  return below ? [2, d] : [1, d];
}

/** §5.2 font-style fallback order. */
function styleRank(face: FaceStyle, want: FaceStyle): [number, number] {
  const order: Record<FaceStyle, FaceStyle[]> = {
    italic: ["italic", "oblique", "normal"],
    oblique: ["oblique", "italic", "normal"],
    normal: ["normal", "oblique", "italic"],
  };
  return [order[want].indexOf(face), 0];
}

/**
 * §5.2 font-weight: a range containing the value wins. Otherwise, for
 * 400–500, heavier faces up to 500 first, then lighter faces, then heavier
 * than 500; below 400, lighter faces first; above 500, heavier first.
 */
function weightDistance(range: readonly [number, number], want: number): [number, number] {
  if (want >= range[0] && want <= range[1]) return [0, 0];
  const lighter = range[1] < want;
  const d = lighter ? want - range[1] : range[0] - want;
  if (want >= 400 && want <= 500) {
    if (!lighter && range[0] <= 500) return [1, d];
    if (lighter) return [2, d];
    return [3, d];
  }
  if (want < 400) return lighter ? [1, d] : [2, d];
  return lighter ? [2, d] : [1, d];
}
