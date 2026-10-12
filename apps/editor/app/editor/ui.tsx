"use client";

import { evaluateExpression, ExpressionError, type AnchorKind } from "@fig-tree/editor-core";
import type { LucideIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useAnchor, useEditor } from "./state";

export const MIXED = Symbol("mixed");
export type Maybe<T> = T | typeof MIXED;

/** Combines a ref callback from useAnchor with another ref. */
function mergeRefs<T>(...refs: (((el: T | null) => unknown) | { current: T | null } | undefined)[]): (el: T | null) => (() => void) | undefined {
  return (el) => {
    const cleanups: (() => void)[] = [];
    for (const r of refs) {
      if (!r) continue;
      if (typeof r === "function") {
        const c = r(el);
        if (typeof c === "function") cleanups.push(c as () => void);
      } else r.current = el;
    }
    return cleanups.length ? () => cleanups.forEach((c) => c()) : undefined;
  };
}

export function IconButton({
  anchor,
  label,
  icon: Icon,
  onClick,
  active = false,
  disabled = false,
  size = 28,
  iconSize = 15,
  className = "",
  kind = "button",
  shortcut,
  testId,
}: {
  anchor: string;
  label: string;
  icon: LucideIcon;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  active?: boolean;
  disabled?: boolean;
  size?: number;
  iconSize?: number;
  className?: string;
  kind?: AnchorKind;
  shortcut?: string | null;
  testId?: string;
}) {
  const ref = useAnchor<HTMLButtonElement>(anchor, kind, label);
  return (
    <button
      ref={ref}
      type="button"
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-label={label}
      aria-pressed={kind === "toggle" ? active : undefined}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
      style={{ width: size, height: size }}
      className={`inline-flex shrink-0 items-center justify-center rounded-md transition-colors disabled:opacity-35 ${
        active ? "bg-blue-600 text-white" : "text-stone-600 hover:bg-stone-100 hover:text-stone-900"
      } ${className}`}
    >
      <Icon size={iconSize} strokeWidth={1.75} aria-hidden />
    </button>
  );
}

export function TextButton({ anchor, label, children, onClick, className = "", disabled = false, kind = "button", testId }: { anchor: string; label: string; children: ReactNode; onClick: () => void; className?: string; disabled?: boolean; kind?: AnchorKind; testId?: string }) {
  const ref = useAnchor<HTMLButtonElement>(anchor, kind, label);
  return (
    <button ref={ref} type="button" aria-label={label} disabled={disabled} onClick={onClick} data-testid={testId} className={`rounded-md px-2 py-1 text-[11px] text-stone-700 hover:bg-stone-100 disabled:opacity-40 ${className}`}>
      {children}
    </button>
  );
}

const fmt = (v: number, digits = 2): string => {
  const r = Math.round(v * 10 ** digits) / 10 ** digits;
  return String(Object.is(r, -0) ? 0 : r);
};

/**
 * A number field: type a value or an expression (`12*2`, `+10`, `50%`),
 * ArrowUp/ArrowDown step it (Shift ×10), and dragging the label scrubs it
 * (one undo step per drag). Shows "Mixed" for multi-selections that differ.
 */
export function NumberField({
  anchor,
  label,
  value,
  onCommit,
  icon,
  min,
  max,
  step = 1,
  suffix,
  digits = 2,
  width = "100%",
  disabled = false,
  testId,
  scale = 1,
}: {
  anchor: string;
  label: string;
  value: Maybe<number> | null;
  /** Receives a function from each node's old value to its new one. */
  onCommit: (fn: (old: number) => number) => void;
  icon?: ReactNode;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  digits?: number;
  width?: number | string;
  disabled?: boolean;
  testId?: string;
  /** Display scale (100 shows a 0..1 value as a percentage). */
  scale?: number;
}) {
  const editor = useEditor();
  const ref = useAnchor<HTMLInputElement>(anchor, "field", label);
  const labelRef = useAnchor<HTMLSpanElement>(`${anchor}.scrub`, "slider", `${label} (drag to change)`);
  const shown = value === null ? "" : value === MIXED ? "Mixed" : fmt(value * scale, digits);
  const [text, setText] = useState(shown);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!editing) setText(shown);
  }, [shown, editing]);
  const clampV = (v: number): number => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
  const commitText = (): void => {
    if (text === shown) return;
    const current = value === MIXED || value === null ? null : value * scale;
    try {
      const relative = /^\s*[+*/×÷]/.test(text);
      if (relative || value !== MIXED) {
        const result = (old: number): number => clampV(evaluateExpression(text, old * scale) / scale);
        // Validate once against the shown value.
        evaluateExpression(text, current ?? 0);
        onCommit(result);
      } else {
        const v = clampV(evaluateExpression(text, null) / scale);
        onCommit(() => v);
      }
      setError(false);
    } catch (err) {
      if (err instanceof ExpressionError) {
        setError(true);
        setText(shown);
      } else throw err;
    }
  };
  const scrub = useRef<{ x: number; acc: number } | null>(null);
  return (
    <label className={`group flex h-7 items-center rounded-md border bg-stone-100 text-[11px] ${error ? "border-red-400" : "border-transparent hover:border-stone-200 focus-within:border-blue-500 focus-within:bg-white"} ${disabled ? "opacity-40" : ""}`} style={{ width }}>
      <span
        ref={labelRef}
        className="flex h-full w-6 shrink-0 cursor-ew-resize select-none items-center justify-center text-stone-400"
        title={label}
        onPointerDown={(e) => {
          if (disabled || e.button !== 0) return;
          e.preventDefault();
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          scrub.current = { x: e.clientX, acc: 0 };
          editor.history.begin();
        }}
        onPointerMove={(e) => {
          const s = scrub.current;
          if (!s) return;
          s.acc += ((e.clientX - s.x) * step * (e.shiftKey ? 10 : 1)) / scale;
          s.x = e.clientX;
          const whole = s.acc >= 0 ? Math.floor(s.acc / step) * step : Math.ceil(s.acc / step) * step;
          if (whole !== 0) {
            s.acc -= whole;
            onCommit((old) => clampV(old + whole));
          }
        }}
        onPointerUp={() => {
          if (!scrub.current) return;
          scrub.current = null;
          editor.history.end();
        }}
      >
        {icon ?? label}
      </span>
      <input
        ref={(el) => {
          input.current = el;
          return ref(el);
        }}
        aria-label={label}
        data-testid={testId}
        disabled={disabled}
        className="h-full min-w-0 flex-1 bg-transparent pr-1.5 outline-none placeholder:text-stone-400"
        value={editing ? text : shown}
        placeholder={value === MIXED ? "Mixed" : ""}
        onFocus={(e) => {
          setEditing(true);
          setText(shown);
          e.target.select();
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          commitText();
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commitText();
            setEditing(false);
            input.current?.blur();
          } else if (e.key === "Escape") {
            setText(shown);
            setEditing(false);
            setError(false);
            input.current?.blur();
          } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const d = (e.key === "ArrowUp" ? step : -step) * (e.shiftKey ? 10 : 1);
            onCommit((old) => clampV(old + d / scale));
            setEditing(false);
          }
          e.stopPropagation();
        }}
      />
      {suffix && <span className="pr-2 text-stone-400">{suffix}</span>}
    </label>
  );
}

