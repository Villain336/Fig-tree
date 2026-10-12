/**
 * The keyboard map: every shortcut, with a description for the shortcuts
 * sheet. Bindings are written with `Mod` for the platform's command key
 * (⌘ on macOS, Ctrl elsewhere). Letters and digits match the physical key
 * (`KeyboardEvent.code`), so shortcuts work on any keyboard layout and
 * Shift+1 is not confused with "!".
 */

export type Platform = "mac" | "other";

export interface KeyInput {
  readonly key: string;
  readonly code: string;
  readonly shift: boolean;
  readonly alt: boolean;
  /** The platform command modifier (⌘ on macOS, Ctrl elsewhere). */
  readonly mod: boolean;
  readonly repeat?: boolean;
}

export interface Shortcut {
  /** Action id run by the editor (see `Editor.run`). */
  readonly action: string;
  readonly keys: readonly string[];
  readonly label: string;
  readonly group: ShortcutGroup;
  /**
   * Where the shortcut applies when not everywhere: `vector-edit` keys are
   * handled by vector edit mode (its session sees keys first), so they may
   * reuse global bindings. `actionFor` only matches global shortcuts.
   */
  readonly context?: "vector-edit";
}

export type ShortcutGroup = "Tools" | "Edit" | "Selection" | "Arrange" | "Align" | "View" | "Text" | "Layout" | "Vector" | "Help";

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = ["Tools", "Edit", "Selection", "Arrange", "Align", "Layout", "Vector", "Text", "View", "Help"];

