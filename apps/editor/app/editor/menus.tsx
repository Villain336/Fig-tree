"use client";

import { contextMenu, copySelection, cutSelection, formatBinding, paste, SHORTCUT_GROUPS, SHORTCUTS, type Editor, type MenuItem } from "@fig-tree/editor-core";
import { X } from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { anchorPart, useAnchor, useEditor } from "./state";
import { IconButton, Popover } from "./ui";

/** Writes to the system clipboard when allowed; the editor keeps an internal copy either way. */
export async function clipboardAction(editor: Editor, action: string): Promise<void> {
  if (action === "edit.copy" || action === "edit.cut") {
    const out = action === "edit.copy" ? copySelection(editor) : cutSelection(editor);
    if (!out) return;
    try {
      const items: Record<string, Blob> = { "text/plain": new Blob([out.text], { type: "text/plain" }) };
      if (out.html) items["text/html"] = new Blob([out.html], { type: "text/html" });
      await navigator.clipboard.write([new ClipboardItem(items)]);
    } catch {
      // Clipboard access denied: the internal copy still pastes.
    }
    return;
  }
  if (action === "edit.paste") {
    try {
      const items = await navigator.clipboard.read();
      const data: { html?: string; text?: string } = {};
      for (const item of items) {
        if (item.types.includes("text/html")) data.html = await (await item.getType("text/html")).text();
        if (item.types.includes("text/plain")) data.text = await (await item.getType("text/plain")).text();
      }
      await paste(editor, data);
    } catch {
      await paste(editor, {});
    }
  }
}

export function ContextMenu({ where, at, onClose }: { where: "canvas" | "layers"; at: { x: number; y: number }; onClose: () => void }) {
  const editor = useEditor();
  const entries = contextMenu(editor, where);
  return (
    <Popover at={at} onClose={onClose} width={220} label="Context menu" testId="context-menu">
      <div className="p-1" role="menu">
        {entries.map((e, i) =>
          e === "separator" ? (
            <div key={`s${i}`} className="my-1 border-t border-stone-200" />
          ) : (
            <ContextItem key={e.action} item={e} where={where} onRun={() => {
              onClose();
              if (e.action === "edit.copy" || e.action === "edit.cut" || e.action === "edit.paste") void clipboardAction(editor, e.action);
              else editor.run(e.action);
            }} />
          ),
        )}
      </div>
    </Popover>
  );
}

function ContextItem({ item, where, onRun }: { item: MenuItem; where: string; onRun: () => void }) {
  const ref = useAnchor<HTMLButtonElement>(`menu.${where}.${item.action}`, "menu-item", item.label);
  return (
    <button
      ref={ref}
      role="menuitem"
      type="button"
      disabled={!item.enabled}
      onClick={onRun}
      data-testid={`menu-${item.action}`}
      className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-[12px] text-stone-800 enabled:hover:bg-blue-600 enabled:hover:text-white disabled:text-stone-300"
    >
      <span>{item.label}</span>
      {item.shortcut && <span className="text-[11px] opacity-60">{item.shortcut}</span>}
    </button>
  );
}

export function PageMenu({ page, at, onClose, onRename, onDelete }: { page: string; at: { x: number; y: number }; onClose: () => void; onRename: () => void; onDelete: () => void }) {
  const editor = useEditor();
  const del = useAnchor<HTMLButtonElement>(`menu.page.${anchorPart(page)}.delete`, "menu-item", "Delete page");
  const ren = useAnchor<HTMLButtonElement>(`menu.page.${anchorPart(page)}.rename`, "menu-item", "Rename page");
  return (
    <Popover at={at} onClose={onClose} width={180} label="Page menu" testId="page-menu">
      <div className="p-1" role="menu">
        <button ref={ren} role="menuitem" type="button" className="w-full rounded px-2 py-1.5 text-left text-[12px] hover:bg-blue-600 hover:text-white" onClick={() => { onClose(); onRename(); }}>
          Rename
        </button>
        <button ref={del} role="menuitem" type="button" disabled={editor.doc.pages.length <= 1} className="w-full rounded px-2 py-1.5 text-left text-[12px] enabled:hover:bg-blue-600 enabled:hover:text-white disabled:text-stone-300" onClick={() => { onClose(); onDelete(); }}>
          Delete page
        </button>
      </div>
    </Popover>
  );
}

/** The keyboard shortcuts sheet (⌘/ or Ctrl+/), searchable. */
export function ShortcutsSheet({ onClose }: { onClose: () => void }) {
  const editor = useEditor();
  const [q, setQ] = useState("");
  const search = useAnchor<HTMLInputElement>("shortcuts.search", "field", "Search shortcuts");
  const dialog = useAnchor<HTMLDivElement>("shortcuts.sheet", "panel", "Keyboard shortcuts");
  const query = q.trim().toLowerCase();
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/20" onPointerDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={(e) => {
      e.stopPropagation();
      if (e.key === "Escape") onClose();
    }}>
      <div ref={dialog} role="dialog" aria-label="Keyboard shortcuts" data-testid="shortcuts" className="flex max-h-[80vh] w-[720px] flex-col rounded-xl border border-stone-200 bg-white shadow-xl">
        <header className="flex items-center gap-3 border-b border-stone-200 px-4 py-3">
          <h2 className="text-[14px] font-semibold text-stone-900">Keyboard shortcuts</h2>
          <input ref={search} autoFocus aria-label="Search shortcuts" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} className="h-7 flex-1 rounded-md border border-stone-200 px-2 text-[12px] outline-none focus:border-blue-500" />
          <IconButton anchor="shortcuts.close" label="Close" icon={X} onClick={onClose} />
        </header>
        <div className="grid grid-cols-2 gap-x-8 gap-y-4 overflow-y-auto px-4 py-3">
          {SHORTCUT_GROUPS.map((g) => {
            const items = SHORTCUTS.filter((s) => s.group === g && (!query || s.label.toLowerCase().includes(query) || s.keys.some((k) => k.toLowerCase().includes(query))));
            if (items.length === 0) return null;
            return (
              <section key={g}>
                <h3 className="pb-1 text-[11px] font-semibold uppercase tracking-wide text-stone-400">{g}</h3>
                <dl>
                  {items.map((s) => (
                    <div key={s.action} className="flex items-center justify-between py-0.5 text-[12px]">
                      <dt className="text-stone-700">{s.label}</dt>
                      <dd className="flex gap-1">
                        {s.keys.slice(0, 2).map((k) => (
                          <kbd key={k} className="rounded border border-stone-200 bg-stone-50 px-1.5 font-sans text-[11px] text-stone-600">
                            {formatBinding(k, editor.platform)}
                          </kbd>
                        ))}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
