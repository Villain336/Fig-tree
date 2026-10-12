import type { Command, TextContent, TextStyle } from "@fig-tree/document";
import type { Point } from "@fig-tree/geometry";
import type { Editor } from "../editor";
import type { KeyInput } from "../keymap";
import { invert, transformPoint } from "../math";
import type { OverlayItem } from "../overlay";
import type { Cursor, EditSession, ToolPointer } from "../tools/tool";
import { TextLayoutView } from "./layout";
import { nextGrapheme, nextWordEnd, paragraphAt, previousGrapheme, previousWordStart, wordAt } from "./segment";

export type CaretUnit = "grapheme" | "word" | "line" | "lineBoundary" | "paragraph" | "document";

/** Style keys that toggle with keyboard shortcuts. */
const BOLD = 700;
const NORMAL_WEIGHT = 400;

/**
 * Editing one text node on the canvas: a caret and a selection (anchor and
 * focus, UTF-16 indices into the node's content), keyboard navigation by
 * grapheme, word, line, paragraph and document, mouse selection (click,
 * drag, double-click word, triple-click paragraph, shift-extend), typing
 * and deleting through the `insertText`/`deleteText` commands, IME
 * composition, plain-text clipboard, and style edits on the selection
 * (`formatText` style runs). Runs of typing are one undo step.
 *
 * Geometry comes from the text engine through {@link TextLayoutView}; the
 * host feeds typed text from a hidden textarea ({@link insert} and the
 * composition methods) so every keyboard layout and input method works.
 */
export class TextSession implements EditSession {
  readonly mode = "text";
  anchor = 0;
  focus = 0;
  /** x the caret tries to keep while moving between lines. */
  private goalX: number | null = null;
  /** Style for the next typed text when the selection is collapsed (Bold with nothing selected). */
  pendingStyle: TextStyle | null = null;
  /** An IME composition in progress: the range its text occupies. */
  composition: { start: number; length: number } | null = null;
  private dragging = false;
  private dragUnit: "grapheme" | "word" | "paragraph" = "grapheme";
  private dragOrigin: { start: number; end: number } | null = null;
  readonly layout: TextLayoutView;
  /** Typing pauses longer than this start a new undo step (ms). */
  typingPause = 1000;
  private lastTyping = 0;
  /** Clock for typing merge windows (tests replace it). */
  now: () => number = () => Date.now();

  constructor(
    readonly editor: Editor,
    readonly nodeId: string,
  ) {
    this.layout = new TextLayoutView(editor.bridge, nodeId);
    const len = this.text.length;
    this.anchor = len;
    this.focus = len;
  }

  // ── State ────────────────────────────────────────────────────────────

  get text(): string {
    return this.editor.doc.text(this.nodeId).content;
  }

  get start(): number {
    return Math.min(this.anchor, this.focus);
  }

  get end(): number {
    return Math.max(this.anchor, this.focus);
  }

  get collapsed(): boolean {
    return this.anchor === this.focus;
  }

  get selectedText(): string {
    return this.text.slice(this.start, this.end);
  }

  setSelection(anchor: number, focus: number = anchor): void {
    const len = this.text.length;
    this.anchor = clampIndex(anchor, len);
    this.focus = clampIndex(focus, len);
    this.pendingStyle = null;
    this.publish();
  }

  /** Publishes the caret to presence (awareness-ready). */
  private publish(): void {
    this.editor.presence.update({ text: { id: this.nodeId, anchor: this.anchor, focus: this.focus } });
    this.editor.emit("overlay");
  }

  /** Clamps the selection after the content changed underneath (undo, a collaborator). */
  sync(): void {
    const len = this.text.length;
    if (this.anchor > len || this.focus > len) {
      this.anchor = clampIndex(this.anchor, len);
      this.focus = clampIndex(this.focus, len);
      this.publish();
    }
  }

  // ── Editing ──────────────────────────────────────────────────────────

  private typingGroup(): string {
    return `typing:${this.nodeId}`;
  }

  /** Ends the current run of typing: the next edit is a new undo step. */
  breakTyping(): void {
    this.editor.history.closeSoftGroup();
  }

