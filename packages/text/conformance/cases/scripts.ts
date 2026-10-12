import { box, textBox, type TextCase } from "../case";

const ARABIC = "مرحبا بالعالم، هذا نص عربي طويل للاختبار يلتف عبر عدة أسطر في الفقرة.";
const DEVANAGARI = "नमस्ते दुनिया, यह एक परीक्षण वाक्य है जो कई पंक्तियों में लपेटा जाता है। क्षत्रिय श्री";
const CJK = "中文排版测试：这是一个用于测试换行的文本，包括标点符号。我们可以看到字体如何显示。";
const JAPANESE = "日本語のテキストです。ひらがなとカタカナ、そして漢字。";
const AR = "'Noto Sans Arabic', Inter";
const DEV = "'Noto Sans Devanagari', Inter";
const SC = "'Noto Sans SC', Inter";

/** Bidi, Arabic, Devanagari, CJK, and font features, variable fonts and text-transform. */
export const scriptCases: TextCase[] = [
  // bidi
  { name: "bidi/rtl-paragraph-latin", area: "bidi", root: textBox(`font: 16px ${AR}; width: 260px; direction: rtl`, "Hello world, this is left-to-right text in a right-to-left paragraph.") },
  { name: "bidi/ltr-with-arabic-word", area: "bidi", root: textBox(`font: 16px Inter, 'Noto Sans Arabic'; width: 260px`, "The word عربي appears inside English text and then مرحبا بالعالم again here.") },
  { name: "bidi/rtl-with-latin-word", area: "bidi", root: textBox(`font: 16px ${AR}; width: 260px; direction: rtl`, "هذا نص عربي مع كلمة English في الوسط ثم نص عربي آخر طويل.") },
  { name: "bidi/numbers-in-rtl", area: "bidi", root: textBox(`font: 16px ${AR}; width: 260px; direction: rtl`, "السعر 1234 دولار والرقم 56.78 في عام 2026.") },
  { name: "bidi/neutral-punctuation", area: "bidi", root: textBox(`font: 16px Inter, 'Noto Sans Arabic'; width: 300px`, "(a) عربي (b) [c] عربي! «text» end.") },
  { name: "bidi/rtl-align-start-end", area: "bidi", root: box("width: 260px", textBox(`font: 16px ${AR}; direction: rtl; text-align: start`, "نص قصير"), textBox(`font: 16px ${AR}; direction: rtl; text-align: end`, "نص قصير"), textBox(`font: 16px ${AR}; direction: rtl; text-align: center`, "نص قصير")) },
  { name: "bidi/rtl-indent", area: "bidi", root: textBox(`font: 16px ${AR}; width: 240px; direction: rtl; text-indent: 30px`, ARABIC) },

  // Arabic
  { name: "arabic/joining", area: "arabic", root: textBox(`font: 18px ${AR}; width: 300px; direction: rtl`, ARABIC) },
  { name: "arabic/joining-narrow", area: "arabic", root: textBox(`font: 20px ${AR}; width: 150px; direction: rtl`, ARABIC) },
  { name: "arabic/ltr-paragraph", area: "arabic", root: textBox(`font: 18px ${AR}; width: 300px`, ARABIC) },
  { name: "arabic/joining-across-spans", area: "arabic", root: textBox(`font: 18px ${AR}; width: 300px; direction: rtl`, "مرح", ["font-weight: 700", "با بال"], "عالم") },
  { name: "arabic/weights", area: "arabic", root: box("width: 300px; direction: rtl", ...[300, 400, 700, 900].map((w) => textBox(`font: ${w} 18px ${AR}`, "مرحبا بالعالم"))) },
  { name: "arabic/line-height-fixed", area: "arabic", root: textBox(`font: 16px ${AR}; width: 240px; direction: rtl; line-height: 24px`, ARABIC) },
  { name: "arabic/fallback-in-inter", area: "arabic", root: textBox("font: 16px Inter, 'Noto Sans Arabic'; width: 240px", "Latin first عربي ثاني then Latin again and مزيد من النص") },

  // Devanagari
  { name: "devanagari/conjuncts", area: "devanagari", root: textBox(`font: 18px ${DEV}; width: 300px`, DEVANAGARI) },
  { name: "devanagari/narrow", area: "devanagari", root: textBox(`font: 20px ${DEV}; width: 140px`, DEVANAGARI) },
  { name: "devanagari/weights", area: "devanagari", root: box("width: 300px", ...[300, 500, 800].map((w) => textBox(`font: ${w} 18px ${DEV}`, "क्षत्रिय श्री हिन्दी"))) },
  { name: "devanagari/mixed-latin", area: "devanagari", root: textBox(`font: 16px Inter, 'Noto Sans Devanagari'; width: 260px`, "English text with हिन्दी शब्द mixed into the same paragraph.") },

  // CJK
  { name: "cjk/chinese", area: "cjk", root: textBox(`font: 16px ${SC}; width: 200px`, CJK) },
  { name: "cjk/chinese-narrow", area: "cjk", root: textBox(`font: 18px ${SC}; width: 95px`, CJK) },
  { name: "cjk/japanese-kana", area: "cjk", root: textBox(`font: 16px ${SC}; width: 180px`, JAPANESE) },
  { name: "cjk/mixed-latin", area: "cjk", root: textBox(`font: 16px Inter, 'Noto Sans SC'; width: 200px`, "Fig Tree 是一个设计工具，支持 CSS 排版和 Unicode 文本。") },
  { name: "cjk/justify", area: "cjk", root: textBox(`font: 16px ${SC}; width: 200px; text-align: justify`, CJK) },
  { name: "cjk/line-break-strict", area: "cjk", root: textBox(`font: 16px ${SC}; width: 100px; line-break: strict`, "テストァィゥェォッャュョーです。") },
  { name: "cjk/line-break-normal", area: "cjk", root: textBox(`font: 16px ${SC}; width: 100px; line-break: normal`, "テストァィゥェォッャュョーです。") },

  // OpenType features
  { name: "features/kerning-none", area: "features", root: box("width: 300px", textBox("font: 28px Inter", "AVATAR WAVE To Ty"), textBox("font: 28px Inter; font-kerning: none", "AVATAR WAVE To Ty")) },
  { name: "features/tabular-nums", area: "features", root: box("width: 300px", textBox("font: 18px Inter", "1111 0000 7171"), textBox("font: 18px Inter; font-variant-numeric: tabular-nums", "1111 0000 7171")) },
  { name: "features/feature-settings", area: "features", root: box("width: 400px", textBox("font: 18px Inter; font-feature-settings: 'ss01' 1, 'zero' 1", "a0 b1 c2 Ga 1/2"), textBox("font: 18px Inter; font-feature-settings: 'tnum', 'case'", "(1+1) [x] H-H 1111")) },
  { name: "features/fractions", area: "features", root: textBox("font: 18px Inter; width: 300px; font-variant-numeric: diagonal-fractions", "1/2 3/4 5/8 cups") },
  { name: "features/ligatures-none", area: "features", root: box("width: 300px", textBox("font: 24px 'Noto Sans'", "office fluffy fjord"), textBox("font: 24px 'Noto Sans'; font-variant-ligatures: none", "office fluffy fjord")) },
  { name: "features/contextual-arrows", area: "features", root: box("width: 300px", textBox("font: 20px Inter", "a -> b => c <-> d"), textBox("font: 20px Inter; font-variant-ligatures: no-contextual", "a -> b => c <-> d")) },
  { name: "features/small-caps-feature", area: "features", root: textBox("font: 18px Inter; width: 300px; font-feature-settings: 'smcp'", "Small Caps Text") },

  // variable fonts
  { name: "fonts/variation-settings-wght", area: "fonts", root: box("width: 400px", ...[150, 450, 750].map((w) => textBox(`font: 20px Inter; font-variation-settings: 'wght' ${w}`, `wght ${w} handgloves`))) },
  { name: "fonts/variable-width", area: "fonts", root: box("width: 400px", ...[62.5, 75, 87.5, 100].map((s) => textBox(`font: 20px 'Noto Sans'; font-stretch: ${s}%`, `stretch ${s}% handgloves`))) },
  { name: "fonts/optical-size-auto-vs-none", area: "fonts", root: box("width: 400px", textBox("font: 28px Inter", "Optical size 28 auto"), textBox("font: 28px Inter; font-optical-sizing: none", "Optical size 28 none")) },
  { name: "fonts/matching-weight-fallback", area: "fonts", root: box("width: 400px", ...[100, 350, 450, 550, 600, 800].map((w) => textBox(`font: ${w} 18px 'Noto Static'`, `asked ${w} handgloves`))) },
  { name: "fonts/matching-stretch", area: "fonts", root: box("width: 400px", ...[50, 75, 80, 100, 125].map((s) => textBox(`font: 18px 'Noto Static'; font-stretch: ${s}%`, `stretch ${s} handgloves`))) },
  { name: "fonts/matching-style", area: "fonts", root: box("width: 400px", textBox("font: italic 18px 'Noto Static'", "italic handgloves"), textBox("font: oblique 18px 'Noto Static'", "oblique handgloves"), textBox("font: italic 700 18px 'Noto Static'", "bold italic")) },
  { name: "fonts/family-fallback-list", area: "fonts", root: textBox("font: 16px Missing, 'Noto Sans', Inter; width: 260px", "Falls back to the second family in the list.") },

  // text-transform
  { name: "transform/uppercase", area: "transform", root: textBox("font: 16px Inter; width: 260px; text-transform: uppercase", "The quick brown fox, straße and ĳssel.") },
  { name: "transform/lowercase", area: "transform", root: textBox("font: 16px Inter; width: 260px; text-transform: lowercase", "THE QUICK BROWN FOX AND ÀÉÎÕÜ ĲSSEL") },
  { name: "transform/capitalize", area: "transform", root: textBox("font: 16px Inter; width: 260px; text-transform: capitalize", "the quick brown fox's well-known tale of o'neil") },
  { name: "transform/mixed-runs", area: "transform", root: textBox("font: 16px Inter; width: 260px", "normal ", ["text-transform: uppercase", "upper words"], " normal ", ["text-transform: capitalize", "capital words here"]) },
];
