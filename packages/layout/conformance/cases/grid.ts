import { canvas, div, text, words, type CaseNode, type LayoutCase } from "../case";

/** Hand-written grid cases (CSS Grid Layout 1). Names say what is tested. */

const G = "display:grid;";
const cell = (extra = ""): CaseNode => div(extra);
const cells = (n: number, extra = ""): CaseNode[] => Array.from({ length: n }, () => cell(extra));
const t = (n: number, w: number, h: number, style = ""): CaseNode => text(style, words(n, w, h));

const cases: [string, CaseNode][] = [
  // ── Explicit tracks ──
  ["px-tracks", div(`${G}grid-template-columns:100px 50px 80px;grid-template-rows:40px 60px`, ...cells(6))],
  ["percent-tracks", div(`${G}width:400px;height:200px;grid-template-columns:25% 50%;grid-template-rows:30% 20%`, ...cells(4))],
  ["percent-rows-indefinite", div(`${G}width:400px;grid-template-columns:1fr;grid-template-rows:50% 20px`, t(2, 30, 15), cell())],
  ["fr-tracks", div(`${G}width:400px;height:300px;grid-template-columns:1fr 2fr 1fr;grid-template-rows:1fr 2fr`, ...cells(6))],
  ["fr-with-fixed", div(`${G}width:400px;grid-template-columns:100px 1fr 2fr`, ...cells(3, "height:20px"))],
  ["fr-sum-below-one", div(`${G}width:400px;grid-template-columns:0.25fr 0.25fr`, ...cells(2, "height:20px"))],
  ["fr-content-min", div(`${G}width:200px;grid-template-columns:1fr 1fr`, t(1, 150, 10), t(1, 20, 10))],
  ["minmax-zero-fr", div(`${G}width:200px;grid-template-columns:minmax(0,1fr) minmax(0,1fr)`, t(1, 150, 10), t(1, 20, 10))],
  ["auto-tracks-text", div(`${G}width:400px;grid-template-columns:auto auto auto`, t(3, 30, 10), t(1, 50, 12), t(5, 10, 8))],
  ["auto-tracks-overflow", div(`${G}width:100px;grid-template-columns:auto auto`, t(3, 40, 10), t(3, 40, 10))],
  ["min-content-track", div(`${G}width:400px;grid-template-columns:min-content 1fr`, t(3, 30, 10), cell())],
  ["max-content-track", div(`${G}width:400px;grid-template-columns:max-content 1fr`, t(3, 30, 10), cell())],
  ["minmax-px-px", div(`${G}width:400px;grid-template-columns:minmax(50px,100px) minmax(80px,200px) 1fr`, ...cells(3, "height:20px"))],
  ["minmax-px-auto", div(`${G}width:400px;grid-template-columns:minmax(100px,auto) minmax(50px,auto)`, t(2, 30, 10), cell())],
  ["minmax-auto-max-content", div(`${G}width:400px;grid-template-columns:minmax(auto,max-content) 1fr`, t(4, 25, 10), cell())],
  ["minmax-min-content-px", div(`${G}width:400px;grid-template-columns:minmax(min-content,200px) 1fr`, t(4, 25, 10), cell())],
  ["fit-content-small", div(`${G}width:400px;grid-template-columns:fit-content(50px) 1fr`, t(4, 25, 10), cell())],
  ["fit-content-large", div(`${G}width:400px;grid-template-columns:fit-content(300px) 1fr`, t(4, 25, 10), cell())],
  ["fit-content-percent", div(`${G}width:400px;grid-template-columns:fit-content(10%) auto`, t(4, 25, 10), cell())],
  ["repeat-count", div(`${G}width:400px;grid-template-columns:repeat(3, 50px 1fr)`, ...cells(6, "height:10px"))],
  ["repeat-auto-fill", div(`${G}width:400px;grid-template-columns:repeat(auto-fill, 90px);gap:10px`, ...cells(5, "height:10px"))],
  ["repeat-auto-fill-minmax", div(`${G}width:400px;grid-template-columns:repeat(auto-fill, minmax(90px, 1fr));gap:10px`, ...cells(3, "height:10px"))],
  ["repeat-auto-fit-collapses", div(`${G}width:400px;grid-template-columns:repeat(auto-fit, minmax(90px, 1fr));gap:10px`, ...cells(2, "height:10px"))],
  ["repeat-auto-fill-with-fixed", div(`${G}width:400px;grid-template-columns:50px repeat(auto-fill, 60px) 70px`, ...cells(7, "height:10px"))],
  ["repeat-auto-fill-max-width", div(`${G}max-width:250px;grid-template-columns:repeat(auto-fill, 60px)`, ...cells(7, "height:10px"))],
  ["repeat-auto-fill-rows", div(`${G}height:200px;width:100px;grid-template-rows:repeat(auto-fill, 45px);grid-auto-flow:column`, ...cells(6))],
  ["repeat-auto-fit-justify-center", div(`${G}width:400px;grid-template-columns:repeat(auto-fit, 60px);justify-content:center`, ...cells(2, "height:10px"))],

  // ── Gaps ──
  ["gaps", div(`${G}width:400px;grid-template-columns:repeat(3,1fr);grid-template-rows:30px 30px;gap:10px 20px`, ...cells(6))],
  ["gaps-percent", div(`${G}width:400px;height:200px;grid-template-columns:repeat(3,1fr);grid-template-rows:repeat(2,1fr);gap:5% 10%`, ...cells(6))],
  ["gaps-auto-tracks", div(`${G}width:400px;grid-template-columns:auto auto;column-gap:30px`, t(2, 30, 10), t(2, 40, 10))],

  // ── Implicit grid ──
  ["implicit-rows", div(`${G}width:300px;grid-template-columns:100px 100px`, ...cells(5, "height:20px"))],
  ["implicit-auto-rows", div(`${G}width:300px;grid-template-columns:100px 100px;grid-auto-rows:40px`, ...cells(5))],
  ["implicit-auto-rows-pattern", div(`${G}width:300px;grid-template-columns:100px;grid-auto-rows:10px 20px 30px`, ...cells(5))],
  ["implicit-auto-columns", div(`${G}width:300px;grid-template-rows:20px;grid-auto-flow:column;grid-auto-columns:30px 50px`, ...cells(4))],
  ["implicit-before-explicit", div(`${G}width:300px;grid-template-columns:100px 100px;grid-auto-columns:40px`, cell("grid-column:-4;height:20px"), cell("height:20px"))],
  ["implicit-negative-rows", div(`${G}width:300px;grid-template-rows:30px;grid-auto-rows:10px 20px`, cell("grid-row:-3"), cell("grid-row:1"), cell("grid-row:-4"))],
  ["implicit-beyond-end", div(`${G}width:300px;grid-template-columns:100px;grid-auto-columns:50px`, cell("grid-column:4;height:10px"), cell("height:10px"))],

  // ── Line-based placement ──
  ["placement-lines", div(`${G}width:300px;grid-template-columns:repeat(3,100px);grid-template-rows:repeat(3,30px)`, cell("grid-column:2/4;grid-row:1"), cell("grid-column:1;grid-row:2/4"), cell("grid-area:3/3"))],
  ["placement-negative", div(`${G}width:300px;grid-template-columns:repeat(3,100px);grid-template-rows:repeat(2,30px)`, cell("grid-column:-2/-1"), cell("grid-column:1/-1;grid-row:-2"))],
  ["placement-spans", div(`${G}width:300px;grid-template-columns:repeat(3,100px);grid-auto-rows:30px`, cell("grid-column:span 2"), cell("grid-row:span 2"), cell("grid-column:2/span 2"), cell("grid-column:span 2/3"))],
  ["placement-swap", div(`${G}width:300px;grid-template-columns:repeat(3,100px);grid-auto-rows:30px`, cell("grid-column:3/1"))],
  ["placement-same-line", div(`${G}width:300px;grid-template-columns:repeat(3,100px);grid-auto-rows:30px`, cell("grid-column:2/2"))],
  ["placement-two-spans", div(`${G}width:300px;grid-template-columns:repeat(3,100px);grid-auto-rows:30px`, cell("grid-column:span 2/span 3"))],
  ["placement-named-lines", div(`${G}width:300px;grid-template-columns:[a] 50px [b] 60px [c a] 70px [d];grid-auto-rows:20px`, cell("grid-column:b/d"), cell("grid-column:a 2/span 1"), cell("grid-column:c"))],
  ["placement-named-span", div(`${G}width:300px;grid-template-columns:[x] 50px 50px [x] 50px [x] 50px;grid-auto-rows:20px`, cell("grid-column:1/span x"), cell("grid-column:span x 2/-1"))],
  ["placement-missing-name", div(`${G}width:300px;grid-template-columns:50px 50px;grid-auto-columns:30px;grid-auto-rows:20px`, cell("grid-column:nope"), cell("grid-column:1/nope 2"))],
  ["placement-repeat-names", div(`${G}width:300px;grid-template-columns:repeat(3,[col] 40px);grid-auto-rows:20px`, cell("grid-column:col 2/col 3"), cell("grid-column:col -1"))],
  ["areas-basic", div(`${G}width:300px;grid-template-columns:100px 1fr;grid-template-rows:40px 1fr 30px;height:200px;grid-template-areas:"head head" "side main" "foot foot"`, cell("grid-area:head"), cell("grid-area:side"), cell("grid-area:main"), cell("grid-area:foot"))],
  ["areas-implicit-names", div(`${G}width:300px;grid-template-columns:repeat(3,1fr);grid-auto-rows:20px;grid-template-areas:". a a" ". a a"`, cell("grid-column:a-start/a-end;grid-row:a"), cell("grid-column:a-start"), cell("grid-row:a-end"))],
  ["areas-extend-explicit", div(`${G}width:300px;grid-template-columns:50px;grid-auto-columns:70px;grid-auto-rows:20px;grid-template-areas:"x y z"`, cell("grid-area:z"), cell("grid-area:x"), cell())],

  // ── Auto-placement ──
  ["auto-flow-row", div(`${G}width:300px;grid-template-columns:repeat(3,1fr);grid-auto-rows:20px`, ...cells(7))],
  ["auto-flow-column", div(`${G}height:60px;width:300px;grid-template-rows:repeat(3,20px);grid-auto-flow:column;grid-auto-columns:40px`, ...cells(7))],
  ["auto-flow-sparse-holes", div(`${G}width:300px;grid-template-columns:repeat(3,1fr);grid-auto-rows:20px`, cell(), cell("grid-column:span 3"), cell(), cell("grid-column:span 2"), cell("grid-column:span 2"), cell())],
  ["auto-flow-dense", div(`${G}width:300px;grid-template-columns:repeat(3,1fr);grid-auto-rows:20px;grid-auto-flow:row dense`, cell(), cell("grid-column:span 3"), cell(), cell("grid-column:span 2"), cell("grid-column:span 2"), cell())],
  ["auto-flow-column-dense", div(`${G}height:60px;grid-template-rows:repeat(3,20px);grid-auto-flow:column dense;grid-auto-columns:40px`, cell(), cell("grid-row:span 3"), cell(), cell("grid-row:span 2"), cell("grid-row:span 2"), cell())],
  ["auto-locked-rows", div(`${G}width:300px;grid-template-columns:repeat(4,1fr);grid-auto-rows:20px`, cell("grid-row:2"), cell("grid-row:2"), cell(), cell("grid-row:1;grid-column:span 2"), cell())],
  ["auto-locked-rows-dense", div(`${G}width:300px;grid-template-columns:repeat(4,1fr);grid-auto-rows:20px;grid-auto-flow:dense`, cell("grid-row:2;grid-column:3"), cell("grid-row:2"), cell("grid-row:2"), cell())],
  ["auto-definite-column", div(`${G}width:300px;grid-template-columns:repeat(3,1fr);grid-auto-rows:20px`, cell(), cell(), cell("grid-column:1"), cell("grid-column:3"), cell("grid-column:2"))],
  ["auto-definite-column-dense", div(`${G}width:300px;grid-template-columns:repeat(3,1fr);grid-auto-rows:20px;grid-auto-flow:row dense`, cell(), cell(), cell("grid-column:3"), cell("grid-column:1"), cell())],
  ["auto-around-fixed", div(`${G}width:300px;grid-template-columns:repeat(3,1fr);grid-auto-rows:20px`, cell("grid-area:1/2"), cell(), cell(), cell("grid-area:2/1/4/3"), cell(), cell())],
  ["auto-span-wider-than-grid", div(`${G}width:300px;grid-template-columns:100px 100px;grid-auto-columns:30px;grid-auto-rows:20px`, cell("grid-column:span 4"), cell())],
  ["auto-order", div(`${G}width:300px;grid-template-columns:repeat(3,1fr);grid-auto-rows:20px`, cell("order:2"), cell(), cell("order:-1"), cell())],
  ["auto-display-none", div(`${G}width:300px;grid-template-columns:repeat(3,1fr);grid-auto-rows:20px`, cell(), cell("display:none"), cell())],

  // ── Track sizing with content ──
  ["sizing-auto-rows-content", div(`${G}width:300px;grid-template-columns:100px 100px`, t(5, 30, 10), t(2, 30, 15), t(1, 30, 30), cell())],
  ["sizing-spanning-auto", div(`${G}width:400px;grid-template-columns:auto auto auto`, t(1, 200, 10, "grid-column:span 2"), t(1, 30, 10), t(1, 40, 10), t(1, 50, 10))],
  ["sizing-spanning-two-groups", div(`${G}width:500px;grid-template-columns:auto auto auto`, t(1, 120, 10, "grid-column:1/3"), t(1, 300, 10, "grid-column:1/4"), t(1, 20, 10, "grid-column:2"))],
  ["sizing-spanning-fixed-and-auto", div(`${G}width:400px;grid-template-columns:50px auto 60px`, t(1, 250, 10, "grid-column:1/4"), t(1, 30, 10, "grid-column:2"))],
  ["sizing-spanning-min-content-tracks", div(`${G}width:400px;grid-template-columns:min-content max-content`, t(4, 30, 10, "grid-column:span 2"), t(1, 20, 10), t(1, 25, 10))],
  ["sizing-spanning-flexible", div(`${G}width:400px;grid-template-columns:1fr 2fr;grid-auto-rows:20px`, t(1, 360, 10, "grid-column:span 2"))],
  ["sizing-spanning-flexible-overflow", div(`${G}width:200px;grid-template-columns:1fr 3fr 50px`, t(1, 400, 10, "grid-column:span 2"), cell())],
  ["sizing-spanning-flex-and-auto", div(`${G}width:300px;grid-template-columns:auto 1fr`, t(1, 400, 10, "grid-column:span 2"), t(1, 30, 10))],
  ["sizing-flexible-spanning-together", div(`${G}width:200px;height:100px;grid-template-columns:100px 100px;grid-template-rows:50px 1fr 1fr`, cell("grid-area:1/1;height:50px"), cell("grid-area:2/1;height:4px"), cell("grid-area:3/1;height:26px"), cell("grid-area:2/2/4/3;height:37px;align-self:end"))],
  ["sizing-flexible-spanning-baseline", div(`${G}width:200px;height:100px;grid-template-columns:100px 100px;grid-template-rows:50px 1fr 1fr;align-items:baseline`, cell("grid-area:1/1;height:50px"), cell("grid-area:2/1;height:4px"), cell("grid-area:3/1;height:26px"), cell("grid-area:2/2/4/3;height:37px"))],
  ["sizing-flexible-spanning-baseline-text", div(`${G}width:200px;height:100px;grid-template-columns:100px 100px;grid-template-rows:50px 1fr 1fr;align-items:baseline`, cell("grid-area:1/1;height:50px"), cell("grid-area:2/1;height:30px"), cell("grid-area:3/1;height:26px"), t(1, 30, 12, "grid-area:2/2/4/3"))],
  ["sizing-auto-spanning-baseline", div(`${G}width:200px;grid-template-columns:100px 100px;grid-template-rows:auto auto;align-items:baseline`, cell("grid-area:1/1;height:30px"), cell("grid-area:2/1;height:4px"), t(1, 30, 12, "grid-area:1/2/3/3"))],
  ["sizing-auto-spanning-baseline-tall", div(`${G}width:200px;grid-template-columns:100px 40px;grid-template-rows:auto auto;align-items:baseline`, cell("grid-area:1/1;height:20px"), cell("grid-area:2/1;height:4px;align-self:start"), t(3, 30, 12, "grid-area:1/2/3/3"))],
  ["sizing-auto-spanning-start-tall", div(`${G}width:200px;grid-template-columns:100px 40px;grid-template-rows:auto auto`, cell("grid-area:1/1;height:20px"), cell("grid-area:2/1;height:4px"), t(3, 30, 12, "grid-area:1/2/3/3;align-self:start"))],
  ["sizing-fit-content-spanning", div(`${G}width:400px;grid-template-columns:fit-content(60px) fit-content(200px)`, t(1, 300, 10, "grid-column:span 2"))],
  ["sizing-rows-spanning", div(`${G}width:300px;grid-template-columns:100px 100px`, t(1, 50, 60, "grid-row:span 2"), t(1, 30, 10), t(1, 30, 15))],
  ["sizing-rows-fr-indefinite", div(`${G}width:300px;grid-template-columns:100px;grid-template-rows:1fr 2fr`, t(1, 30, 30), t(1, 30, 10))],
  ["sizing-rows-fr-min-height", div(`${G}width:300px;min-height:200px;grid-template-columns:100px;grid-template-rows:1fr 2fr`, t(1, 30, 30), t(1, 30, 10))],
  ["sizing-rows-fr-max-height", div(`${G}width:300px;max-height:30px;grid-template-columns:100px;grid-template-rows:1fr 2fr`, t(1, 30, 30), t(1, 30, 10))],
  ["sizing-rows-auto-min-height", div(`${G}width:300px;min-height:150px;grid-template-columns:100px`, t(1, 30, 30), t(1, 30, 10))],
  ["sizing-text-wraps-in-column", div(`${G}width:300px;grid-template-columns:70px 1fr`, t(5, 30, 10), t(3, 30, 10))],
  ["sizing-item-fixed-width", div(`${G}width:400px;grid-template-columns:auto auto`, cell("width:120px;height:10px"), t(3, 30, 10))],
  ["sizing-item-min-width", div(`${G}width:400px;grid-template-columns:auto 1fr`, t(2, 30, 10, "min-width:100px"), cell())],
  ["sizing-item-max-width", div(`${G}width:400px;grid-template-columns:auto 1fr`, t(5, 30, 10, "max-width:70px"), cell())],
  ["sizing-item-margins-padding", div(`${G}width:400px;grid-template-columns:auto auto`, t(2, 30, 10, "margin:5px 10px;padding:3px 4px;border:2px solid"), t(1, 30, 10))],
  ["sizing-auto-min-in-fixed-track", div(`${G}width:400px;grid-template-columns:50px 1fr`, t(1, 120, 10), cell())],
  ["sizing-overflow-hidden-item", div(`${G}width:200px;grid-template-columns:1fr 1fr`, t(1, 150, 10, "overflow:hidden"), t(1, 20, 10))],
  ["sizing-percent-item-width", div(`${G}width:400px;grid-template-columns:200px 1fr`, cell("width:50%;height:10px"), cell("width:25%;height:10px"))],
  ["sizing-percent-item-height", div(`${G}width:400px;grid-template-columns:100px;grid-template-rows:100px 60px`, cell("height:50%"), cell("height:25%;width:50px"))],

  // ── Alignment ──
  ...(["start", "end", "center", "space-between", "space-around", "space-evenly", "stretch", "left", "right"] as const).map(
    (v): [string, CaseNode] => [`justify-content-${v}`, div(`${G}width:400px;grid-template-columns:60px 80px;grid-auto-rows:20px;justify-content:${v}`, ...cells(4))],
  ),
  ...(["start", "end", "center", "space-between", "space-around", "space-evenly", "stretch"] as const).map(
    (v): [string, CaseNode] => [`align-content-${v}`, div(`${G}width:200px;height:200px;grid-template-columns:1fr;grid-template-rows:30px 40px;align-content:${v}`, ...cells(2))],
  ),
  ["justify-content-stretch-auto", div(`${G}width:400px;grid-template-columns:auto 100px auto;grid-auto-rows:20px`, cell(), cell(), cell())],
  ["justify-content-center-overflow", div(`${G}width:100px;grid-template-columns:80px 80px;grid-auto-rows:20px;justify-content:center`, ...cells(2))],
  ["justify-content-safe-center-overflow", div(`${G}width:100px;grid-template-columns:80px 80px;grid-auto-rows:20px;justify-content:safe center`, ...cells(2))],
  ["align-content-space-between-spanning", div(`${G}width:200px;height:200px;grid-template-columns:1fr;grid-template-rows:30px 30px 30px;align-content:space-between`, cell("grid-row:1/3"), cell())],
  ...(["start", "end", "center", "stretch", "normal", "self-start", "self-end", "left", "right"] as const).map(
    (v): [string, CaseNode] => [`justify-items-${v}`, div(`${G}width:300px;grid-template-columns:100px 100px;grid-auto-rows:30px;justify-items:${v}`, cell("width:40px"), t(2, 15, 10), cell())],
  ),
  ...(["start", "end", "center", "stretch", "normal", "baseline"] as const).map(
    (v): [string, CaseNode] => [`align-items-${v}`, div(`${G}width:300px;grid-template-columns:100px 100px 100px;grid-auto-rows:60px;align-items:${v}`, cell("height:20px"), t(2, 40, 10), t(1, 40, 25))],
  ),
  ["self-overrides", div(`${G}width:300px;grid-template-columns:100px 100px;grid-auto-rows:60px;place-items:center`, cell("width:20px;height:20px;justify-self:start"), cell("width:20px;height:20px;align-self:end"), cell("place-self:stretch"), cell("width:20px;height:20px"))],
  ["self-auto-margins", div(`${G}width:300px;grid-template-columns:100px 100px;grid-auto-rows:60px`, cell("width:20px;height:20px;margin:auto"), cell("width:20px;height:20px;margin-left:auto"), cell("width:20px;height:20px;margin-top:auto"))],
  ["self-stretch-min-max", div(`${G}width:300px;grid-template-columns:100px 100px;grid-auto-rows:60px`, cell("max-width:50px;max-height:30px"), cell("min-height:80px"))],
  ["self-stretch-margins", div(`${G}width:300px;grid-template-columns:100px 100px;grid-auto-rows:60px`, cell("margin:5px 10px 15px 20px"), cell("margin:-5px"))],
  ["self-center-overflow", div(`${G}width:300px;grid-template-columns:50px 50px;grid-auto-rows:30px;justify-items:center;align-items:center`, cell("width:80px;height:50px"), cell())],
  ["self-safe-overflow", div(`${G}width:300px;grid-template-columns:50px 50px;grid-auto-rows:30px;justify-items:safe center;align-items:safe end`, cell("width:80px;height:50px"), cell())],
  ["baseline-rows", div(`${G}width:300px;grid-template-columns:repeat(3,1fr);align-items:baseline`, t(1, 30, 10), t(1, 30, 30, "margin-top:5px"), cell("height:15px"), t(2, 50, 12), t(1, 20, 6))],
  ["grid-baseline-in-flex", div("display:flex;align-items:baseline;width:400px", div(`${G}grid-template-columns:50px 50px`, t(1, 30, 12), t(1, 30, 20)), t(1, 30, 30))],

  // ── Container sizing ──
  ["container-max-content", div("", div(`${G}width:max-content;grid-template-columns:auto auto;gap:5px`, t(3, 20, 10), t(2, 30, 10)))],
  ["container-min-content", div("", div(`${G}width:min-content;grid-template-columns:auto auto;gap:5px`, t(3, 20, 10), t(2, 30, 10)))],
  ["container-fit-content-fr", div("", div(`${G}width:fit-content;grid-template-columns:1fr 2fr`, t(1, 60, 10), t(1, 50, 10)))],
  ["container-in-flex-item", div("display:flex;width:500px", div(`${G}grid-template-columns:repeat(2,auto);gap:10px`, t(2, 40, 10), t(3, 30, 10)), div("flex:1;height:10px"))],
  ["container-fr-max-content", div("", div(`${G}width:max-content;grid-template-columns:1fr 1fr 2fr`, t(1, 60, 10), t(1, 20, 10), t(1, 50, 10)))],
  ["container-min-content-span-flex", div("", div(`${G}width:min-content;grid-template-columns:50px 1fr`, t(1, 100, 10, "grid-column:span 2")))],
  ["container-max-content-span-flex", div("", div(`${G}width:max-content;grid-template-columns:50px 1fr`, t(1, 100, 10, "grid-column:span 2")))],
  ["container-min-content-span-flex-auto", div("", div(`${G}width:min-content;grid-template-columns:auto 1fr`, t(1, 100, 10, "grid-column:span 2")))],
  ["container-min-content-span-flex-min-width", div("", div(`${G}width:min-content;grid-template-columns:50px 1fr`, t(1, 100, 10, "grid-column:span 2;min-width:80px")))],
  ["container-min-content-single-flex", div("", div(`${G}width:min-content;grid-template-columns:50px 1fr`, cell(), t(1, 100, 10)))],
  ["container-min-content-span-auto", div("", div(`${G}width:min-content;grid-template-columns:auto auto`, t(1, 100, 10, "grid-column:span 2")))],
  ["container-min-content-span-fixed-max", div("", div(`${G}width:min-content;grid-template-columns:minmax(auto, 30px) auto`, t(1, 100, 10, "grid-column:span 2")))],
  ["intrinsic-max-content-fr-fit-content-auto", div("", div(`${G}width:max-content;grid-template-columns:repeat(2, 3fr) fit-content(70px) repeat(3, auto);padding:0 8px`, t(4, 40, 13, "grid-column:3 / 2;min-width:96px;min-height:31px;margin:9px auto 5px 3px;box-sizing:border-box"), cell("width:36px;border:1px solid;justify-self:stretch"), cell("grid-column:3 / 3;height:80px;align-self:end"), t(4, 16, 6, "min-width:0")))],
  ["intrinsic-min-content-auto-min-zero", div("", div(`${G}width:min-content;grid-template-columns:repeat(2, 3fr) fit-content(70px) repeat(3, auto);padding:0 8px`, t(4, 40, 13, "grid-column:3 / 2;min-width:96px;min-height:31px;margin:9px auto 5px 3px;box-sizing:border-box"), cell("width:36px;border:1px solid;justify-self:stretch"), cell("grid-column:3 / 3;height:80px;align-self:end"), t(4, 16, 6, "min-width:0")))],
  ["container-padding-border", div(`${G}width:300px;padding:10px 20px;border:5px solid;grid-template-columns:1fr 1fr;grid-auto-rows:30px;gap:4px`, ...cells(4))],
  ["container-border-box", div(`${G}box-sizing:border-box;width:300px;height:100px;padding:10px;grid-template-columns:1fr 1fr;grid-template-rows:1fr`, ...cells(2))],
  ["container-auto-height-gaps", div(`${G}width:300px;grid-template-columns:1fr;row-gap:12px`, t(1, 30, 20), t(1, 30, 25))],
  ["container-empty", div(`${G}width:300px;grid-template-columns:100px;grid-template-rows:40px;padding:5px`)],

  // ── Nesting, replaced, aspect ratio ──
  ["nested-grid", div(`${G}width:400px;grid-template-columns:1fr 1fr;gap:10px`, div(`${G}grid-template-columns:repeat(2,1fr);gap:4px`, ...cells(4, "height:15px")), t(4, 30, 10))],
  ["flex-in-grid", div(`${G}width:400px;grid-template-columns:200px 1fr`, div("display:flex;gap:5px", t(2, 30, 10), cell("flex:1")), cell())],
  ["grid-in-flex-column", div("display:flex;flex-direction:column;width:300px", div(`${G}grid-template-columns:1fr 1fr`, t(2, 40, 10), cell()), cell("height:20px"))],
  ["canvas-items", div(`${G}width:400px;grid-template-columns:150px 150px;grid-auto-rows:100px`, canvas("", 80, 40), canvas("width:100%", 80, 40), canvas("justify-self:stretch;align-self:stretch", 80, 40))],
  ["aspect-ratio-item", div(`${G}width:400px;grid-template-columns:100px 100px`, cell("aspect-ratio:2"), cell("aspect-ratio:1/2;justify-self:start;width:40px"))],
  ["aspect-ratio-auto-row", div(`${G}width:400px;grid-template-columns:100px 150px`, cell("aspect-ratio:1"), t(1, 30, 10))],

  // ── Positioned children ──
  ["abspos-grid-area", div(`${G}position:relative;width:300px;height:200px;padding:10px;grid-template-columns:100px 100px;grid-template-rows:50px 50px`, cell(), cell("position:absolute;grid-column:2;grid-row:2;inset:0"))],
  ["abspos-grid-area-auto-lines", div(`${G}position:relative;width:300px;height:200px;padding:10px;grid-template-columns:100px 100px;grid-template-rows:50px 50px`, cell("position:absolute;grid-column:2/auto;grid-row:auto/2;inset:0"))],
  ["abspos-grid-area-span", div(`${G}position:relative;width:300px;height:200px;grid-template-columns:100px 100px;grid-template-rows:50px 50px`, cell("position:absolute;grid-column:span 2;top:0;bottom:0;left:0;width:20px"))],
  ["abspos-grid-insets", div(`${G}position:relative;width:300px;height:200px;grid-template-columns:100px 100px;grid-template-rows:50px 50px;gap:10px`, cell("position:absolute;grid-area:1/1/3/3;left:10px;top:10%;width:30px;height:30px"))],
  ["abspos-grid-static", div(`${G}position:relative;width:300px;height:200px;padding:7px;grid-template-columns:100px 100px`, cell("height:20px"), cell("position:absolute;width:30px;height:30px"))],
  ["abspos-grid-static-aligned", div(`${G}position:relative;width:300px;height:200px;justify-items:center;align-items:end;grid-template-columns:100px 100px`, cell("position:absolute;width:30px;height:30px"))],
  ["abspos-grid-not-cb", div("position:relative;width:400px;height:300px;padding:10px", div(`${G}width:300px;height:200px;margin:20px;grid-template-columns:100px 100px`, cell("height:20px"), cell("position:absolute;grid-column:2;right:0;width:30px;height:30px")))],
  ["abspos-grid-static-padding-centered", div(`${G}position:relative;width:300px;height:200px;padding:7px 11px;justify-items:center;align-items:center;grid-template-columns:100px 100px`, cell("position:absolute;width:30px;height:30px"))],
  ["abspos-grid-static-not-cb-padding", div("position:relative;width:400px;height:300px", div(`${G}width:300px;height:200px;padding:7px 11px;margin:5px;grid-template-columns:100px 100px`, cell("position:absolute;width:30px;height:30px")))],
  ["abspos-grid-static-not-cb-centered", div("position:relative;width:400px;height:300px", div(`${G}width:300px;height:200px;padding:7px 11px;margin:5px;place-items:center;grid-template-columns:100px 100px`, cell("position:absolute;width:30px;height:30px")))],
  ["abspos-grid-static-placed", div(`${G}position:relative;width:300px;height:200px;padding:7px;grid-template-columns:100px 100px;grid-template-rows:50px 50px`, cell("position:absolute;grid-column:2;grid-row:2;width:30px;height:30px"))],
  ["relative-grid-item", div(`${G}width:300px;grid-template-columns:100px 100px;grid-auto-rows:40px`, cell("position:relative;left:10px;top:50%"), cell())],
];

export const gridCases: LayoutCase[] = cases.map(([name, root]) => ({ name: `grid/${name}`, area: "grid", kind: "hand", root }));
