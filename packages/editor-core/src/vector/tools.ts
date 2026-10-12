import { freehandToNetwork, invert, networkBounds, transformNetwork, transformPoint, translation, type Point } from "@fig-tree/geometry";
import { newId } from "@fig-tree/document";
import type { Editor } from "../editor";
import type { OverlayItem } from "../overlay";
import { containerAt } from "../placement";
import { nextName } from "../tools/create";
import type { Cursor, EditMode, EditSession, Tool, ToolPointer } from "../tools/tool";
import { clean, editableNetwork, VECTOR_EDITABLE } from "./edit";
import { VectorEditSession, type VectorSubTool } from "./session";

/**
 * Vector edit mode for vectors and shapes (Enter, or a double-click). A
 * shape shows the points it is drawn with and becomes a vector on its first
 * edit.
 */
export class VectorEditMode implements EditMode {
  readonly id = "vector";
  readonly nodeTypes = VECTOR_EDITABLE;

  enter(editor: Editor, id: string, at?: ToolPointer): EditSession | null {
    const doc = editor.doc;
    if (doc.get<boolean>(id, "locked") || !editableNetwork(doc, id)) return null;
    void at;
    return new VectorEditSession(editor, id);
  }
}

/** The vector edit session, if one is open. */
export function vectorSession(editor: Editor): VectorEditSession | null {
  const s = editor.session;
  return s instanceof VectorEditSession ? s : null;
}

/** Enters vector edit mode on a node with a sub-tool (the pen for "add points to this vector"). */
export function editVectorWith(editor: Editor, id: string, subTool: VectorSubTool): boolean {
  if (!editor.enterEditMode(id)) return false;
  vectorSession(editor)?.setSubTool(subTool);
  return true;
}

/**
 * The pen tool (P): the first click creates a vector inside the frame
 * under the pointer and opens vector edit mode on it with the pen, so every
 * later click, drag and key goes to the pen (see `VectorEditSession`).
 * Escape or Enter ends the path, a second press returns to the select tool.
 */
export class PenToolTool implements Tool {
  readonly id = "pen";
  readonly label = "Pen";
  readonly icon = "PenTool";
  readonly action = "tool.pen";
  readonly group = "vector";
  readonly order = 30;

  cursor(): Cursor {
    return "pen";
  }

  pointerDown(editor: Editor, e: ToolPointer): void {
    if (e.button !== 0) return;
    const parent = containerAt(editor, e.world);
    const session = VectorEditSession.newVector(editor, parent);
    editor.openSession(session);
    session.pointerDown(e);
  }

  pointerMove(): void {}

  pointerUp(): void {}
}

/**
 * The pencil tool (Shift+P): a freehand stroke is fitted with curves
 * (within a tolerance of 1.5 screen pixels, corners kept), and becomes a
 * vector with a round stroke; a stroke that ends where it started is closed
 * and filled. One undo step per stroke; the tool stays active.
 */
export class PencilTool implements Tool {
  readonly id = "pencil";
  readonly label = "Pencil";
  readonly icon = "Pencil";
  readonly action = "tool.pencil";
  readonly group = "vector";
  readonly order = 31;
  /** Fitting tolerance and closing distance, in screen pixels. */
  static readonly TOLERANCE = 1.5;
  static readonly CLOSE_DISTANCE = 10;
  private stroke: { points: Point[]; screen: Point[]; parent: string } | null = null;

  busy(): boolean {
    return this.stroke !== null;
  }

  cursor(): Cursor {
    return "pencil";
  }

  pointerDown(editor: Editor, e: ToolPointer): void {
    if (e.button !== 0) return;
    this.stroke = { points: [e.world], screen: [e.screen], parent: containerAt(editor, e.world) };
    editor.emit("overlay");
  }

  pointerMove(editor: Editor, e: ToolPointer): void {
    const s = this.stroke;
    if (!s) return;
    const last = s.screen[s.screen.length - 1]!;
    if (Math.hypot(e.screen.x - last.x, e.screen.y - last.y) < 1) return;
    s.points.push(e.world);
    s.screen.push(e.screen);
    editor.emit("overlay");
  }

  pointerUp(editor: Editor, e: ToolPointer): void {
    const s = this.stroke;
    this.stroke = null;
    if (!s) return;
    const last = s.screen[s.screen.length - 1]!;
    if (Math.hypot(e.screen.x - last.x, e.screen.y - last.y) >= 0.5) s.points.push(e.world);
    editor.emit("overlay");
    if (s.points.length < 2) return;
    const id = drawFreehand(editor, s.points, s.parent);
    if (id) editor.select([id]);
  }

  cancel(editor: Editor): boolean {
    if (!this.stroke) return false;
    this.stroke = null;
    editor.emit("overlay");
    return true;
  }

  overlay(_editor: Editor, out: OverlayItem[]): void {
    if (this.stroke && this.stroke.screen.length > 1) out.push({ kind: "path", role: "pencil", contours: [this.stroke.screen] });
  }
}

const black = { type: "solid" as const, color: { r: 0, g: 0, b: 0, a: 1 } };
const gray = { type: "solid" as const, color: { r: 0.85, g: 0.85, b: 0.85, a: 1 } };

/**
 * Creates a vector from freehand points (world space) inside `parent`:
 * curve fitting within the pencil's tolerance, closed and filled when the
 * stroke ends near its start. Returns the new node's id.
 */
export function drawFreehand(editor: Editor, world: readonly Point[], parent: string): string | null {
  const space = parent === editor.page ? null : editor.geometry.worldMatrix(parent);
  const inv = space ? invert(space) : null;
  const pts = world.map((p) => (inv ? transformPoint(inv, p.x, p.y) : p));
  const scale = editor.viewport.scale;
  let net = freehandToNetwork(pts, { tolerance: PencilTool.TOLERANCE / scale, closeDistance: PencilTool.CLOSE_DISTANCE / scale });
  if (net.segments.length === 0) return null;
  const b = networkBounds(net);
  net = transformNetwork(net, translation(-b.minX, -b.minY));
  const closed = net.regions.length > 0;
  const id = newId(editor.doc.random);
  const r = editor.history.apply([
    {
      type: "createNode",
      node: {
        id,
        type: "vector",
        props: {
          name: nextName(editor, "vector"),
          x: b.minX,
          y: b.minY,
          width: b.maxX - b.minX,
          height: b.maxY - b.minY,
          fills: closed ? [gray] : [],
          strokes: [black],
          strokeWeight: 2,
          strokeCap: "round",
          strokeJoin: "round",
          vectorNetwork: clean(net),
        },
      },
      parent,
    },
  ]);
  return r ? id : null;
}