export function TextField({ anchor, label, value, onCommit, placeholder, className = "", testId }: { anchor: string; label: string; value: string; onCommit: (v: string) => void; placeholder?: string; className?: string; testId?: string }) {
  const ref = useAnchor<HTMLInputElement>(anchor, "field", label);
  const [text, setText] = useState(value);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(value);
  }, [value, editing]);
  return (
    <input
      ref={ref}
      aria-label={label}
      data-testid={testId}
      placeholder={placeholder}
      className={`h-7 min-w-0 rounded-md border border-transparent bg-stone-100 px-2 text-[11px] outline-none hover:border-stone-200 focus:border-blue-500 focus:bg-white ${className}`}
      value={editing ? text : value}
      onFocus={(e) => {
        setEditing(true);
        setText(value);
        e.target.select();
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text !== value) onCommit(text);
        setEditing(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setText(value);
          setEditing(false);
          setTimeout(() => (e.target as HTMLInputElement).blur());
        }
        e.stopPropagation();
      }}
    />
  );
}

export function SelectField<T extends string>({ anchor, label, value, options, onChange, width = "100%", testId }: { anchor: string; label: string; value: Maybe<T>; options: readonly (readonly [T, string])[]; onChange: (v: T) => void; width?: number | string; testId?: string }) {
  const ref = useAnchor<HTMLSelectElement>(anchor, "field", label);
  return (
    <select
      ref={ref}
      aria-label={label}
      data-testid={testId}
      title={label}
      className="h-7 rounded-md border border-transparent bg-stone-100 px-1.5 text-[11px] text-stone-800 outline-none hover:border-stone-200 focus:border-blue-500"
      style={{ width }}
      value={value === MIXED ? "" : value}
      onChange={(e) => onChange(e.target.value as T)}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {value === MIXED && <option value="">Mixed</option>}
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );
}

/** A row of mutually exclusive icon buttons. */
export function Segmented<T extends string>({ anchor, label, value, options, onChange }: { anchor: string; label: string; value: Maybe<T> | null; options: readonly { value: T; label: string; icon: LucideIcon }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex h-7 items-center gap-0.5 rounded-md bg-stone-100 p-0.5" role="group" aria-label={label}>
      {options.map((o) => (
        <IconButton key={o.value} anchor={`${anchor}.${o.value}`} label={o.label} icon={o.icon} size={24} iconSize={14} kind="toggle" active={value === o.value} onClick={() => onChange(o.value)} className={value === o.value ? "" : "hover:bg-white"} />
      ))}
    </div>
  );
}

export function Section({ title, children, actions, testId }: { title: string; children: ReactNode; actions?: ReactNode; testId?: string }) {
  return (
    <section className="border-b border-stone-200 px-3 py-2.5" data-testid={testId}>
      <header className="mb-1.5 flex h-6 items-center justify-between">
        <h3 className="text-[11px] font-semibold text-stone-800">{title}</h3>
        <div className="flex items-center gap-0.5">{actions}</div>
      </header>
      {children}
    </section>
  );
}

/**
 * A floating panel next to a trigger rectangle, closed by Escape or a
 * press outside it.
 */
export function Popover({ at, onClose, children, width = 240, testId, label }: { at: { x: number; y: number }; onClose: () => void; children: ReactNode; width?: number; testId?: string; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({ left: at.x, top: at.y, visibility: "hidden" });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(at.x, window.innerWidth - r.width - 8));
    const top = Math.max(8, Math.min(at.y, window.innerHeight - r.height - 8));
    setPos({ left, top });
  }, [at.x, at.y]);
  useEffect(() => {
    const down = (e: PointerEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [onClose]);
  return createPortal(
    <div ref={ref} role="dialog" aria-label={label} data-testid={testId} className="fixed z-50 rounded-lg border border-stone-200 bg-white text-[11px] shadow-lg" style={{ ...pos, width }} onKeyDown={(e) => e.stopPropagation()}>
      {children}
    </div>,
    document.body,
  );
}

export { mergeRefs, fmt };
