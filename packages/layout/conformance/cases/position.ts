import { canvas, div, text, words, type CaseNode, type LayoutCase } from "../case";

/**
 * Positioned layout (CSS Positioned Layout 3, CSS 2 §10.3.7 / §10.6.4),
 * box model and sizing (CSS Box Model 3, CSS Sizing 3) and block layout.
 */

const CB = "position:relative;width:200px;height:150px;";
const abs = (extra: string): CaseNode => div(`position:absolute;${extra}`);
const t = (n: number, w: number, h: number, style = ""): CaseNode => text(style, words(n, w, h));

const position: [string, CaseNode][] = [
  // Insets and sizes.
  ["abs-left-top", div(CB, abs("left:10px;top:20px;width:50px;height:30px"))],
  ["abs-right-bottom", div(CB, abs("right:10px;bottom:20px;width:50px;height:30px"))],
  ["abs-stretch-both-axes", div(CB, abs("left:10px;right:20px;top:5px;bottom:15px"))],
  ["abs-percent-insets", div(CB, abs("left:10%;top:20%;width:50%;height:25%"))],
  ["abs-calc-center", div(CB, abs("left:calc(50% - 25px);top:calc(50% - 10px);width:50px;height:20px"))],
  ["abs-padding-box-cb", div(`${CB}padding:10px 20px;border:5px solid`, abs("left:0;top:0;right:0;bottom:0"))],
  ["abs-shrink-to-fit-text", div(CB, t(5, 30, 10, "position:absolute;left:10px;top:0"))],
  ["abs-shrink-to-fit-narrow", div(CB, t(5, 30, 10, "position:absolute;left:150px;top:0"))],
  ["abs-shrink-to-fit-right", div(CB, t(3, 30, 10, "position:absolute;right:10px;top:0"))],
  ["abs-min-max", div(CB, abs("left:0;right:0;max-width:80px;top:0;bottom:0;min-height:200px"))],
  ["abs-auto-margins-center", div(CB, abs("left:0;right:0;top:0;bottom:0;width:50px;height:30px;margin:auto"))],
  ["abs-auto-margin-left", div(CB, abs("left:0;right:0;width:50px;height:30px;margin-left:auto"))],
  ["abs-auto-margins-overflow", div(CB, abs("left:10px;right:10px;width:250px;height:20px;margin:0 auto"))],
  ["abs-overconstrained", div(CB, abs("left:10px;right:10px;width:300px;height:20px"))],
  ["abs-overconstrained-vertical", div(CB, abs("top:10px;bottom:10px;height:200px;width:20px"))],
  ["abs-margins", div(CB, abs("left:10px;top:10px;width:50px;height:30px;margin:5px 6px 7px 8px"))],
  ["abs-box-sizing", div(CB, abs("left:10px;top:10px;width:50px;height:30px;padding:5px;border:3px solid;box-sizing:border-box"))],
  ["abs-aspect-ratio-width", div(CB, abs("left:0;top:0;width:80px;aspect-ratio:2"))],
  ["abs-aspect-ratio-height", div(CB, abs("left:0;top:0;height:40px;aspect-ratio:2"))],
  ["abs-aspect-ratio-stretch", div(CB, abs("left:10px;right:10px;top:0;aspect-ratio:4"))],
  ["abs-replaced", div(CB, canvas("position:absolute;left:10px;top:10px", 60, 30), canvas("position:absolute;right:0;bottom:0;height:20px", 60, 30))],
  ["abs-nested-cb", div(CB, div("margin:10px;padding:5px", div("position:relative;left:3px;top:4px;width:100px;height:60px", abs("right:0;bottom:0;width:20px;height:20px"))))],
  ["abs-grandparent-cb-static", div(`${CB}padding:5px`, div("margin:7px;padding:3px", div("height:20px"), abs("width:20px;height:20px")))],
  ["abs-static-after-margins", div(CB, div("height:20px;margin-bottom:15px"), abs("width:20px;height:20px"), div("height:10px;margin-top:5px"))],
  ["abs-no-cb-viewport", div("width:300px;height:100px", abs("right:0;bottom:0;width:20px;height:20px"))],
  ["fixed-uses-viewport", div(`${CB}margin:20px`, div("position:fixed;left:5px;top:5px;width:20px;height:20px"))],
  // Self-alignment of absolutely positioned boxes (Positioned Layout 3 §4).
  ["abs-justify-end", div(CB, abs("left:10px;right:10px;width:50px;height:20px;justify-self:end"))],
  ["abs-justify-center-auto-width", div(CB, t(2, 30, 10, "position:absolute;left:10px;right:10px;top:0;justify-self:center"))],
  ["abs-justify-stretch", div(CB, abs("left:10px;right:20px;height:20px;justify-self:stretch"))],
  ["abs-align-end", div(CB, abs("top:10px;bottom:10px;height:50px;width:20px;align-self:end"))],
  ["abs-align-center-overflow", div(CB, abs("top:10px;bottom:10px;height:145px;width:20px;align-self:center"))],
  ["abs-align-start-overflow-shift", div(CB, abs("top:10px;bottom:10px;height:145px;width:20px;align-self:start"))],
  ["abs-align-start-overflow-big", div(CB, abs("top:10px;bottom:10px;height:200px;width:20px;align-self:start"))],
  ["abs-align-end-overflow", div(CB, abs("top:10px;bottom:10px;height:145px;width:20px;align-self:end"))],
  ["abs-justify-start-overflow-shift", div(CB, abs("left:30px;right:10px;width:195px;height:20px;justify-self:start"))],
  ["abs-justify-unsafe-end-overflow", div(CB, abs("left:30px;right:10px;width:195px;height:20px;justify-self:unsafe end"))],
  ["abs-one-inset-ignores-alignment", div(CB, abs("left:10px;width:50px;height:20px;justify-self:end"), abs("right:10px;width:50px;height:20px;justify-self:start;top:30px"))],
  ["abs-static-self-alignment", div(CB, div("height:30px"), abs("width:50px;height:20px;justify-self:end;align-self:end"))],
  // Relative positioning.
  ["relative-offsets", div("width:300px", div("position:relative;left:10px;top:5px;height:20px"), div("position:relative;right:10px;bottom:5px;height:20px"), div("height:20px"))],
  ["relative-percent", div("width:300px;height:200px", div("position:relative;left:10%;top:10%;height:20px"))],
  ["relative-percent-indefinite-height", div("width:300px", div("position:relative;top:10%;left:5%;height:20px"))],
  ["relative-left-wins", div("width:300px", div("position:relative;left:10px;right:50px;height:20px"))],
  ["relative-in-flex", div("display:flex;width:300px", div("position:relative;left:-5px;top:3px;width:50px;height:20px"), div("width:50px;height:20px"))],
  // Grid implicit tracks on an axis without explicit tracks.
  ["grid-empty-implicit-row-before", div("display:grid;row-gap:10px;width:100px", div("grid-row:-3;height:20px"))],
  ["grid-empty-implicit-row-explicit", div("display:grid;row-gap:10px;width:100px;grid-template-rows:30px", div("grid-row:-4;height:20px"))],
  ["grid-empty-implicit-row-after", div("display:grid;row-gap:10px;width:100px", div("grid-row:3;height:20px"))],
  ["grid-empty-implicit-col-after", div("display:grid;column-gap:10px;grid-auto-columns:15px", div("grid-column:3;height:20px"))],
];

