"use client";

import { addPage, deletePage, moveInTree, renameNode, setFlag, type Editor } from "@fig-tree/editor-core";
import type { NodeType } from "@fig-tree/document";
import {
  ChevronDown,
  ChevronRight,
  Circle,
  Component,
  Diamond,
  Eye,
  EyeOff,
  File,
  Frame,
  Group,
  Hexagon,
  Image as ImageIcon,
  LayoutGrid,
  Lock,
  Minus,
  PenTool,
  Plus,
  Rows3,
  Columns3,
  Square,
  Star,
  TriangleAlert,
  Type,
  Unlock,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { anchorPart, useAnchor, useEditor, useEditorTick } from "./state";
import { IconButton } from "./ui";

const ICONS: Record<NodeType, LucideIcon> = {
  page: File,
  frame: Frame,
  group: Group,
  rectangle: Square,
  ellipse: Circle,
  polygon: Hexagon,
  star: Star,
  line: Minus,
  vector: PenTool,
  text: Type,
  image: ImageIcon,
  component: Component,
  instance: Diamond,
};

function iconFor(editor: Editor, id: string, type: NodeType): LucideIcon {
  if (type === "frame") {
    const d = editor.doc.get<string>(id, "display");
    if (d === "grid") return LayoutGrid;
    if (d === "flex") return editor.doc.get<string>(id, "flexDirection").startsWith("column") ? Rows3 : Columns3;
  }
  return ICONS[type];
}

interface Row {
  readonly id: string;
  readonly type: NodeType;
  readonly name: string;
  readonly depth: number;
  readonly parent: string;
  readonly hasChildren: boolean;
  readonly visible: boolean;
  readonly locked: boolean;
  readonly unsupported: readonly string[];
}

/** Rows shown at most (very large documents are truncated; collapse frames to see the rest). */
const MAX_ROWS = 2000;
/** Documents up to this size start with every layer expanded. */
const EXPAND_ALL_BELOW = 400;

function rowsOf(editor: Editor, collapsed: ReadonlySet<string>): { rows: Row[]; truncated: number } {
  const doc = editor.doc;
  const rows: Row[] = [];
  let truncated = 0;
  const walk = (parent: string, depth: number): void => {
    const kids = doc.tree.childrenOf(parent);
    for (let i = kids.length - 1; i >= 0; i--) {
      const id = kids[i]!;
      if (rows.length >= MAX_ROWS) {
        truncated++;
        continue;
      }
      const type = doc.typeOf(id)!;
      const n = doc.tree.childrenOf(id).length;
      rows.push({
        id,
        type,
        name: doc.get<string>(id, "name"),
        depth,
        parent,
        hasChildren: n > 0,
        visible: doc.get<boolean>(id, "visible"),
        locked: doc.get<boolean>(id, "locked"),
        unsupported: [...(editor.bridge.unsupported.get(id) ?? [])],
      });
      if (n > 0 && !collapsed.has(id)) walk(id, depth + 1);
    }
  };
  walk(editor.page, 0);
  return { rows, truncated };
}

type Drop = { row: string; where: "before" | "after" | "inside" };

export function LayersPanel({ onContextMenu, renaming, setRenaming }: { onContextMenu: (at: { x: number; y: number }) => void; renaming: string | null; setRenaming: (id: string | null) => void }) {
  const editor = useEditor();
  const tick = useEditorTick(["document", "selection", "page", "hover"]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => (editor.doc.tree.size > EXPAND_ALL_BELOW ? new Set(editor.doc.tree.ids()) : new Set()));
  const [drop, setDrop] = useState<Drop | null>(null);
  const anchor = useRef<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const dragRef = useRef<{ ids: string[]; startY: number; active: boolean } | null>(null);

  // Reveal selected layers by expanding their ancestors.
  const selection = editor.selection;
  useEffect(() => {
    let changed = false;
    const next = new Set(collapsed);
    for (const id of selection) {
      for (let p = editor.doc.tree.parentOf(id); p && p !== editor.page && p !== "root"; p = editor.doc.tree.parentOf(p)) {
        if (next.delete(p)) changed = true;
      }
    }
    if (changed) setCollapsed(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection]);

  const { rows, truncated } = useMemo(() => rowsOf(editor, collapsed), [editor, collapsed, tick]);
  const selected = new Set(selection);

  const select = (id: string, e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }): void => {
    const mod = editor.platform === "mac" ? e.metaKey : e.ctrlKey;
    if (mod) {
      editor.select(selected.has(id) ? selection.filter((s) => s !== id) : [...selection, id]);
      anchor.current = id;
    } else if (e.shiftKey && anchor.current) {
      const a = rows.findIndex((r) => r.id === anchor.current);
      const b = rows.findIndex((r) => r.id === id);
      if (a >= 0 && b >= 0) editor.select(rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((r) => r.id));
    } else {
      editor.select([id]);
      anchor.current = id;
    }
  };

  const dropAt = (clientY: number): Drop | null => {
    const list = listRef.current;
    if (!list) return null;
    for (const el of list.querySelectorAll<HTMLElement>("[data-row]")) {
      const r = el.getBoundingClientRect();
      if (clientY < r.top || clientY > r.bottom) continue;
      const id = el.dataset.row!;
      const row = rows.find((x) => x.id === id)!;
      const f = (clientY - r.top) / r.height;
      const container = ["frame", "group", "component", "instance"].includes(row.type);
      if (container && f > 0.25 && f < 0.75) return { row: id, where: "inside" };
      return { row: id, where: f < 0.5 ? "before" : "after" };
    }
    return null;
  };

  const commitDrop = (ids: string[], d: Drop): void => {
    const doc = editor.doc;
    const moving = new Set(ids);
    if (d.where === "inside") {
      const others = doc.tree.childrenOf(d.row).filter((c) => !moving.has(c));
      moveInTree(editor, ids, d.row, others.length);
      return;
    }
    const parent = doc.tree.parentOf(d.row)!;
    if (moving.has(d.row)) return;
    const others = doc.tree.childrenOf(parent).filter((c) => !moving.has(c));
    const i = others.indexOf(d.row);
    // The list shows the top of the stack first: "before" a row is above it in z-order.
    moveInTree(editor, ids, parent, d.where === "before" ? i + 1 : i);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <h2 className="flex h-8 shrink-0 items-center px-3 text-[11px] font-semibold text-stone-800">Layers</h2>
      <ul ref={listRef} className="min-h-0 flex-1 overflow-y-auto pb-4 text-[12px]" data-testid="layers" role="tree" aria-label="Layers" onPointerLeave={() => editor.setHover(null)}>
        {rows.map((r) => (
          <LayerRow
            key={r.id}
            row={r}
            selected={selected.has(r.id)}
            hovered={editor.hover === r.id}
            collapsed={collapsed.has(r.id)}
            renaming={renaming === r.id}
            drop={drop?.row === r.id ? drop.where : null}
            onToggle={() => {
              const next = new Set(collapsed);
              if (next.has(r.id)) next.delete(r.id);
              else next.add(r.id);
              setCollapsed(next);
            }}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              if (!selected.has(r.id) || e.shiftKey || e.metaKey || e.ctrlKey) select(r.id, e);
              dragRef.current = { ids: selected.has(r.id) && !(e.shiftKey || e.metaKey || e.ctrlKey) ? [...selection] : [r.id], startY: e.clientY, active: false };
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              const d = dragRef.current;
              if (!d) return;
              if (!d.active && Math.abs(e.clientY - d.startY) < 4) return;
              d.active = true;
              setDrop(dropAt(e.clientY));
            }}
            onPointerUp={(e) => {
              const d = dragRef.current;
              dragRef.current = null;
              setDrop(null);
              if (d?.active) {
                const target = dropAt(e.clientY);
                if (target) commitDrop(d.ids, target);
              } else if (d && selected.has(r.id) && !(e.shiftKey || e.metaKey || e.ctrlKey)) editor.select([r.id]);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              if (!selected.has(r.id)) editor.select([r.id]);
              onContextMenu({ x: e.clientX, y: e.clientY });
            }}
            onRename={(name) => {
              if (name !== null) renameNode(editor, r.id, name);
              setRenaming(null);
            }}
            onStartRename={() => setRenaming(r.id)}
            onHover={() => editor.setHover(r.id)}
            onFlag={(key, value) => setFlag(editor, selected.has(r.id) ? selection : [r.id], key, value)}
            icon={iconFor(editor, r.id, r.type)}
          />
        ))}
        {rows.length === 0 && <li className="px-3 py-2 text-[12px] text-stone-400">No layers on this page.</li>}
        {truncated > 0 && <li className="px-3 py-1 text-[11px] text-stone-400">{truncated.toLocaleString()} more layers not listed</li>}
      </ul>
    </div>
  );
}

