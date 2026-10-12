import type { NodeType } from "@fig-tree/document";
import type { Point } from "@fig-tree/geometry";
import type { Editor } from "../editor";
import type { KeyInput } from "../keymap";
import type { OverlayItem } from "../overlay";

/** A pointer event in both canvas CSS pixels (`screen`) and page coordinates (`world`). */
export interface ToolPointer {
  readonly screen: Point;
  readonly world: Point;
  /** 0 primary, 1 middle, 2 secondary. */
  readonly button: number;
  readonly shift: boolean;
  readonly alt: boolean;
  /** ⌘ on macOS, Ctrl elsewhere. */
  readonly mod: boolean;
  /** 1 for a single click, 2 for a double click, 3 for a triple click. */
  readonly clickCount: number;
}

export type Cursor =
  | "default"
  | "crosshair"
  | "text"
  | "grab"
  | "grabbing"
  | "move"
  | "copy"
  | "pointer"
  | "ew-resize"
  | "ns-resize"
  | "nesw-resize"
  | "nwse-resize"
  | "rotate"
  | "pen"
  | "pen-add"
  | "pen-close"
  | "pencil"
  | "bend"
  | "bucket";

/**
 * A canvas tool. The editor routes pointer and key events to the active
 * tool, which applies edits through `editor.history` (the command API with
 * the user's actor) and contributes overlay items.
 *
 * Tools are registered in {@link ToolRegistry}; the toolbar is generated
 * from it, so a later module (the pen and vector editing tools of module
 * 5b) adds a tool by registering one, with no change to the editor.
 */
export interface Tool {
  readonly id: string;
  readonly label: string;
  /** Lucide icon name for the toolbar. */
  readonly icon: string;
  /** Keyboard action that selects the tool (see keymap). */
  readonly action?: string;
  /** Toolbar group; tools of a group share a slot. */
  readonly group: "select" | "frame" | "shape" | "vector" | "text" | "image" | "navigate";
  readonly order: number;
  activate?(editor: Editor): void;
  deactivate?(editor: Editor): void;
  pointerDown(editor: Editor, e: ToolPointer): void;
  pointerMove(editor: Editor, e: ToolPointer): void;
  pointerUp(editor: Editor, e: ToolPointer): void;
  /** Returns true when the tool handled the key. */
  keyDown?(editor: Editor, e: KeyInput): boolean;
  keyUp?(editor: Editor, e: KeyInput): void;
  /** Escape or an interruption: abandon the gesture in progress. Returns true if something was cancelled. */
  cancel?(editor: Editor): boolean;
  cursor?(editor: Editor): Cursor;
  overlay?(editor: Editor, out: OverlayItem[]): void;
  /** Whether a gesture is in progress (the editor holds hover updates meanwhile). */
  busy?(): boolean;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private readonly listeners = new Set<() => void>();

  register(tool: Tool): () => void {
    if (this.tools.has(tool.id)) throw new Error(`tool "${tool.id}" is already registered`);
    this.tools.set(tool.id, tool);
    this.listeners.forEach((l) => l());
    return () => {
      if (this.tools.get(tool.id) === tool) this.tools.delete(tool.id);
      this.listeners.forEach((l) => l());
    };
  }

  get(id: string): Tool | undefined {
    return this.tools.get(id);
  }

  /** Tools in toolbar order. */
  list(): Tool[] {
    return [...this.tools.values()].sort((a, b) => a.order - b.order);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/**
 * An edit mode edits the inside of one node: text editing for text nodes,
 * and (module 5b) vector point editing for vector networks. The select tool
 * enters the mode registered for a node's type on double-click or Enter;
 * while a session is open the editor routes input to it first.
 */
export interface EditMode {
  readonly id: string;
  readonly nodeTypes: readonly NodeType[];
  /** Starts editing `id`, optionally at a pointer position (a double-click). Returns null to decline. */
  enter(editor: Editor, id: string, at?: ToolPointer): EditSession | null;
}

export interface EditSession {
  readonly mode: string;
  readonly nodeId: string;
  /** Each returns true when the session handled the event; false lets the editor end the session. */
  pointerDown(e: ToolPointer): boolean;
  pointerMove(e: ToolPointer): void;
  pointerUp(e: ToolPointer): void;
  keyDown(e: KeyInput): boolean;
  overlay(out: OverlayItem[]): void;
  cursor?(e: ToolPointer): Cursor | null;
  /** Ends the session (commits pending state). */
  exit(): void;
}

export class EditModeRegistry {
  private readonly modes = new Map<string, EditMode>();

  register(mode: EditMode): () => void {
    if (this.modes.has(mode.id)) throw new Error(`edit mode "${mode.id}" is already registered`);
    this.modes.set(mode.id, mode);
    return () => {
      if (this.modes.get(mode.id) === mode) this.modes.delete(mode.id);
    };
  }

  /** The mode that edits nodes of a type (the most recently registered wins). */
  forType(type: NodeType): EditMode | undefined {
    let found: EditMode | undefined;
    for (const m of this.modes.values()) if (m.nodeTypes.includes(type)) found = m;
    return found;
  }

  get(id: string): EditMode | undefined {
    return this.modes.get(id);
  }

  list(): EditMode[] {
    return [...this.modes.values()];
  }
}
