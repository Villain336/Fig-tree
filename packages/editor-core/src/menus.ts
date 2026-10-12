import type { Editor } from "./editor";
import { shortcutLabel } from "./keymap";

export interface MenuItem {
  readonly action: string;
  readonly label: string;
  readonly shortcut: string | null;
  readonly enabled: boolean;
}

export type MenuEntry = MenuItem | "separator";

const CANVAS: readonly (readonly [string, string] | "separator")[] = [
  ["edit.copy", "Copy"],
  ["edit.cut", "Cut"],
  ["edit.paste", "Paste"],
  ["edit.duplicate", "Duplicate"],
  ["edit.delete", "Delete"],
  "separator",
  ["arrange.front", "Bring to front"],
  ["arrange.forward", "Bring forward"],
  ["arrange.backward", "Send backward"],
  ["arrange.back", "Send to back"],
  "separator",
  ["arrange.group", "Group selection"],
  ["arrange.frame", "Frame selection"],
  ["arrange.ungroup", "Ungroup"],
  ["layout.add", "Add auto layout"],
  "separator",
  ["boolean.union", "Union selection"],
  ["boolean.subtract", "Subtract selection"],
  ["boolean.intersect", "Intersect selection"],
  ["boolean.exclude", "Exclude selection"],
  ["object.flatten", "Flatten"],
  ["object.outlineStroke", "Outline stroke"],
  ["vector.edit", "Edit points"],
  ["edit.copyAsSvg", "Copy as SVG"],
  "separator",
  ["object.flipX", "Flip horizontal"],
  ["object.flipY", "Flip vertical"],
  ["object.hide", "Show/hide"],
  ["object.lock", "Lock/unlock"],
];

const LAYERS: readonly (readonly [string, string] | "separator")[] = [["edit.rename", "Rename"], "separator", ...CANVAS];

/**
 * Context menu entries for the canvas or the layers panel, with enabled
 * states and platform shortcut labels. Labels are our own wording.
 */
export function contextMenu(editor: Editor, where: "canvas" | "layers"): MenuEntry[] {
  const spec = where === "canvas" ? CANVAS : LAYERS;
  const hasSelection = editor.selection.length > 0;
  return spec.map((e) => {
    if (e === "separator") return e;
    const [action, label] = e;
    const enabled = action === "edit.paste" ? true : action === "edit.copy" || action === "edit.cut" ? hasSelection : editor.canRun(action);
    return { action, label, shortcut: shortcutLabel(action, editor.platform), enabled };
  });
}