  /** The full style of the character before `index` (run overrides only), for continuing it. */
  private styleBefore(index: number): TextStyle {
    const content = this.editor.doc.text(this.nodeId);
    const at = Math.max(0, index - 1);
    for (const r of content.runs) if (r.start <= at && at < r.end) return { ...r.style };
    return {};
  }

  /** Replaces the selection with `text` (typing and paste). */
  insert(text: string): void {
    if (text === "") return;
    if (this.composition) return;
    const now = this.now();
    if (now - this.lastTyping > this.typingPause) this.breakTyping();
    this.lastTyping = now;
    const cmds: Command[] = [];
    const s = this.start;
    if (!this.collapsed) cmds.push({ type: "deleteText", id: this.nodeId, index: s, length: this.end - s });
    const style = this.pendingStyle ? { ...this.styleBefore(s), ...this.pendingStyle } : null;
    cmds.push(style ? { type: "insertText", id: this.nodeId, index: s, text, style } : { type: "insertText", id: this.nodeId, index: s, text });
    if (this.editor.history.apply(cmds, { group: this.typingGroup() })) {
      this.anchor = this.focus = s + text.length;
      this.goalX = null;
      this.publish();
    }
  }

  /** Deletes the selection, or the unit before (`backward`) or after the caret. */
  delete(direction: "backward" | "forward", unit: "grapheme" | "word" | "lineBoundary" = "grapheme"): void {
    if (this.composition) return;
    let from = this.start;
    let to = this.end;
    if (this.collapsed) {
      const text = this.text;
      if (direction === "backward") from = unit === "word" ? previousWordStart(text, from) : unit === "lineBoundary" ? this.lineStart(from) : previousGrapheme(text, from);
      else to = unit === "word" ? nextWordEnd(text, to) : unit === "lineBoundary" ? this.lineEnd(to) : nextGrapheme(text, to);
    }
    if (to <= from) return;
    // Deleting is its own run of edits, separate from typing.
    this.editor.history.apply([{ type: "deleteText", id: this.nodeId, index: from, length: to - from }], { group: `delete:${this.nodeId}` });
    this.anchor = this.focus = from;
    this.goalX = null;
    this.pendingStyle = null;
    this.publish();
  }

  // ── IME composition ──────────────────────────────────────────────────

  /**
   * An input method starts composing. The composed text is written into
   * the document as it changes (others see it, layout reflows), all of it
   * in one undo step with the committed result.
   */
  compositionStart(): void {
    this.breakTyping();
    this.editor.history.begin();
    const s = this.start;
    if (!this.collapsed) {
      this.editor.history.apply([{ type: "deleteText", id: this.nodeId, index: s, length: this.end - s }]);
      this.anchor = this.focus = s;
    }
    this.composition = { start: s, length: 0 };
    this.publish();
  }

  compositionUpdate(data: string): void {
    const c = this.composition;
    if (!c) return;
    this.replaceComposition(data);
  }

  /** The composition ends with `data` committed (empty when cancelled). */
  compositionEnd(data: string): void {
    const c = this.composition;
    if (!c) return;
    this.replaceComposition(data);
    this.composition = null;
    this.editor.history.end();
    this.publish();
  }

  private replaceComposition(data: string): void {
    const c = this.composition!;
    const current = this.text.slice(c.start, c.start + c.length);
    if (current === data) return;
    const cmds: Command[] = [];
    if (c.length > 0) cmds.push({ type: "deleteText", id: this.nodeId, index: c.start, length: c.length });
    if (data.length > 0) {
      const style = this.pendingStyle ? { ...this.styleBefore(c.start), ...this.pendingStyle } : null;
      cmds.push(style ? { type: "insertText", id: this.nodeId, index: c.start, text: data, style } : { type: "insertText", id: this.nodeId, index: c.start, text: data });
    }
    if (this.editor.history.apply(cmds)) {
      this.composition = { start: c.start, length: data.length };
      this.anchor = this.focus = c.start + data.length;
      this.publish();
    }
  }

  // ── Styles ───────────────────────────────────────────────────────────

