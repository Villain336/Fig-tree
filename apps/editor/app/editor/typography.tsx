"use client";

import { GoogleFontsLoader, type FontRegistry } from "@fig-tree/text";
import { setProps, textNodeStyleCommands, textSession } from "@fig-tree/editor-core";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  ArrowDownToLine,
  ArrowUpToLine,
  CaseLower,
  CaseSensitive,
  CaseUpper,
  ChevronDown,
  FoldVertical,
  MoveHorizontal,
  Square,
  Strikethrough,
  Underline,
  Ban,
  AlignVerticalJustifyCenter,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useAnchor, useEditor, useEditorTick } from "./state";
import { MIXED, NumberField, Popover, Section, Segmented, SelectField, type Maybe } from "./ui";
import { prop } from "./values";

/** Popular families from the Google Fonts repository (loaded on demand; OFL, Apache 2.0 or UFL). */
const GOOGLE_FAMILIES = [
  "Roboto", "Open Sans", "Lato", "Montserrat", "Poppins", "Source Sans 3", "Raleway", "Nunito", "Work Sans", "DM Sans", "Space Grotesk", "IBM Plex Sans",
  "IBM Plex Mono", "JetBrains Mono", "Fira Sans", "Rubik", "Karla", "Manrope", "Archivo", "Outfit", "Sora", "Plus Jakarta Sans", "Barlow", "Mulish",
  "Playfair Display", "Merriweather", "Lora", "Libre Baskerville", "PT Serif", "Source Serif 4",
];

const WEIGHT_NAMES: Record<number, string> = { 100: "Thin", 200: "Extra light", 300: "Light", 400: "Regular", 500: "Medium", 600: "Semibold", 700: "Bold", 800: "Extra bold", 900: "Black" };

let loader: GoogleFontsLoader | null = null;

/** Every family in the registry, with the weights its faces cover. */
function families(fonts: FontRegistry | null): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const e of fonts?.entries() ?? []) {
    const set = out.get(e.family) ?? new Set<number>();
    for (let w = 100; w <= 900; w += 100) if (w >= e.weight[0] && w <= e.weight[1]) set.add(w);
    out.set(e.family, set);
  }
  return out;
}

/**
 * Typography of selected text nodes, or of the selected characters while
 * editing text (style runs). Paragraph settings (alignment, resizing,
 * truncation) always apply to the whole text box.
 */
