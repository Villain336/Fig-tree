/**
 * A small, forgiving XML parser for pasted SVG: elements, attributes, text,
 * comments, CDATA, processing instructions and a DOCTYPE (skipped). It
 * runs anywhere (no DOM), so SVG import works in Node tests and workers.
 * Entities: the five XML ones and numeric references.
 */

export interface XmlElement {
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: readonly XmlNode[];
}

export type XmlNode = XmlElement | string;

export class XmlError extends Error {}

const MAX_DEPTH = 256;
const MAX_NODES = 200_000;

export function parseXml(src: string): XmlElement {
  let pos = 0;
  let count = 0;
  const fail = (msg: string): never => {
    throw new XmlError(`${msg} at ${pos}`);
  };
  const skipMisc = (): void => {
    for (;;) {
      while (pos < src.length && /\s/.test(src[pos]!)) pos++;
      if (src.startsWith("<?", pos)) {
        const end = src.indexOf("?>", pos);
        pos = end < 0 ? src.length : end + 2;
      } else if (src.startsWith("<!--", pos)) {
        const end = src.indexOf("-->", pos);
        pos = end < 0 ? src.length : end + 3;
      } else if (src.startsWith("<!DOCTYPE", pos) || src.startsWith("<!doctype", pos)) {
        // Skip to the matching '>' (an internal subset in brackets may contain '>').
        let depth = 0;
        while (pos < src.length) {
          const c = src[pos++];
          if (c === "[") depth++;
          else if (c === "]") depth--;
          else if (c === ">" && depth <= 0) break;
        }
      } else return;
    }
  };
  const name = (): string => {
    const m = /^[A-Za-z_:][\w:.-]*/.exec(src.slice(pos, pos + 256));
    if (!m) fail("expected a name");
    pos += m![0].length;
    return m![0];
  };
  const element = (depth: number): XmlElement => {
    if (depth > MAX_DEPTH) fail("too deeply nested");
    if (++count > MAX_NODES) fail("too many nodes");
    if (src[pos] !== "<") fail("expected <");
    pos++;
    const tag = name();
    const attrs: Record<string, string> = {};
    for (;;) {
      while (pos < src.length && /\s/.test(src[pos]!)) pos++;
      if (src.startsWith("/>", pos)) {
        pos += 2;
        return { name: tag, attrs, children: [] };
      }
      if (src[pos] === ">") {
        pos++;
        break;
      }
      if (pos >= src.length) fail("unterminated tag");
      const key = name();
      while (/\s/.test(src[pos] ?? "")) pos++;
      if (src[pos] !== "=") {
        attrs[key] = "";
        continue;
      }
      pos++;
      while (/\s/.test(src[pos] ?? "")) pos++;
      const q = src[pos];
      if (q !== '"' && q !== "'") fail("expected a quoted attribute value");
      const end = src.indexOf(q!, pos + 1);
      if (end < 0) fail("unterminated attribute value");
      attrs[key] = decodeEntities(src.slice(pos + 1, end));
      pos = end + 1;
    }
    const children: XmlNode[] = [];
    for (;;) {
      if (pos >= src.length) fail(`unclosed <${tag}>`);
      if (src.startsWith("</", pos)) {
        pos += 2;
        const close = name();
        if (close !== tag) fail(`mismatched </${close}> for <${tag}>`);
        while (/\s/.test(src[pos] ?? "")) pos++;
        if (src[pos] !== ">") fail("expected >");
        pos++;
        return { name: tag, attrs, children };
      }
      if (src.startsWith("<!--", pos)) {
        const end = src.indexOf("-->", pos);
        pos = end < 0 ? src.length : end + 3;
        continue;
      }
      if (src.startsWith("<![CDATA[", pos)) {
        const end = src.indexOf("]]>", pos);
        children.push(src.slice(pos + 9, end < 0 ? src.length : end));
        pos = end < 0 ? src.length : end + 3;
        continue;
      }
      if (src.startsWith("<?", pos)) {
        const end = src.indexOf("?>", pos);
        pos = end < 0 ? src.length : end + 2;
        continue;
      }
      if (src[pos] === "<") {
        children.push(element(depth + 1));
        continue;
      }
      const next = src.indexOf("<", pos);
      const text = src.slice(pos, next < 0 ? src.length : next);
      pos = next < 0 ? src.length : next;
      if (text.trim() !== "") children.push(decodeEntities(text));
    }
  };
  skipMisc();
  const root = element(0);
  return root;
}

function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k === "amp") return "&";
    if (k === "lt") return "<";
    if (k === "gt") return ">";
    if (k === "quot") return '"';
    if (k === "apos") return "'";
    const code = k.startsWith("#x") ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

/** Child elements of an element. */
export function elements(e: XmlElement): XmlElement[] {
  return e.children.filter((c): c is XmlElement => typeof c !== "string");
}

/** All text inside an element. */
export function textContent(e: XmlElement): string {
  return e.children.map((c) => (typeof c === "string" ? c : textContent(c))).join("");
}
