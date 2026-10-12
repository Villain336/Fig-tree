import { box, textBox, type TextCase } from "../case";

const LOREM = "The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs.";
const LONG = "Typography is the art and technique of arranging type to make written language legible, readable and appealing when displayed.";

/** Fonts, sizes, weights, line heights and inline boxes: the common cases. */
export const basicCases: TextCase[] = [
  { name: "basic/single-line-inter-16", area: "basic", root: textBox("font: 16px Inter; width: max-content", "Hello world") },
  { name: "basic/wrap-inter-16", area: "basic", root: textBox("font: 16px Inter; width: 240px", LOREM) },
  { name: "basic/wrap-inter-13", area: "basic", root: textBox("font: 13px Inter; width: 180px", LONG) },
  { name: "basic/wrap-inter-20", area: "basic", root: textBox("font: 20px Inter; width: 300px", LONG) },
  { name: "basic/wrap-noto-15", area: "basic", root: textBox("font: 15px 'Noto Sans'; width: 260px", LONG) },
  { name: "basic/wrap-noto-static-17", area: "basic", root: textBox("font: 17px 'Noto Static'; width: 220px", LOREM) },
  { name: "basic/sizes-10-to-40", area: "basic", root: box("width: 400px", ...[10, 12, 14, 18, 24, 32, 40].map((s) => textBox(`font: ${s}px Inter`, "Size sample Ag"))) },
  { name: "basic/fractional-size-12.5", area: "basic", root: textBox("font: 12.5px Inter; width: 200px", LOREM) },
  { name: "basic/fractional-size-10.3", area: "basic", root: textBox("font: 10.3px 'Noto Sans'; width: 150px", LOREM) },
  { name: "basic/weights-variable", area: "basic", root: box("width: 500px", ...[100, 300, 400, 500, 650, 800, 900].map((w) => textBox(`font: ${w} 18px Inter`, `Weight ${w} hamburgefonstiv`))) },
  { name: "basic/weights-static", area: "basic", root: box("width: 500px", ...[300, 400, 700, 900].map((w) => textBox(`font: ${w} 18px 'Noto Static'`, `Weight ${w} hamburgefonstiv`))) },
  { name: "basic/italic-variable", area: "basic", root: textBox("font: italic 18px 'Noto Sans'; width: 300px", LOREM) },
  { name: "basic/italic-static", area: "basic", root: textBox("font: italic 700 18px 'Noto Static'; width: 300px", LOREM) },
  { name: "basic/mixed-runs-sizes", area: "basic", root: textBox("font: 16px Inter; width: 320px", "Mixed ", ["font-size: 28px", "large"], " and ", ["font-size: 11px", "small"], " runs in one paragraph that wraps across lines.") },
  { name: "basic/mixed-runs-fonts", area: "basic", root: textBox("font: 16px Inter; width: 300px", "Inter text then ", ["font-family: 'Noto Sans'", "Noto Sans text"], " then ", ["font-family: 'Noto Static'; font-weight: 700", "bold static"], " and back.") },
  { name: "basic/mixed-runs-weights", area: "basic", root: textBox("font: 15px Inter; width: 260px", "Regular ", ["font-weight: 700", "bold"], " ", ["font-weight: 300", "light"], " ", ["font-weight: 900", "black words wrap here"], " end.") },
  { name: "basic/shrink-to-fit", area: "basic", root: box("position: relative", { style: "position: absolute; font: 16px Inter", text: ["Shrink to fit width"] }) },
  { name: "basic/shrink-to-fit-wraps-at-container", area: "basic", root: box("width: 200px; position: relative", { style: "position: absolute; font: 16px Inter", text: [LOREM] }) },
  { name: "basic/empty-text", area: "basic", root: box("width: 200px", textBox("font: 16px Inter", ""), textBox("font: 16px Inter", "After empty")) },
  { name: "basic/padding-border", area: "basic", root: textBox("font: 14px Inter; width: 200px; padding: 7px 11px; border: 3px solid black", LOREM) },
  { name: "basic/long-word-overflows", area: "basic", root: textBox("font: 16px Inter; width: 120px", "Supercalifragilisticexpialidocious word") },
  { name: "basic/numbers-punctuation", area: "basic", root: textBox("font: 16px Inter; width: 220px", "Prices: $12.50, €9.99 (approx.); totals 1,234,567.89 — done! Is it? Yes: 100% sure.") },
  { name: "basic/woff2-font", area: "basic", root: textBox("font: 16px 'Inter Woff2'; width: 240px", LOREM) },
  { name: "basic/decorations", area: "basic", root: textBox("font: 16px Inter; width: 260px", ["text-decoration: underline", "Underlined words"], " then ", ["text-decoration: line-through", "struck through"], " and ", ["text-decoration: overline", "overlined"], " with ", ["text-decoration: underline; font-size: 24px", "bigger"], " text.") },
  { name: "basic/decorations-noto", area: "basic", root: textBox("font: 18px 'Noto Sans'; width: 300px; text-decoration: underline", LOREM) },
];
