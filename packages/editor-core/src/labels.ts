import type { Point } from "@fig-tree/geometry";
import type { Editor } from "./editor";
import { boxesIntersect } from "./math";
import { isBoard } from "./selection";

export interface FrameLabel {
  readonly id: string;
  readonly text: string;
  /** Baseline-middle anchor point of the text (canvas CSS px). */
  readonly at: Point;
  /** Hit rectangle (canvas CSS px). */
  readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

const LABEL_HEIGHT = 16;
const MAX_LABELS = 500;

/**
 * Name labels above top-level frames (boards). Clicking a label selects its
 * frame, and dragging it moves the frame. Labels are truncated to the
 * frame's on-screen width and hidden for frames that are off screen.
 */
export function frameLabels(editor: Editor): FrameLabel[] {
  const doc = editor.doc;
  const out: FrameLabel[] = [];
  const visible = editor.viewport.visibleWorld;
  for (const id of doc.tree.childrenOf(editor.page)) {
    if (out.length >= MAX_LABELS) break;
    if (!isBoard(doc, id) || !doc.get<boolean>(id, "visible")) continue;
    const b = editor.geometry.bounds(id);
    if (!boxesIntersect(b, visible)) continue;
    const q = editor.geometry.quad(id);
    const tl = editor.viewport.toScreen(q[0]);
    const tr = editor.viewport.toScreen(q[1]);
    const maxWidth = Math.max(0, Math.hypot(tr.x - tl.x, tr.y - tl.y));
    if (maxWidth < 12) continue;
    let text = doc.get<string>(id, "name");
    let width = editor.measureText(text);
    if (width > maxWidth) {
      while (text.length > 1 && editor.measureText(`${text}…`) > maxWidth) text = text.slice(0, -1);
      text = `${text}…`;
      width = Math.min(maxWidth, editor.measureText(text));
    }
    const at = { x: tl.x, y: tl.y - LABEL_HEIGHT / 2 - 2 };
    out.push({ id, text, at, rect: { x: at.x, y: at.y - LABEL_HEIGHT / 2, width: Math.max(width, 8), height: LABEL_HEIGHT } });
  }
  return out;
}

/** The frame whose label is under a screen point. */
export function labelAt(editor: Editor, screen: Point): string | null {
  const labels = frameLabels(editor);
  for (let i = labels.length - 1; i >= 0; i--) {
    const r = labels[i]!.rect;
    if (screen.x >= r.x && screen.x <= r.x + r.width && screen.y >= r.y && screen.y <= r.y + r.height) return labels[i]!.id;
  }
  return null;
}