  /** The effective value of a style key for each character of [from, to) (the node's base style where no run overrides it). */
  styleValues<K extends keyof TextStyle>(key: K, from = this.start, to = this.end): unknown[] {
    const doc = this.editor.doc;
    const content: TextContent = doc.text(this.nodeId);
    const base = doc.get<unknown>(this.nodeId, key as string);
    const a = from;
    const b = to > from ? to : Math.min(from + 1, content.content.length);
    const out = new Set<string>();
    const values: unknown[] = [];
    const push = (v: unknown): void => {
      const k = JSON.stringify(v);
      if (!out.has(k)) {
        out.add(k);
        values.push(v);
      }
    };
    if (to <= from && this.pendingStyle && key in this.pendingStyle) return [this.pendingStyle[key]];
    const at = to > from ? a : Math.max(0, a - 1);
    const end = to > from ? b : at + 1;
    let pos = at;
    for (const r of content.runs) {
      if (r.end <= pos) continue;
      if (r.start >= end) break;
      if (r.start > pos) push(base);
      push(key in r.style ? r.style[key] : base);
      pos = r.end;
    }
    if (pos < end || values.length === 0) push(base);
    return values;
  }

  /**
   * Applies style overrides to the selection as style runs (`formatText`);
   * with nothing selected, they apply to the next typed text.
   */
  format(style: Record<string, unknown>): void {
    this.breakTyping();
    if (this.collapsed) {
      this.pendingStyle = { ...(this.pendingStyle ?? {}), ...(style as TextStyle) };
      this.editor.emit("overlay");
      return;
    }
    this.editor.history.apply([{ type: "formatText", id: this.nodeId, index: this.start, length: this.end - this.start, style }]);
    this.editor.emit("overlay");
  }

  toggleBold(): void {
    const weights = this.styleValues("fontWeight") as number[];
    this.format({ fontWeight: weights.every((w) => w >= 600) ? NORMAL_WEIGHT : BOLD });
  }

  toggleItalic(): void {
    const styles = this.styleValues("fontStyle") as string[];
    this.format({ fontStyle: styles.every((s) => s === "italic") ? "normal" : "italic" });
  }

  toggleUnderline(): void {
    const decorations = this.styleValues("textDecoration") as string[];
    this.format({ textDecoration: decorations.every((d) => d === "underline") ? "none" : "underline" });
  }

  // ── Caret movement ───────────────────────────────────────────────────

