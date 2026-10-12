import { canvas, div, text, words, type LayoutCase } from "../case";

/**
 * Hand-written flexbox cases (CSS Flexible Box Layout 1). Each targets one
 * step of the §9 algorithm or one property; names say what is tested.
 */

const box = (w: number, h: number, extra = ""): ReturnType<typeof div> => div(`width:${w}px;height:${h}px;${extra}`);
const C = "display:flex;";

const cases: [string, ReturnType<typeof div>][] = [
  // ── Basics ──
  ["row-fixed-items", div(`${C}width:400px;height:100px`, box(50, 50), box(80, 20), box(30, 70))],
  ["row-auto-height-container", div(`${C}width:400px`, box(50, 50), box(80, 20), box(30, 70))],
  ["column-fixed-items", div(`${C}flex-direction:column;width:200px;height:300px`, box(50, 50), box(80, 20), box(30, 70))],
  ["column-auto-height", div(`${C}flex-direction:column;width:200px`, box(50, 50), box(80, 20), div("height:30px"))],
  ["row-gap", div(`${C}width:400px;column-gap:13px`, box(50, 50), box(80, 20), box(30, 70))],
  ["row-gap-percent", div(`${C}width:400px;column-gap:5%`, box(50, 50), box(80, 20), box(30, 70))],
  ["column-gap-row-gap", div(`${C}flex-direction:column;width:200px;height:300px;gap:7px 20px`, box(50, 50), box(80, 20), box(30, 70))],
  ["container-padding-border", div(`${C}width:300px;height:100px;padding:10px 20px 5px 15px;border:3px solid`, box(50, 50), div("flex-grow:1;height:20px"))],
  ["container-border-box", div(`${C}box-sizing:border-box;width:300px;height:100px;padding:10px;border:5px solid`, div("flex-grow:1"), box(40, 40))],
  ["item-padding-border", div(`${C}width:300px;height:100px`, div("width:50px;padding:5px 7px;border:2px solid"), div("flex-grow:1;padding:3px;border:4px solid"))],
  ["item-margins", div(`${C}width:300px;height:100px`, box(50, 50, "margin:5px 10px 15px 20px"), box(40, 40, "margin:-5px 3px"))],
  ["item-percent-margins", div(`${C}width:300px;height:100px`, box(50, 50, "margin:5% 2%"), div("flex-grow:1;margin-left:10%"))],
  ["item-percent-padding", div(`${C}width:300px;height:100px`, div("flex-grow:1;padding:5%"), box(40, 40, "padding-top:10%"))],
  ["display-none-item", div(`${C}width:300px;height:100px;gap:10px`, box(50, 50), box(50, 50, "display:none"), box(50, 50))],
  ["empty-container", div(`${C}width:300px;padding:10px`)],
  ["single-item-overflowing", div(`${C}width:100px;height:50px`, box(300, 20, "flex-shrink:0"))],

  // ── flex-grow ──
  ["grow-equal", div(`${C}width:400px;height:50px`, div("flex-grow:1"), div("flex-grow:1"), div("flex-grow:1"))],
  ["grow-weighted", div(`${C}width:400px;height:50px`, div("flex-grow:1"), div("flex-grow:2"), div("flex-grow:3"))],
  ["grow-with-basis", div(`${C}width:400px;height:50px`, div("flex:1 1 100px"), div("flex:2 1 50px"), box(30, 30))],
  ["grow-max-clamp", div(`${C}width:400px;height:50px`, div("flex-grow:1;max-width:50px"), div("flex-grow:1"), div("flex-grow:1"))],
  ["grow-min-clamp", div(`${C}width:300px;height:50px`, div("flex:1 1 0px;min-width:200px"), div("flex:1 1 0px"), div("flex:1 1 0px"))],
  ["grow-sum-below-one", div(`${C}width:400px;height:50px`, div("flex-grow:0.2;width:50px"), div("flex-grow:0.3;width:50px"))],
  ["grow-sum-below-one-single", div(`${C}width:400px;height:50px`, div("flex-grow:0.5"))],
  ["grow-gap", div(`${C}width:400px;height:50px;gap:20px`, div("flex-grow:1"), div("flex-grow:1"), div("flex-grow:2"))],
  ["grow-padding-items", div(`${C}width:400px;height:50px`, div("flex:1 1 0px;padding:0 30px"), div("flex:1 1 0px"))],
  ["grow-border-box-basis", div(`${C}width:400px;height:50px`, div("flex:1 1 100px;box-sizing:border-box;padding:0 20px"), div("flex:1 1 100px;padding:0 20px"))],
  ["grow-multiple-violations", div(`${C}width:500px;height:50px`, div("flex-grow:1;max-width:60px"), div("flex-grow:1;max-width:80px"), div("flex-grow:2;min-width:300px"), div("flex-grow:1"))],
  ["grow-fractional", div(`${C}width:401px;height:50px`, div("flex-grow:1"), div("flex-grow:1"), div("flex-grow:1"))],

  // ── flex-shrink ──
  ["shrink-equal", div(`${C}width:300px;height:50px`, box(200, 20), box(200, 20))],
  ["shrink-scaled-by-basis", div(`${C}width:300px;height:50px`, box(100, 20), box(300, 20))],
  ["shrink-weighted", div(`${C}width:300px;height:50px`, div("width:200px;flex-shrink:1"), div("width:200px;flex-shrink:3"))],
  ["shrink-zero", div(`${C}width:300px;height:50px`, div("width:200px;flex-shrink:0"), div("width:200px"))],
  ["shrink-min-clamp", div(`${C}width:300px;height:50px`, div("width:200px;min-width:180px"), div("width:200px"), div("width:200px"))],
  ["shrink-padding-inner-base", div(`${C}width:300px;height:50px`, div("width:200px;padding:0 40px"), div("width:200px"))],
  ["shrink-border-box-inner-base", div(`${C}width:300px;height:50px`, div("box-sizing:border-box;width:200px;padding:0 50px"), div("width:200px"))],
  ["shrink-sum-below-one", div(`${C}width:300px;height:50px`, div("width:200px;flex-shrink:0.25"), div("width:200px;flex-shrink:0.25"))],
  ["shrink-to-padding", div(`${C}width:50px;height:50px`, div("width:200px;padding:0 20px"), div("width:200px;padding:0 10px"))],
  ["shrink-gap", div(`${C}width:300px;height:50px;column-gap:30px`, box(200, 20), box(200, 20))],

  // ── flex-basis ──
  ["basis-px", div(`${C}width:400px;height:50px`, div("flex-basis:120px"), div("flex-basis:80px;width:300px"))],
  ["basis-percent", div(`${C}width:400px;height:50px`, div("flex-basis:25%"), div("flex-basis:50%"))],
  ["basis-zero-grow", div(`${C}width:400px;height:50px`, text("flex:1 1 0px", words(4, 30, 10)), div("flex:1 1 0px"))],
  ["basis-auto-width", div(`${C}width:400px;height:50px`, div("flex-basis:auto;width:150px"), div("width:30%"))],
  ["basis-content", div(`${C}width:400px;height:50px`, text("flex-basis:content;width:300px", words(3, 40, 10)), box(20, 20))],
  ["basis-auto-text", div(`${C}width:400px`, text("", words(5, 30, 12)), text("", words(2, 50, 8)))],
  ["basis-text-shrinks-to-min", div(`${C}width:150px`, text("", words(5, 30, 12)), text("", words(4, 25, 8)))],
  ["basis-flex-1-shorthand", div(`${C}width:400px;height:60px`, text("flex:1", words(6, 20, 10)), text("flex:1", words(2, 20, 10)))],
  ["basis-flex-auto-shorthand", div(`${C}width:400px;height:60px`, text("flex:auto", words(6, 20, 10)), text("flex:auto", words(2, 20, 10)))],
  ["basis-flex-none", div(`${C}width:100px;height:60px`, text("flex:none", words(6, 20, 10)), box(50, 20))],
  ["basis-max-content-keyword", div(`${C}width:400px;height:60px`, text("flex-basis:max-content;flex-grow:0", words(3, 25, 10)), text("flex-basis:min-content", words(3, 25, 10)))],
  ["basis-column-percent-indefinite", div(`${C}flex-direction:column;width:200px`, text("flex-basis:50%", words(3, 50, 10)), box(30, 30))],
  ["basis-column-percent-definite", div(`${C}flex-direction:column;width:200px;height:300px`, div("flex-basis:50%"), div("flex-basis:20%"))],

  // ── Automatic minimum size (§4.5) ──
  ["automin-text", div(`${C}width:100px;height:50px`, text("", words(3, 60, 10)), box(80, 10))],
  ["automin-overflow-hidden", div(`${C}width:100px;height:50px`, text("overflow:hidden", words(3, 60, 10)), box(80, 10))],
  ["automin-specified-smaller", div(`${C}width:100px;height:50px`, text("width:40px", words(3, 60, 10)), box(80, 10))],
  ["automin-min-width-zero", div(`${C}width:100px;height:50px`, text("min-width:0", words(3, 60, 10)), box(80, 10))],
  ["automin-column-content", div(`${C}flex-direction:column;width:100px;height:50px`, text("", words(3, 60, 20)), box(80, 30))],
  ["automin-column-specified", div(`${C}flex-direction:column;width:100px;height:50px`, text("height:10px", words(3, 60, 20)), box(80, 30))],
  ["automin-nested-flex", div(`${C}width:120px;height:50px`, div(`${C}`, box(100, 10), box(50, 10)), box(80, 10))],
  ["automin-max-width-caps", div(`${C}width:100px;height:50px`, text("max-width:50px", words(3, 70, 10)), box(80, 10))],

  // ── Wrapping ──
  ["wrap-basic", div(`${C}flex-wrap:wrap;width:200px`, box(80, 30), box(80, 40), box(80, 20), box(80, 50))],
  ["wrap-gaps", div(`${C}flex-wrap:wrap;width:200px;gap:10px 15px`, box(80, 30), box(80, 40), box(80, 20), box(80, 50))],
  ["wrap-reverse", div(`${C}flex-wrap:wrap-reverse;width:200px`, box(80, 30), box(80, 40), box(80, 20))],
  ["wrap-reverse-fixed-height", div(`${C}flex-wrap:wrap-reverse;width:200px;height:200px`, box(80, 30), box(80, 40), box(80, 20))],
  ["wrap-grow-per-line", div(`${C}flex-wrap:wrap;width:200px`, div("flex:1 0 80px;height:20px"), div("flex:1 0 80px;height:20px"), div("flex:1 0 80px;height:20px"))],
  ["wrap-stretch-lines", div(`${C}flex-wrap:wrap;width:200px;height:200px`, div("width:80px"), div("width:80px;height:30px"), div("width:80px"))],
  ["wrap-align-content-center", div(`${C}flex-wrap:wrap;align-content:center;width:200px;height:200px`, box(80, 30), box(80, 40), box(80, 20))],
  ["wrap-align-content-space-between", div(`${C}flex-wrap:wrap;align-content:space-between;width:200px;height:200px`, box(80, 30), box(80, 40), box(80, 20), box(80, 20), box(80, 10))],
  ["wrap-align-content-space-around", div(`${C}flex-wrap:wrap;align-content:space-around;width:200px;height:200px`, box(80, 30), box(80, 40), box(80, 20))],
  ["wrap-align-content-space-evenly", div(`${C}flex-wrap:wrap;align-content:space-evenly;width:200px;height:200px`, box(80, 30), box(80, 40), box(80, 20))],
  ["wrap-align-content-end", div(`${C}flex-wrap:wrap;align-content:flex-end;width:200px;height:200px;row-gap:10px`, box(80, 30), box(80, 40), box(80, 20))],
  ["wrap-align-content-overflow", div(`${C}flex-wrap:wrap;align-content:center;width:200px;height:50px`, box(80, 30), box(80, 40), box(80, 20), box(80, 25))],
  ["wrap-reverse-align-content-start", div(`${C}flex-wrap:wrap-reverse;align-content:flex-start;width:200px;height:200px`, box(80, 30), box(80, 40), box(80, 20))],
  ["wrap-reverse-align-content-start-physical", div(`${C}flex-wrap:wrap-reverse;align-content:start;width:200px;height:200px`, box(80, 30), box(80, 40), box(80, 20))],
  ["wrap-column-fixed-height", div(`${C}flex-direction:column;flex-wrap:wrap;width:300px;height:100px`, box(50, 40), box(60, 40), box(40, 40), box(30, 30))],
  ["wrap-column-gap", div(`${C}flex-direction:column;flex-wrap:wrap;width:300px;height:100px;gap:5px 12px`, box(50, 40), box(60, 40), box(40, 40))],
  ["wrap-column-max-height", div(`${C}flex-direction:column;flex-wrap:wrap;width:300px;max-height:90px`, box(50, 40), box(60, 40), box(40, 40))],
  ["wrap-single-item-line", div(`${C}flex-wrap:wrap;width:100px`, box(150, 20), box(30, 20))],
  ["wrap-text-items", div(`${C}flex-wrap:wrap;width:150px;gap:5px`, text("", words(3, 30, 10)), text("", words(4, 25, 12)), text("", words(2, 40, 8)))],

  // ── justify-content ──
  ...(["flex-start", "flex-end", "center", "space-between", "space-around", "space-evenly", "start", "end", "left", "right", "normal", "stretch"] as const).map(
    (j): [string, ReturnType<typeof div>] => [`justify-${j}`, div(`${C}justify-content:${j};width:400px;height:50px`, box(50, 20), box(70, 30), box(30, 10))],
  ),
  ...(["flex-start", "flex-end", "center", "space-between", "start", "end", "left", "right"] as const).map(
    (j): [string, ReturnType<typeof div>] => [`justify-row-reverse-${j}`, div(`${C}flex-direction:row-reverse;justify-content:${j};width:400px;height:50px`, box(50, 20), box(70, 30), box(30, 10))],
  ),
  ...(["flex-start", "flex-end", "center", "space-around", "start", "end"] as const).map(
    (j): [string, ReturnType<typeof div>] => [`justify-column-${j}`, div(`${C}flex-direction:column;justify-content:${j};width:100px;height:300px`, box(50, 20), box(70, 30), box(30, 10))],
  ),
  ...(["flex-start", "flex-end", "center", "start", "end"] as const).map(
    (j): [string, ReturnType<typeof div>] => [`justify-column-reverse-${j}`, div(`${C}flex-direction:column-reverse;justify-content:${j};width:100px;height:300px`, box(50, 20), box(70, 30), box(30, 10))],
  ),
  ["justify-center-overflow", div(`${C}justify-content:center;width:100px;height:50px`, box(80, 20, "flex-shrink:0"), box(70, 30, "flex-shrink:0"))],
  ["justify-safe-center-overflow", div(`${C}justify-content:safe center;width:100px;height:50px`, box(80, 20, "flex-shrink:0"), box(70, 30, "flex-shrink:0"))],
  ["justify-space-between-single", div(`${C}justify-content:space-between;width:300px;height:50px`, box(80, 20))],
  ["justify-space-around-single", div(`${C}justify-content:space-around;width:300px;height:50px`, box(80, 20))],
  ["justify-space-evenly-overflow", div(`${C}justify-content:space-evenly;width:100px;height:50px`, box(80, 20, "flex-shrink:0"), box(70, 30, "flex-shrink:0"))],
  ["justify-space-around-overflow", div(`${C}justify-content:space-around;width:100px;height:50px`, box(80, 20, "flex-shrink:0"), box(70, 30, "flex-shrink:0"))],
  ["justify-space-between-overflow", div(`${C}justify-content:space-between;width:100px;height:50px`, box(80, 20, "flex-shrink:0"), box(70, 30, "flex-shrink:0"))],
  ["justify-with-gap-and-wrap", div(`${C}flex-wrap:wrap;justify-content:space-between;width:250px;gap:10px`, box(80, 20), box(80, 20), box(80, 20), box(80, 20))],

  // ── Auto margins ──
  ["auto-margin-left", div(`${C}width:400px;height:50px`, box(50, 20), box(50, 20, "margin-left:auto"), box(50, 20))],
  ["auto-margins-both-center", div(`${C}width:400px;height:50px`, box(50, 20, "margin:0 auto"))],
  ["auto-margins-split", div(`${C}width:400px;height:50px;justify-content:flex-end`, box(50, 20, "margin-right:auto"), box(50, 20, "margin-left:auto"), box(50, 20))],
  ["auto-margins-negative-free", div(`${C}width:100px;height:50px`, box(80, 20, "margin-left:auto;flex-shrink:0"), box(70, 20, "flex-shrink:0"))],
  ["auto-margin-cross-top", div(`${C}width:300px;height:100px`, box(50, 20, "margin-top:auto"), box(50, 20, "margin:auto 0"), box(50, 20, "margin-bottom:auto"))],
  ["auto-margin-cross-overflow", div(`${C}width:300px;height:30px`, box(50, 60, "margin-top:auto"), box(50, 60, "margin:auto 0"))],
  ["auto-margin-column", div(`${C}flex-direction:column;width:200px;height:300px`, box(50, 20, "margin-top:auto"), box(50, 20, "margin-left:auto"), box(50, 20, "margin:0 auto"))],
  ["auto-margin-row-reverse", div(`${C}flex-direction:row-reverse;width:400px;height:50px`, box(50, 20, "margin-left:auto"), box(50, 20))],

  // ── align-items / align-self ──
  ...(["stretch", "flex-start", "flex-end", "center", "start", "end", "self-start", "self-end", "normal", "baseline"] as const).map(
    (a): [string, ReturnType<typeof div>] => [`align-items-${a}`, div(`${C}align-items:${a};width:300px;height:100px`, div("width:50px"), box(50, 30), div("width:50px;height:60px;margin-top:10px"))],
  ),
  ...(["stretch", "flex-start", "flex-end", "center", "start", "end"] as const).map(
    (a): [string, ReturnType<typeof div>] => [`align-items-column-${a}`, div(`${C}flex-direction:column;align-items:${a};width:200px;height:200px`, div("height:30px"), box(50, 30), div("width:80px;height:30px;margin-left:10px"))],
  ),
  ...(["flex-start", "flex-end", "center", "start", "end", "stretch"] as const).map(
    (a): [string, ReturnType<typeof div>] => [`align-items-wrap-reverse-${a}`, div(`${C}flex-wrap:wrap-reverse;align-items:${a};width:200px;height:200px`, box(80, 30), box(80, 50), div("width:80px"))],
  ),
  ["align-self-mixed", div(`${C}width:300px;height:100px;align-items:center`, box(30, 30, "align-self:flex-start"), box(30, 30), box(30, 30, "align-self:flex-end"), div("width:30px;align-self:stretch"), box(30, 30, "align-self:auto"))],
  ["align-stretch-min-max", div(`${C}width:300px;height:100px`, div("width:50px;max-height:40px"), div("width:50px;min-height:150px"), div("width:50px;height:20px"))],
  ["align-stretch-auto-height-container", div(`${C}width:300px`, box(50, 40), div("width:50px"), text("width:50px", words(3, 40, 15)))],
  ["align-stretch-margins", div(`${C}width:300px;height:100px`, div("width:50px;margin:10px 0 5px"), div("width:50px;margin-top:-10px"))],
  ["align-center-overflow", div(`${C}align-items:center;width:300px;height:40px`, box(50, 100), box(50, 20))],
  ["align-safe-center-overflow", div(`${C}align-items:safe center;width:300px;height:40px`, box(50, 100), box(50, 20))],
  ["align-unsafe-end-overflow", div(`${C}align-items:unsafe end;width:300px;height:40px`, box(50, 100), box(50, 20))],
  ["align-stretch-min-height-container", div(`${C}width:300px;min-height:120px`, div("width:50px"), box(50, 30))],
  ["align-stretch-max-height-container", div(`${C}width:300px;max-height:40px`, div("width:50px"), box(50, 80))],

  // ── Baselines ──
  ["baseline-text", div(`${C}align-items:baseline;width:400px`, text("", words(2, 30, 10)), text("", words(2, 30, 24)), text("", words(1, 30, 16)))],
  ["baseline-text-margins", div(`${C}align-items:baseline;width:400px`, text("margin-top:15px", words(2, 30, 10)), text("padding-top:5px;border:2px solid", words(2, 30, 24)), box(30, 20))],
  ["baseline-synthesized", div(`${C}align-items:baseline;width:400px`, box(30, 20), box(30, 50), text("", words(1, 30, 16)))],
  ["baseline-multiline-text", div(`${C}align-items:baseline;width:400px`, text("width:60px", words(3, 30, 10)), text("", words(1, 30, 30)))],
  ["baseline-mixed-align", div(`${C}align-items:baseline;width:400px;height:100px`, text("", words(1, 30, 10)), text("align-self:center", words(1, 30, 10)), text("", words(1, 30, 20)))],
  ["baseline-wrap", div(`${C}align-items:baseline;flex-wrap:wrap;width:100px`, text("", words(1, 40, 10)), text("", words(1, 40, 25)), text("", words(1, 40, 15)), text("", words(1, 40, 5)))],
  ["baseline-nested-flex", div(`${C}align-items:baseline;width:400px`, div(`${C}align-items:baseline`, text("", words(1, 20, 12)), text("", words(1, 20, 20))), text("", words(1, 30, 30)))],
  ["baseline-nested-block", div(`${C}align-items:baseline;width:400px`, div("width:60px", box(40, 10), text("", words(1, 30, 12))), text("", words(1, 30, 30)))],
  ["baseline-column-fallback", div(`${C}flex-direction:column;align-items:baseline;width:300px`, text("", words(1, 40, 10)), text("", words(1, 80, 25)))],
  ["last-baseline", div(`${C}align-items:last baseline;width:400px`, text("width:60px", words(3, 30, 10)), text("", words(1, 30, 30)), box(30, 15))],
  ["baseline-container-in-block", div("width:400px", div(`${C}align-items:baseline;height:80px`, text("", words(1, 30, 10)), text("", words(1, 30, 30))))],

  // ── order ──
  ["order-basic", div(`${C}width:300px;height:50px`, box(50, 20, "order:2"), box(60, 20), box(70, 20, "order:-1"))],
  ["order-wrap", div(`${C}flex-wrap:wrap;width:150px`, box(60, 20, "order:3"), box(60, 30, "order:1"), box(60, 40, "order:2"), box(60, 10))],
  ["order-reverse", div(`${C}flex-direction:row-reverse;width:300px;height:50px`, box(50, 20, "order:1"), box(60, 20))],

  // ── Nesting and percentages ──
  ["nested-column-in-row", div(`${C}width:400px;height:200px`, div(`${C}flex-direction:column;flex:1`, div("flex:1"), box(30, 40)), box(100, 50))],
  ["nested-row-in-column", div(`${C}flex-direction:column;width:300px;height:200px`, div(`${C}flex:1`, div("flex:1"), div("flex:2")), div("height:30px"))],
  ["percent-height-in-stretched-item", div(`${C}width:300px;height:200px`, div("width:100px", div("height:50%")), box(50, 50))],
  ["percent-height-in-auto-container", div(`${C}width:300px`, div("width:100px", div("height:50%")), box(50, 50))],
  ["percent-width-of-item-child", div(`${C}width:300px;height:100px`, div("width:200px", div("width:25%;height:20px")))],
  ["percent-height-column-flexed", div(`${C}flex-direction:column;width:300px;height:200px`, div("flex:1", div("height:50%")), box(50, 50))],
  ["percent-item-height", div(`${C}width:300px;height:200px`, div("width:50px;height:30%"), div("width:50px;height:110%"))],
  ["deep-nesting", div(`${C}width:500px;height:300px;padding:10px;gap:10px`, div(`${C}flex-direction:column;flex:2;gap:5px`, div(`${C}flex:1;gap:3px`, div("flex:1"), div("flex:1")), div("height:40px")), div(`${C}flex-direction:column;flex:1`, div("flex:1"), div("flex:2")))],

  // ── Column specifics ──
  ["column-grow-fixed-height", div(`${C}flex-direction:column;width:100px;height:300px`, div("flex-grow:1"), div("flex-grow:2"), div("height:30px"))],
  ["column-grow-indefinite", div(`${C}flex-direction:column;width:100px`, div("flex-grow:1;height:20px"), div("flex-grow:2;height:30px"))],
  ["column-min-height-grows", div(`${C}flex-direction:column;width:100px;min-height:200px`, div("flex-grow:1;height:20px"), div("height:30px"))],
  ["column-max-height-shrinks", div(`${C}flex-direction:column;width:100px;max-height:60px`, div("height:50px"), div("height:50px"))],
  ["column-text-heights", div(`${C}flex-direction:column;width:100px`, text("", words(5, 30, 10)), text("", words(2, 60, 14)))],
  ["column-text-stretch-vs-start", div(`${C}flex-direction:column;align-items:flex-start;width:100px`, text("", words(5, 30, 10)), text("", words(2, 60, 14)))],
  ["column-reverse-auto-height", div(`${C}flex-direction:column-reverse;width:100px`, box(50, 20), box(50, 40))],
  ["column-shrink", div(`${C}flex-direction:column;width:100px;height:100px`, box(50, 80), box(50, 80, "flex-shrink:3"))],

  // ── Intrinsic sizing of flex containers ──
  ["intrinsic-row-max-content", div("", div(`${C}width:max-content;gap:10px`, text("", words(3, 20, 10)), box(50, 20)))],
  ["intrinsic-row-min-content", div("", div(`${C}width:min-content;gap:10px`, text("", words(3, 20, 10)), box(50, 20)))],
  ["intrinsic-row-wrap-min-content", div("", div(`${C}flex-wrap:wrap;width:min-content`, text("", words(3, 20, 10)), box(50, 20)))],
  ["intrinsic-column-max-content", div("", div(`${C}flex-direction:column;width:max-content`, text("", words(3, 20, 10)), box(50, 20)))],
  ["intrinsic-fit-content-in-column", div(`${C}flex-direction:column;align-items:flex-start;width:300px`, div(`${C}`, box(40, 20), box(30, 20)), div(`${C}flex-wrap:wrap;gap:5px`, text("", words(20, 20, 10))))],
  ["intrinsic-nested-item-contribution", div(`${C}width:500px;height:50px`, div(`${C};gap:10px`, box(40, 20), text("", words(4, 25, 10))), div("flex:1"))],
  ["intrinsic-contribution-not-shrinkable", div("", div(`${C}width:max-content`, div("flex:0 0 100px;height:10px"), box(20, 10)))],
  ["intrinsic-contribution-not-growable-min", div("", div(`${C}width:min-content`, div("width:104px;flex-basis:0px;height:10px"), box(20, 10)))],
  ["intrinsic-contribution-not-growable-max", div("", div(`${C}width:max-content`, div("width:104px;flex-basis:30px;height:10px"), box(20, 10)))],
  ["intrinsic-contribution-growable", div("", div(`${C}width:max-content`, div("width:50px;flex:1 1 100px;height:10px"), box(20, 10)))],
  ["intrinsic-contribution-text-basis-zero", div("", div(`${C}width:max-content`, text("flex:1 1 0px", words(3, 20, 10)), text("flex:2 1 0px", words(1, 10, 10))))],
  ["intrinsic-contribution-flex-fraction", div("", div(`${C}width:max-content`, text("flex:1 0 0px", words(5, 20, 10)), text("flex:2 0 0px", words(1, 10, 10))))],
  ["intrinsic-contribution-shrink-only", div("", div(`${C}width:max-content`, text("flex:0 1 100px", words(2, 20, 10)), box(20, 10)))],
  ["intrinsic-contribution-min-content-text", div("", div(`${C}width:min-content`, text("flex:0 1 100px", words(2, 20, 10)), text("flex:0 0 10px", words(2, 30, 10))))],
  ["intrinsic-hug-with-fill-children", div("", div(`${C}width:fit-content;gap:8px;padding:8px`, text("flex:1 1 0px", words(3, 20, 10)), text("flex:1 1 0px", words(2, 30, 10)), box(40, 20, "flex-shrink:0")))],
  ["intrinsic-column-wrap-width", div("", div(`${C}flex-direction:column;flex-wrap:wrap;height:100px;width:max-content`, box(50, 60), box(30, 60), box(40, 30)))],
  ["intrinsic-column-wrap-width-gap", div("", div(`${C}flex-direction:column;flex-wrap:wrap;height:100px;width:min-content;column-gap:10px`, box(50, 60), box(30, 60), box(40, 30)))],
  ["intrinsic-column-wrap-max-height", div("", div(`${C}flex-direction:column;flex-wrap:wrap;max-height:100px;width:max-content`, box(50, 60), box(30, 60), box(40, 30)))],
  ["baseline-column-margins", div(`${C}flex-direction:column;align-items:baseline;width:300px`, box(50, 20, "margin-left:-2px"), box(20, 20), box(0, 20, "margin-left:8px"))],
  ["baseline-column-text", div(`${C}flex-direction:column;align-items:baseline;width:300px`, text("margin-left:5px", words(2, 30, 10)), box(20, 20, "border:3px solid"))],
  ["column-item-percent-height-grow", div(`${C}flex-direction:column;width:200px`, div("height:50%;flex-grow:1"), box(20, 30))],
  ["column-wrap-automin", div(`${C}flex-direction:column;width:200px;height:120px`, div(`${C}flex-direction:column;flex-wrap:wrap;height:55px`, box(20, 39), box(20, 30), box(20, 30)), box(20, 100))],
  ["intrinsic-contribution-percent-basis", div("", div(`${C}width:max-content`, text("flex-basis:22%", words(3, 20, 10)), box(10, 10)))],
  ["intrinsic-contribution-percent-basis-grow", div("", div(`${C}width:max-content`, text("flex-basis:22%;flex-grow:1", words(3, 20, 10)), box(10, 10)))],
  ["intrinsic-contribution-content-basis", div("", div(`${C}width:max-content`, text("flex-basis:content", words(3, 20, 10)), box(10, 10)))],
  ["intrinsic-contribution-px-basis-text", div("", div(`${C}width:max-content`, text("flex-basis:50px", words(3, 20, 10)), box(10, 10)))],
  ["intrinsic-contribution-px-basis-text-min", div("", div(`${C}width:min-content`, text("flex-basis:50px", words(3, 20, 10)), box(10, 10)))],
  ["automin-wrap-container-unshrinkable-child", div(`${C}width:20px;height:50px`, div(`${C}flex-wrap:wrap`, div("width:102px;flex-shrink:0;flex-basis:0px;height:10px")))],
  ["automin-nowrap-container-unshrinkable-child", div(`${C}width:20px;height:50px`, div(`${C}`, div("width:102px;flex-shrink:0;flex-basis:0px;height:10px")))],
  ["automin-wrap-container-shrinkable-child", div(`${C}width:20px;height:50px`, div(`${C}flex-wrap:wrap`, div("width:102px;flex-basis:0px;height:10px")))],
  ["intrinsic-min-unshrinkable-zero-basis", div("", div(`${C}width:min-content`, div("width:102px;flex-shrink:0;flex-basis:0px;height:10px"), box(10, 10)))],
  ["intrinsic-row-wrap-max-content", div("", div(`${C}flex-wrap:wrap;width:max-content`, box(50, 10), box(30, 10)))],
  ["intrinsic-row-wrap-max-content-text", div("", div(`${C}flex-wrap:wrap;width:max-content`, text("", words(3, 20, 10)), text("width:40px", words(3, 20, 10))))],
  ["intrinsic-row-wrap-in-item", div(`${C}width:200px;height:50px`, div(`${C}flex-wrap:wrap`, box(50, 10), box(30, 10)), div("flex:1 1 0px"))],
  ["intrinsic-row-wrap-percent-basis-in-item", div(`${C}width:200px;height:50px`, div(`${C}flex-wrap:wrap;flex-basis:22%`, box(50, 10), box(30, 10)), div("flex:1 1 0px"))],
  ["intrinsic-column-min-content-text", div("", div(`${C}flex-direction:column;width:min-content`, text("", words(3, 20, 10)), box(30, 10)))],
  ["intrinsic-column-wrap-min-content-text", div("", div(`${C}flex-direction:column;flex-wrap:wrap;height:100px;width:min-content`, text("", words(3, 20, 10)), box(30, 10)))],
  ["intrinsic-column-wrap-min-content-text-2lines", div("", div(`${C}flex-direction:column;flex-wrap:wrap;height:30px;width:min-content`, text("", words(3, 20, 10)), box(30, 25)))],
  ["intrinsic-column-wrap-fit-content", div(`${C}flex-direction:column;align-items:center;width:100px`, div(`${C}flex-direction:column;flex-wrap:wrap;max-height:30px`, text("", words(3, 50, 10)), box(30, 25)))],
  ["column-wrap-item-fits-line-center", div(`${C}flex-direction:column;flex-wrap:wrap;align-items:center;width:100px`, box(300, 10), text("", words(3, 50, 10)))],
  ["column-wrap-item-fits-line-start", div(`${C}flex-direction:column;flex-wrap:wrap;align-items:flex-start;width:100px`, box(120, 10), text("", words(3, 50, 10)))],
  ["column-wrap-item-fits-own-line", div(`${C}flex-direction:column;flex-wrap:wrap;align-items:flex-start;width:100px;height:30px`, box(300, 10), text("", words(3, 50, 10)), text("", words(3, 50, 10)))],
  ["column-nowrap-item-fits-container", div(`${C}flex-direction:column;align-items:flex-start;width:100px`, box(300, 10), text("", words(3, 50, 10)))],
  ["intrinsic-item-width-max-content", div(`${C}width:100px;height:50px`, text("width:max-content", words(3, 25, 10)), box(20, 20))],

  // ── Aspect ratio and replaced items ──
  ["aspect-ratio-row-definite-height", div(`${C}width:300px;height:100px;align-items:flex-start`, div("height:50px;aspect-ratio:2"), box(20, 20))],
  ["aspect-ratio-row-stretched", div(`${C}width:300px;height:100px`, div("aspect-ratio:1/2"), box(20, 20))],
  ["aspect-ratio-column-width", div(`${C}flex-direction:column;width:200px;align-items:flex-start`, div("width:100px;aspect-ratio:2"), box(20, 20))],
  ["aspect-ratio-column-stretch", div(`${C}flex-direction:column;width:200px`, div("aspect-ratio:4"), box(20, 20))],
  ["canvas-stretched", div(`${C}width:300px;height:100px`, canvas("", 40, 30), box(20, 20))],
  ["canvas-align-start", div(`${C}width:300px;height:100px;align-items:flex-start`, canvas("", 40, 30), canvas("height:60px", 40, 30))],
  ["canvas-shrink", div(`${C}width:100px;height:100px;align-items:flex-start`, canvas("", 80, 30), canvas("", 80, 30))],
  ["canvas-column", div(`${C}flex-direction:column;width:300px;align-items:center`, canvas("", 80, 30), canvas("width:40px", 80, 30))],

  // ── Absolutely positioned children (§4.1) ──
  ["abspos-static-start", div(`${C}position:relative;width:300px;height:100px`, box(50, 50), box(30, 30, "position:absolute"))],
  ["abspos-static-center", div(`${C}position:relative;justify-content:center;align-items:center;width:300px;height:100px`, box(50, 50), box(30, 30, "position:absolute"))],
  ["abspos-static-end", div(`${C}position:relative;justify-content:flex-end;align-items:flex-end;width:300px;height:100px;padding:10px`, box(30, 30, "position:absolute"))],
  ["abspos-static-row-reverse", div(`${C}position:relative;flex-direction:row-reverse;width:300px;height:100px`, box(30, 30, "position:absolute"))],
  ["abspos-static-align-self", div(`${C}position:relative;width:300px;height:100px`, box(30, 30, "position:absolute;align-self:center"))],
  ["abspos-static-column-center", div(`${C}position:relative;flex-direction:column;justify-content:center;width:300px;height:100px`, box(30, 30, "position:absolute"))],
  ["abspos-static-wrap-reverse-baseline", div(`${C}position:relative;flex-wrap:wrap-reverse;align-items:baseline;width:300px;height:100px`, box(30, 30, "position:absolute"))],
  ["abspos-static-wrap-reverse-flex-start", div(`${C}position:relative;flex-wrap:wrap-reverse;align-items:flex-start;width:300px;height:100px`, box(30, 30, "position:absolute"))],
  ["abspos-static-wrap-reverse-stretch", div(`${C}position:relative;flex-wrap:wrap-reverse;width:300px;height:100px`, box(30, 30, "position:absolute"))],
  ["abspos-static-wrap-reverse-end", div(`${C}position:relative;flex-wrap:wrap-reverse;align-items:end;width:300px;height:100px`, box(30, 30, "position:absolute"))],
  ["abspos-static-last-baseline", div(`${C}position:relative;align-items:last baseline;width:300px;height:100px`, box(30, 30, "position:absolute"))],
  ["abspos-insets-in-flex", div(`${C}position:relative;width:300px;height:100px`, box(50, 50), div("position:absolute;left:10px;right:20px;top:5px;height:20px"))],
  ["abspos-space-between-static", div(`${C}position:relative;justify-content:space-between;width:300px;height:100px`, box(30, 30, "position:absolute"), box(50, 50))],
];

export const flexCases: LayoutCase[] = cases.map(([name, root]) => ({ name: `flex/${name}`, area: "flex", kind: "hand", root }));