export function TypographySection({ ids, fonts }: { ids: readonly string[]; fonts: FontRegistry | null }) {
  const editor = useEditor();
  useEditorTick(["document", "selection", "session", "overlay"]);
  const texts = ids.filter((id) => editor.doc.typeOf(id) === "text");
  const session = textSession(editor);
  const runEditing = session !== null && texts.length === 1 && texts[0] === session.nodeId;
  if (texts.length === 0) return null;

  /** A text style value over the edited characters, or over the whole texts (base style and runs). */
  const styleValue = <T,>(key: string): Maybe<T> | null => {
    if (runEditing) {
      const v = session!.styleValues(key as never);
      return v.length === 1 ? (v[0] as T) : MIXED;
    }
    const all = new Set<string>();
    let first: T | undefined;
    for (const id of texts) {
      const base = editor.doc.get<T>(id, key);
      const runs = editor.doc.text(id).runs;
      const content = editor.doc.text(id).content.length;
      let covered = 0;
      for (const r of runs) {
        if (key in r.style) {
          all.add(JSON.stringify(r.style[key as keyof typeof r.style]));
          covered += r.end - r.start;
        }
      }
      if (covered < content || content === 0) all.add(JSON.stringify(base));
      first ??= base;
    }
    if (all.size > 1) return MIXED;
    return all.size === 1 ? (JSON.parse([...all][0]!) as T) : (first ?? null);
  };
  const applyStyle = (style: Record<string, unknown>): void => {
    if (runEditing) session!.format(style);
    else editor.history.apply(textNodeStyleCommands(editor.doc, texts, style));
  };

  const family = styleValue<string>("fontFamily");
  const weight = styleValue<number>("fontWeight");
  const size = styleValue<number>("fontSize");
  const lineHeight = styleValue<{ unit: string; value: number } | "normal">("lineHeight");
  const letter = styleValue<{ unit: "px" | "em"; value: number }>("letterSpacing");
  const decoration = styleValue<string>("textDecoration");
  const transform = styleValue<string>("textTransform");
  const align = prop<string>(editor, texts, "textAlign");
  const valign = prop<string>(editor, texts, "verticalAlign");
  const wm = prop<string>(editor, texts, "widthMode");
  const hm = prop<string>(editor, texts, "heightMode");
  // Fill (in auto layout) is none of the three: no button is pressed then.
  const resize = wm === MIXED || hm === MIXED ? MIXED : wm === "hug" && hm === "hug" ? "auto-width" : wm === "fixed" && hm === "hug" ? "auto-height" : wm === "fixed" && hm === "fixed" ? "fixed" : null;
  const overflow = prop<string>(editor, texts, "textOverflow");
  const maxLines = prop<number>(editor, texts, "maxLines");

  const fam = families(fonts);
  const weights = family !== MIXED && family !== null && fam.get(family) ? [...fam.get(family)!].sort((a, b) => a - b) : [100, 200, 300, 400, 500, 600, 700, 800, 900];

  return (
    <Section title="Typography" testId="section-typography">
      <div className="flex flex-col gap-1.5">
        <FamilyPicker value={family} fonts={fonts} onPick={(f) => applyStyle({ fontFamily: f })} />
        <div className="grid grid-cols-2 gap-1.5">
          <SelectField
            anchor="design.text.weight"
            label="Font weight"
            value={weight === MIXED ? MIXED : String(weight ?? 400)}
            options={(weight === MIXED || weight === null || weights.includes(weight) ? weights : [...weights, weight].sort((a, b) => a - b)).map((w) => [String(w), WEIGHT_NAMES[w] ?? String(w)] as const)}
            onChange={(v) => applyStyle({ fontWeight: Number(v) })}
            testId="font-weight"
          />
          <NumberField anchor="design.text.size" label="Font size" icon={<span className="text-[10px]">Aa</span>} value={size} min={1} max={10000} onCommit={(f) => applyStyle({ fontSize: Math.max(1, f(typeof size === "number" ? size : 16)) })} testId="font-size" />
          <NumberField
            anchor="design.text.lineHeight"
            label="Line height (empty = auto)"
            icon={<FoldVertical size={12} aria-hidden />}
            value={lineHeight === MIXED ? MIXED : lineHeight === null || lineHeight === "normal" ? null : lineHeight.value}
            suffix={lineHeight !== MIXED && lineHeight !== null && lineHeight !== "normal" ? (lineHeight.unit === "percent" ? "%" : "px") : "auto"}
            min={0}
            onCommit={(f) => {
              const unit = lineHeight !== MIXED && lineHeight !== null && lineHeight !== "normal" ? lineHeight.unit : "px";
              const base = typeof size === "number" ? size * 1.2 : 20;
              const old = lineHeight !== MIXED && lineHeight !== null && lineHeight !== "normal" ? lineHeight.value : unit === "percent" ? 120 : base;
              applyStyle({ lineHeight: { unit, value: Math.max(0, f(old)) } });
            }}
          />
          <NumberField
            anchor="design.text.letterSpacing"
            label="Letter spacing"
            icon={<MoveHorizontal size={12} aria-hidden />}
            value={letter === MIXED ? MIXED : letter === null ? 0 : letter.unit === "em" ? letter.value * 100 : letter.value}
            suffix={letter !== MIXED && letter?.unit === "em" ? "%" : "px"}
            onCommit={(f) => {
              const unit = letter !== MIXED && letter?.unit === "em" ? "em" : "px";
              const old = letter !== MIXED && letter ? (unit === "em" ? letter.value * 100 : letter.value) : 0;
              const v = f(old);
              applyStyle({ letterSpacing: { unit, value: unit === "em" ? v / 100 : v } });
            }}
          />
        </div>
        <div className="flex items-center justify-between gap-1">
          <Segmented anchor="design.text.align" label="Text alignment" value={align === "start" ? "left" : align === "end" ? "right" : align} onChange={(v) => setProps(editor, texts, { textAlign: v })} options={[
            { value: "left", label: "Align left", icon: AlignLeft },
            { value: "center", label: "Align center", icon: AlignCenter },
            { value: "right", label: "Align right", icon: AlignRight },
            { value: "justify", label: "Justify", icon: AlignJustify },
          ]} />
          <Segmented anchor="design.text.valign" label="Vertical alignment" value={valign} onChange={(v) => setProps(editor, texts, { verticalAlign: v })} options={[
            { value: "top", label: "Align top", icon: ArrowUpToLine },
            { value: "center", label: "Align middle", icon: AlignVerticalJustifyCenter },
            { value: "bottom", label: "Align bottom", icon: ArrowDownToLine },
          ]} />
        </div>
        <div className="flex items-center justify-between gap-1">
          <Segmented anchor="design.text.decoration" label="Decoration" value={decoration} onChange={(v) => applyStyle({ textDecoration: v })} options={[
            { value: "none", label: "No decoration", icon: Ban },
            { value: "underline", label: "Underline", icon: Underline },
            { value: "line-through", label: "Strikethrough", icon: Strikethrough },
          ]} />
          <Segmented anchor="design.text.case" label="Letter case" value={transform} onChange={(v) => applyStyle({ textTransform: v })} options={[
            { value: "none", label: "As typed", icon: Ban },
            { value: "uppercase", label: "Uppercase", icon: CaseUpper },
            { value: "lowercase", label: "Lowercase", icon: CaseLower },
            { value: "capitalize", label: "Capitalize words", icon: CaseSensitive },
          ]} />
        </div>
        <div className="flex items-center justify-between gap-1">
          <Segmented anchor="design.text.resize" label="Resizing" value={resize} onChange={(v) => setProps(editor, texts, (id) => {
            const box = editor.bridge.box(id);
            if (v === "auto-width") return { widthMode: "hug", heightMode: "hug" };
            if (v === "auto-height") return { widthMode: "fixed", heightMode: "hug", ...(box ? { width: box.width } : {}) };
            return { widthMode: "fixed", heightMode: "fixed", ...(box ? { width: box.width, height: box.height } : {}) };
          })} options={[
            { value: "auto-width", label: "Auto width", icon: MoveHorizontal },
            { value: "auto-height", label: "Auto height (fixed width)", icon: FoldVertical },
            { value: "fixed", label: "Fixed size", icon: Square },
          ]} />
          <label className="flex items-center gap-1 text-[11px] text-stone-600">
            <TruncateToggle value={overflow} onChange={(on) => setProps(editor, texts, on ? { textOverflow: "ellipsis" } : { textOverflow: "clip", maxLines: null })} />
            Truncate
          </label>
        </div>
        {overflow === "ellipsis" && (
          <NumberField anchor="design.text.maxLines" label="Maximum lines" icon={<span className="text-[10px]">≤</span>} value={maxLines} digits={0} min={1} onCommit={(f) => setProps(editor, texts, (id) => ({ maxLines: Math.max(1, Math.round(f(editor.doc.stored(id, "maxLines") as number ?? 1))) }))} />
        )}
      </div>
    </Section>
  );
}

