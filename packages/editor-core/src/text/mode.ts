import type { Editor } from "../editor";
import type { EditMode, EditSession, ToolPointer } from "../tools/tool";
import { TextSession } from "./session";

/** Text editing on the canvas: double-click a text node (or press Enter) to edit it. */
export class TextEditMode implements EditMode {
  readonly id = "text";
  readonly nodeTypes = ["text"] as const;

  enter(editor: Editor, id: string, at?: ToolPointer): EditSession | null {
    if (editor.doc.typeOf(id) !== "text" || editor.doc.get<boolean>(id, "locked")) return null;
    const session = new TextSession(editor, id);
    if (at) {
      // The double-click that entered places the caret, and selects the word under it.
      session.pointerDown({ ...at, clickCount: at.clickCount >= 2 ? 2 : 1 });
      session.pointerUp();
    } else {
      session.selectAll();
    }
    return session;
  }
}

/** The text session being edited, if any. */
export function textSession(editor: Editor): TextSession | null {
  const s = editor.session;
  return s instanceof TextSession ? s : null;
}
