"use client";

import type { AnchorKind, Editor, EditorChange } from "@fig-tree/editor-core";
import { createContext, useCallback, useContext, useEffect, useState } from "react";

export const EditorContext = createContext<Editor | null>(null);

export function useEditor(): Editor {
  const e = useContext(EditorContext);
  if (!e) throw new Error("useEditor outside an editor");
  return e;
}

/**
 * Re-renders the component (at most once per animation frame) when the
 * editor reports one of `kinds`. Panels read the document and the editor
 * directly while rendering, so a tick is all they need.
 */
export function useEditorTick(kinds: readonly EditorChange[]): number {
  const editor = useEditor();
  const [tick, setTick] = useState(0);
  const key = kinds.join(",");
  useEffect(() => {
    const wanted = new Set(key.split(",") as EditorChange[]);
    let frame = 0;
    const off = editor.subscribe((changes) => {
      for (const c of changes) {
        if (!wanted.has(c)) continue;
        if (!frame) frame = requestAnimationFrame(() => {
          frame = 0;
          setTick((t) => t + 1);
        });
        return;
      }
    });
    return () => {
      off();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [editor, key]);
  return tick;
}

/**
 * Registers an element in the UI anchor registry (`editor.anchors`) under a
 * stable id, and marks it with `data-anchor`. Every interactive control
 * uses this (or a component built on it), so agents and tests can find it.
 */
export function useAnchor<T extends HTMLElement>(id: string, kind: AnchorKind, label: string): (el: T | null) => (() => void) | undefined {
  const editor = useContext(EditorContext);
  return useCallback(
    (el: T | null) => {
      if (!el || !editor) return undefined;
      el.dataset.anchor = id;
      const off = editor.anchors.register(id, kind, label, () => {
        if (!el.isConnected) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      });
      return () => off();
    },
    [editor, id, kind, label],
  );
}

/** Turns arbitrary text (node ids, names) into an anchor id segment. */
export function anchorPart(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "-");
}
