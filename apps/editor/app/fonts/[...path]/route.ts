import { readFile } from "node:fs/promises";
import { join, normalize, sep } from "node:path";

/**
 * Serves the bundled fonts (fixtures/fonts: OFL fonts the sample document
 * and the text tests use) at /fonts/<dir>/<file>. Only font files inside
 * that directory are served.
 */
const ROOT = join(process.cwd(), "..", "..", "fixtures", "fonts");
const TYPES: Record<string, string> = { ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2" };

export async function GET(_request: Request, context: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await context.params;
  const rel = normalize(path.map(decodeURIComponent).join(sep));
  const ext = rel.split(".").pop()?.toLowerCase() ?? "";
  if (rel.startsWith("..") || rel.includes(`${sep}..`) || !TYPES[ext]) return new Response("not found", { status: 404 });
  try {
    const bytes = await readFile(join(ROOT, rel));
    return new Response(bytes, { headers: { "content-type": TYPES[ext]!, "cache-control": "public, max-age=31536000, immutable" } });
  } catch {
    return new Response("not found", { status: 404 });
  }
}
