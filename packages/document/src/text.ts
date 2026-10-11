import * as Y from "yjs";
import { canonicalJson } from "./json";
import { TEXT_STYLE_KEYS, type TextContent, type TextStyle } from "./schema";

/**
 * Text content lives in a `Y.Text` per text node; style runs are Yjs
 * formatting attributes, so concurrent typing and styling merge. Object
 * valued styles are stored as canonical JSON strings because Yjs compares
 * attribute values by identity when it merges adjacent formatting.
 */

const OBJECT_KEYS: ReadonlySet<string> = new Set(["lineHeight", "letterSpacing", "fontFeatures", "fontVariations", "fills"]);
const STYLE_KEYS: ReadonlySet<string> = new Set(TEXT_STYLE_KEYS);

export function encodeStyle(style: TextStyle): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(style)) {
    if (v === undefined) continue;
    out[k] = v === null ? null : OBJECT_KEYS.has(k) ? canonicalJson(v) : (v as string | number);
  }
  return out;
}

export function decodeStyle(attrs: Record<string, unknown> | undefined): TextStyle {
  const out: Record<string, unknown> = {};
  if (!attrs) return out as TextStyle;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || !STYLE_KEYS.has(k)) continue;
    out[k] = OBJECT_KEYS.has(k) && typeof v === "string" ? JSON.parse(v) : v;
  }
  return out as TextStyle;
}

/** A styled span of text: the plain model used by drafts and the file format. */
export interface Span {
  text: string;
  /** Encoded attributes (see {@link encodeStyle}); empty means the node's base style. */
  attrs: Record<string, string | number | boolean | null>;
}

function sameAttrs(a: Span["attrs"], b: Span["attrs"]): boolean {
  const ka = Object.keys(a).filter((k) => a[k] !== null);
  const kb = Object.keys(b).filter((k) => b[k] !== null);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
}

function cleanAttrs(attrs: Span["attrs"]): Span["attrs"] {
  const out: Span["attrs"] = {};
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

/** Normalizes spans: drops empty ones and merges neighbours with equal styles. */
export function normalizeSpans(spans: readonly Span[]): Span[] {
  const out: Span[] = [];
  for (const s of spans) {
    if (s.text.length === 0) continue;
    const attrs = cleanAttrs(s.attrs);
    const last = out[out.length - 1];
    if (last && sameAttrs(last.attrs, attrs)) last.text += s.text;
    else out.push({ text: s.text, attrs });
  }
  return out;
}

export function spansFromYText(text: Y.Text): Span[] {
  const delta = text.toDelta() as { insert: unknown; attributes?: Record<string, string | number | boolean | null> }[];
  return normalizeSpans(delta.filter((d) => typeof d.insert === "string").map((d) => ({ text: d.insert as string, attrs: d.attributes ?? {} })));
}

export function spansToContent(spans: readonly Span[]): TextContent {
  let content = "";
  const runs: TextContent["runs"] = [];
  for (const s of normalizeSpans(spans)) {
    const start = content.length;
    content += s.text;
    const style = decodeStyle(s.attrs);
    if (Object.keys(style).length > 0) runs.push({ start, end: content.length, style });
  }
  return { content, runs };
}

export function contentToSpans(text: TextContent): Span[] {
  const spans: Span[] = [];
  let at = 0;
  for (const run of text.runs) {
    if (run.start > at) spans.push({ text: text.content.slice(at, run.start), attrs: {} });
    spans.push({ text: text.content.slice(run.start, run.end), attrs: encodeStyle(run.style) });
    at = run.end;
  }
  if (at < text.content.length) spans.push({ text: text.content.slice(at), attrs: {} });
  return normalizeSpans(spans);
}

export function spansLength(spans: readonly Span[]): number {
  return spans.reduce((n, s) => n + s.text.length, 0);
}

/** Splits spans so that a span boundary falls at `index`; returns the index of the span starting there. */
function splitAt(spans: Span[], index: number): number {
  let at = 0;
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i]!;
    if (index === at) return i;
    if (index < at + s.text.length) {
      const cut = index - at;
      spans.splice(i, 1, { text: s.text.slice(0, cut), attrs: s.attrs }, { text: s.text.slice(cut), attrs: { ...s.attrs } });
      return i + 1;
    }
    at += s.text.length;
  }
  return spans.length;
}

/**
 * Text edits with Yjs semantics, so a draft predicts exactly what the Y.Text
 * will contain: an insert without a style inherits the formatting of the
 * character before it; with a style it uses exactly that style.
 */
export type TextOp =
  | { readonly op: "insert"; readonly index: number; readonly text: string; readonly attrs?: Span["attrs"] }
  | { readonly op: "delete"; readonly index: number; readonly length: number }
  | { readonly op: "format"; readonly index: number; readonly length: number; readonly attrs: Span["attrs"] };

export function applySpanOp(spans: readonly Span[], op: TextOp): Span[] {
  const out = spans.map((s) => ({ text: s.text, attrs: { ...s.attrs } }));
  switch (op.op) {
    case "insert": {
      if (op.text.length === 0) return normalizeSpans(out);
      const i = splitAt(out, op.index);
      const inherited = i > 0 ? out[i - 1]!.attrs : {};
      out.splice(i, 0, { text: op.text, attrs: op.attrs ? { ...op.attrs } : { ...inherited } });
      return normalizeSpans(out);
    }
    case "delete": {
      const a = splitAt(out, op.index);
      const b = splitAt(out, op.index + op.length);
      out.splice(a, b - a);
      return normalizeSpans(out);
    }
    case "format": {
      const a = splitAt(out, op.index);
      const b = splitAt(out, op.index + op.length);
      for (let i = a; i < b; i++) {
        const s = out[i]!;
        for (const [k, v] of Object.entries(op.attrs)) {
          if (v === null) delete s.attrs[k];
          else s.attrs[k] = v;
        }
      }
      return normalizeSpans(out);
    }
  }
}

export function applyYTextOp(text: Y.Text, op: TextOp): void {
  switch (op.op) {
    case "insert":
      if (op.attrs) text.insert(op.index, op.text, op.attrs);
      else text.insert(op.index, op.text);
      return;
    case "delete":
      text.delete(op.index, op.length);
      return;
    case "format":
      text.format(op.index, op.length, op.attrs);
      return;
  }
}

/** Writes spans into an empty Y.Text. */
export function writeSpans(text: Y.Text, spans: readonly Span[]): void {
  let at = 0;
  for (const s of spans) {
    text.insert(at, s.text, { ...s.attrs });
    at += s.text.length;
  }
}
