# Test fonts

Fonts used by the text engine's tests, the text conformance suite and the editor's sample document. All are licensed under the **SIL Open Font License 1.1**; each directory holds the family's `OFL.txt` with its copyright line. None of the fonts below uses a Reserved Font Name for its family name.

They are subsets (and, where noted, static instances) of the upstream files, made with HarfBuzz's subsetter by [`scripts/fonts/build-fixtures.mjs`](../../scripts/fonts/build-fixtures.mjs), which keeps every OpenType layout feature of the font and, unless an instance is made, every variation axis. Rebuild them with `node scripts/fonts/build-fixtures.mjs <download-dir>` after downloading the upstream files listed here into `<download-dir>` (named `<dir>_<file>`, for example `inter_Inter[opsz,wght].ttf`).

| File | Upstream (github.com/google/fonts, branch `main`) | Kept |
|---|---|---|
| `inter/Inter[opsz,wght].ttf` | `ofl/inter/Inter[opsz,wght].ttf` | Latin, Latin-1, Latin Extended-A, combining marks, general punctuation, a few symbols; `opsz` and `wght` axes |
| `inter/Inter-latin.woff2` | `https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7.woff2` (Google Fonts' own Latin subset, unmodified) | as served |
| `noto-sans/NotoSans[wdth,wght].ttf` | `ofl/notosans/NotoSans[wdth,wght].ttf` | as Inter; `wdth` and `wght` axes |
| `noto-sans/NotoSans-Italic[wdth,wght].ttf` | `ofl/notosans/NotoSans-Italic[wdth,wght].ttf` | Basic Latin, Latin-1, punctuation |
| `noto-sans/NotoSans-{Light,Regular,Bold,Black,Condensed}.ttf` | static instances of `NotoSans[wdth,wght].ttf` (wght 300/400/700/900 at wdth 100; wght 400 at wdth 75) | Basic Latin, Latin-1, punctuation |
| `noto-sans/NotoSans-{Italic,BoldItalic}.ttf` | static instances of `NotoSans-Italic[wdth,wght].ttf` (wght 400/700) | Basic Latin, Latin-1, punctuation |
| `noto-sans-arabic/NotoSansArabic[wdth,wght].ttf` | `ofl/notosansarabic/NotoSansArabic[wdth,wght].ttf` | Arabic block, ASCII punctuation and digits, ZWNJ/ZWJ/LRM/RLM, dotted circle |
| `noto-sans-devanagari/NotoSansDevanagari[wdth,wght].ttf` | `ofl/notosansdevanagari/NotoSansDevanagari[wdth,wght].ttf` | Devanagari block, ASCII, ZWNJ/ZWJ, dotted circle |
| `noto-sans-sc/NotoSansSC-Regular.ttf` | static wght 400 instance of `ofl/notosanssc/NotoSansSC[wght].ttf` | CJK punctuation, kana, fullwidth forms, about 560 hanzi |

Noto Sans SC's license names "Source" as a Reserved Font Name (it derives from Source Han Sans); the subset keeps the family name Noto Sans SC, which does not use it.
