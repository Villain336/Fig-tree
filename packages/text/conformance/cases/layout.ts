import { box, textBox, type TextCase } from "../case";

const TEXT = "The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs.";
const HEADLINE = "Balanced headlines read better than ragged ones do";

/** Truncation, text-wrap styles, and text inside flex and grid sizing. */
export const layoutCases: TextCase[] = [
  // truncation
  { name: "truncation/ellipsis-nowrap", area: "truncation", root: textBox("font: 16px Inter; width: 150px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis", TEXT) },
  { name: "truncation/ellipsis-fits", area: "truncation", root: textBox("font: 16px Inter; width: 150px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis", "Short") },
  { name: "truncation/ellipsis-noto", area: "truncation", root: textBox("font: 18px 'Noto Sans'; width: 170px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis", TEXT) },
  ...[1, 2, 3].map((n): TextCase => ({
    name: `truncation/line-clamp-${n}`,
    area: "truncation",
    root: textBox(`font: 16px Inter; width: 220px; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: ${n}; overflow: hidden`, TEXT),
  })),
  { name: "truncation/line-clamp-not-reached", area: "truncation", root: textBox("font: 16px Inter; width: 220px; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 5; overflow: hidden", "Only one line") },
  { name: "truncation/line-clamp-line-height", area: "truncation", root: textBox("font: 16px Inter; width: 220px; line-height: 24px; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden", TEXT) },

  // text-wrap styles
  ...[160, 220, 300, 420].map((w): TextCase => ({ name: `wrap-style/balance-${w}`, area: "wrap-style", root: textBox(`font: 20px Inter; width: ${w}px; text-wrap: balance`, HEADLINE) })),
  { name: "wrap-style/balance-long-paragraph", area: "wrap-style", root: textBox("font: 16px Inter; width: 200px; text-wrap: balance", TEXT + " " + TEXT) },
  { name: "wrap-style/balance-centered", area: "wrap-style", root: textBox("font: 20px Inter; width: 260px; text-wrap: balance; text-align: center", HEADLINE) },
  ...[180, 240].map((w): TextCase => ({ name: `wrap-style/pretty-${w}`, area: "wrap-style", root: textBox(`font: 16px Inter; width: ${w}px; text-wrap: pretty`, TEXT) })),
  { name: "wrap-style/pretty-orphan", area: "wrap-style", root: textBox("font: 16px Inter; width: 230px; text-wrap: pretty", "A paragraph whose greedy breaking leaves one word") },
  { name: "wrap-style/nowrap", area: "wrap-style", root: textBox("font: 16px Inter; width: 100px; text-wrap: nowrap", "No wrapping here at all") },

  // sizing in flex and grid
  { name: "sizing/flex-row-hug-labels", area: "sizing", root: box("display: flex; gap: 8px; width: 500px", ...["OK", "Cancel", "Save changes", "Delete"].map((l) => textBox("font: 500 14px Inter; padding: 6px 12px; border: 1px solid black", l))) },
  { name: "sizing/flex-row-shrinks-text", area: "sizing", root: box("display: flex; width: 300px", textBox("font: 16px Inter", TEXT), textBox("font: 16px Inter; flex-shrink: 0", "Fixed label")) },
  { name: "sizing/flex-wrap-text-items", area: "sizing", root: box("display: flex; flex-wrap: wrap; gap: 6px; width: 260px", ...["alpha", "beta gamma", "delta epsilon zeta", "eta", "theta iota kappa lambda"].map((t) => textBox("font: 15px Inter; padding: 2px 6px; border: 1px solid black", t))) },
  { name: "sizing/flex-baseline", area: "sizing", root: box("display: flex; align-items: baseline; gap: 10px; width: 400px", textBox("font: 32px Inter", "Big"), textBox("font: 13px Inter", "small text"), textBox("font: 20px 'Noto Sans'; padding-top: 9px", "padded")) },
  { name: "sizing/flex-column-stretch", area: "sizing", root: box("display: flex; flex-direction: column; width: 220px", textBox("font: 16px Inter", TEXT), textBox("font: 16px Inter; align-self: flex-start", "Hugging line")) },
  { name: "sizing/flex-grow-text", area: "sizing", root: box("display: flex; width: 400px", textBox("font: 16px Inter; flex: 1", "Grows to fill"), textBox("font: 16px Inter; flex: 2", "Grows twice as much with longer text that wraps")) },
  { name: "sizing/grid-auto-columns", area: "sizing", root: box("display: grid; grid-template-columns: auto auto 1fr; gap: 10px; width: 420px", textBox("font: 16px Inter", "Name"), textBox("font: 16px Inter", "Description of the item"), textBox("font: 16px Inter", TEXT)) },
  { name: "sizing/grid-min-max-content", area: "sizing", root: box("display: grid; grid-template-columns: min-content max-content; gap: 10px; width: 500px", textBox("font: 16px Inter", "min content column"), textBox("font: 16px Inter", "max content")) },
  { name: "sizing/grid-baseline", area: "sizing", root: box("display: grid; grid-template-columns: 1fr 1fr; align-items: baseline; width: 300px", textBox("font: 28px Inter", "Ag"), textBox("font: 12px Inter", "small baseline aligned")) },
  { name: "sizing/fit-content", area: "sizing", root: box("width: 300px", textBox("font: 16px Inter; width: fit-content", "Short text"), textBox("font: 16px Inter; width: fit-content", TEXT)) },
  { name: "sizing/min-content-width", area: "sizing", root: box("width: 300px", textBox("font: 16px Inter; width: min-content", TEXT)) },
  { name: "sizing/max-content-width", area: "sizing", root: box("width: 300px; position: relative", { style: "position: absolute; font: 16px Inter; width: max-content", text: ["A line that is wider than the container"] }) },
];
