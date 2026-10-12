// Builds the vendored test fonts in fixtures/fonts/ from upstream files.
//
//   node scripts/fonts/build-fixtures.mjs <download-dir>
//
// <download-dir> holds the unmodified upstream files from google/fonts (see
// fixtures/fonts/README.md for their URLs). The fonts are only read as data:
// HarfBuzz's subsetter (harfbuzzjs, MIT) keeps the listed Unicode ranges,
// every OpenType layout feature the font has and, unless an instance is
// requested, every variation axis. All fonts here are licensed under the SIL
// Open Font License 1.1, which allows subsetting; none of the subsets uses a
// Reserved Font Name.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = process.argv[2];
if (!src) throw new Error("usage: node scripts/fonts/build-fixtures.mjs <download-dir>");
const out = join(root, "fixtures", "fonts");

const { instance } = await WebAssembly.instantiate(readFileSync(join(root, "node_modules/harfbuzzjs/dist/harfbuzz-subset.wasm")));
const hb = instance.exports;
const { Face, Blob } = await import("harfbuzzjs");

const tag = (s) => ((s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)) >>> 0;
const SETS_LAYOUT_FEATURE_TAG = 6;

function featureTags(bytes) {
  const face = new Face(new Blob(bytes));
  return [...new Set([...face.getTableFeatureTags("GSUB"), ...face.getTableFeatureTags("GPOS")])];
}

/** Subsets `bytes` to `codepoints`, keeping all layout features; pins `pin` axes to the given values. */
function subset(bytes, codepoints, pin = {}) {
  const heap = () => new Uint8Array(hb.memory.buffer);
  const ptr = hb.malloc(bytes.length);
  heap().set(bytes, ptr);
  const blob = hb.hb_blob_create(ptr, bytes.length, 2 /* writable */, 0, 0);
  const face = hb.hb_face_create(blob, 0);
  hb.hb_blob_destroy(blob);
  const input = hb.hb_subset_input_create_or_fail();
  const unicodes = hb.hb_subset_input_unicode_set(input);
  for (const cp of codepoints) hb.hb_set_add(unicodes, cp);
  const features = hb.hb_subset_input_set(input, SETS_LAYOUT_FEATURE_TAG);
  for (const t of featureTags(bytes)) hb.hb_set_add(features, tag(t));
  for (const [axis, value] of Object.entries(pin)) {
    if (!hb.hb_subset_input_pin_axis_location(input, face, tag(axis), value)) throw new Error(`cannot pin ${axis}`);
  }
  const result = hb.hb_subset_or_fail(face, input);
  if (!result) throw new Error("subset failed");
  const outBlob = hb.hb_face_reference_blob(result);
  const lenPtr = hb.malloc(4);
  const data = hb.hb_blob_get_data(outBlob, lenPtr);
  const len = new Uint32Array(hb.memory.buffer, lenPtr, 1)[0];
  const copy = heap().slice(data, data + len);
  hb.free(lenPtr);
  hb.free(ptr);
  return copy;
}

const ranges = (...rs) => rs.flatMap(([a, b]) => Array.from({ length: (b ?? a) - a + 1 }, (_, i) => a + i));
const chars = (s) => [...s].map((c) => c.codePointAt(0));

const LATIN = ranges([0x20, 0x7e], [0xa0, 0x17f], [0x300, 0x36f], [0x2000, 0x206f], [0x20ac], [0x2122], [0x2190, 0x2193], [0x2212], [0xfb00, 0xfb06], [0xfeff], [0xfffd]);
const LATIN_BASIC = ranges([0x20, 0x7e], [0xa0, 0xff], [0x2000, 0x206f]);
const ARABIC = ranges([0x20, 0x40], [0x5b, 0x60], [0x7b, 0x7e], [0xa0], [0x600, 0x6ff], [0x200c, 0x200f], [0x25cc]);
const DEVANAGARI = ranges([0x20, 0x7e], [0xa0], [0x900, 0x97f], [0x200c, 0x200d], [0x25cc]);
// CJK: punctuation, kana, fullwidth forms and about 500 frequent hanzi.
const HANZI =
  "的一是不了人我在有他这中大来上国个到说们为子和你地出道也时年得就那要下以生会自着去之过家学对可她里后小么心多天而能好都然没日于起还发成事只作当想看文无开手十用主行方又如前所本见经头面公同三已老从动两长知民样现分将外但身些与高意进把法此实回二理美点月明其种声全工己话儿者向情部正名定女问力机给等几很业最间新什打便位因重被走电四第门相次东政海口使教西再平真听世气信北少关并内加化由却代军产入先山五太水万市眼体别处总才场师书比住员九笑性通目华报立马命张活难神数件安表原车白应路期叫死常提感金何更反合放做系计或司利受光王果亲界及今京务制解各任至清物台象记边共风战干接它许八特觉望直服毛林题建南度统色字请交爱让认算论百吃义科怎元社术结六功指思非流每青管夫连远资队跟带花快条院变联言权往展该领传近留红治决周保达办运武半候七必城父强步完革深区即求品士转量空甚众技轻程告江语英基派满式李息写呢识极令黄德收脸钱党倒未持音跑投注切亚官找排版字体文本测试换行标点符号汉语日本語";
