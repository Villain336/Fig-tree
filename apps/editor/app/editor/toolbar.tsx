"use client";

import { shortcutLabel, vectorSession, type Tool, type VectorSubTool } from "@fig-tree/editor-core";
import {
  Check,
  ChevronDown,
  Circle,
  Frame,
  Hand,
  Image as ImageIcon,
  Keyboard,
  Minus,
  MousePointer2,
  PaintBucket,
  Pencil,
  PenTool,
  Redo2,
  Shapes,
  Spline,
  Square,
  SquaresExclude,
  SquaresIntersect,
  SquaresSubtract,
  SquaresUnite,
  Star,
  Triangle,
  Type,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { Popover, IconButton, TextButton } from "./ui";
import { useAnchor, useEditor, useEditorTick } from "./state";

/** Toolbar icons by the names tools declare (module 5b's tools name theirs too). */
export const TOOL_ICONS: Record<string, LucideIcon> = { MousePointer2, Hand, Frame, Square, Circle, Triangle, Star, Minus, Type, Image: ImageIcon, PenTool, Pencil };

/** Icons of the boolean operations (Lucide), shared with the layers panel. */
export const BOOLEAN_ICONS: Record<string, LucideIcon> = { union: SquaresUnite, subtract: SquaresSubtract, intersect: SquaresIntersect, exclude: SquaresExclude };
export const BOOLEAN_LABELS: Record<string, string> = { union: "Union", subtract: "Subtract", intersect: "Intersect", exclude: "Exclude" };

function MenuRow({ anchor, label, shortcut, checked, onClick }: { anchor: string; label: string; shortcut?: string | null; checked?: boolean; onClick: () => void }) {
  const ref = useAnchor<HTMLButtonElement>(anchor, "menu-item", label);
  return (
    <button ref={ref} role="menuitem" type="button" className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-stone-800 hover:bg-blue-600 hover:text-white" onClick={onClick}>
      <span className="w-3">{checked && <Check size={12} aria-hidden />}</span>
      <span className="flex-1">{label}</span>
      {shortcut && <span className="text-[11px] opacity-60">{shortcut}</span>}
    </button>
  );
}

function ZoomMenu() {
  const editor = useEditor();
  useEditorTick(["view", "settings"]);
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null);
  const ref = useAnchor<HTMLButtonElement>("toolbar.zoom", "button", "Zoom and view options");
  const run = (a: string) => () => {
    editor.run(a);
    setOpen(null);
  };
  const sc = (a: string) => shortcutLabel(a, editor.platform);
  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-label="Zoom and view options"
        data-testid="zoom"
        className="flex h-7 items-center gap-1 rounded-md px-2 text-[11px] tabular-nums text-stone-700 hover:bg-stone-100"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setOpen(open ? null : { x: r.right - 220, y: r.bottom + 4 });
        }}
      >
        {Math.round(editor.viewport.scale * 100)}%
        <ChevronDown size={12} aria-hidden />
      </button>
      {open && (
        <Popover at={open} onClose={() => setOpen(null)} width={220} label="View" testId="zoom-menu">
          <div className="p-1" role="menu">
            <MenuRow anchor="menu.view.zoomIn" label="Zoom in" shortcut={sc("view.zoomIn")} onClick={run("view.zoomIn")} />
            <MenuRow anchor="menu.view.zoomOut" label="Zoom out" shortcut={sc("view.zoomOut")} onClick={run("view.zoomOut")} />
            <MenuRow anchor="menu.view.zoomFit" label="Zoom to fit" shortcut={sc("view.zoomFit")} onClick={run("view.zoomFit")} />
            <MenuRow anchor="menu.view.zoomSelection" label="Zoom to selection" shortcut={sc("view.zoomSelection")} onClick={run("view.zoomSelection")} />
            <MenuRow anchor="menu.view.zoom100" label="Zoom to 100%" shortcut={sc("view.zoom100")} onClick={run("view.zoom100")} />
            <div className="my-1 border-t border-stone-200" />
            <MenuRow anchor="menu.view.pixelGrid" label="Pixel grid" checked={editor.settings.pixelGrid} shortcut={sc("view.pixelGrid")} onClick={run("view.pixelGrid")} />
            <MenuRow anchor="menu.view.rulers" label="Rulers" checked={editor.settings.rulers} shortcut={sc("view.rulers")} onClick={run("view.rulers")} />
            <MenuRow anchor="menu.view.snapping" label="Snap to objects" checked={editor.settings.snapping} onClick={run("view.snapping")} />
            <MenuRow anchor="menu.view.pixelSnap" label="Snap to pixel grid" checked={editor.settings.pixelSnap} onClick={run("view.pixelSnap")} />
          </div>
        </Popover>
      )}
    </>
  );
}

