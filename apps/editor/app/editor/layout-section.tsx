"use client";

import type { TrackListEntry } from "@fig-tree/document";
import { setProps } from "@fig-tree/editor-core";
import { ArrowDown, ArrowRight, Columns3, LayoutGrid, Minus, Plus, Rows3, Space, WrapText, X } from "lucide-react";
import { useState } from "react";
import { useAnchor, useEditor, useEditorTick } from "./state";
import { IconButton, MIXED, NumberField, Section, SelectField, type Maybe } from "./ui";
import { prop } from "./values";

const FRAMES = new Set(["frame", "component", "instance"]);
type Sides = { top: number; right: number; bottom: number; left: number };

/**
 * Auto layout (CSS flexbox) and grid editing for frames: add or remove
 * it, direction and wrap, gaps, padding, the 3×3 alignment matrix and
 * "space between", and grid track lists.
 */
export function AutoLayoutSection({ ids }: { ids: readonly string[] }) {
  const editor = useEditor();
  useEditorTick(["document", "selection"]);
  const frames = ids.filter((id) => FRAMES.has(editor.doc.typeOf(id) ?? ""));
  const [allPadding, setAllPadding] = useState(false);
  const paddingModeRef = useAnchor<HTMLButtonElement>("design.layout.paddingMode", "toggle", "Padding per side");
  if (frames.length === 0) return null;
  const display = prop<string>(editor, frames, "display");
  const set = (props: Record<string, unknown>): void => {
    setProps(editor, frames, props);
  };
  if (display === "block" || display === null) {
    return (
      <Section
        title="Auto layout"
        testId="section-layout"
        actions={
          <>
            <IconButton anchor="design.layout.addGrid" label="Add a grid layout" icon={LayoutGrid} size={24} iconSize={14} onClick={() => set({ display: "grid", gridTemplateColumns: [{ type: "repeat", count: 2, tracks: [{ type: "fr", value: 1 }] }], columnGap: 8, rowGap: 8 })} />
            <IconButton anchor="design.layout.add" label="Add auto layout" icon={Plus} size={24} iconSize={14} onClick={() => editor.run("layout.add")} testId="add-auto-layout" />
          </>
        }
      >
        <span className="sr-only">No auto layout</span>
      </Section>
    );
  }
  const direction = prop<string>(editor, frames, "flexDirection");
  const wrap = prop<string>(editor, frames, "flexWrap");
  const justify = prop<string>(editor, frames, "justifyContent");
  const alignItems = prop<string>(editor, frames, "alignItems");
  const justifyItems = prop<string>(editor, frames, "justifyItems");
  const rowGap = prop<number>(editor, frames, "rowGap");
  const columnGap = prop<number>(editor, frames, "columnGap");
  const padding = prop<Sides>(editor, frames, "padding");
  const isGrid = display === "grid";
  const row = direction === "row" || direction === "row-reverse";
  const mainGap = isGrid ? columnGap : row ? columnGap : rowGap;
  const crossGap = isGrid ? rowGap : row ? rowGap : columnGap;
  const pad = (key: keyof Sides): Maybe<number> | null => (padding === MIXED ? MIXED : padding === null ? null : padding[key]);
  const setPadding = (keys: (keyof Sides)[], f: (old: number) => number): void => {
    setProps(editor, frames, (id) => {
      const p = { ...editor.doc.get<Sides>(id, "padding") };
      for (const k of keys) p[k] = Math.max(0, f(p[k]));
      return { padding: p };
    });
  };
  return (
    <Section
      title={isGrid ? "Grid layout" : "Auto layout"}
      testId="section-layout"
      actions={<IconButton anchor="design.layout.remove" label="Remove auto layout" icon={Minus} size={24} iconSize={14} onClick={() => editor.run("layout.remove")} testId="remove-auto-layout" />}
    >
      <div className="flex flex-col gap-1.5">
        {!isGrid && (
          <div className="flex items-center gap-1">
            <IconButton anchor="design.layout.direction.row" label="Horizontal (row)" icon={ArrowRight} kind="toggle" active={row} size={26} onClick={() => set({ flexDirection: "row" })} testId="direction-row" />
            <IconButton anchor="design.layout.direction.column" label="Vertical (column)" icon={ArrowDown} kind="toggle" active={direction === "column" || direction === "column-reverse"} size={26} onClick={() => set({ flexDirection: "column" })} testId="direction-column" />
            <IconButton anchor="design.layout.wrap" label="Wrap" icon={WrapText} kind="toggle" active={wrap === "wrap"} size={26} onClick={() => set({ flexWrap: wrap === "wrap" ? "nowrap" : "wrap" })} />
            <IconButton anchor="design.layout.spaceBetween" label="Space between (auto gap)" icon={Space} kind="toggle" active={justify === "space-between"} size={26} onClick={() => set({ justifyContent: justify === "space-between" ? "flex-start" : "space-between" })} />
            <IconButton anchor="design.layout.toGrid" label="Switch to grid" icon={LayoutGrid} size={26} onClick={() => set({ display: "grid", gridTemplateColumns: [{ type: "repeat", count: 2, tracks: [{ type: "fr", value: 1 }] }] })} />
          </div>
        )}
        {isGrid && (
          <div className="flex items-center gap-1">
            <IconButton anchor="design.layout.toFlex" label="Switch to auto layout" icon={Columns3} size={26} onClick={() => set({ display: "flex" })} />
          </div>
        )}
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <div className="grid grid-cols-2 gap-1.5">
            <NumberField anchor="design.layout.gap" label={isGrid ? "Column gap" : "Gap between items"} icon={row || isGrid ? <Columns3 size={12} aria-hidden /> : <Rows3 size={12} aria-hidden />} value={justify === "space-between" && !isGrid ? null : mainGap} min={0} onCommit={(f) => setProps(editor, frames, (id) => {
              const d = editor.doc.get<string>(id, "flexDirection");
              const key = editor.doc.get<string>(id, "display") === "grid" || d.startsWith("row") ? "columnGap" : "rowGap";
              return { [key]: Math.max(0, f(editor.doc.get<number>(id, key))) };
            })} testId="gap" />
            {(isGrid || wrap === "wrap") && (
              <NumberField anchor="design.layout.crossGap" label={isGrid ? "Row gap" : "Gap between lines"} icon={<Rows3 size={12} aria-hidden />} value={crossGap} min={0} onCommit={(f) => setProps(editor, frames, (id) => {
                const d = editor.doc.get<string>(id, "flexDirection");
                const key = editor.doc.get<string>(id, "display") === "grid" || d.startsWith("row") ? "rowGap" : "columnGap";
                return { [key]: Math.max(0, f(editor.doc.get<number>(id, key))) };
              })} />
            )}
            {allPadding ? (
              (["top", "right", "bottom", "left"] as const).map((k) => (
                <NumberField key={k} anchor={`design.layout.padding.${k}`} label={`Padding ${k}`} icon={<span className="text-[10px]">{k[0]!.toUpperCase()}</span>} value={pad(k)} min={0} onCommit={(f) => setPadding([k], f)} testId={`padding-${k}`} />
              ))
            ) : (
              <>
                <NumberField anchor="design.layout.padding.horizontal" label="Horizontal padding" icon={<span className="text-[10px]">↔</span>} value={pad("left") === pad("right") ? pad("left") : MIXED} min={0} onCommit={(f) => setPadding(["left", "right"], f)} testId="padding-h" />
                <NumberField anchor="design.layout.padding.vertical" label="Vertical padding" icon={<span className="text-[10px]">↕</span>} value={pad("top") === pad("bottom") ? pad("top") : MIXED} min={0} onCommit={(f) => setPadding(["top", "bottom"], f)} testId="padding-v" />
              </>
            )}
          </div>
          <AlignmentMatrix
            isGrid={isGrid}
            row={row}
            justify={justify}
            alignItems={alignItems}
            justifyItems={justifyItems}
            onPick={(x, y) => {
              const v = (i: number, grid: boolean): string => (grid ? ["start", "center", "end"] : ["flex-start", "center", "flex-end"])[i]!;
              if (isGrid) set({ justifyItems: v(x, true), alignItems: v(y, true) });
              else {
                setProps(editor, frames, (id) => {
                  const r = editor.doc.get<string>(id, "flexDirection").startsWith("row");
                  const spaced = editor.doc.get<string>(id, "justifyContent") === "space-between";
                  return { ...(spaced ? {} : { justifyContent: v(r ? x : y, false) }), alignItems: v(r ? y : x, false) };
                });
              }
            }}
          />
        </div>
        <button type="button" className="self-start text-[11px] text-stone-500 hover:text-stone-800" ref={paddingModeRef} onClick={() => setAllPadding(!allPadding)}>
          {allPadding ? "Padding: horizontal and vertical" : "Padding: each side"}
        </button>
        {isGrid && (
          <>
            <TrackList anchor="design.grid.columns" label="Columns" ids={frames} keyName="gridTemplateColumns" />
            <TrackList anchor="design.grid.rows" label="Rows" ids={frames} keyName="gridTemplateRows" />
          </>
        )}
      </div>
    </Section>
  );
}