// Every CJK character the conformance cases and the editor sample use.
const CASE_TEXT = "中文排版测试：这是一个用于测试换行的文本，包括标点符号。我们可以看到字体如何显示。日本語のテキストです。ひらがなとカタカナ、そして漢字。中文 排版 测试 文本 换行 标点 符号 是一个设计工具，支持排版和文本。设计工具界面布局文字段落标题正文列表间距对齐";
const CJK = [...chars(CASE_TEXT), ...ranges([0x20, 0x7e], [0xa0], [0x2018, 0x201d], [0x2026], [0xb7], [0x3000, 0x303f], [0x3040, 0x30ff], [0xff00, 0xffef]), ...chars(HANZI)];

const read = (name) => new Uint8Array(readFileSync(join(src, name)));
const jobs = [
  { dir: "inter", license: "inter_OFL.txt", files: [["Inter[opsz,wght].ttf", "inter_Inter[opsz,wght].ttf", LATIN, {}]] },
  {
    dir: "noto-sans",
    license: "notosans_OFL.txt",
    files: [
      ["NotoSans[wdth,wght].ttf", "notosans_NotoSans[wdth,wght].ttf", LATIN, {}],
      ["NotoSans-Italic[wdth,wght].ttf", "notosans_NotoSans-Italic[wdth,wght].ttf", LATIN_BASIC, {}],
      // Static instances, for font-matching tests with separate faces.
      ["NotoSans-Light.ttf", "notosans_NotoSans[wdth,wght].ttf", LATIN_BASIC, { wdth: 100, wght: 300 }],
      ["NotoSans-Regular.ttf", "notosans_NotoSans[wdth,wght].ttf", LATIN_BASIC, { wdth: 100, wght: 400 }],
      ["NotoSans-Bold.ttf", "notosans_NotoSans[wdth,wght].ttf", LATIN_BASIC, { wdth: 100, wght: 700 }],
      ["NotoSans-Black.ttf", "notosans_NotoSans[wdth,wght].ttf", LATIN_BASIC, { wdth: 100, wght: 900 }],
      ["NotoSans-Italic.ttf", "notosans_NotoSans-Italic[wdth,wght].ttf", LATIN_BASIC, { wdth: 100, wght: 400 }],
      ["NotoSans-BoldItalic.ttf", "notosans_NotoSans-Italic[wdth,wght].ttf", LATIN_BASIC, { wdth: 100, wght: 700 }],
      ["NotoSans-Condensed.ttf", "notosans_NotoSans[wdth,wght].ttf", LATIN_BASIC, { wdth: 75, wght: 400 }],
    ],
  },
  { dir: "noto-sans-arabic", license: "notosansarabic_OFL.txt", files: [["NotoSansArabic[wdth,wght].ttf", "notosansarabic_NotoSansArabic[wdth,wght].ttf", ARABIC, {}]] },
  { dir: "noto-sans-devanagari", license: "notosansdevanagari_OFL.txt", files: [["NotoSansDevanagari[wdth,wght].ttf", "notosansdevanagari_NotoSansDevanagari[wdth,wght].ttf", DEVANAGARI, {}]] },
  { dir: "noto-sans-sc", license: "notosanssc_OFL.txt", files: [["NotoSansSC-Regular.ttf", "notosanssc_NotoSansSC[wght].ttf", CJK, { wght: 400 }]] },
];

for (const job of jobs) {
  const dir = join(out, job.dir);
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(src, job.license), join(dir, "OFL.txt"));
  for (const [name, from, cps, pin] of job.files) {
    const bytes = subset(read(from), cps, pin);
    writeFileSync(join(dir, name), bytes);
    console.log(`${job.dir}/${name}: ${bytes.length} bytes`);
  }
}
// An unmodified WOFF2 file as served by Google Fonts (Inter, latin subset), for the WOFF2 decoder.
mkdirSync(join(out, "inter"), { recursive: true });
copyFileSync(join(src, "gstatic_inter-latin.woff2"), join(out, "inter", "Inter-latin.woff2"));