  private lineOf(index: number): { start: number; end: number; top: number; height: number } | null {
    const lines = this.layout.lines();
    if (lines.length === 0) return null;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      const next = lines[i + 1];
      // A caret at a soft wrap belongs to the next line, except at the end of the text.
      if (index >= l.start && (index < l.end || (index === l.end && (!next || next.start > index || next.paragraph !== l.paragraph)))) return l;
    }
    return lines[lines.length - 1]!;
  }

  private lineStart(index: number): number {
    return this.lineOf(index)?.start ?? 0;
  }

  private lineEnd(index: number): number {
    const l = this.lineOf(index);
    if (!l) return this.text.length;
    // A soft-wrapped line ends before its trailing space.
    const text = this.text;
    let e = l.end;
    if (e > l.start && e < text.length && text[e] !== "\n" && /\s/.test(text[e - 1]!)) e--;
    return e;
  }

  /** Moves the caret (or extends the selection with `extend`). */
  move(direction: "left" | "right" | "up" | "down", unit: CaretUnit, extend: boolean): void {
    this.breakTyping();
    const text = this.text;
    const len = text.length;
    let f = this.focus;
    const vertical = direction === "up" || direction === "down";
    if (!vertical) this.goalX = null;
    if (!extend && !this.collapsed && unit === "grapheme" && !vertical) {
      // Collapsing a selection with an arrow goes to its edge.
      f = direction === "left" ? this.start : this.end;
      this.anchor = this.focus = f;
      this.pendingStyle = null;
      this.publish();
      return;
    }
    switch (unit) {
      case "grapheme":
        if (direction === "left") f = previousGrapheme(text, f);
        else if (direction === "right") f = nextGrapheme(text, f);
        else f = this.verticalTarget(f, direction === "up" ? -1 : 1);
        break;
      case "word":
        f = direction === "left" || direction === "up" ? previousWordStart(text, f) : nextWordEnd(text, f);
        break;
      case "line":
        f = this.verticalTarget(f, direction === "up" || direction === "left" ? -1 : 1);
        break;
      case "lineBoundary":
        f = direction === "left" || direction === "up" ? this.lineStart(f) : this.lineEnd(f);
        break;
      case "paragraph": {
        if (direction === "left" || direction === "up") {
          const p = paragraphAt(text, f);
          f = f > p.start ? p.start : paragraphAt(text, Math.max(0, p.start - 1)).start;
        } else {
          const p = paragraphAt(text, f);
          f = f < p.end ? p.end : paragraphAt(text, Math.min(len, p.end + 1)).end;
        }
        break;
      }
      case "document":
        f = direction === "left" || direction === "up" ? 0 : len;
        break;
    }
    this.focus = clampIndex(f, len);
    if (!extend) this.anchor = this.focus;
    this.pendingStyle = null;
    this.publish();
  }

  /** The caret on the line above (-1) or below (+1), keeping the goal x. */
  private verticalTarget(index: number, dir: -1 | 1): number {
    const caret = this.layout.caret(index);
    this.goalX ??= caret.x;
    const lines = this.layout.lines();
    const current = this.lineOf(index);
    const i = current ? lines.findIndex((l) => l.start === current.start && l.top === current.top) : -1;
    const target = lines[i + dir];
    if (!target) return dir < 0 ? 0 : this.text.length;
    if (target.start === target.end) return target.start;
    return this.layout.indexAt(this.goalX, target.top + target.height / 2);
  }

  selectAll(): void {
    this.setSelection(0, this.text.length);
  }

  // ── Pointer ──────────────────────────────────────────────────────────

  /** The caret index under a world point. */
  indexAtWorld(p: Point): number {
    const inv = invert(this.editor.geometry.worldMatrix(this.nodeId));
    if (!inv) return 0;
    const l = transformPoint(inv, p.x, p.y);
    return this.layout.indexAt(l.x, l.y);
  }

  /** Whether a world point is inside the edited node's box (with a small margin). */
  contains(p: Point): boolean {
    const inv = invert(this.editor.geometry.worldMatrix(this.nodeId));
    if (!inv) return false;
    const l = transformPoint(inv, p.x, p.y);
    const { width, height } = this.editor.geometry.size(this.nodeId);
    const m = 4 / this.editor.viewport.scale;
    return l.x >= -m && l.y >= -m && l.x <= width + m && l.y <= height + m;
  }

  pointerDown(e: ToolPointer): boolean {
    if (e.button !== 0) return this.contains(e.world);
    if (!this.contains(e.world)) return false;
    this.breakTyping();
    const index = this.indexAtWorld(e.world);
    const text = this.text;
    this.goalX = null;
    if (e.clickCount >= 3) {
      const p = paragraphAt(text, index);
      this.dragUnit = "paragraph";
      this.dragOrigin = p;
      this.setSelection(p.start, p.end);
    } else if (e.clickCount === 2) {
      const w = wordAt(text, index);
      this.dragUnit = "word";
      this.dragOrigin = w;
      this.setSelection(w.start, w.end);
    } else if (e.shift) {
      this.dragUnit = "grapheme";
      this.dragOrigin = { start: this.anchor, end: this.anchor };
      this.setSelection(this.anchor, index);
    } else {
      this.dragUnit = "grapheme";
      this.dragOrigin = { start: index, end: index };
      this.setSelection(index);
    }
    this.dragging = true;
    return true;
  }

  pointerMove(e: ToolPointer): void {
    if (!this.dragging || !this.dragOrigin) return;
    const index = this.indexAtWorld(e.world);
    const o = this.dragOrigin;
    if (this.dragUnit === "grapheme") {
      this.focus = index;
      this.anchor = o.start;
    } else {
      const unit = this.dragUnit === "word" ? wordAt(this.text, index) : paragraphAt(this.text, index);
      if (index < o.start) {
        this.anchor = o.end;
        this.focus = unit.start;
      } else {
        this.anchor = o.start;
        this.focus = Math.max(unit.end, o.end);
      }
    }
    this.publish();
  }

  pointerUp(): void {
    this.dragging = false;
  }

  cursor(e: ToolPointer): Cursor | null {
    return this.contains(e.world) ? "text" : null;
  }

  // ── Keyboard ─────────────────────────────────────────────────────────

  keyDown(e: KeyInput): boolean {
    if (this.composition) return true;
    const mac = this.editor.platform === "mac";
    const key = e.key;
    const arrow = key === "ArrowLeft" ? "left" : key === "ArrowRight" ? "right" : key === "ArrowUp" ? "up" : key === "ArrowDown" ? "down" : null;
    if (arrow) {
      const horizontal = arrow === "left" || arrow === "right";
      let unit: CaretUnit = "grapheme";
      if (mac) {
        if (e.mod) unit = horizontal ? "lineBoundary" : "document";
        else if (e.alt) unit = horizontal ? "word" : "paragraph";
      } else if (e.mod) unit = horizontal ? "word" : "paragraph";
      this.move(arrow, unit, e.shift);
      return true;
    }
    if (key === "Home" || key === "End") {
      const dir = key === "Home" ? "left" : "right";
      this.move(dir, e.mod ? "document" : "lineBoundary", e.shift);
      return true;
    }
    if (key === "Backspace" || key === "Delete") {
      const dir = key === "Backspace" ? "backward" : "forward";
      const unit = mac ? (e.mod ? "lineBoundary" : e.alt ? "word" : "grapheme") : e.mod ? "word" : "grapheme";
      this.delete(dir, unit);
      return true;
    }
    if (key === "Enter") {
      // Enter starts a paragraph; Shift+Enter a line break inside it (U+2028, a forced break).
      this.insert(e.shift ? String.fromCharCode(0x2028) : "\n");
      return true;
    }
    if (key === "Tab" && !e.mod) {
      this.insert("\t");
      return true;
    }
    if (key === "Escape") {
      this.editor.exitEditMode();
      return true;
    }
    if (e.mod && !e.alt) {
      switch (e.code) {
        case "KeyA":
          this.selectAll();
          return true;
        case "KeyB":
          this.toggleBold();
          return true;
        case "KeyI":
          this.toggleItalic();
          return true;
        case "KeyU":
          this.toggleUnderline();
          return true;
        default:
          // Undo, redo, clipboard and other shortcuts go to the editor.
          return false;
      }
    }
    // Printable characters arrive as text input (beforeinput), not here.
    if (key.length === 1 && !e.mod) return true;
    return false;
  }

  // ── Overlay ──────────────────────────────────────────────────────────

  overlay(out: OverlayItem[]): void {
    const geom = this.editor.geometry;
    if (!this.editor.doc.has(this.nodeId)) return;
    const world = geom.worldMatrix(this.nodeId);
    const vp = this.editor.viewport;
    const toScreen = (x: number, y: number): Point => vp.toScreen(transformPoint(world, x, y));
    const { width, height } = geom.size(this.nodeId);
    out.push({ kind: "outline", points: [toScreen(0, 0), toScreen(width, 0), toScreen(width, height), toScreen(0, height)], closed: true, role: "editing" });
    for (const r of this.layout.rangeRects(this.start, this.end)) {
      out.push({ kind: "rect", role: "text-selection", points: [toScreen(r.x, r.y), toScreen(r.x + r.width, r.y), toScreen(r.x + r.width, r.y + r.height), toScreen(r.x, r.y + r.height)] });
    }
    if (this.collapsed || this.composition) {
      const c = this.layout.caret(this.focus);
      out.push({ kind: "caret", from: toScreen(c.x, c.y), to: toScreen(c.x, c.y + c.height) });
    }
  }

  /** Where the hidden text input should sit (canvas CSS px), so IME candidate windows appear at the caret. */
  inputRect(): { x: number; y: number; height: number } {
    const c = this.layout.caret(this.focus);
    const p = this.editor.viewport.toScreen(transformPoint(this.editor.geometry.worldMatrix(this.nodeId), c.x, c.y));
    return { x: p.x, y: p.y, height: c.height * this.editor.viewport.scale };
  }

  exit(): void {
    if (this.composition) this.compositionEnd(this.text.slice(this.composition.start, this.composition.start + this.composition.length));
    this.breakTyping();
    this.dragging = false;
    // Text left empty disappears, as in other design tools.
    const doc = this.editor.doc;
    if (doc.has(this.nodeId) && this.text.length === 0) this.editor.history.apply([{ type: "delete", ids: [this.nodeId] }]);
  }
}

function clampIndex(i: number, len: number): number {
  return i < 0 ? 0 : i > len ? len : i;
}