function TruncateToggle({ value, onChange }: { value: Maybe<string> | null; onChange: (on: boolean) => void }) {
  const ref = useAnchor<HTMLInputElement>("design.text.truncate", "toggle", "Truncate with an ellipsis");
  return <input ref={ref} type="checkbox" aria-label="Truncate with an ellipsis" checked={value === "ellipsis"} onChange={(e) => onChange(e.target.checked)} className="accent-blue-600" />;
}

function FamilyPicker({ value, fonts, onPick }: { value: Maybe<string> | null; fonts: FontRegistry | null; onPick: (family: string) => void }) {
  const ref = useAnchor<HTMLButtonElement>("design.text.family", "button", "Font family");
  const searchRef = useAnchor<HTMLInputElement>("fontpicker.search", "field", "Search fonts");
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const local = useMemo(() => [...families(fonts).keys()].sort(), [fonts, open]);
  const q = query.trim().toLowerCase();
  const localMatches = local.filter((f) => f.toLowerCase().includes(q));
  const google = [...GOOGLE_FAMILIES, ...(q && !GOOGLE_FAMILIES.some((g) => g.toLowerCase() === q) && !local.some((l) => l.toLowerCase() === q) ? [query.trim()] : [])].filter((f) => f.toLowerCase().includes(q) && !local.includes(f));
  const pickGoogle = async (name: string): Promise<void> => {
    if (!fonts) return;
    onPick(name);
    setStatus(`Loading ${name} from Google Fonts…`);
    try {
      loader ??= new GoogleFontsLoader();
      await loader.register(fonts, name);
      setStatus(null);
      setOpen(null);
    } catch (err) {
      setStatus(`Could not load ${name}: ${String((err as Error).message ?? err)}`);
    }
  };
  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-label="Font family"
        data-testid="font-family"
        className="flex h-7 w-full items-center justify-between rounded-md border border-transparent bg-stone-100 px-2 text-left text-[12px] hover:border-stone-200"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setOpen(open ? null : { x: r.left - 8, y: r.bottom + 4 });
          setQuery("");
          setStatus(null);
        }}
      >
        <span className="truncate">{value === MIXED ? "Mixed" : (value ?? "sans-serif")}</span>
        <ChevronDown size={12} aria-hidden />
      </button>
      {open && (
        <Popover at={open} onClose={() => setOpen(null)} width={248} label="Fonts" testId="font-picker">
          <div className="p-2">
            <input ref={searchRef} aria-label="Search fonts" autoFocus placeholder="Search fonts" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.stopPropagation()} className="mb-1.5 h-7 w-full rounded-md border border-stone-200 px-2 text-[12px] outline-none focus:border-blue-500" />
            {status && <p className="mb-1 px-1 text-[11px] text-stone-500" data-testid="font-status">{status}</p>}
            <ul className="max-h-64 overflow-y-auto" role="listbox" aria-label="Font families">
              {localMatches.length > 0 && <li className="px-1 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wide text-stone-400">In this document</li>}
              {localMatches.map((f) => (
                <FontRow key={f} family={f} selected={value === f} onPick={() => { onPick(f); setOpen(null); }} />
              ))}
              {google.length > 0 && <li className="px-1 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-stone-400">Google Fonts</li>}
              {google.map((f) => (
                <FontRow key={`g-${f}`} family={f} selected={value === f} onPick={() => void pickGoogle(f)} />
              ))}
            </ul>
          </div>
        </Popover>
      )}
    </>
  );
}

function FontRow({ family, selected, onPick }: { family: string; selected: boolean; onPick: () => void }) {
  const ref = useAnchor<HTMLButtonElement>(`fontpicker.family.${family.replace(/[^A-Za-z0-9_-]/g, "-")}`, "menu-item", `Font ${family}`);
  return (
    <li role="option" aria-selected={selected}>
      <button ref={ref} type="button" onClick={onPick} className={`w-full truncate rounded px-1.5 py-1 text-left text-[12px] ${selected ? "bg-blue-600 text-white" : "hover:bg-stone-100"}`}>
        {family}
      </button>
    </li>
  );
}
