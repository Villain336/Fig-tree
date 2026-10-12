"use client";

import { cssDeclarations, hasProp, type Color, type ComputedBox, type CornerRadius, type Effect } from "@fig-tree/document";
import { FRAME_PRESETS, geometryValue, isInFlow, layoutDisplay, newFrameAt, setGeometry, setProps, vectorSession, type GeometryKey, type HandleMirroring, type ShapeTool } from "@fig-tree/editor-core";
import type { FontRegistry } from "@fig-tree/text";
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalSpaceAround,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalSpaceAround,
  FlipHorizontal2,
  FlipVertical2,
  Link2,
  Link2Off,
  Merge,
  RotateCw,
  Scan,
  Scissors,
  SquareDashed,
  Trash2,
} from "lucide-react";
import { Fragment, useState } from "react";
import { HexField } from "./color-picker";
import { AutoLayoutSection } from "./layout-section";
import { PaintSection } from "./paint";
import { useAnchor, useEditor, useEditorTick } from "./state";
import { TypographySection } from "./typography";
import { IconButton, MIXED, NumberField, Section, SelectField, TextButton, type Maybe } from "./ui";
import { common, prop, withProp } from "./values";

type Tab = "design" | "css";

export function DesignPanel({ fonts }: { fonts: FontRegistry | null }) {
  const editor = useEditor();
  useEditorTick(["selection", "tool", "page", "document", "session"]);
  const [tab, setTab] = useState<Tab>("design");
  const ids = editor.selection.filter((id) => editor.doc.has(id));
  const editingPoints = vectorSession(editor) !== null;
  return (
    <aside className="flex w-64 shrink-0 flex-col border-l border-stone-200 bg-white" aria-label="Properties" data-testid="design-panel">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-stone-200 px-2" role="tablist">
        <TabButton id="design" label="Design" tab={tab} setTab={setTab} />
        <TabButton id="css" label="CSS" tab={tab} setTab={setTab} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-8">
        {tab === "css" ? (
          <CssView ids={ids} />
        ) : (
          <>
            {editor.tool.id === "frame" && <FramePresets />}
            {editingPoints ? (
              <>
                <VectorSection />
                {ids.length > 0 && (
                  <>
                    <PaintSection ids={ids} keyName="fills" />
                    <PaintSection ids={ids} keyName="strokes" />
                  </>
                )}
              </>
            ) : ids.length === 0 ? (
              <PageSection />
            ) : (
              <>
                <AlignBar ids={ids} />
                <PositionSection ids={ids} />
                <SizeSection ids={ids} />
                <AutoLayoutSection ids={ids} />
                <AppearanceSection ids={ids} />
                <TypographySection ids={ids} fonts={fonts} />
                <PaintSection ids={ids} keyName="fills" />
                <PaintSection ids={ids} keyName="strokes" />
                <EffectsSection ids={ids} />
              </>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

const MIRRORING: readonly (readonly [HandleMirroring, string])[] = [
  ["none", "Independent"],
  ["angle", "Mirror angle"],
  ["angle-length", "Mirror angle and length"],
];

/** Vector edit mode: the selected points' position, handle mirroring and corner radius, and point actions. */
function VectorSection() {
  const editor = useEditor();
  useEditorTick(["session", "document", "selection"]);
  const s = vectorSession(editor);
  if (!s) return null;
  const pos = s.pointPosition();
  const mirroring = s.mirroring;
  const radius = s.cornerRadius;
  const count = s.selectedVertices.length;
  const type = editor.doc.typeOf(s.nodeId);
  const run = (a: string) => () => editor.run(a);
  return (
    <Section title="Edit points" testId="section-vector">
      {s.convertsOnEdit && <p className="mb-2 rounded-md bg-amber-50 px-2 py-1.5 text-[11px] leading-4 text-amber-800" data-testid="vector-convert-note">Editing points turns this {type} into a vector.</p>}
      <div className="grid grid-cols-2 gap-1.5">
        <NumberField anchor="design.vector.x" label="Point X" icon={<span className="text-[10px]">X</span>} value={pos ? pos.x : null} disabled={!pos} onCommit={(f) => pos && s.setPointPosition("x", f(pos.x))} testId="vector-x" />
        <NumberField anchor="design.vector.y" label="Point Y" icon={<span className="text-[10px]">Y</span>} value={pos ? pos.y : null} disabled={!pos} onCommit={(f) => pos && s.setPointPosition("y", f(pos.y))} testId="vector-y" />
        <div className="col-span-2 flex items-center gap-1.5">
          <span className="w-16 shrink-0 text-[11px] text-stone-500">Handles</span>
          <SelectField
            anchor="design.vector.mirroring"
            label="Handle mirroring"
            value={mirroring === "mixed" ? MIXED : (mirroring ?? "none")}
            options={MIRRORING}
            disabled={mirroring === null}
            onChange={(v) => s.setMirroring(v)}
            testId="vector-mirroring"
          />
        </div>
        <NumberField anchor="design.vector.radius" label="Point corner radius" icon={<Scan size={12} aria-hidden />} value={radius === null ? null : radius === "mixed" ? MIXED : radius} min={0} disabled={radius === null} onCommit={(f) => s.setCornerRadius(f)} testId="vector-radius" />
      </div>
      <div className="mt-2 flex items-center gap-0.5">
        <IconButton anchor="design.vector.join" label="Join points" icon={Merge} size={26} disabled={!editor.canRun("vector.join")} onClick={run("vector.join")} testId="vector-join" />
        <IconButton anchor="design.vector.disconnect" label="Disconnect points" icon={Scissors} size={26} disabled={!editor.canRun("vector.disconnect")} onClick={run("vector.disconnect")} testId="vector-disconnect" />
        <IconButton anchor="design.vector.flipX" label="Flip points horizontally" icon={FlipHorizontal2} size={26} disabled={!editor.canRun("vector.flipX")} onClick={run("vector.flipX")} />
        <IconButton anchor="design.vector.flipY" label="Flip points vertically" icon={FlipVertical2} size={26} disabled={!editor.canRun("vector.flipY")} onClick={run("vector.flipY")} />
        <IconButton anchor="design.vector.delete" label="Delete points, keeping the shape" icon={Trash2} size={26} disabled={!editor.canRun("vector.deleteKeep")} onClick={run("vector.deleteKeep")} testId="vector-delete" />
      </div>
      <p className="mt-1.5 text-[11px] text-stone-500" data-testid="vector-count">{count === 0 ? "No points selected" : count === 1 ? "1 point selected" : `${count} points selected`}</p>
    </Section>
  );
}

function TabButton({ id, label, tab, setTab }: { id: Tab; label: string; tab: Tab; setTab: (t: Tab) => void }) {
  const ref = useAnchor<HTMLButtonElement>(`design.tab.${id}`, "tab", `${label} tab`);
  return (
    <button ref={ref} role="tab" type="button" aria-selected={tab === id} data-testid={`tab-${id}`} onClick={() => setTab(id)} className={`rounded-md px-2 py-1 text-[12px] ${tab === id ? "font-semibold text-stone-900" : "text-stone-500 hover:text-stone-800"}`}>
      {label}
    </button>
  );
}

function PageSection() {
  const editor = useEditor();
  const page = editor.page;
  const bg = editor.doc.get<Color>(page, "backgroundColor");
  return (
    <Section title="Page" testId="section-page">
      <div className="flex items-center gap-1.5">
        <span className="h-6 w-6 shrink-0 rounded border border-stone-300" style={{ background: `rgb(${bg.r * 255}, ${bg.g * 255}, ${bg.b * 255})` }} />
        <HexField anchor="design.page.background" color={bg} onChange={(c) => editor.history.apply([{ type: "updateProps", id: page, props: { backgroundColor: { ...c, a: 1 } } }])} />
      </div>
    </Section>
  );
}

function FramePresets() {
  const editor = useEditor();
  const tool = editor.tools.get("frame") as ShapeTool;
  const groups = [...new Set(FRAME_PRESETS.map((p) => p.group))];
  return (
    <Section title="Frame sizes" testId="section-presets">
      {groups.map((g) => (
        <Fragment key={g}>
          <h4 className="pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-stone-400">{g}</h4>
          {FRAME_PRESETS.filter((p) => p.group === g).map((p) => (
            <PresetRow key={p.name} name={p.name} size={`${p.width}×${p.height}`} onPick={() => {
              tool.preset = null;
              newFrameAt(editor, p.width, p.height, p.name);
            }} />
          ))}
        </Fragment>
      ))}
    </Section>
  );
}

function PresetRow({ name, size, onPick }: { name: string; size: string; onPick: () => void }) {
  const ref = useAnchor<HTMLButtonElement>(`design.preset.${name.replace(/[^A-Za-z0-9]/g, "-")}`, "button", `${name} frame`);
  return (
    <button ref={ref} type="button" onClick={onPick} className="flex w-full items-center justify-between rounded px-1 py-1 text-left text-[12px] text-stone-700 hover:bg-stone-100">
      <span>{name}</span>
      <span className="text-[11px] text-stone-400">{size}</span>
    </button>
  );
}

function AlignBar({ ids }: { ids: readonly string[] }) {
  const editor = useEditor();
  const items: [string, string, typeof AlignStartVertical][] = [
    ["align.left", "Align left", AlignStartVertical],
    ["align.centerX", "Align horizontal centers", AlignCenterVertical],
    ["align.right", "Align right", AlignEndVertical],
    ["align.top", "Align top", AlignStartHorizontal],
    ["align.centerY", "Align vertical centers", AlignCenterHorizontal],
    ["align.bottom", "Align bottom", AlignEndHorizontal],
    ["distribute.x", "Distribute horizontal spacing", AlignHorizontalSpaceAround],
    ["distribute.y", "Distribute vertical spacing", AlignVerticalSpaceAround],
  ];
  void ids;
  return (
    <div className="flex items-center justify-between border-b border-stone-200 px-2 py-1.5" data-testid="align-bar">
      {items.map(([action, label, Icon]) => (
        <IconButton key={action} anchor={`design.${action}`} label={label} icon={Icon} size={26} disabled={!editor.canRun(action)} onClick={() => editor.run(action)} testId={action} />
      ))}
    </div>
  );
}

function geometry(editor: ReturnType<typeof useEditor>, ids: readonly string[], key: GeometryKey): Maybe<number> | null {
  return common(ids, (id) => geometryValue(editor, id, key));
}

function PositionSection({ ids }: { ids: readonly string[] }) {
  const editor = useEditor();
  useEditorTick(["document"]);
  const inFlow = ids.every((id) => isInFlow(editor.doc, id));
  const rotatable = ids.some((id) => editor.doc.typeOf(id) !== "group") || ids.length > 0;
  return (
    <Section title="Position" testId="section-position">
      <div className="grid grid-cols-2 gap-1.5">
        <NumberField anchor="design.position.x" label="X" value={geometry(editor, ids, "x")} disabled={inFlow} onCommit={(f) => setGeometry(editor, ids, "x", f)} testId="x" />
        <NumberField anchor="design.position.y" label="Y" value={geometry(editor, ids, "y")} disabled={inFlow} onCommit={(f) => setGeometry(editor, ids, "y", f)} testId="y" />
        <NumberField anchor="design.position.rotation" label="Rotation (degrees, clockwise)" icon={<RotateCw size={12} aria-hidden />} value={geometry(editor, ids, "rotation")} disabled={!rotatable} suffix="°" onCommit={(f) => setGeometry(editor, ids, "rotation", f)} testId="rotation" />
        <div className="flex items-center gap-0.5">
          <IconButton anchor="design.position.flipX" label="Flip horizontal" icon={FlipHorizontal2} size={26} onClick={() => editor.run("object.flipX")} />
          <IconButton anchor="design.position.flipY" label="Flip vertical" icon={FlipVertical2} size={26} onClick={() => editor.run("object.flipY")} />
        </div>
      </div>
    </Section>
  );
}

const MODE_LABELS: Record<string, string> = { fixed: "Fixed", hug: "Hug", fill: "Fill" };

function SizeSection({ ids }: { ids: readonly string[] }) {
  const editor = useEditor();
  const doc = editor.doc;
  const [more, setMore] = useState(false);
  const boxed = ids.filter((id) => doc.typeOf(id) !== "group");
  const ratio = prop<number>(editor, boxed, "aspectRatio");
  const locked = boxed.length > 0 && boxed.every((id) => doc.stored(id, "aspectRatio") !== undefined);
  // Hug for containers with layout and text; fill inside auto layout and grid.
  const modes = (axis: "width" | "height"): (readonly [string, string])[] => {
    const out: (readonly [string, string])[] = [["fixed", "Fixed"]];
    if (boxed.every((id) => layoutDisplay(doc, id) !== null || doc.typeOf(id) === "text")) out.push(["hug", "Hug"]);
    if (boxed.every((id) => isInFlow(doc, id))) out.push(["fill", "Fill"]);
    void axis;
    return out;
  };
  const wm = prop<string>(editor, boxed, "widthMode");
  const hm = prop<string>(editor, boxed, "heightMode");
  const constraintsShown = boxed.length > 0 && boxed.every((id) => !isInFlow(doc, id) && doc.typeOf(doc.tree.parentOf(id) ?? "") !== "page" && hasProp(doc.typeOf(id)!, "constraints"));
  const constraints = prop<{ horizontal: string; vertical: string }>(editor, boxed, "constraints");
  const mm = (key: "minWidth" | "maxWidth" | "minHeight" | "maxHeight", label: string) => (
    <NumberField anchor={`design.size.${key}`} label={label} icon={<span className="text-[9px]">{label.split(" ")[0]!.slice(0, 3)}</span>} value={common(boxed, (id) => doc.stored(id, key) as number | undefined)} min={0} onCommit={(f) => setProps(editor, boxed, (id) => ({ [key]: Math.max(0, f((doc.stored(id, key) as number | undefined) ?? geometryValue(editor, id, key.endsWith("Width") ? "width" : "height"))) }))} />
  );
  return (
    <Section
      title="Layout"
      testId="section-size"
      actions={
        <>
          <IconButton anchor="design.size.aspectLock" label={locked ? "Unlock aspect ratio" : "Lock aspect ratio"} kind="toggle" active={locked} icon={locked ? Link2 : Link2Off} size={24} iconSize={13} onClick={() => setProps(editor, boxed, (id) => {
            if (locked) return { aspectRatio: null };
            const w = geometryValue(editor, id, "width");
            const h = geometryValue(editor, id, "height");
            return w > 0 && h > 0 ? { aspectRatio: w / h } : null;
          })} />
          <IconButton anchor="design.size.more" label={more ? "Hide minimum and maximum sizes" : "Show minimum and maximum sizes"} kind="toggle" active={more} icon={SquareDashed} size={24} iconSize={13} onClick={() => setMore(!more)} />
        </>
      }
    >
      <div className="grid grid-cols-2 gap-1.5">
        <NumberField anchor="design.size.width" label="W" value={geometry(editor, ids, "width")} min={0} onCommit={(f) => setGeometry(editor, ids, "width", f)} testId="w" />
        <NumberField anchor="design.size.height" label="H" value={geometry(editor, ids, "height")} min={0} onCommit={(f) => setGeometry(editor, ids, "height", f)} testId="h" />
        {boxed.length > 0 && (
          <>
            <SelectField anchor="design.size.widthMode" label="Width sizing" value={wm ?? "fixed"} options={modes("width").map(([v]) => [v, `${MODE_LABELS[v]} width`] as const)} onChange={(v) => setProps(editor, boxed, { widthMode: v })} testId="width-mode" />
            <SelectField anchor="design.size.heightMode" label="Height sizing" value={hm ?? "fixed"} options={modes("height").map(([v]) => [v, `${MODE_LABELS[v]} height`] as const)} onChange={(v) => setProps(editor, boxed, { heightMode: v })} testId="height-mode" />
          </>
        )}
        {more && (
          <>
            {mm("minWidth", "Min width")}
            {mm("maxWidth", "Max width")}
            {mm("minHeight", "Min height")}
            {mm("maxHeight", "Max height")}
          </>
        )}
        {ratio !== null && ratio !== MIXED && <p className="col-span-2 text-[11px] text-stone-500">Aspect ratio {Math.round(ratio * 1000) / 1000}</p>}
      </div>
      {constraintsShown && (
        <div className="mt-2 grid grid-cols-2 gap-1.5" data-testid="constraints">
          <SelectField anchor="design.constraints.horizontal" label="Horizontal constraint" value={constraints === MIXED ? MIXED : (constraints?.horizontal ?? "start")} options={[["start", "Left"], ["end", "Right"], ["start-end", "Left and right"], ["center", "Center"], ["scale", "Scale"]]} onChange={(v) => setProps(editor, boxed, (id) => ({ constraints: { ...doc.get<{ horizontal: string; vertical: string }>(id, "constraints"), horizontal: v } }))} />
          <SelectField anchor="design.constraints.vertical" label="Vertical constraint" value={constraints === MIXED ? MIXED : (constraints?.vertical ?? "start")} options={[["start", "Top"], ["end", "Bottom"], ["start-end", "Top and bottom"], ["center", "Center"], ["scale", "Scale"]]} onChange={(v) => setProps(editor, boxed, (id) => ({ constraints: { ...doc.get<{ horizontal: string; vertical: string }>(id, "constraints"), vertical: v } }))} />
        </div>
      )}
    </Section>
  );
}

function AppearanceSection({ ids }: { ids: readonly string[] }) {
  const editor = useEditor();
  const doc = editor.doc;
  const [perCorner, setPerCorner] = useState(false);
  const opacity = prop<number>(editor, ids, "opacity");
  const blend = prop<string>(editor, ids, "blendMode");
  const radiusIds = withProp(editor, ids, "cornerRadius");
  const radius = prop<CornerRadius>(editor, radiusIds, "cornerRadius");
  const smoothing = prop<number>(editor, withProp(editor, ids, "cornerSmoothing"), "cornerSmoothing");
  const clipIds = ids.filter((id) => ["frame", "component", "instance"].includes(doc.typeOf(id)!));
  const clips = common(clipIds, (id) => doc.get<string>(id, "overflowX") !== "visible");
  const points = prop<number>(editor, withProp(editor, ids, "pointCount"), "pointCount");
  const inner = prop<number>(editor, ids.filter((id) => doc.typeOf(id) === "star"), "innerRadius");
  const uniform = radius === MIXED || radius === null ? radius : typeof radius === "number" ? radius : MIXED;
  const corner = (k: "topLeft" | "topRight" | "bottomRight" | "bottomLeft"): Maybe<number> | null => (radius === MIXED || radius === null ? radius : typeof radius === "number" ? radius : radius[k]);
  const setCorner = (keys: ("topLeft" | "topRight" | "bottomRight" | "bottomLeft")[], f: (old: number) => number): void => {
    setProps(editor, radiusIds, (id) => {
      const r = doc.get<CornerRadius>(id, "cornerRadius");
      const full = typeof r === "number" ? { topLeft: r, topRight: r, bottomRight: r, bottomLeft: r } : { ...r };
      for (const k of keys) full[k] = Math.max(0, f(full[k]));
      const same = full.topLeft === full.topRight && full.topRight === full.bottomRight && full.bottomRight === full.bottomLeft;
      return { cornerRadius: same ? full.topLeft : full };
    });
  };
  return (
    <Section title="Appearance" testId="section-appearance">
      <div className="grid grid-cols-2 gap-1.5">
        <NumberField anchor="design.appearance.opacity" label="Opacity" icon={<span className="text-[10px]">%</span>} value={opacity} scale={100} digits={0} min={0} max={1} onCommit={(f) => setProps(editor, ids, (id) => ({ opacity: Math.round(Math.min(1, Math.max(0, f(doc.get<number>(id, "opacity")))) * 1000) / 1000 }))} testId="opacity" />
        <SelectField
          anchor="design.appearance.blend"
          label="Blend mode"
          value={blend ?? "normal"}
          options={["normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn", "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity"].map((m) => [m, m === "normal" ? "Normal" : m.replace(/-/g, " ")] as const)}
          onChange={(v) => setProps(editor, ids, { blendMode: v })}
        />
        {radiusIds.length > 0 && !perCorner && (
          <NumberField anchor="design.appearance.radius" label="Corner radius" icon={<Scan size={12} aria-hidden />} value={uniform} min={0} onCommit={(f) => setCorner(["topLeft", "topRight", "bottomRight", "bottomLeft"], f)} testId="radius" />
        )}
        {radiusIds.length > 0 && (
          <TextButton anchor="design.appearance.radiusMode" label="Corner radius per corner" kind="toggle" onClick={() => setPerCorner(!perCorner)} className="text-left text-stone-500">
            {perCorner ? "One radius" : "Each corner"}
          </TextButton>
        )}
        {radiusIds.length > 0 && perCorner && (
          <>
            {(["topLeft", "topRight", "bottomLeft", "bottomRight"] as const).map((k) => (
              <NumberField key={k} anchor={`design.appearance.radius.${k}`} label={`Radius ${k.replace(/([A-Z])/g, " $1").toLowerCase()}`} icon={<span className="text-[9px]">{k === "topLeft" ? "┌" : k === "topRight" ? "┐" : k === "bottomLeft" ? "└" : "┘"}</span>} value={corner(k)} min={0} onCommit={(f) => setCorner([k], f)} />
            ))}
          </>
        )}
        {smoothing !== null && (
          <NumberField anchor="design.appearance.smoothing" label="Corner smoothing" icon={<span className="text-[9px]">sm</span>} value={smoothing} scale={100} digits={0} min={0} max={1} suffix="%" onCommit={(f) => setProps(editor, withProp(editor, ids, "cornerSmoothing"), (id) => ({ cornerSmoothing: Math.round(Math.min(1, Math.max(0, f(doc.get<number>(id, "cornerSmoothing")))) * 100) / 100 }))} />
        )}
        {points !== null && (
          <NumberField anchor="design.appearance.points" label="Number of points" icon={<span className="text-[9px]">pts</span>} value={points} digits={0} min={3} max={120} onCommit={(f) => setProps(editor, withProp(editor, ids, "pointCount"), (id) => ({ pointCount: Math.round(Math.min(120, Math.max(3, f(doc.get<number>(id, "pointCount"))))) }))} />
        )}
        {inner !== null && (
          <NumberField anchor="design.appearance.innerRadius" label="Star inner radius" icon={<span className="text-[9px]">in</span>} value={inner} scale={100} digits={0} min={0} max={1} suffix="%" onCommit={(f) => setProps(editor, ids.filter((id) => doc.typeOf(id) === "star"), (id) => ({ innerRadius: Math.min(1, Math.max(0, f(doc.get<number>(id, "innerRadius")))) }))} />
        )}
        {clipIds.length > 0 && (
          <label className="col-span-2 flex items-center gap-1.5 text-[11px] text-stone-600">
            <ClipToggle checked={clips === true} onChange={(on) => setProps(editor, clipIds, { overflowX: on ? "hidden" : "visible", overflowY: on ? "hidden" : "visible" })} />
            Clip content
          </label>
        )}
      </div>
    </Section>
  );
}

function ClipToggle({ checked, onChange }: { checked: boolean; onChange: (on: boolean) => void }) {
  const ref = useAnchor<HTMLInputElement>("design.appearance.clip", "toggle", "Clip content");
  return <input ref={ref} type="checkbox" aria-label="Clip content" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-blue-600" />;
}

function EffectsSection({ ids }: { ids: readonly string[] }) {
  const editor = useEditor();
  const effects = ids.flatMap((id) => (hasProp(editor.doc.typeOf(id)!, "effects") ? editor.doc.get<Effect[]>(id, "effects") : []));
  return (
    <Section title="Effects" testId="section-effects">
      {effects.length > 0 ? (
        <ul className="text-[11px] text-stone-600">
          {effects.map((e, i) => (
            <li key={i}>{e.type.replace("-", " ")} (not drawn yet)</li>
          ))}
        </ul>
      ) : null}
      <p className="text-[11px] leading-4 text-stone-400">Shadows and blurs come with the effects module.</p>
    </Section>
  );
}

function boxRows(b: ComputedBox): [string, string][] {
  const fmt = (v: number): string => String(Math.round(v * 100) / 100);
  const rows: [string, string][] = [
    ["x", fmt(b.x)],
    ["y", fmt(b.y)],
    ["w", fmt(b.width)],
    ["h", fmt(b.height)],
  ];
  const sides = (e: ComputedBox["padding"]): string => [e.top, e.right, e.bottom, e.left].map(fmt).join(" ");
  if (b.padding.top || b.padding.right || b.padding.bottom || b.padding.left) rows.push(["padding", sides(b.padding)]);
  if (b.border.top || b.border.right || b.border.bottom || b.border.left) rows.push(["border", sides(b.border)]);
  return rows;
}

/** The CSS view: the computed layout box and the node's CSS declarations (what code export emits). */
function CssView({ ids }: { ids: readonly string[] }) {
  const editor = useEditor();
  useEditorTick(["document", "selection"]);
  const id = ids[0];
  if (!id) return <p className="p-3 text-[12px] text-stone-400">Select a layer to see its CSS.</p>;
  const box = editor.bridge.box(id);
  const css = cssDeclarations(editor.doc, id);
  const unsupported = [...(editor.bridge.unsupported.get(id) ?? [])];
  return (
    <div className="p-3 text-[12px]">
      {box && (
        <>
          <h3 className="pb-1 text-[11px] font-semibold text-stone-800">Layout box</h3>
          <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-3 font-mono text-[11px] leading-5 text-stone-700" data-testid="box">
            {boxRows(box).map(([k, v]) => (
              <Fragment key={k}>
                <dt className="text-stone-400">{k}</dt>
                <dd>{v}</dd>
              </Fragment>
            ))}
          </dl>
        </>
      )}
      <h3 className="pb-1 text-[11px] font-semibold text-stone-800">CSS</h3>
      <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-5 text-stone-700" data-testid="css">
        {Object.entries(css)
          .map(([k, v]) => `${k}: ${v};`)
          .join("\n")}
      </pre>
      {unsupported.length > 0 && (
        <>
          <h3 className="pb-1 pt-3 text-[11px] font-semibold text-stone-800">Not rendered yet</h3>
          <ul className="list-inside list-disc text-stone-600">
            {unsupported.map((u) => (
              <li key={u}>{u}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