const box: [string, CaseNode][] = [
  ["content-box-sizes", div("width:100px;height:50px;padding:10px 5px;border:3px solid;margin:7px")],
  ["border-box-sizes", div("box-sizing:border-box;width:100px;height:50px;padding:10px 5px;border:3px solid;margin:7px")],
  ["border-box-smaller-than-padding", div("box-sizing:border-box;width:10px;height:10px;padding:10px;border:3px solid")],
  ["percent-width-height", div("width:400px;height:300px", div("width:50%;height:25%"), div("width:calc(100% - 50px);height:10%"))],
  ["percent-height-indefinite", div("width:400px", div("height:50%;width:20px"), div("height:20px"))],
  ["percent-padding-margin", div("width:400px", div("padding:5% 10%;margin:2.5% 0;height:20px"))],
  ["min-max-width", div("width:400px", div("width:500px;max-width:300px;height:10px"), div("width:50px;min-width:100px;height:10px"), div("max-width:200px;min-width:250px;height:10px"))],
  ["min-max-height", div("width:400px", div("height:100px;max-height:30px"), div("height:10px;min-height:40px"), t(5, 100, 20, "max-height:30px"))],
  ["min-max-border-box", div("width:400px", div("box-sizing:border-box;width:500px;max-width:100px;padding:20px;height:10px"))],
  ["width-keywords", div("width:400px", t(6, 30, 10, "width:min-content"), t(6, 30, 10, "width:max-content"), t(6, 30, 10, "width:fit-content"), t(20, 30, 10, "width:fit-content"))],
  ["min-max-width-keywords", div("width:400px", t(6, 30, 10, "width:10px;min-width:min-content"), t(6, 30, 10, "max-width:max-content"), t(6, 30, 10, "width:500px;max-width:fit-content"))],
  ["auto-margins-center", div("width:400px", div("width:100px;height:10px;margin:0 auto"), div("width:100px;height:10px;margin-left:auto"), div("width:100px;height:10px;margin-right:auto"))],
  ["auto-margins-overflow", div("width:100px", div("width:200px;height:10px;margin:0 auto"))],
  ["negative-margins", div("width:400px;padding:20px", div("height:20px;margin:-10px -15px"), div("height:20px"))],
  ["aspect-ratio-width", div("width:400px", div("width:200px;aspect-ratio:2"), div("aspect-ratio:8"))],
  ["aspect-ratio-height", div("width:400px", div("height:50px;aspect-ratio:3;width:auto"))],
  ["aspect-ratio-border-box", div("width:400px", div("width:200px;aspect-ratio:2;box-sizing:border-box;padding:10px"), div("width:200px;aspect-ratio:2;padding:10px"))],
  ["aspect-ratio-auto-ratio", div("width:400px", div("width:200px;aspect-ratio:auto 2;padding:10px"))],
  ["aspect-ratio-min-content-floor", div("width:400px", t(10, 30, 20, "width:60px;aspect-ratio:4"))],
  ["aspect-ratio-overflow-hidden", div("width:400px", t(10, 30, 20, "width:60px;aspect-ratio:4;overflow:hidden"))],
  ["aspect-ratio-max-height", div("width:400px", div("width:200px;aspect-ratio:1;max-height:50px"))],
  ["display-none", div("width:400px", div("height:20px"), div("display:none;height:50px", div("height:10px")), div("height:20px"))],
  ["replaced-natural", div("width:400px", canvas("", 120, 60), canvas("width:60px", 120, 60), canvas("height:30px", 120, 60), canvas("width:50px;height:50px", 120, 60))],
  ["replaced-max-width", div("width:400px", canvas("max-width:100%", 600, 100), canvas("max-width:50px", 120, 60))],
  ["overflow-hidden-box", div("width:200px;height:50px;overflow:hidden", div("height:200px"))],
];

