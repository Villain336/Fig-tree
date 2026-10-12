import { box, textBox, type TextCase } from "../case";

const TEXT = "The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs.";
const SPACED = "  Leading   spaces,\tinner   runs\tand tabs,   trailing   ";
const LINES = "First line\nSecond   line with   spaces\n\nFourth after blank\n  indented fifth";

/** White space processing, line breaking, spacing, line height and alignment. */
export const lineCases: TextCase[] = [
  // white-space
  ...(["normal", "pre", "nowrap", "pre-wrap", "pre-line", "break-spaces"] as const).flatMap((ws): TextCase[] => [
    { name: `white-space/${ws}-spaces`, area: "white-space", root: textBox(`font: 16px Inter; width: 220px; white-space: ${ws}`, SPACED) },
    { name: `white-space/${ws}-newlines`, area: "white-space", root: textBox(`font: 16px Inter; width: 220px; white-space: ${ws}`, LINES) },
  ]),
  { name: "white-space/collapse-across-spans", area: "white-space", root: textBox("font: 16px Inter; width: 300px", "one ", ["font-weight: 700", " two "], " three") },
  { name: "white-space/pre-wrap-trailing-spaces-hang", area: "white-space", root: textBox("font: 16px Inter; width: 100px; white-space: pre-wrap", "aaaa bbbb      cccc dddd") },
  { name: "white-space/tab-size", area: "white-space", root: textBox("font: 16px Inter; width: 400px; white-space: pre; tab-size: 4", "a\tbb\tccc\tdddd\te") },
  { name: "white-space/nowrap-shrink-to-fit", area: "white-space", root: box("position: relative", { style: "position: absolute; font: 16px Inter; white-space: nowrap", text: [TEXT] }) },

  // breaking
  { name: "breaking/hyphen-minus", area: "breaking", root: textBox("font: 16px Inter; width: 130px", "state-of-the-art well-known e-mail x-ray") },
  { name: "breaking/slashes-and-urls", area: "breaking", root: textBox("font: 16px Inter; width: 150px", "see https://example.com/path/to/a/page and a/b/c") },
  { name: "breaking/overflow-wrap-break-word", area: "breaking", root: textBox("font: 16px Inter; width: 120px; overflow-wrap: break-word", "An extraordinarilylongunbreakableword in text") },
  { name: "breaking/overflow-wrap-anywhere", area: "breaking", root: textBox("font: 16px Inter; width: 120px; overflow-wrap: anywhere", "An extraordinarilylongunbreakableword in text") },
  { name: "breaking/overflow-wrap-anywhere-min-content", area: "breaking", root: box("display: flex; width: 10px", textBox("font: 16px Inter; overflow-wrap: anywhere", "word")) },
  { name: "breaking/word-break-break-all", area: "breaking", root: textBox("font: 16px Inter; width: 150px; word-break: break-all", TEXT) },
  { name: "breaking/word-break-keep-all-cjk", area: "breaking", root: textBox("font: 16px 'Noto Sans SC'; width: 120px; word-break: keep-all", "中文 排版 测试 文本 换行 标点 符号") },
  { name: "breaking/soft-hyphens", area: "breaking", root: textBox("font: 16px Inter; width: 110px", "hyphen­ation is in­ter­est­ing for type­set­ting") },
  { name: "breaking/soft-hyphens-none", area: "breaking", root: textBox("font: 16px Inter; width: 110px; hyphens: none", "hyphen­ation is in­ter­est­ing") },
  { name: "breaking/nbsp-and-zwsp", area: "breaking", root: textBox("font: 16px Inter; width: 120px", "keep these together but​this​can​break") },
  { name: "breaking/quotes-and-brackets", area: "breaking", root: textBox("font: 16px Inter; width: 140px", "He said “hello (world)” and [left] {right} «guillemets» ‘single’") },
  { name: "breaking/narrow-width", area: "breaking", root: textBox("font: 16px Inter; width: 30px", "a bc def ghij") },
  { name: "breaking/zero-width", area: "breaking", root: textBox("font: 16px Inter; width: 0px", "tiny words here") },
  { name: "breaking/exact-fit", area: "breaking", root: box("position: relative", { style: "position: absolute; font: 16px Inter", text: ["exact fit"] }, textBox("font: 16px Inter; width: 64px", "exact fit word")) },

  // spacing
  ...[-1, 0.5, 2, 4].map((ls): TextCase => ({ name: `spacing/letter-${ls}px`, area: "spacing", root: textBox(`font: 16px Inter; width: 260px; letter-spacing: ${ls}px`, TEXT) })),
  { name: "spacing/letter-em", area: "spacing", root: textBox("font: 18px 'Noto Sans'; width: 260px; letter-spacing: 0.1em", TEXT) },
  ...[3, 10, -2].map((ws): TextCase => ({ name: `spacing/word-${ws}px`, area: "spacing", root: textBox(`font: 16px Inter; width: 260px; word-spacing: ${ws}px`, TEXT) })),
  { name: "spacing/letter-and-word-runs", area: "spacing", root: textBox("font: 16px Inter; width: 300px", "Normal then ", ["letter-spacing: 3px", "tracked out"], " then ", ["word-spacing: 12px", "wide word gaps here"], " end.") },
  { name: "spacing/indent-px", area: "spacing", root: textBox("font: 16px Inter; width: 260px; text-indent: 40px", TEXT) },
  { name: "spacing/indent-negative", area: "spacing", root: textBox("font: 16px Inter; width: 260px; text-indent: -20px; padding-left: 20px", TEXT) },
  { name: "spacing/indent-percent", area: "spacing", root: textBox("font: 16px Inter; width: 260px; text-indent: 10%", TEXT) },

  // line-height
  ...["normal", "1", "1.2", "1.5", "2", "20px", "13.5px", "150%", "0.8"].map((lh): TextCase => ({
    name: `line-height/${lh}`,
    area: "line-height",
    root: textBox(`font: 16px Inter; width: 220px; line-height: ${lh}`, TEXT),
  })),
  { name: "line-height/noto-normal", area: "line-height", root: textBox("font: 16px 'Noto Sans'; width: 220px", TEXT) },
  { name: "line-height/mixed-sizes-normal", area: "line-height", root: textBox("font: 14px Inter; width: 240px", "Small ", ["font-size: 30px", "Big"], " small again and more words to wrap ", ["font-size: 22px", "medium"], " text.") },
  { name: "line-height/mixed-sizes-fixed", area: "line-height", root: textBox("font: 14px Inter; width: 240px; line-height: 18px", "Small ", ["font-size: 30px", "Big"], " small again and more words to wrap ", ["font-size: 22px", "medium"], " text.") },
  { name: "line-height/span-line-height", area: "line-height", root: textBox("font: 14px Inter; width: 240px; line-height: 20px", "Root ", ["line-height: 40px", "tall span"], " and ", ["line-height: 8px; font-size: 24px", "short span"], " wrap wrap wrap") },
  { name: "line-height/mixed-fonts-normal", area: "line-height", root: textBox("font: 16px Inter; width: 260px", "Inter and ", ["font-family: 'Noto Sans'", "Noto Sans"], " and ", ["font-family: 'Noto Sans SC'", "中文字体"], " mixed.") },
  { name: "line-height/fractional", area: "line-height", root: textBox("font: 15px Inter; width: 220px; line-height: 1.37", TEXT) },

  // alignment
  ...(["left", "right", "center", "justify", "start", "end"] as const).map((a): TextCase => ({ name: `align/${a}`, area: "align", root: textBox(`font: 16px Inter; width: 250px; text-align: ${a}`, TEXT) })),
  { name: "align/justify-last-center", area: "align", root: textBox("font: 16px Inter; width: 250px; text-align: justify; text-align-last: center", TEXT) },
  { name: "align/justify-with-letter-spacing", area: "align", root: textBox("font: 16px Inter; width: 250px; text-align: justify; letter-spacing: 1px", TEXT) },
  { name: "align/center-with-indent", area: "align", root: textBox("font: 16px Inter; width: 250px; text-align: center; text-indent: 30px", TEXT) },
  { name: "align/right-pre-wrap-spaces", area: "align", root: textBox("font: 16px Inter; width: 160px; text-align: right; white-space: pre-wrap", "trailing spaces   \nhang   at the end    of lines") },
  { name: "align/center-overflowing-word", area: "align", root: textBox("font: 16px Inter; width: 80px; text-align: center", "Unbreakablelongword short") },
];