/** The boolean operations menu: union, subtract, intersect, exclude, then flatten and outline stroke. */
function BooleanMenu() {
  const editor = useEditor();
  useEditorTick(["selection", "document"]);
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null);
  const ref = useAnchor<HTMLButtonElement>("toolbar.boolean", "button", "Boolean operations");
  const run = (a: string) => () => {
    editor.run(a);
    setOpen(null);
  };
  const sc = (a: string) => shortcutLabel(a, editor.platform);
  const enabled = editor.canRun("boolean.union");
  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-label="Boolean operations"
        title="Boolean operations"
        data-testid="boolean-menu"
        disabled={!enabled}
        className="flex h-7 items-center gap-0.5 rounded-md px-1.5 text-stone-600 hover:bg-stone-100 hover:text-stone-900 disabled:opacity-35"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setOpen(open ? null : { x: r.left, y: r.bottom + 4 });
        }}
      >
        <SquaresUnite size={15} strokeWidth={1.75} aria-hidden />
        <ChevronDown size={12} aria-hidden />
      </button>
      {open && (
        <Popover at={open} onClose={() => setOpen(null)} width={220} label="Boolean operations" testId="boolean-popover">
          <div className="p-1" role="menu">
            {(["union", "subtract", "intersect", "exclude"] as const).map((op) => (
              <MenuRow key={op} anchor={`menu.boolean.${op}`} label={`${BOOLEAN_LABELS[op]} selection`} shortcut={sc(`boolean.${op}`)} onClick={run(`boolean.${op}`)} />
            ))}
            <div className="my-1 border-t border-stone-200" />
            <MenuRow anchor="menu.boolean.flatten" label="Flatten" shortcut={sc("object.flatten")} onClick={run("object.flatten")} />
            <MenuRow anchor="menu.boolean.outlineStroke" label="Outline stroke" shortcut={sc("object.outlineStroke")} onClick={run("object.outlineStroke")} />
          </div>
        </Popover>
      )}
    </>
  );
}

const VECTOR_TOOLS: { id: VectorSubTool; label: string; icon: LucideIcon; keys: string }[] = [
  { id: "select", label: "Select points", icon: MousePointer2, keys: "V" },
  { id: "pen", label: "Pen", icon: PenTool, keys: "P" },
  { id: "bend", label: "Bend", icon: Spline, keys: "Mod" },
  { id: "bucket", label: "Paint bucket", icon: PaintBucket, keys: "B" },
];

/** The toolbar while editing a vector's points: its sub-tools and Done. */
function VectorTools() {
  const editor = useEditor();
  const session = vectorSession(editor)!;
  const mac = editor.platform === "mac";
  return (
    <nav className="flex items-center gap-0.5" aria-label="Vector editing tools" data-testid="vector-toolbar">
      <span className="pr-2 text-[11px] font-medium text-stone-500">Edit points</span>
      {VECTOR_TOOLS.map((t) => (
        <IconButton
          key={t.id}
          anchor={`toolbar.vector.${t.id}`}
          label={t.label}
          icon={t.icon}
          kind="toggle"
          active={session.subTool === t.id}
          shortcut={t.keys === "Mod" ? (mac ? "⌘" : "Ctrl") : t.keys}
          testId={`vector-tool-${t.id}`}
          onClick={() => session.setSubTool(t.id)}
        />
      ))}
      <TextButton anchor="toolbar.vector.done" label="Done editing points" testId="vector-done" onClick={() => editor.run("vector.done")} className="ml-1 border border-stone-200">
        Done
      </TextButton>
    </nav>
  );
}

export function Toolbar({ onShortcuts }: { onShortcuts: () => void }) {
  const editor = useEditor();
  useEditorTick(["tool", "document", "session"]);
  const editing = vectorSession(editor) !== null;
  const tools = editor.tools.list();
  const groups: Tool[][] = [];
  for (const t of tools) {
    const last = groups[groups.length - 1];
    if (last && last[0]!.group === t.group) last.push(t);
    else groups.push([t]);
  }
  return (
    <header className="flex h-11 shrink-0 items-center justify-between border-b border-stone-200 bg-white px-2" data-testid="toolbar">
      <div className="flex w-60 items-center gap-2 pl-1">
        <span className="text-[13px] font-semibold tracking-tight text-stone-900">Fig Tree</span>
        <span className="truncate text-[12px] text-stone-500">{editor.doc.name}</span>
      </div>
      {editing ? (
        <VectorTools />
      ) : (
      <nav className="flex items-center gap-1" aria-label="Tools">
        {groups.map((g, i) => (
          <div key={g[0]!.id} className={`flex items-center gap-0.5 ${i > 0 ? "border-l border-stone-200 pl-1" : ""}`}>
            {g.map((t) => (
              <IconButton
                key={t.id}
                anchor={`toolbar.tool.${t.id}`}
                label={t.label}
                icon={TOOL_ICONS[t.icon] ?? Shapes}
                kind="toggle"
                active={editor.tool.id === t.id}
                shortcut={t.action ? shortcutLabel(t.action, editor.platform) : null}
                testId={`tool-${t.id}`}
                onClick={() => editor.setTool(t.id)}
              />
            ))}
          </div>
        ))}
        <div className="flex items-center border-l border-stone-200 pl-1">
          <BooleanMenu />
        </div>
      </nav>
      )}
      <div className="flex w-72 items-center justify-end gap-0.5">
        <IconButton anchor="toolbar.undo" label="Undo" icon={Undo2} disabled={!editor.history.canUndo()} shortcut={shortcutLabel("edit.undo", editor.platform)} onClick={() => editor.run("edit.undo")} />
        <IconButton anchor="toolbar.redo" label="Redo" icon={Redo2} disabled={!editor.history.canRedo()} shortcut={shortcutLabel("edit.redo", editor.platform)} onClick={() => editor.run("edit.redo")} />
        <IconButton anchor="toolbar.shortcuts" label="Keyboard shortcuts" icon={Keyboard} shortcut={shortcutLabel("help.shortcuts", editor.platform)} onClick={onShortcuts} />
        <ZoomMenu />
        <TextButton anchor="toolbar.bench" label="Renderer benchmark" onClick={() => (window.location.href = "/bench")} className="text-stone-500">
          Bench
        </TextButton>
      </div>
    </header>
  );
}