const block: [string, CaseNode][] = [
  ["stack", div("width:300px", div("height:20px"), div("height:30px"), div("height:10px"))],
  ["sibling-margins-collapse", div("width:300px", div("height:20px;margin-bottom:20px"), div("height:20px;margin-top:10px"), div("height:20px;margin-top:30px"))],
  ["negative-margins-collapse", div("width:300px", div("height:20px;margin-bottom:20px"), div("height:20px;margin-top:-5px"), div("height:20px;margin-bottom:-10px"), div("height:20px;margin-top:-5px"))],
  ["parent-contains-margins", div("width:300px;margin-top:5px", div("height:20px;margin-top:15px;margin-bottom:25px"))],
  ["auto-height-with-padding", div("width:300px;padding:10px;border:2px solid", div("height:20px"), t(5, 80, 15))],
  ["text-wraps-to-width", div("width:150px", t(7, 40, 12), t(3, 30, 20))],
  ["nested-widths", div("width:400px;padding:0 20px", div("margin:0 30px;padding:5px", div("height:10px")))],
  ["percent-chain", div("width:400px;height:200px", div("height:50%", div("height:50%;width:50%")))],
  ["min-height-container", div("width:300px;min-height:100px", div("height:20px"))],
  ["max-height-container", div("width:300px;max-height:30px", div("height:20px"), div("height:20px"))],
  ["flex-and-grid-in-block", div("width:300px", div("display:flex;gap:5px", div("flex:1;height:20px"), div("flex:2;height:20px")), div("display:grid;grid-template-columns:1fr 1fr;margin-top:10px", div("height:15px"), div("height:25px")))],
  ["intrinsic-block", div("display:flex;width:400px;align-items:flex-start", div("", t(3, 40, 10), div("width:150px;height:10px")))],
];

export const positionCases: LayoutCase[] = [
  ...position.map(([name, root]): LayoutCase => ({ name: `position/${name}`, area: "position", kind: "hand", root })),
  ...box.map(([name, root]): LayoutCase => ({ name: `box/${name}`, area: "box", kind: "hand", root })),
  ...block.map(([name, root]): LayoutCase => ({ name: `block/${name}`, area: "block", kind: "hand", root })),
];