function LayerRow({
  row,
  selected,
  hovered,
  collapsed,
  renaming,
  drop,
  onToggle,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onContextMenu,
  onRename,
  onStartRename,
  onHover,
  onFlag,
  icon: Icon,
}: {
  row: Row;
  selected: boolean;
  hovered: boolean;
  collapsed: boolean;
  renaming: boolean;
  drop: Drop["where"] | null;
  onToggle: () => void;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onRename: (name: string | null) => void;
  onStartRename: () => void;
  onHover: () => void;
  onFlag: (key: "locked" | "visible", value: boolean) => void;
  icon: LucideIcon;
}) {
  const id = anchorPart(row.id);
  const rowRef = useAnchor<HTMLDivElement>(`layers.row.${id}`, "list-item", `Layer ${row.name}`);
  const inputRef = useAnchor<HTMLInputElement>(`layers.row.${id}.rename`, "field", `Rename ${row.name}`);
  const indent = 8 + row.depth * 14;
  return (
    <li role="treeitem" aria-selected={selected} aria-expanded={row.hasChildren ? !collapsed : undefined} className="relative">
      {drop === "before" && <div className="pointer-events-none absolute right-1 top-0 z-10 h-0.5 bg-blue-600" style={{ left: indent }} />}
      {drop === "after" && <div className="pointer-events-none absolute bottom-0 right-1 z-10 h-0.5 bg-blue-600" style={{ left: indent }} />}
      <div
        ref={rowRef}
        data-row={row.id}
        data-node={row.id}
        data-testid={`layer-${row.id}`}
        aria-label={row.name}
        className={`group flex h-7 cursor-default items-center gap-1 pr-1 ${selected ? "bg-blue-100" : hovered ? "bg-stone-100" : ""} ${drop === "inside" ? "ring-2 ring-inset ring-blue-600" : ""} ${row.visible ? "text-stone-800" : "text-stone-400"}`}
        style={{ paddingLeft: indent }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerEnter={onHover}
        onContextMenu={onContextMenu}
        onDoubleClick={onStartRename}
      >
        {row.hasChildren ? (
          <span onPointerDown={(e) => e.stopPropagation()} className="flex">
          <IconButton anchor={`layers.row.${id}.expand`} label={collapsed ? "Expand" : "Collapse"} icon={collapsed ? ChevronRight : ChevronDown} size={16} iconSize={12} onClick={(e) => { e.stopPropagation(); onToggle(); }} className="hover:bg-transparent" />
          </span>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <Icon size={13} strokeWidth={1.75} className="shrink-0 text-stone-500" aria-hidden />
        {renaming ? (
          <input
            ref={inputRef}
            aria-label={`Rename ${row.name}`}
            data-testid="layer-rename"
            defaultValue={row.name}
            autoFocus
            onFocus={(e) => e.target.select()}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") onRename((e.target as HTMLInputElement).value);
              if (e.key === "Escape") onRename(null);
            }}
            onBlur={(e) => onRename(e.target.value)}
            className="h-5 min-w-0 flex-1 rounded border border-blue-500 bg-white px-1 text-[12px] outline-none"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate">{row.name}</span>
        )}
        {row.unsupported.length > 0 && (
          <span className="shrink-0 text-amber-600" title={`Not rendered yet: ${row.unsupported.join(", ")}`}>
            <TriangleAlert size={12} aria-label="has unsupported features" />
          </span>
        )}
        <span className={`flex shrink-0 items-center ${row.locked || !row.visible ? "" : "opacity-0 group-hover:opacity-100"}`} onPointerDown={(e) => e.stopPropagation()}>
          <IconButton anchor={`layers.row.${id}.lock`} label={row.locked ? "Unlock" : "Lock"} kind="toggle" active={false} icon={row.locked ? Lock : Unlock} size={20} iconSize={12} onClick={(e) => { e.stopPropagation(); onFlag("locked", !row.locked); }} className="hover:bg-stone-200" />
          <IconButton anchor={`layers.row.${id}.visibility`} label={row.visible ? "Hide" : "Show"} kind="toggle" active={false} icon={row.visible ? Eye : EyeOff} size={20} iconSize={12} onClick={(e) => { e.stopPropagation(); onFlag("visible", !row.visible); }} className="hover:bg-stone-200" />
        </span>
      </div>
    </li>
  );
}

export function PagesPanel({ onPageMenu }: { onPageMenu: (page: string, at: { x: number; y: number }) => void }) {
  const editor = useEditor();
  useEditorTick(["document", "page"]);
  const [renaming, setRenaming] = useState<string | null>(null);
  return (
    <div className="shrink-0 border-b border-stone-200 pb-1.5" data-testid="pages">
      <div className="flex h-8 items-center justify-between pl-3 pr-1">
        <h2 className="text-[11px] font-semibold text-stone-800">Pages</h2>
        <IconButton anchor="pages.add" label="Add a page" icon={Plus} size={24} iconSize={14} onClick={() => addPage(editor)} testId="add-page" />
      </div>
      <ul className="max-h-40 overflow-y-auto text-[12px]" role="listbox" aria-label="Pages">
        {editor.doc.pages.map((p) => (
          <PageRow key={p} id={p} current={p === editor.page} renaming={renaming === p} setRenaming={setRenaming} onMenu={(at) => onPageMenu(p, at)} />
        ))}
      </ul>
    </div>
  );
}

function PageRow({ id, current, renaming, setRenaming, onMenu }: { id: string; current: boolean; renaming: boolean; setRenaming: (id: string | null) => void; onMenu: (at: { x: number; y: number }) => void }) {
  const editor = useEditor();
  const name = editor.doc.get<string>(id, "name");
  const ref = useAnchor<HTMLButtonElement>(`pages.page.${anchorPart(id)}`, "list-item", `Page ${name}`);
  const inputRef = useAnchor<HTMLInputElement>(`pages.page.${anchorPart(id)}.rename`, "field", `Rename page ${name}`);
  return (
    <li role="option" aria-selected={current}>
      {renaming ? (
        <input
          ref={inputRef}
          aria-label={`Rename page ${name}`}
          defaultValue={name}
          autoFocus
          onFocus={(e) => e.target.select()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              renameNode(editor, id, (e.target as HTMLInputElement).value);
              setRenaming(null);
            }
            if (e.key === "Escape") setRenaming(null);
          }}
          onBlur={(e) => {
            renameNode(editor, id, e.target.value);
            setRenaming(null);
          }}
          className="mx-2 h-6 w-[calc(100%-1rem)] rounded border border-blue-500 px-1 text-[12px] outline-none"
        />
      ) : (
        <button
          ref={ref}
          type="button"
          data-page={id}
          className={`flex h-7 w-full items-center gap-2 px-3 text-left ${current ? "font-medium text-stone-900" : "text-stone-600 hover:bg-stone-100"}`}
          onClick={() => editor.setPage(id)}
          onDoubleClick={() => setRenaming(id)}
          onContextMenu={(e) => {
            e.preventDefault();
            onMenu({ x: e.clientX, y: e.clientY });
          }}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${current ? "bg-blue-600" : "bg-transparent"}`} />
          <span className="truncate">{name}</span>
        </button>
      )}
    </li>
  );
}

export { deletePage };