function position(v: Maybe<string> | null): number | null {
  if (v === MIXED || v === null) return null;
  if (v === "center") return 1;
  if (v === "end" || v === "flex-end") return 2;
  if (v === "start" || v === "flex-start" || v === "normal" || v === "stretch" || v === "baseline") return 0;
  return null;
}

function AlignmentMatrix({ isGrid, row, justify, alignItems, justifyItems, onPick }: { isGrid: boolean; row: boolean; justify: Maybe<string> | null; alignItems: Maybe<string> | null; justifyItems: Maybe<string> | null; onPick: (x: number, y: number) => void }) {
  const main = isGrid ? position(justifyItems) : position(justify);
  const cross = position(alignItems);
  const x = isGrid ? main : row ? main : cross;
  const y = isGrid ? cross : row ? cross : main;
  return (
    <div className="grid h-[62px] w-[62px] grid-cols-3 grid-rows-3 gap-0.5 rounded-md bg-stone-100 p-1" role="group" aria-label="Alignment" data-testid="align-matrix">
      {[0, 1, 2].flatMap((yy) => [0, 1, 2].map((xx) => <MatrixCell key={`${xx}${yy}`} x={xx} y={yy} active={x === xx && (y === yy || justify === "space-between")} onPick={onPick} />))}
    </div>
  );
}

