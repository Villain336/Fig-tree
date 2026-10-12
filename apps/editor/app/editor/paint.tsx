"use client";

import type { Paint } from "@fig-tree/document";
import { parseHex, setProps, textNodeStyleCommands, textSession, toHex } from "@fig-tree/editor-core";
import { Eye, EyeOff, Minus, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { ColorPicker, HexField, paintCss, type EditablePaint } from "./color-picker";
import { useAnchor, useEditor, useEditorTick } from "./state";
import { IconButton, MIXED, NumberField, Popover, Section, SelectField, TextButton, type Maybe } from "./ui";
import { prop, withProp } from "./values";

const DEFAULT_FILL: Paint = { type: "solid", color: { r: 0.85, g: 0.85, b: 0.85, a: 1 } };
const DEFAULT_STROKE: Paint = { type: "solid", color: { r: 0, g: 0, b: 0, a: 1 } };

function editable(p: Paint): p is EditablePaint {
  return p.type === "solid" || p.type === "linear-gradient" || p.type === "radial-gradient";
}

/**
 * The paint stacks of the selection (fills or strokes): add, remove, hide,
 * recolor, change opacity, and open the color picker. Text being edited
 * takes fills on its selected characters (style runs).
 */
export function PaintSection({ ids, keyName }: { ids: readonly string[]; keyName: "fills" | "strokes" }) {
  const editor = useEditor();
  useEditorTick(["document", "selection", "session"]);
  const targets = withProp(editor, ids, keyName);
  const [picker, setPicker] = useState<{ index: number; at: { x: number; y: number } } | null>(null);
  const session = textSession(editor);
  const runEditing = keyName === "fills" && session !== null && !session.collapsed && targets.length === 1 && targets[0] === session.nodeId;
  const stack: Maybe<Paint[]> | null = runEditing ? common(session!.styleValues("fills") as Paint[][]) : prop<Paint[]>(editor, targets, keyName);

  // Gradient handles on the canvas follow the open picker.
  useEffect(() => {
    if (!picker || targets.length !== 1 || stack === MIXED || stack === null) {
      if (editor.paintEdit?.key === keyName) editor.setPaintEdit(null);
      return;
    }
    const p = stack[picker.index];
    editor.setPaintEdit(p && p.type !== "solid" ? { id: targets[0]!, key: keyName, index: picker.index } : null);
  });
  useEffect(() => () => {
    if (editor.paintEdit?.key === keyName) editor.setPaintEdit(null);
  }, [editor, keyName]);

  if (targets.length === 0) return null;
  const apply = (next: Paint[]): void => {
    if (runEditing) {
      session!.format({ fills: next });
      return;
    }
    if (keyName === "fills") {
      const texts = targets.filter((id) => editor.doc.typeOf(id) === "text");
      const others = targets.filter((id) => editor.doc.typeOf(id) !== "text");
      const cmds = [...textNodeStyleCommands(editor.doc, texts, { fills: next }), ...others.map((id) => ({ type: "updateProps" as const, id, props: { fills: next } }))];
      editor.history.apply(cmds);
    } else setProps(editor, targets, { [keyName]: next });
  };
  const title = keyName === "fills" ? "Fill" : "Stroke";
  const add = (): void => apply([...(stack === MIXED || stack === null ? [] : stack), keyName === "fills" ? DEFAULT_FILL : DEFAULT_STROKE]);
  return (
    <Section title={title} testId={`section-${keyName}`} actions={<IconButton anchor={`design.${keyName}.add`} label={`Add a ${title.toLowerCase()}`} icon={Plus} size={24} iconSize={14} onClick={add} />}>
      {stack === MIXED ? (
        <TextButton anchor={`design.${keyName}.replaceMixed`} label={`Replace mixed ${keyName}`} onClick={() => apply([keyName === "fills" ? DEFAULT_FILL : DEFAULT_STROKE])}>
          Mixed — click to replace
        </TextButton>
      ) : (
        <ul className="flex flex-col gap-1">
          {[...(stack ?? [])].map((p, i) => ({ p, i })).reverse().map(({ p, i }) => (
            <PaintRow
              key={i}
              anchor={`design.${keyName}.${i}`}
              paint={p}
              onChange={(np) => apply((stack ?? []).map((x, k) => (k === i ? np : x)))}
              onRemove={() => apply((stack ?? []).filter((_, k) => k !== i))}
              onOpen={(at) => setPicker({ index: i, at })}
            />
          ))}
        </ul>
      )}
      {keyName === "strokes" && stack !== null && (stack === MIXED || stack.length > 0) && <StrokeSettings ids={targets} />}
      {picker && stack !== MIXED && stack !== null && stack[picker.index] && editable(stack[picker.index]!) && (
        <Popover at={picker.at} onClose={() => setPicker(null)} width={264} label="Color picker" testId="picker">
          <ColorPicker anchor="picker" paint={stack[picker.index] as EditablePaint} onChange={(np) => apply(stack.map((x, k) => (k === picker.index ? np : x)))} />
        </Popover>
      )}
    </Section>
  );
}

function common(values: Paint[][]): Maybe<Paint[]> | null {
  if (values.length === 0) return null;
  const first = JSON.stringify(values[0]);
  return values.every((v) => JSON.stringify(v) === first) ? values[0]! : MIXED;
}

function PaintRow({ anchor, paint, onChange, onRemove, onOpen }: { anchor: string; paint: Paint; onChange: (p: Paint) => void; onRemove: () => void; onOpen: (at: { x: number; y: number }) => void }) {
  const swatch = useAnchor<HTMLButtonElement>(`${anchor}.swatch`, "button", "Open the color picker");
  const visible = paint.visible !== false;
  return (
    <li className={`flex items-center gap-1 ${visible ? "" : "opacity-50"}`}>
      <button
        ref={swatch}
        type="button"
        aria-label="Open the color picker"
        data-testid={`${anchor}.swatch`}
        className="h-6 w-6 shrink-0 rounded border border-stone-300"
        style={{ background: `${paintCss(paint)}, repeating-conic-gradient(#e7e5e4 0 25%, #fff 0 50%) 0 0 / 6px 6px` }}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onOpen({ x: r.left - 276, y: r.top - 40 });
        }}
      />
      {paint.type === "solid" ? (
        <HexField anchor={`${anchor}.hex`} color={paint.color} onChange={(c) => onChange({ ...paint, color: c })} />
      ) : (
        <span className="flex h-7 flex-1 items-center rounded-md bg-stone-100 px-2 text-[11px] text-stone-600">{paint.type === "linear-gradient" ? "Linear" : paint.type === "radial-gradient" ? "Radial" : paint.type === "image" ? "Image" : paint.type}</span>
      )}
      <NumberField anchor={`${anchor}.opacity`} label="Paint opacity" icon={<span className="text-[10px]">%</span>} value={paint.opacity ?? 1} scale={100} digits={0} min={0} max={1} width={58} onCommit={(f) => onChange({ ...paint, opacity: Math.round(f(paint.opacity ?? 1) * 1000) / 1000 })} />
      <IconButton anchor={`${anchor}.visible`} label={visible ? "Hide this paint" : "Show this paint"} kind="toggle" icon={visible ? Eye : EyeOff} size={24} iconSize={13} onClick={() => onChange({ ...paint, visible: !visible })} />
      <IconButton anchor={`${anchor}.remove`} label="Remove this paint" icon={Minus} size={24} iconSize={13} onClick={onRemove} />
    </li>
  );
}

