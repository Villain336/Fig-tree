import type { Editor } from "@fig-tree/editor-core";
import { hasProp } from "@fig-tree/document";
import { MIXED, type Maybe } from "./ui";

/** The value all ids share, MIXED when they differ, null when none of them has it. */
export function common<T>(ids: readonly string[], get: (id: string) => T | undefined): Maybe<T> | null {
  let found = false;
  let value: T | undefined;
  for (const id of ids) {
    const v = get(id);
    if (v === undefined) continue;
    if (!found) {
      found = true;
      value = v;
    } else if (JSON.stringify(v) !== JSON.stringify(value)) return MIXED;
  }
  return found ? (value as T) : null;
}

/** A property's common value over the ids that have it. */
export function prop<T>(editor: Editor, ids: readonly string[], key: string): Maybe<T> | null {
  return common(ids, (id) => {
    const t = editor.doc.typeOf(id);
    return t && hasProp(t, key) ? editor.doc.get<T>(id, key) : undefined;
  });
}

export function withProp(editor: Editor, ids: readonly string[], key: string): string[] {
  return ids.filter((id) => {
    const t = editor.doc.typeOf(id);
    return t !== undefined && hasProp(t, key);
  });
}
