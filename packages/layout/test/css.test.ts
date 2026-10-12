import { describe, expect, it } from "vitest";
import { CssError, parseDeclarations, parseGridLine, parseLP, parseStyle, parseTrackList } from "../src";

describe("CSS declaration parser", () => {
  it("parses lengths, percentages and calc()", () => {
    expect(parseLP("12px")).toBe(12);
    expect(parseLP("0")).toBe(0);
    expect(parseLP("50%")).toEqual({ pct: 50, px: 0 });
    expect(parseLP("calc(50% - 10px)")).toEqual({ pct: 50, px: -10 });
    expect(parseLP("calc(100% / 3 + 2 * 4px)")).toEqual({ pct: 100 / 3, px: 8 });
    expect(parseLP("calc(10px + 5px)")).toBe(15);
    expect(() => parseLP("12")).toThrow(CssError);
    expect(() => parseLP("1em")).toThrow(CssError);
  });

  it("expands box shorthands", () => {
    const s = parseStyle("margin: 1px auto 3px; padding: 4px 5px; border: 2px solid red; inset: 0 10%");
    expect(s.margin).toEqual({ top: 1, right: "auto", bottom: 3, left: "auto" });
    expect(s.padding).toEqual({ top: 4, right: 5, bottom: 4, left: 5 });
    expect(s.border).toEqual({ top: 2, right: 2, bottom: 2, left: 2 });
    expect(s.inset).toEqual({ top: 0, right: { pct: 10, px: 0 }, bottom: 0, left: { pct: 10, px: 0 } });
    expect(parseStyle("border: none").border.top).toBe(0);
    expect(parseStyle("border-left: 3px solid; margin-top: -4px").border.left).toBe(3);
  });

  it("parses the flex shorthand like browsers", () => {
    expect(parseDeclarations("flex: 1")).toEqual({ flexGrow: 1, flexShrink: 1, flexBasis: { pct: 0, px: 0 } });
    expect(parseDeclarations("flex: none")).toEqual({ flexGrow: 0, flexShrink: 0, flexBasis: "auto" });
    expect(parseDeclarations("flex: auto")).toEqual({ flexGrow: 1, flexShrink: 1, flexBasis: "auto" });
    expect(parseDeclarations("flex: 2 3 10px")).toEqual({ flexGrow: 2, flexShrink: 3, flexBasis: 10 });
    expect(parseDeclarations("flex: 30%")).toEqual({ flexGrow: 1, flexShrink: 1, flexBasis: { pct: 30, px: 0 } });
    expect(parseDeclarations("flex: 1 1 0px")).toEqual({ flexGrow: 1, flexShrink: 1, flexBasis: 0 });
  });

  it("parses alignment with overflow positions and place-* shorthands", () => {
    const s = parseStyle("place-items: safe center end; justify-content: space-evenly; align-self: last baseline");
    expect(s.alignItems).toBe("safe center");
    expect(s.justifyItems).toBe("end");
    expect(s.justifyContent).toBe("space-evenly");
    expect(s.alignSelf).toBe("last baseline");
    expect(() => parseStyle("justify-content: middle")).toThrow(CssError);
  });

  it("parses grid track lists with names, repeat(), minmax() and fit-content()", () => {
    expect(parseTrackList("[a] 100px [b c] 1fr minmax(20px, auto) fit-content(50%)")).toEqual([
      { names: ["a"] },
      100,
      { names: ["b", "c"] },
      { fr: 1 },
      { min: 20, max: "auto" },
      { fitContent: { pct: 50, px: 0 } },
    ]);
    expect(parseTrackList("repeat(auto-fill, [col] minmax(100px, 1fr))")).toEqual([{ repeat: "auto-fill", entries: [{ names: ["col"] }, { min: 100, max: { fr: 1 } }] }]);
    expect(parseTrackList("repeat(3, 10px 20px)")).toEqual([{ repeat: 3, entries: [10, 20] }]);
    expect(() => parseTrackList("minmax(1fr, 10px)")).toThrow(CssError);
  });

  it("parses grid placements", () => {
    expect(parseGridLine("auto")).toBe("auto");
    expect(parseGridLine("-1")).toEqual({ line: -1 });
    expect(parseGridLine("span 2")).toEqual({ span: 2 });
    expect(parseGridLine("span foo")).toEqual({ span: 1, name: "foo" });
    expect(parseGridLine("2 foo")).toEqual({ line: 2, name: "foo" });
    expect(parseGridLine("header")).toEqual({ name: "header" });
    expect(() => parseGridLine("0")).toThrow(CssError);
    const s = parseStyle("grid-area: header; grid-column: 2 / span 3");
    expect([s.gridRowStart, s.gridRowEnd]).toEqual([{ name: "header" }, { name: "header" }]);
    expect([s.gridColumnStart, s.gridColumnEnd]).toEqual([{ line: 2 }, { span: 3 }]);
  });

  it("parses grid-template-areas and rejects ragged rows", () => {
    expect(parseStyle(`grid-template-areas: "a a ." "b ... c"`).gridTemplateAreas).toEqual([["a", "a", "."], ["b", ".", "c"]]);
    expect(() => parseStyle(`grid-template-areas: "a a" "b"`)).toThrow(CssError);
  });

  it("ignores properties that do not affect layout and reports bad values with the property name", () => {
    expect(parseDeclarations("color: red; background: url(x.png)")).toEqual({});
    expect(() => parseStyle("width: -5px")).toThrow(/width: -5px/);
  });
});
