import type { Command, NodeType, Paint } from "@fig-tree/document";
import { newId } from "@fig-tree/document";
import type { Point } from "@fig-tree/geometry";
import type { Editor } from "../editor";
import { DRAG_THRESHOLD } from "../editor";
import { boxContainsBox, distance, invert, transformPoint, type Box } from "../math";
import type { OverlayItem } from "../overlay";
import { pickPath } from "../hit-test";
import { containerAt, snapTargets } from "../placement";
import { snapValue, type SnapTarget } from "../snapping";
import { isInFlow } from "../transform";
import type { Cursor, Tool, ToolPointer } from "./tool";

const gray: Paint = { type: "solid", color: { r: 0.85, g: 0.85, b: 0.85, a: 1 } };
const white: Paint = { type: "solid", color: { r: 1, g: 1, b: 1, a: 1 } };
const black: Paint = { type: "solid", color: { r: 0, g: 0, b: 0, a: 1 } };

/** Default size of a shape created with a click. */
export const DEFAULT_SIZE = 100;

/** Frame sizes offered by the frame tool (CSS px). Names are generic device classes. */
export const FRAME_PRESETS: readonly { readonly group: string; readonly name: string; readonly width: number; readonly height: number }[] = [
  { group: "Phone", name: "Phone compact", width: 360, height: 640 },
  { group: "Phone", name: "Phone", width: 393, height: 852 },
  { group: "Phone", name: "Phone large", width: 430, height: 932 },
  { group: "Phone", name: "Android", width: 412, height: 917 },
  { group: "Tablet", name: "Tablet", width: 768, height: 1024 },
  { group: "Tablet", name: "Tablet large", width: 1024, height: 1366 },
  { group: "Desktop", name: "Laptop", width: 1280, height: 832 },
  { group: "Desktop", name: "Desktop", width: 1440, height: 1024 },
  { group: "Desktop", name: "Desktop wide", width: 1920, height: 1080 },
  { group: "Watch", name: "Watch", width: 198, height: 242 },
  { group: "Social", name: "Square post", width: 1080, height: 1080 },
  { group: "Social", name: "Story", width: 1080, height: 1920 },
  { group: "Presentation", name: "Slide 16:9", width: 1920, height: 1080 },
];

/** Initial properties of new nodes by type (besides placement). */
export function creationProps(type: NodeType): Record<string, unknown> {
  switch (type) {
    case "frame":
      return { fills: [white] };
    case "line":
      return { strokes: [black], strokeWeight: 1 };
    case "text":
      return { fontFamily: "Inter", fontSize: 16, fills: [black] };
    case "rectangle":
    case "ellipse":
    case "polygon":
    case "star":
      return { fills: [gray] };
    default:
      return {};
  }
}

