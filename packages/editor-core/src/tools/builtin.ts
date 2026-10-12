import type { Editor } from "../editor";
import { HandTool, ImageTool, ShapeTool, TextTool } from "./create";
import { SelectTool } from "./select";
import { PencilTool, PenToolTool } from "../vector/tools";

/**
 * The tools every editor starts with. The pen and pencil (module 5c) are in
 * the "vector" group; later modules register theirs the same way
 * (`editor.tools.register`).
 */
export function registerBuiltinTools(editor: Editor): void {
  editor.tools.register(new SelectTool());
  editor.tools.register(new HandTool());
  editor.tools.register(new ShapeTool("frame", "frame", "Frame", "Frame", 10));
  editor.tools.register(new ShapeTool("rectangle", "rectangle", "Rectangle", "Square", 20));
  editor.tools.register(new ShapeTool("ellipse", "ellipse", "Ellipse", "Circle", 21));
  editor.tools.register(new ShapeTool("polygon", "polygon", "Polygon", "Triangle", 22));
  editor.tools.register(new ShapeTool("star", "star", "Star", "Star", 23));
  editor.tools.register(new ShapeTool("line", "line", "Line", "Minus", 24));
  editor.tools.register(new PenToolTool());
  editor.tools.register(new PencilTool());
  editor.tools.register(new TextTool());
  editor.tools.register(new ImageTool());
}
