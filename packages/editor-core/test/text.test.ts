import type { FontRegistry } from "@fig-tree/text";
import { beforeAll, describe, expect, it } from "vitest";
import { copySelection, cutSelection, paste, textSession, type TextSession } from "../src";
import { click, doubleClick, key, setup, text, textFonts } from "./helpers";

let fonts: FontRegistry;
beforeAll(async () => {
  fonts = await textFonts();
});

/** A text node at (100, 100) and an editing session on it. */
function editing(content: string, extra: Record<string, unknown> = {}, platform: "mac" | "other" = "other") {
  const s = setup((page) => [text("t", page, content, { x: 100, y: 100, ...extra })], { fonts, platform });
  expect(s.editor.enterEditMode("t")).toBe(true);
  const session = textSession(s.editor)!;
  // Typing runs merge by time; tests control the clock.
  let now = 0;
  session.now = () => now;
  const advance = (ms: number) => (now += ms);
  return { ...s, session, advance };
}

const content = (s: { session: TextSession }): string => s.session.text;

describe("text editing", () => {
  it("enters on double-click with the word under the pointer selected, and Enter selects all", () => {
    const s = setup((page) => [text("t", page, "Hello world", { x: 100, y: 100 })], { fonts });
    click(s.editor, 110, 108);
    expect(s.editor.selection).toEqual(["t"]);
    doubleClick(s.editor, 110, 108);
    const session = textSession(s.editor)!;
    expect(session.selectedText).toBe("Hello");
    key(s.editor, "Escape");
    expect(s.editor.session).toBeNull();
    expect(s.editor.selection).toEqual(["t"]);
    key(s.editor, "Enter");
    expect(textSession(s.editor)!.selectedText).toBe("Hello world");
  });

  it("types, replaces the selection and deletes graphemes and words", () => {
    const s = editing("Hello world");
    s.session.setSelection(5);
    s.session.insert(",");
    expect(content(s)).toBe("Hello, world");
    s.session.setSelection(7, 12);
    s.session.insert("there");
    expect(content(s)).toBe("Hello, there");
    key(s.editor, "Backspace");
    expect(content(s)).toBe("Hello, ther");
    key(s.editor, "Backspace", { mod: true });
    expect(content(s)).toBe("Hello, ");
    s.session.setSelection(0);
    key(s.editor, "Delete");
    expect(content(s)).toBe("ello, ");
  });

  it("deletes emoji and combining sequences as one grapheme", () => {
    const s = editing("a👍🏽éb");
    s.session.setSelection(7);
    key(s.editor, "Backspace");
    expect(content(s)).toBe("a👍🏽b");
    key(s.editor, "Backspace");
    expect(content(s)).toBe("ab");
  });

  it("moves by grapheme, word and document, extending with Shift", () => {
    const s = editing("one two three");
    s.session.setSelection(0);
    key(s.editor, "ArrowRight", { mod: true });
    expect(s.session.focus).toBe(3);
    key(s.editor, "ArrowRight", { mod: true });
    expect(s.session.focus).toBe(7);
    key(s.editor, "ArrowLeft", { mod: true, shift: true });
    expect([s.session.anchor, s.session.focus]).toEqual([7, 4]);
    expect(s.session.selectedText).toBe("two");
    // An arrow without Shift collapses to the selection's edge.
    key(s.editor, "ArrowRight");
    expect([s.session.anchor, s.session.focus]).toEqual([7, 7]);
    key(s.editor, "End", { mod: true });
    expect(s.session.focus).toBe(13);
    key(s.editor, "Home", { mod: true, shift: true });
    expect(s.session.selectedText).toBe("one two three");
  });

  it("uses macOS bindings on a Mac (Alt for words, Cmd for lines)", () => {
    const s = editing("one two three", {}, "mac");
    s.session.setSelection(0);
    key(s.editor, "ArrowRight", { alt: true });
    expect(s.session.focus).toBe(3);
    key(s.editor, "ArrowRight", { mod: true });
    expect(s.session.focus).toBe(13);
    key(s.editor, "Backspace", { alt: true });
    expect(content(s)).toBe("one two ");
  });

  it("moves between wrapped lines keeping the column, with Home and End per line", () => {
    // Fixed width: the text wraps into lines.
    const s = editing("alpha beta gamma delta", { width: 60, widthMode: "fixed", heightMode: "hug" });
    const lines = s.session.layout.lines();
    expect(lines.length).toBeGreaterThan(2);
    s.session.setSelection(1);
    key(s.editor, "ArrowDown");
    const second = lines[1]!;
    expect(s.session.focus).toBeGreaterThan(second.start);
    expect(s.session.focus).toBeLessThanOrEqual(second.end);
    key(s.editor, "Home");
    expect(s.session.focus).toBe(second.start);
    key(s.editor, "End");
    // End stops before the space the line wrapped at.
    expect(content(s)[s.session.focus]).toBe(" ");
    key(s.editor, "ArrowUp");
    key(s.editor, "ArrowUp");
    expect(s.session.focus).toBe(0);
    key(s.editor, "ArrowDown", { mod: true });
    expect(s.session.focus).toBe(content(s).length);
  });

  it("moves by paragraph and inserts paragraph and line breaks", () => {
    const s = editing("first\nsecond");
    s.session.setSelection(0);
    key(s.editor, "ArrowDown", { mod: true });
    expect(s.session.focus).toBe(5);
    key(s.editor, "ArrowDown", { mod: true });
    expect(s.session.focus).toBe(12);
    key(s.editor, "Enter");
    key(s.editor, "Enter", { shift: true });
    expect(content(s)).toBe("first\nsecond\n ");
  });

  it("selects with the mouse: click, drag, Shift-click, double and triple click", () => {
    const s = editing("Hello brave world");
    const caret = (i: number) => {
      const c = s.session.layout.caret(i);
      return { x: 100 + c.x, y: 100 + c.y + c.height / 2 };
    };
    const a = caret(6);
    s.editor.pointerDown({ x: a.x, y: a.y });
    const b = caret(11);
    s.editor.pointerMove({ x: b.x, y: b.y });
    s.editor.pointerUp({ x: b.x, y: b.y });
    expect(s.session.selectedText).toBe("brave");
    const end = caret(17);
    s.editor.pointerDown({ x: end.x, y: end.y, shift: true });
    s.editor.pointerUp({ x: end.x, y: end.y, shift: true });
    expect(s.session.selectedText).toBe("brave world");
    s.editor.pointerDown({ x: a.x + 2, y: a.y, clickCount: 2 });
    s.editor.pointerUp({ x: a.x + 2, y: a.y, clickCount: 2 });
    expect(s.session.selectedText).toBe("brave");
    s.editor.pointerDown({ x: a.x + 2, y: a.y, clickCount: 3 });
    s.editor.pointerUp({ x: a.x + 2, y: a.y, clickCount: 3 });
    expect(s.session.selectedText).toBe("Hello brave world");
    // Clicking outside the text ends editing.
    click(s.editor, 700, 500);
    expect(s.editor.session).toBeNull();
  });

  it("merges a run of typing into one undo step, split by pauses and caret moves", () => {
    const s = editing("");
    for (const ch of "abc") s.session.insert(ch);
    s.advance(5000);
    s.session.insert("d");
    s.session.insert("e");
    key(s.editor, "ArrowLeft");
    s.session.insert("X");
    expect(content(s)).toBe("abcdXe");
    key(s.editor, "z", { mod: true });
    expect(content(s)).toBe("abcde");
    key(s.editor, "z", { mod: true });
    expect(content(s)).toBe("abc");
    key(s.editor, "z", { mod: true });
    expect(content(s)).toBe("");
    // The caret stays inside the text after undo.
    expect(s.session.focus).toBe(0);
  });

  it("commits IME composition as one undo step, replacing the selection", () => {
    const s = editing("Hello world");
    s.session.setSelection(6, 11);
    s.session.compositionStart();
    s.session.compositionUpdate("k");
    expect(content(s)).toBe("Hello k");
    s.session.compositionUpdate("か");
    s.session.compositionUpdate("かn");
    s.session.compositionUpdate("かな");
    // Keys during composition belong to the input method.
    expect(key(s.editor, "Backspace")).toBe(true);
    expect(content(s)).toBe("Hello かな");
    s.session.compositionEnd("仮名");
    expect(content(s)).toBe("Hello 仮名");
    expect(s.session.focus).toBe(8);
    s.session.insert("!");
    expect(content(s)).toBe("Hello 仮名!");
    key(s.editor, "z", { mod: true });
    expect(content(s)).toBe("Hello 仮名");
    key(s.editor, "z", { mod: true });
    expect(content(s)).toBe("Hello world");
  });

  it("leaves the text untouched when a composition is cancelled", () => {
    const s = editing("abc");
    s.session.setSelection(1);
    s.session.compositionStart();
    s.session.compositionUpdate("ü");
    s.session.compositionEnd("");
    expect(content(s)).toBe("abc");
    expect(s.editor.history.canUndo()).toBe(false);
  });

  it("styles the selection as runs, and the next typed text when nothing is selected", () => {
    const s = editing("plain bold");
    s.session.setSelection(6, 10);
    key(s.editor, "b", { mod: true });
    expect(s.doc.text("t").runs).toEqual([{ start: 6, end: 10, style: { fontWeight: 700 } }]);
    key(s.editor, "b", { mod: true });
    expect(s.doc.text("t").runs).toEqual([{ start: 6, end: 10, style: { fontWeight: 400 } }]);
    s.session.format({ fontSize: 24, fills: [{ type: "solid", color: { r: 1, g: 0, b: 0, a: 1 } }] });
    expect(s.session.styleValues("fontSize")).toEqual([24]);
    expect(s.session.styleValues("fontSize", 0, 10)).toEqual([16, 24]);
    // Collapsed: italic applies to what is typed next.
    s.session.setSelection(5);
    key(s.editor, "i", { mod: true });
    s.session.insert("X");
    expect(s.doc.text("t").runs[0]).toEqual({ start: 5, end: 6, style: { fontStyle: "italic" } });
    key(s.editor, "u", { mod: true });
    expect(s.session.pendingStyle).toEqual({ textDecoration: "underline" });
  });

  it("copies, cuts and pastes plain text inside the text", async () => {
    const s = editing("copy me");
    s.session.setSelection(0, 4);
    expect(copySelection(s.editor)).toEqual({ text: "copy", html: null });
    expect(cutSelection(s.editor)).toEqual({ text: "copy", html: null });
    expect(content(s)).toBe(" me");
    await paste(s.editor, { text: "paste\r\nit" });
    expect(content(s)).toBe("paste\nit me");
  });

  it("deletes text left empty when editing ends", () => {
    const s = editing("x");
    s.session.selectAll();
    key(s.editor, "Backspace");
    key(s.editor, "Escape");
    expect(s.doc.has("t")).toBe(false);
  });

  it("creates text with the text tool and edits it at once", () => {
    const s = setup(() => [], { fonts });
    s.editor.run("tool.text");
    click(s.editor, 50, 60);
    const session = textSession(s.editor)!;
    expect(session).not.toBeNull();
    for (const ch of "New") session.insert(ch);
    expect(s.doc.text(session.nodeId).content).toBe("New");
    expect(s.doc.get(session.nodeId, "x")).toBe(50);
    expect(s.editor.bridge.box(session.nodeId)!.width).toBeGreaterThan(20);
    // The caret overlay follows the text.
    const caret = s.editor.overlay().find((i) => i.kind === "caret");
    expect(caret).toBeDefined();
  });
});