/** A numbered default name ("Rectangle 3") unique among the page's nodes of that type. */
export function nextName(editor: Editor, type: NodeType): string {
  const base = { frame: "Frame", rectangle: "Rectangle", ellipse: "Ellipse", polygon: "Polygon", star: "Star", line: "Line", text: "Text", image: "Image" }[type as string] ?? type;
  let max = 0;
  const re = new RegExp(`^${base} (\\d+)$`);
  for (const id of editor.doc.tree.subtree(editor.page)) {
    const m = re.exec(editor.doc.get<string>(id, "name") ?? "");
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${base} ${max + 1}`;
}

/** A world point in a container's local space. */
function toSpace(editor: Editor, parent: string, p: Point): Point {
  if (parent === editor.page) return p;
  const inv = invert(editor.geometry.worldMatrix(parent));
  return inv ? transformPoint(inv, p.x, p.y) : p;
}

/**
 * Creation tools for frames and shapes: click to create a default-sized
 * node at the pointer, or drag to size it (Shift: square or 45° lines,
 * Alt: from the center). The node is created on press, inside the frame
 * under the pointer, and sized as the pointer moves, all in one undo step.
 * A frame drawn around existing nodes adopts them. The tool returns to
 * select afterwards, with the new node selected.
 */
export class ShapeTool implements Tool {
  readonly group: Tool["group"];
  private drag: { id: string; parent: string; origin: Point; start: ToolPointer; moved: boolean; targets: SnapTarget[] } | null = null;
  /** Size of a click-created frame (a device preset picked in the panel). */
  preset: { width: number; height: number; name: string } | null = null;

  constructor(
    readonly id: string,
    readonly type: "frame" | "rectangle" | "ellipse" | "polygon" | "star" | "line",
    readonly label: string,
    readonly icon: string,
    readonly order: number,
  ) {
    this.group = type === "frame" ? "frame" : "shape";
  }

  get action(): string {
    return `tool.${this.type}`;
  }

  busy(): boolean {
    return this.drag !== null;
  }

  cursor(): Cursor {
    return "crosshair";
  }

  pointerDown(editor: Editor, e: ToolPointer): void {
    if (e.button !== 0) return;
    const doc = editor.doc;
    let origin = e.world;
    const parent = containerAt(editor, e.world);
    const targets = editor.settings.snapping ? snapTargets(editor, new Set([parent]), new Set()) : [];
    if (targets.length) origin = { x: snapValue(origin.x, targets, "x", editor.snapThreshold), y: snapValue(origin.y, targets, "y", editor.snapThreshold) };
    if (editor.settings.pixelSnap) origin = { x: Math.round(origin.x), y: Math.round(origin.y) };
    const local = toSpace(editor, parent, origin);
    const id = newId(doc.random);
    editor.history.begin();
    const r = editor.history.apply([
      {
        type: "createNode",
        node: { id, type: this.type, props: { ...creationProps(this.type), name: nextName(editor, this.type), x: local.x, y: local.y, width: 0, height: 0 } },
        parent,
      },
    ]);
    if (!r) {
      editor.history.end();
      return;
    }
    this.drag = { id, parent, origin, start: e, moved: false, targets };
    editor.select([id]);
  }

  pointerMove(editor: Editor, e: ToolPointer): void {
    const d = this.drag;
    if (!d) return;
    if (!d.moved && distance(d.start.screen, e.screen) < DRAG_THRESHOLD) return;
    d.moved = true;
    let p = e.world;
    if (d.targets.length && !e.shift) p = { x: snapValue(p.x, d.targets, "x", editor.snapThreshold), y: snapValue(p.y, d.targets, "y", editor.snapThreshold) };
    if (editor.settings.pixelSnap) p = { x: Math.round(p.x), y: Math.round(p.y) };
    editor.history.apply([{ type: "updateProps", id: d.id, props: this.boxProps(editor, d.parent, d.origin, p, e.shift, e.alt) }]);
    editor.emit("overlay");
  }

  /** Placement of the node being drawn from `origin` to `p` (world), in the parent's space. */
  private boxProps(editor: Editor, parent: string, origin: Point, p: Point, shift: boolean, alt: boolean): Record<string, unknown> {
    const a = toSpace(editor, parent, origin);
    let b = toSpace(editor, parent, p);
    if (this.type === "line") {
      if (shift) {
        const len = distance(a, b);
        const ang = Math.round(Math.atan2(b.y - a.y, b.x - a.x) / (Math.PI / 4)) * (Math.PI / 4);
        b = { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
      }
      const from = alt ? { x: 2 * a.x - b.x, y: 2 * a.y - b.y } : a;
      const len = distance(from, b);
      const rotation = (Math.atan2(b.y - from.y, b.x - from.x) * 180) / Math.PI;
      const cx = (from.x + b.x) / 2;
      const cy = (from.y + b.y) / 2;
      return { x: round3(cx - len / 2), y: round3(cy), width: round3(len), height: 0, rotation: round3(rotation) };
    }
    let w = b.x - a.x;
    let h = b.y - a.y;
    if (shift) {
      const s = Math.max(Math.abs(w), Math.abs(h));
      w = Math.sign(w || 1) * s;
      h = Math.sign(h || 1) * s;
    }
    let x0 = a.x, y0 = a.y;
    if (alt) {
      x0 = a.x - w;
      y0 = a.y - h;
      w *= 2;
      h *= 2;
    }
    const x = Math.min(x0, x0 + w);
    const y = Math.min(y0, y0 + h);
    return { x: round3(x), y: round3(y), width: round3(Math.abs(w)), height: round3(Math.abs(h)) };
  }

  pointerUp(editor: Editor, e: ToolPointer): void {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    void e;
    const doc = editor.doc;
    if (!d.moved) {
      // A click: default size (or the chosen preset) with its top-left at the pointer.
      const size = this.type === "frame" && this.preset ? this.preset : { width: DEFAULT_SIZE, height: this.type === "line" ? 0 : DEFAULT_SIZE };
      const props: Record<string, unknown> = { width: size.width, height: size.height };
      if (this.type === "frame" && this.preset) props.name = this.preset.name;
      editor.history.apply([{ type: "updateProps", id: d.id, props }]);
    } else if (this.type === "frame") {
      this.adoptEnclosed(editor, d.id, d.parent);
    }
    editor.history.end();
    if (doc.has(d.id)) editor.select([d.id]);
    editor.setTool("select");
  }

  /** Nodes of the parent fully inside a newly drawn frame move into it (keeping their place). */
  private adoptEnclosed(editor: Editor, frame: string, parent: string): void {
    const doc = editor.doc;
    const geom = editor.geometry;
    const fb: Box = geom.bounds(frame);
    if (fb.width < 1 || fb.height < 1) return;
    const inside = doc.tree
      .childrenOf(parent)
      .filter((c) => c !== frame && !doc.get<boolean>(c, "locked") && doc.get<boolean>(c, "visible") && !isInFlow(doc, c) && boxContainsBox(fb, geom.bounds(c)));
    if (inside.length === 0) return;
    const cmds: Command[] = [{ type: "setParent", ids: inside, parent: frame, index: 0 }];
    editor.history.apply(cmds);
  }

  cancel(editor: Editor): boolean {
    if (!this.drag) {
      editor.setTool("select");
      return true;
    }
    this.drag = null;
    editor.history.abort();
    editor.setTool("select");
    return true;
  }

  overlay(_editor: Editor, _out: OverlayItem[]): void {}
}

function round3(v: number): number {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
}

/** Text tool: click for an auto-width text, drag for a fixed-width box; editing starts at once. */
export class TextTool implements Tool {
  readonly id = "text";
  readonly label = "Text";
  readonly icon = "Type";
  readonly action = "tool.text";
  readonly group = "text";
  readonly order = 60;
  private drag: { id: string; parent: string; origin: Point; start: ToolPointer; moved: boolean } | null = null;

  busy(): boolean {
    return this.drag !== null;
  }

  cursor(): Cursor {
    return "text";
  }

  pointerDown(editor: Editor, e: ToolPointer): void {
    if (e.button !== 0) return;
    // Clicking existing text edits it.
    const hit = pickPath(editor.geometry, e.world, { tolerance: editor.pickTolerance });
    const last = hit?.[hit.length - 1];
    if (last && editor.doc.typeOf(last) === "text") {
      editor.setTool("select");
      editor.enterEditMode(last, e);
      return;
    }
    let origin = e.world;
    if (editor.settings.pixelSnap) origin = { x: Math.round(origin.x), y: Math.round(origin.y) };
    const parent = containerAt(editor, e.world);
    const local = toSpace(editor, parent, origin);
    const id = newId(editor.doc.random);
    // Creating and the typing that follows are separate undo steps.
    const r = editor.history.apply([
      { type: "createNode", node: { id, type: "text", props: { ...creationProps("text"), name: nextName(editor, "text"), x: local.x, y: local.y }, text: { content: "", runs: [] } }, parent },
    ]);
    if (!r) return;
    this.drag = { id, parent, origin, start: e, moved: false };
    editor.select([id]);
  }

  pointerMove(editor: Editor, e: ToolPointer): void {
    const d = this.drag;
    if (!d) return;
    if (!d.moved && distance(d.start.screen, e.screen) < DRAG_THRESHOLD) return;
    if (!d.moved) editor.history.begin();
    d.moved = true;
    const a = toSpace(editor, d.parent, d.origin);
    let p = e.world;
    if (editor.settings.pixelSnap) p = { x: Math.round(p.x), y: Math.round(p.y) };
    const b = toSpace(editor, d.parent, p);
    editor.history.apply([
      {
        type: "updateProps",
        id: d.id,
        props: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.max(1, Math.abs(b.x - a.x)), height: Math.max(1, Math.abs(b.y - a.y)), widthMode: "fixed", heightMode: "fixed" },
      },
    ]);
  }

  pointerUp(editor: Editor): void {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.moved) editor.history.end();
    editor.setTool("select");
    editor.enterEditMode(d.id);
  }

  cancel(editor: Editor): boolean {
    editor.setTool("select");
    return true;
  }
}

/** Hand tool: drag to pan. */
export class HandTool implements Tool {
  readonly id = "hand";
  readonly label = "Hand";
  readonly icon = "Hand";
  readonly action = "tool.hand";
  readonly group = "navigate";
  readonly order = 1;
  private last: Point | null = null;

  busy(): boolean {
    return this.last !== null;
  }

  cursor(): Cursor {
    return this.last ? "grabbing" : "grab";
  }

  pointerDown(_editor: Editor, e: ToolPointer): void {
    this.last = e.screen;
  }

  pointerMove(editor: Editor, e: ToolPointer): void {
    if (!this.last) return;
    editor.viewport.panBy(e.screen.x - this.last.x, e.screen.y - this.last.y);
    this.last = e.screen;
    editor.emit("view");
  }

  pointerUp(): void {
    this.last = null;
  }
}

/**
 * Image tool: asks the host for a file (`place-image`), then places it with
 * {@link placeImage}. Choosing it with nothing to place returns to select.
 */
export class ImageTool implements Tool {
  readonly id = "image";
  readonly label = "Image";
  readonly icon = "Image";
  readonly action = "tool.image";
  readonly group = "image";
  readonly order = 70;

  activate(editor: Editor): void {
    editor.request({ kind: "place-image" });
  }

  cursor(): Cursor {
    return "crosshair";
  }

  pointerDown(editor: Editor): void {
    editor.request({ kind: "place-image" });
  }

  pointerMove(): void {}

  pointerUp(): void {}

  cancel(editor: Editor): boolean {
    editor.setTool("select");
    return true;
  }
}