const NAMES = [["top left", "top center", "top right"], ["middle left", "center", "middle right"], ["bottom left", "bottom center", "bottom right"]];

function MatrixCell({ x, y, active, onPick }: { x: number; y: number; active: boolean; onPick: (x: number, y: number) => void }) {
  const label = `Align ${NAMES[y]![x]}`;
  const ref = useAnchor<HTMLButtonElement>(`design.layout.align.${x}${y}`, "toggle", label);
  return (
    <button ref={ref} type="button" aria-label={label} aria-pressed={active} title={label} data-testid={`align-${x}${y}`} onClick={() => onPick(x, y)} className="flex items-center justify-center rounded hover:bg-white">
      <span className={`block rounded-sm ${active ? "h-2.5 w-2.5 bg-blue-600" : "h-1 w-1 bg-stone-400"}`} />
    </button>
  );
}

type Breadth = "fr" | "px" | "percent" | "auto" | "min-content" | "max-content";

function TrackList({ anchor, label, ids, keyName }: { anchor: string; label: string; ids: readonly string[]; keyName: "gridTemplateColumns" | "gridTemplateRows" }) {
  const editor = useEditor();
  const tracks = prop<TrackListEntry[]>(editor, ids, keyName);
  if (tracks === MIXED) return <p className="text-[11px] text-stone-500">{label}: mixed</p>;
  const list = tracks ?? [];
  const write = (next: TrackListEntry[]): void => {
    setProps(editor, ids, { [keyName]: next });
  };
  return (
    <div data-testid={`tracks-${keyName}`}>
      <div className="flex h-6 items-center justify-between">
        <span className="text-[11px] text-stone-600">{label}</span>
        <IconButton anchor={`${anchor}.add`} label={`Add a ${label.toLowerCase().slice(0, -1)}`} icon={Plus} size={22} iconSize={13} onClick={() => write([...list, { type: "fr", value: 1 }])} />
      </div>
      <ul className="flex flex-col gap-1">
        {list.map((t, i) => (
          <li key={i} className="flex items-center gap-1">
            {t.type === "repeat" ? (
              <span className="flex h-7 flex-1 items-center rounded-md bg-stone-100 px-2 font-mono text-[11px] text-stone-600">
                repeat({t.count}, {t.tracks.map((x) => ("value" in x ? `${x.value}${x.type === "percent" ? "%" : x.type}` : x.type)).join(" ")})
              </span>
            ) : t.type === "minmax" || t.type === "fit-content" ? (
              <span className="flex h-7 flex-1 items-center rounded-md bg-stone-100 px-2 font-mono text-[11px] text-stone-600">{t.type}</span>
            ) : (
              <>
                <NumberField anchor={`${anchor}.${i}.value`} label={`${label} ${i + 1} size`} icon={<span className="text-[10px]">{i + 1}</span>} value={"value" in t ? t.value : null} disabled={!("value" in t)} min={0} onCommit={(f) => write(list.map((x, k) => (k === i && "value" in x ? { ...x, value: Math.max(0, f(x.value)) } : x)) as TrackListEntry[])} />
                <SelectField<Breadth>
                  anchor={`${anchor}.${i}.unit`}
                  label={`${label} ${i + 1} unit`}
                  value={t.type as Breadth}
                  width={86}
                  options={[["fr", "fr"], ["px", "px"], ["percent", "%"], ["auto", "auto"], ["min-content", "min"], ["max-content", "max"]]}
                  onChange={(u) => write(list.map((x, k) => (k === i ? (u === "fr" || u === "px" || u === "percent" ? { type: u, value: "value" in x ? x.value : u === "px" ? 100 : 1 } : { type: u }) : x)) as TrackListEntry[])}
                />
              </>
            )}
            <IconButton anchor={`${anchor}.${i}.remove`} label={`Remove ${label.toLowerCase().slice(0, -1)} ${i + 1}`} icon={X} size={22} iconSize={12} onClick={() => write(list.filter((_, k) => k !== i))} />
          </li>
        ))}
      </ul>
    </div>
  );
}
