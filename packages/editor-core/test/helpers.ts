import { FigDocument, SceneBridge, seededRandom, type Command } from "@fig-tree/document";
import { Scene } from "@fig-tree/renderer";
import { loadHarfBuzz, type FontRegistry } from "@fig-tree/text";
import { Editor, type PointerInput } from "../src";
import { fixtureRegistry } from "../../text/conformance/fonts";

export const ink = { type: "solid" as const, color: { r: 0, g: 0, b: 0, a: 1 } };
export const gray = { type: "solid" as const, color: { r: 0.5, g: 0.5, b: 0.5, a: 1 } };

let fonts: FontRegistry | null = null;

export async function textFonts(): Promise<FontRegistry> {
  if (!fonts) {
    await loadHarfBuzz();
    fonts = fixtureRegistry();
  }
  return fonts;
}

export interface Setup {
  readonly doc: FigDocument;
  readonly bridge: SceneBridge;
  readonly editor: Editor;
  readonly page: string;
}

/**
 * A document built by `commands`, its bridge and an editor with an 800×600
 * canvas at 100% zoom with the world origin at the canvas origin (so screen
 * and world coordinates are equal unless a test zooms).
 */
export function setup(commands: (page: string) => Command[] = () => [], options: { fonts?: FontRegistry; platform?: "mac" | "other" } = {}): Setup {
  const doc = FigDocument.create({ random: seededRandom(11), clientId: 1 });
  const page = doc.pages[0]!;
  const cmds = commands(page);
  if (cmds.length) doc.apply(cmds, doc.actor("author", "system"));
  const bridge = new SceneBridge(doc, new Scene(), options.fonts ? { fonts: options.fonts } : {});
  const editor = new Editor(doc, bridge, { platform: options.platform ?? "other" });
  editor.viewport.resize(800, 600);
  editor.viewport.set(1, 0, 0);
  return { doc, bridge, editor, page };
}

export const rect = (id: string, parent: string, x: number, y: number, w: number, h: number, props: Record<string, unknown> = {}): Command => ({
  type: "createNode",
  node: { id, type: "rectangle", props: { x, y, width: w, height: h, fills: [gray], ...props } },
  parent,
});

export const frame = (id: string, parent: string, x: number, y: number, w: number, h: number, props: Record<string, unknown> = {}): Command => ({
  type: "createNode",
  node: { id, type: "frame", props: { x, y, width: w, height: h, fills: [{ type: "solid", color: { r: 1, g: 1, b: 1, a: 1 } }], ...props } },
  parent,
});

export const text = (id: string, parent: string, content: string, props: Record<string, unknown> = {}): Command => ({
  type: "createNode",
  node: { id, type: "text", props: { fontFamily: "Inter", fontSize: 16, fills: [ink], ...props }, text: { content, runs: [] } },
  parent,
});

type Mods = Partial<Pick<PointerInput, "shift" | "alt" | "mod" | "button" | "clickCount">>;

export function click(editor: Editor, x: number, y: number, mods: Mods = {}): void {
  editor.pointerDown({ x, y, ...mods });
  editor.pointerUp({ x, y, ...mods });
}

export function doubleClick(editor: Editor, x: number, y: number, mods: Mods = {}): void {
  click(editor, x, y, { ...mods, clickCount: 1 });
  click(editor, x, y, { ...mods, clickCount: 2 });
}

/** Presses at `from`, moves to `to` in `steps` steps, releases. */
export function drag(editor: Editor, from: [number, number], to: [number, number], mods: Mods = {}, steps = 5): void {
  editor.pointerDown({ x: from[0], y: from[1], ...mods });
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    editor.pointerMove({ x: from[0] + (to[0] - from[0]) * t, y: from[1] + (to[1] - from[1]) * t, ...mods });
  }
  editor.pointerUp({ x: to[0], y: to[1], ...mods });
}

export function key(editor: Editor, k: string, mods: { shift?: boolean; alt?: boolean; mod?: boolean } = {}): boolean {
  const code = /^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : /^[0-9]$/.test(k) ? `Digit${k}` : k === " " ? "Space" : k === "[" ? "BracketLeft" : k === "]" ? "BracketRight" : k === "=" ? "Equal" : k === "-" ? "Minus" : k === "/" ? "Slash" : k;
  return editor.keyDown({ key: k, code, shift: mods.shift ?? false, alt: mods.alt ?? false, mod: mods.mod ?? false });
}

export function props(doc: FigDocument, id: string, ...keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((k) => [k, doc.get(id, k)]));
}
