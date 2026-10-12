import { describe, expect, it } from "vitest";
import {
  AnchorRegistry,
  actionFor,
  evaluateExpression,
  ExpressionError,
  formatBinding,
  hslToRgb,
  hsvToRgb,
  parseHex,
  rgbToHsl,
  rgbToHsv,
  SHORTCUTS,
  toHex,
  Viewport,
  LocalPresence,
} from "../src";

const k = (code: string, key: string, m: { shift?: boolean; alt?: boolean; mod?: boolean } = {}) => ({ code, key, shift: m.shift ?? false, alt: m.alt ?? false, mod: m.mod ?? false });

describe("expressions", () => {
  it("evaluates arithmetic", () => {
    expect(evaluateExpression("12*2")).toBe(24);
    expect(evaluateExpression("(8 + 4) * 2")).toBe(24);
    expect(evaluateExpression("100/4-5")).toBe(20);
    expect(evaluateExpression("-4")).toBe(-4);
    expect(evaluateExpression("2*-3")).toBe(-6);
    expect(evaluateExpression("1,5")).toBe(1.5);
    expect(evaluateExpression("16px")).toBe(16);
  });

  it("supports relative edits and percentages of the current value", () => {
    expect(evaluateExpression("+10", 5)).toBe(15);
    expect(evaluateExpression("*2", 7)).toBe(14);
    expect(evaluateExpression("/4", 10)).toBe(2.5);
    expect(evaluateExpression("50%", 30)).toBe(15);
    expect(evaluateExpression("-4", 10)).toBe(-4);
  });

  it("rejects malformed input", () => {
    for (const bad of ["", "2*", "abc", "(1", "1/0", "alert(1)", "2**3"]) expect(() => evaluateExpression(bad)).toThrow(ExpressionError);
    expect(() => evaluateExpression("50%")).toThrow(ExpressionError);
  });
});

describe("colors", () => {
  it("parses and formats hex", () => {
    expect(parseHex("#FF0000")).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(parseHex("f00")).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(parseHex("3a")).toEqual(parseHex("3a3a3a"));
    expect(parseHex("00000080")!.a).toBeCloseTo(128 / 255);
    expect(parseHex("xyz")).toBeNull();
    expect(parseHex("12345")).toBeNull();
    expect(toHex({ r: 0.2, g: 0.4, b: 0.6, a: 1 })).toBe("336699");
    expect(toHex({ r: 1, g: 1, b: 1, a: 0.5 }, true)).toBe("FFFFFF80");
  });

  it("round-trips through HSV and HSL", () => {
    for (const c of [
      { r: 1, g: 0, b: 0, a: 1 },
      { r: 0.2, g: 0.6, b: 0.4, a: 0.5 },
      { r: 0.9, g: 0.85, b: 0.1, a: 1 },
      { r: 0, g: 0, b: 0, a: 1 },
    ]) {
      const v = hsvToRgb(rgbToHsv(c), c.a);
      const l = hslToRgb(rgbToHsl(c), c.a);
      for (const ch of ["r", "g", "b", "a"] as const) {
        expect(v[ch]).toBeCloseTo(c[ch], 9);
        expect(l[ch]).toBeCloseTo(c[ch], 9);
      }
    }
    expect(rgbToHsv({ r: 0, g: 0, b: 1, a: 1 }).h).toBe(240);
  });
});

describe("keymap", () => {
  it("maps keys to actions by physical key and modifiers", () => {
    expect(actionFor(k("KeyD", "d", { mod: true }))).toBe("edit.duplicate");
    expect(actionFor(k("KeyZ", "Z", { mod: true, shift: true }))).toBe("edit.redo");
    expect(actionFor(k("KeyG", "©", { mod: true, alt: true }))).toBe("arrange.frame");
    expect(actionFor(k("Digit1", "!", { shift: true }))).toBe("view.zoomFit");
    expect(actionFor(k("KeyR", "r"))).toBe("tool.rectangle");
    expect(actionFor(k("KeyR", "r", { mod: true }))).toBe("edit.rename");
    expect(actionFor(k("Delete", "Delete"))).toBe("edit.delete");
    expect(actionFor(k("BracketRight", "]", { mod: true }))).toBe("arrange.forward");
    expect(actionFor(k("KeyQ", "q"))).toBeNull();
  });

  it("formats bindings per platform", () => {
    expect(formatBinding("Shift+Mod+Z", "mac")).toBe("⇧⌘Z");
    expect(formatBinding("Shift+Mod+Z", "other")).toBe("Shift+Ctrl+Z");
    expect(formatBinding("Alt+Mod+G", "mac")).toBe("⌥⌘G");
  });

  it("has no binding claimed by two actions", () => {
    const seen = new Map<string, string>();
    for (const s of SHORTCUTS) {
      for (const b of s.keys) {
        expect(seen.get(b), `${b} is bound to ${seen.get(b)} and ${s.action}`).toBeUndefined();
        seen.set(b, s.action);
      }
    }
  });
});

describe("viewport", () => {
  it("maps between world and screen and zooms about a point", () => {
    const v = new Viewport();
    v.resize(800, 600);
    v.set(2, 100, 50);
    expect(v.toScreen({ x: 10, y: 10 })).toEqual({ x: 120, y: 70 });
    expect(v.toWorld({ x: 120, y: 70 })).toEqual({ x: 10, y: 10 });
    v.zoomAt(4, { x: 120, y: 70 });
    expect(v.toScreen({ x: 10, y: 10 })).toEqual({ x: 120, y: 70 });
    v.fit({ x: 0, y: 0, width: 1000, height: 1000 }, 50);
    expect(v.scale).toBeCloseTo(0.5);
    v.zoomStep(1);
    expect(v.scale).toBe(0.75);
    v.actualSize();
    expect(v.scale).toBe(1);
  });
});

describe("anchors and presence", () => {
  it("registers anchors with rects, and detects duplicates", () => {
    const a = new AnchorRegistry();
    const off = a.register("toolbar.tool.select", "button", "Move", () => ({ x: 1, y: 2, width: 3, height: 4 }));
    expect(a.rect("toolbar.tool.select")).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(a.list("toolbar")).toEqual([{ id: "toolbar.tool.select", kind: "button", label: "Move" }]);
    const second = a.register("toolbar.tool.select", "button", "Move", () => null);
    expect(a.duplicates.has("toolbar.tool.select")).toBe(true);
    off(); // a stale unregister does not remove the newer registration
    expect(a.has("toolbar.tool.select")).toBe(true);
    second();
    expect(a.has("toolbar.tool.select")).toBe(false);
    expect(() => a.register("Bad Id", "button", "", () => null)).toThrow();
  });

  it("keeps presence as plain JSON and reports changed keys", () => {
    const p = new LocalPresence("page");
    const seen: string[][] = [];
    p.subscribe((_s, changed) => seen.push([...changed]));
    p.setSelection(["a", "b", "a"]);
    p.setSelection(["a", "b"]);
    p.setHover("c");
    expect(seen).toEqual([["selection"], ["hover"]]);
    expect(JSON.parse(JSON.stringify(p))).toEqual({ page: "page", selection: ["a", "b"], hover: "c", text: null, cursor: null });
  });
});