function StrokeSettings({ ids }: { ids: readonly string[] }) {
  const editor = useEditor();
  const weight = prop<number | Record<string, number>>(editor, ids, "strokeWeight");
  const align = prop<string>(editor, ids, "strokeAlign");
  const cap = prop<string>(editor, ids, "strokeCap");
  const join = prop<string>(editor, ids, "strokeJoin");
  const dashes = prop<number[]>(editor, ids, "strokeDashes");
  const w = weight === MIXED || weight === null ? weight : typeof weight === "number" ? weight : MIXED;
  const dash = dashes === MIXED || dashes === null ? dashes : dashes.length ? dashes[0]! : 0;
  return (
    <div className="mt-2 grid grid-cols-2 gap-1.5">
      <NumberField anchor="design.strokes.weight" label="Stroke weight" icon={<span className="text-[10px]">W</span>} value={w} min={0} onCommit={(f) => setProps(editor, ids, (id) => ({ strokeWeight: Math.max(0, f(typeof editor.doc.get(id, "strokeWeight") === "number" ? editor.doc.get<number>(id, "strokeWeight") : 1)) }))} />
      <SelectField anchor="design.strokes.align" label="Stroke position" value={align ?? "inside"} options={[["inside", "Inside"], ["center", "Center"], ["outside", "Outside"]]} onChange={(v) => setProps(editor, ids, { strokeAlign: v })} />
      <SelectField anchor="design.strokes.cap" label="Line ends" value={cap ?? "butt"} options={[["butt", "Flat ends"], ["round", "Round ends"], ["square", "Square ends"]]} onChange={(v) => setProps(editor, ids, { strokeCap: v })} />
      <SelectField anchor="design.strokes.join" label="Corners" value={join ?? "miter"} options={[["miter", "Sharp corners"], ["round", "Round corners"], ["bevel", "Bevel corners"]]} onChange={(v) => setProps(editor, ids, { strokeJoin: v })} />
      <NumberField anchor="design.strokes.dash" label="Dash length (0 = solid)" icon={<span className="text-[10px]">- -</span>} value={dash} min={0} onCommit={(f) => setProps(editor, ids, (id) => {
        const d = f(editor.doc.get<number[]>(id, "strokeDashes")[0] ?? 0);
        return { strokeDashes: d > 0 ? [d, d] : [] };
      })} />
    </div>
  );
}

export { parseHex, toHex };