export const SHORTCUTS: readonly Shortcut[] = [
  { action: "tool.select", keys: ["V"], label: "Move and select", group: "Tools" },
  { action: "tool.hand", keys: ["H"], label: "Hand (pan the canvas)", group: "Tools" },
  { action: "tool.frame", keys: ["F", "A"], label: "Frame", group: "Tools" },
  { action: "tool.rectangle", keys: ["R"], label: "Rectangle", group: "Tools" },
  { action: "tool.ellipse", keys: ["O"], label: "Ellipse", group: "Tools" },
  { action: "tool.star", keys: ["Shift+S"], label: "Star", group: "Tools" },
  { action: "tool.line", keys: ["L"], label: "Line", group: "Tools" },
  { action: "tool.pen", keys: ["P"], label: "Pen", group: "Tools" },
  { action: "tool.pencil", keys: ["Shift+P"], label: "Pencil", group: "Tools" },
  { action: "tool.text", keys: ["T"], label: "Text", group: "Tools" },
  { action: "tool.image", keys: ["Shift+Mod+K"], label: "Place an image", group: "Tools" },

  { action: "edit.undo", keys: ["Mod+Z"], label: "Undo", group: "Edit" },
  { action: "edit.redo", keys: ["Shift+Mod+Z", "Mod+Y"], label: "Redo", group: "Edit" },
  { action: "edit.copy", keys: ["Mod+C"], label: "Copy", group: "Edit" },
  { action: "edit.cut", keys: ["Mod+X"], label: "Cut", group: "Edit" },
  { action: "edit.paste", keys: ["Mod+V"], label: "Paste", group: "Edit" },
  { action: "edit.duplicate", keys: ["Mod+D"], label: "Duplicate", group: "Edit" },
  { action: "edit.delete", keys: ["Delete", "Backspace"], label: "Delete", group: "Edit" },
  { action: "edit.rename", keys: ["Mod+R"], label: "Rename the selected layer", group: "Edit" },
  { action: "edit.copyAsSvg", keys: ["Shift+Mod+C"], label: "Copy as SVG", group: "Edit" },

  { action: "select.all", keys: ["Mod+A"], label: "Select all", group: "Selection" },
  { action: "select.none", keys: ["Escape"], label: "Select the parent, then nothing", group: "Selection" },
  { action: "select.children", keys: ["Enter"], label: "Select children (edit text, or the points of a vector or shape)", group: "Selection" },
  { action: "select.parent", keys: ["Shift+Enter"], label: "Select parent", group: "Selection" },
  { action: "select.next", keys: ["Tab"], label: "Select next sibling", group: "Selection" },
  { action: "select.previous", keys: ["Shift+Tab"], label: "Select previous sibling", group: "Selection" },
  { action: "nudge.small", keys: ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"], label: "Nudge by 1 px", group: "Selection" },
  { action: "nudge.large", keys: ["Shift+ArrowUp", "Shift+ArrowDown", "Shift+ArrowLeft", "Shift+ArrowRight"], label: "Nudge by 10 px", group: "Selection" },

  { action: "arrange.group", keys: ["Mod+G"], label: "Group selection", group: "Arrange" },
  { action: "arrange.ungroup", keys: ["Shift+Mod+G"], label: "Ungroup", group: "Arrange" },
  { action: "arrange.frame", keys: ["Alt+Mod+G"], label: "Frame selection", group: "Arrange" },
  { action: "arrange.forward", keys: ["Mod+]"], label: "Bring forward", group: "Arrange" },
  { action: "arrange.backward", keys: ["Mod+["], label: "Send backward", group: "Arrange" },
  { action: "arrange.front", keys: ["]"], label: "Bring to front", group: "Arrange" },
  { action: "arrange.back", keys: ["["], label: "Send to back", group: "Arrange" },
  { action: "object.lock", keys: ["Shift+Mod+L"], label: "Lock or unlock", group: "Arrange" },
  { action: "object.hide", keys: ["Shift+Mod+H"], label: "Show or hide", group: "Arrange" },
  { action: "object.flipX", keys: ["Shift+H"], label: "Flip horizontal", group: "Arrange" },
  { action: "object.flipY", keys: ["Shift+V"], label: "Flip vertical", group: "Arrange" },

  { action: "align.left", keys: ["Alt+A"], label: "Align left", group: "Align" },
  { action: "align.centerX", keys: ["Alt+H"], label: "Align horizontal centers", group: "Align" },
  { action: "align.right", keys: ["Alt+D"], label: "Align right", group: "Align" },
  { action: "align.top", keys: ["Alt+W"], label: "Align top", group: "Align" },
  { action: "align.centerY", keys: ["Alt+V"], label: "Align vertical centers", group: "Align" },
  { action: "align.bottom", keys: ["Alt+S"], label: "Align bottom", group: "Align" },
  { action: "distribute.x", keys: ["Shift+Alt+H"], label: "Distribute horizontal spacing", group: "Align" },
  { action: "distribute.y", keys: ["Shift+Alt+V"], label: "Distribute vertical spacing", group: "Align" },

  { action: "layout.add", keys: ["Shift+A"], label: "Add auto layout (flex)", group: "Layout" },

  { action: "boolean.union", keys: ["Shift+Alt+U"], label: "Union selection", group: "Vector" },
  { action: "boolean.subtract", keys: ["Shift+Alt+S"], label: "Subtract selection", group: "Vector" },
  { action: "boolean.intersect", keys: ["Shift+Alt+I"], label: "Intersect selection", group: "Vector" },
  { action: "boolean.exclude", keys: ["Shift+Alt+E"], label: "Exclude selection", group: "Vector" },
  { action: "object.flatten", keys: ["Mod+E"], label: "Flatten (text becomes outlines)", group: "Vector" },
  { action: "object.outlineStroke", keys: ["Shift+Mod+O"], label: "Outline stroke", group: "Vector" },
  { action: "vector.done", keys: ["Escape", "Enter"], label: "Finish the path, then leave vector editing", group: "Vector", context: "vector-edit" },
  { action: "vector.select", keys: ["V"], label: "Vector editing: select and move points", group: "Vector", context: "vector-edit" },
  { action: "vector.pen", keys: ["P"], label: "Vector editing: pen (add points and branches)", group: "Vector", context: "vector-edit" },
  { action: "vector.bucket", keys: ["B"], label: "Vector editing: paint bucket (fill or unfill an area)", group: "Vector", context: "vector-edit" },
  { action: "vector.bend", keys: ["Mod"], label: "Hold and drag a segment to bend it, a point to pull handles", group: "Vector", context: "vector-edit" },
  { action: "vector.breakHandles", keys: ["Alt"], label: "Hold while dragging a handle to move it alone", group: "Vector", context: "vector-edit" },
  { action: "vector.angle", keys: ["Shift"], label: "Hold to snap segments and handles to 15°", group: "Vector", context: "vector-edit" },
  { action: "vector.deleteKeep", keys: ["Delete", "Backspace"], label: "Delete points, keeping the shape (Backspace while drawing: last point)", group: "Vector", context: "vector-edit" },
  { action: "vector.deleteGap", keys: ["Shift+Delete", "Shift+Backspace"], label: "Delete points and their segments", group: "Vector", context: "vector-edit" },
  { action: "vector.join", keys: ["Mod+J"], label: "Join two points", group: "Vector", context: "vector-edit" },
  { action: "vector.disconnect", keys: ["Shift+Mod+J"], label: "Disconnect segments at the selected points", group: "Vector", context: "vector-edit" },
  { action: "vector.flipX", keys: ["Shift+H"], label: "Flip the selected points horizontally", group: "Vector", context: "vector-edit" },
  { action: "vector.flipY", keys: ["Shift+V"], label: "Flip the selected points vertically", group: "Vector", context: "vector-edit" },

  { action: "text.bold", keys: ["Mod+B"], label: "Bold", group: "Text" },
  { action: "text.italic", keys: ["Mod+I"], label: "Italic", group: "Text" },
  { action: "text.underline", keys: ["Mod+U"], label: "Underline", group: "Text" },

  { action: "view.zoomIn", keys: ["Mod+=", "Shift+="], label: "Zoom in", group: "View" },
  { action: "view.zoomOut", keys: ["Mod+-", "-"], label: "Zoom out", group: "View" },
  { action: "view.zoomFit", keys: ["Shift+1"], label: "Zoom to fit", group: "View" },
  { action: "view.zoomSelection", keys: ["Shift+2"], label: "Zoom to selection", group: "View" },
  { action: "view.zoom100", keys: ["Shift+0"], label: "Zoom to 100%", group: "View" },
  { action: "view.pixelGrid", keys: ["Shift+Mod+'"], label: "Show or hide the pixel grid", group: "View" },
  { action: "view.rulers", keys: ["Shift+R"], label: "Show or hide rulers", group: "View" },
  { action: "view.pan", keys: ["Space"], label: "Hold and drag to pan", group: "View" },
  { action: "view.measure", keys: ["Alt"], label: "Hold and hover to measure distances", group: "View" },

  { action: "help.shortcuts", keys: ["Mod+/", "Shift+/"], label: "Keyboard shortcuts", group: "Help" },
];

interface ParsedBinding {
  readonly shift: boolean;
  readonly alt: boolean;
  readonly mod: boolean;
  /** A `KeyboardEvent.code` to match, or a `key` for named keys. */
  readonly code: string | null;
  readonly key: string | null;
}

const CODE_FOR: Record<string, string> = {
  "=": "Equal",
  "-": "Minus",
  "[": "BracketLeft",
  "]": "BracketRight",
  "/": "Slash",
  "'": "Quote",
  ",": "Comma",
  ".": "Period",
  ";": "Semicolon",
  "\\": "Backslash",
  "`": "Backquote",
  Space: "Space",
};

/** Parses a binding like `Shift+Mod+Z`. */
export function parseBinding(binding: string): ParsedBinding {
  const parts = binding.split("+");
  // "Mod+=" splits fine; a trailing "+" key is not used by the map.
  const last = parts[parts.length - 1]!;
  const mods = new Set(parts.slice(0, -1));
  let code: string | null = null;
  let key: string | null = null;
  if (/^[A-Z]$/.test(last)) code = `Key${last}`;
  else if (/^[0-9]$/.test(last)) code = `Digit${last}`;
  else if (CODE_FOR[last]) code = CODE_FOR[last]!;
  else key = last;
  return { shift: mods.has("Shift"), alt: mods.has("Alt"), mod: mods.has("Mod"), code, key };
}

export function matchesBinding(binding: string, e: KeyInput): boolean {
  const b = parseBinding(binding);
  if (b.shift !== e.shift || b.alt !== e.alt || b.mod !== e.mod) return false;
  if (b.code) return e.code === b.code || (b.code === "Equal" && e.code === "NumpadAdd") || (b.code === "Minus" && e.code === "NumpadSubtract");
  return e.key === b.key;
}

/** The action bound to a key press, if any. */
export function actionFor(e: KeyInput, shortcuts: readonly Shortcut[] = SHORTCUTS): string | null {
  for (const s of shortcuts) {
    if (s.context) continue;
    for (const k of s.keys) if (matchesBinding(k, e)) return s.action;
  }
  return null;
}

const MAC_SYMBOLS: Record<string, string> = { Shift: "⇧", Alt: "⌥", Mod: "⌘" };
const KEY_LABELS: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Backspace: "⌫",
  Delete: "Del",
  Enter: "↵",
  Escape: "Esc",
};

/** A binding as shown to the user on a platform. */
export function formatBinding(binding: string, platform: Platform): string {
  const parts = binding.split("+");
  const last = parts.pop()!;
  // A lone modifier ("hold ⌘") is shown like one in a combination.
  const keyLabel = KEY_LABELS[last] ?? (platform === "mac" ? MAC_SYMBOLS[last] : last === "Mod" ? "Ctrl" : undefined) ?? last;
  if (platform === "mac") return [...parts.map((p) => MAC_SYMBOLS[p] ?? p), keyLabel].join("");
  return [...parts.map((p) => (p === "Mod" ? "Ctrl" : p)), keyLabel].join("+");
}

/** The first binding of an action, formatted for the platform (for menus and tooltips). */
export function shortcutLabel(action: string, platform: Platform): string | null {
  const s = SHORTCUTS.find((x) => x.action === action);
  return s ? formatBinding(s.keys[0]!, platform) : null;
}
