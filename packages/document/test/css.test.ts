import { describe, expect, it } from "vitest";
import { cssDeclarations, type Command } from "../src";
import { makeDoc } from "./helpers";

function doc(commands: (page: string) => Command[]) {
  const d = makeDoc(8);
  d.doc.apply(commands(d.page), d.user);
  return (id: string) => cssDeclarations(d.doc, id);
}

describe("CSS mapping", () => {
  it("places absolutely positioned children by their constraints", () => {
    const css = doc((page) => [
      { type: "createNode", node: { id: "f", type: "frame", props: { width: 400, height: 300 } }, parent: page },
      { type: "createNode", node: { id: "a", type: "rectangle", props: { x: 10, y: 20, width: 100, height: 50 } }, parent: "f" },
      { type: "createNode", node: { id: "b", type: "rectangle", props: { x: 290, y: 230, width: 100, height: 50, constraints: { horizontal: "end", vertical: "end" } } }, parent: "f" },
      { type: "createNode", node: { id: "c", type: "rectangle", props: { x: 10, y: 0, width: 380, height: 50, constraints: { horizontal: "start-end", vertical: "center" } } }, parent: "f" },
      { type: "createNode", node: { id: "d", type: "rectangle", props: { x: 100, y: 30, width: 200, height: 60, constraints: { horizontal: "scale", vertical: "scale" } } }, parent: "f" },
      { type: "createNode", node: { id: "top", type: "frame", props: { x: -5, y: 7, width: 10, height: 10 } }, parent: page },
    ]);
    expect(css("a")).toMatchObject({ position: "absolute", left: "10px", top: "20px", width: "100px", height: "50px" });
    expect(css("b")).toMatchObject({ right: "10px", bottom: "20px" });
    expect(css("b").left).toBeUndefined();
    expect(css("c")).toMatchObject({ left: "10px", right: "10px", width: "auto", top: "calc(50% - 150px)" });
    expect(css("d")).toMatchObject({ left: "25%", width: "50%", top: "10%", height: "20%" });
    expect(css("top")).toMatchObject({ position: "absolute", left: "-5px", top: "7px", overflow: "hidden" });
  });

  it("maps fixed, hug and fill sizing to flex, grid and block parents", () => {
    const css = doc((page) => [
      { type: "createNode", node: { id: "row", type: "frame", props: { display: "flex", flexDirection: "row", rowGap: 8, columnGap: 8, alignItems: "center", padding: { top: 8, right: 16, bottom: 8, left: 16 } } }, parent: page },
      { type: "createNode", node: { id: "fixed", type: "rectangle", props: { width: 40, height: 40 } }, parent: "row" },
      { type: "createNode", node: { id: "fill", type: "rectangle", props: { widthMode: "fill", heightMode: "fill" } }, parent: "row" },
      { type: "createNode", node: { id: "hug", type: "frame", props: { widthMode: "hug", heightMode: "hug", flexShrink: 2 } }, parent: "row" },
      { type: "createNode", node: { id: "col", type: "frame", props: { display: "flex", flexDirection: "column" } }, parent: page },
      { type: "createNode", node: { id: "colFill", type: "rectangle", props: { widthMode: "fill", heightMode: "fill" } }, parent: "col" },
      { type: "createNode", node: { id: "grid", type: "frame", props: { display: "grid", gridTemplateColumns: [{ type: "repeat", count: "auto-fill", tracks: [{ type: "minmax", min: { type: "px", value: 120 }, max: { type: "fr", value: 1 } }] }], gridTemplateAreas: ["a  a", "b c"] } }, parent: page },
      { type: "createNode", node: { id: "cell", type: "rectangle", props: { widthMode: "fill", gridColumn: { start: { span: 2 }, end: "auto" }, gridRow: { start: 1, end: -1 } } }, parent: "grid" },
      { type: "createNode", node: { id: "abs", type: "rectangle", props: { position: "absolute", widthMode: "fill" } }, parent: "row" },
    ]);
    expect(css("row")).toMatchObject({ display: "flex", "flex-direction": "row", "flex-wrap": "nowrap", gap: "8px", "align-items": "center", padding: "8px 16px", "box-sizing": "border-box" });
    expect(css("fixed")).toMatchObject({ position: "relative", width: "40px", "flex-shrink": "0", height: "40px" });
    expect(css("fill")).toMatchObject({ flex: "1 1 0px", "align-self": "stretch" });
    expect(css("hug")).toMatchObject({ width: "fit-content", height: "fit-content", "flex-shrink": "2" });
    expect(css("colFill")).toMatchObject({ "align-self": "stretch", flex: "1 1 0px" });
    expect(css("grid")).toMatchObject({ display: "grid", "grid-template-columns": "repeat(auto-fill, minmax(120px, 1fr))", "grid-template-areas": '"a a" "b c"' });
    expect(css("cell")).toMatchObject({ "justify-self": "stretch", "grid-column": "span 2 / auto", "grid-row": "1 / -1" });
    // Taken out of flow by position: absolute, fill means 100% of the containing block.
    expect(css("abs")).toMatchObject({ position: "absolute", width: "100%" });
  });

  it("maps the box model, corners, overflow, transforms and compositing", () => {
    const css = doc((page) => [
      {
        type: "createNode",
        node: {
          id: "f",
          type: "frame",
          props: {
            rotation: 15,
            flipX: true,
            cornerRadius: { topLeft: 4, topRight: 4, bottomRight: 0, bottomLeft: 0 },
            overflowX: "scroll",
            overflowY: "hidden",
            strokesInLayout: true,
            strokeWeight: { top: 1, right: 2, bottom: 1, left: 2 },
            opacity: 0.5,
            blendMode: "multiply",
            isolation: "isolate",
            minWidth: 50,
            aspectRatio: 1.5,
            margin: { top: "auto", right: 0, bottom: "auto", left: 0 },
            boxSizing: "content-box",
            visible: false,
          },
        },
        parent: page,
      },
    ]);
    expect(css("f")).toMatchObject({
      transform: "rotate(15deg) scale(-1, 1)",
      "border-radius": "4px 4px 0px 0px",
      overflow: "scroll hidden",
      "border-style": "solid",
      "border-width": "1px 2px",
      opacity: "0.5",
      "mix-blend-mode": "multiply",
      isolation: "isolate",
      "min-width": "50px",
      "aspect-ratio": "1.5",
      margin: "auto 0px",
      "box-sizing": "content-box",
      display: "none",
    });
  });
});
