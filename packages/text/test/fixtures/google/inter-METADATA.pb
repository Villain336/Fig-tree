# A METADATA.pb in the format of github.com/google/fonts, written for the
# tests: it describes the Inter test font under fixtures/fonts/inter.
name: "Inter"
designer: "Test \303\251tude"
license: "OFL"
category: "SANS_SERIF"
date_added: "2020-01-24"
fonts {
  name: "Inter"
  style: "normal"
  weight: 400
  filename: "Inter[opsz,wght].ttf"
  post_script_name: "Inter-Regular"
  full_name: "Inter Regular"
}
fonts {
  name: "Inter"
  style: "italic"
  weight: 400
  filename: "Inter-Italic[opsz,wght].ttf"
  post_script_name: "Inter-Italic"
}
subsets: "latin"
subsets: "latin-ext"
axes {
  tag: "opsz"
  min_value: 14.0
  max_value: 32.0
}
axes {
  tag: "wght"
  min_value: 100.0
  max_value: 900.0
}
source {
  repository_url: "https://example.invalid/inter"
  files {
    source_file: "a.ttf"
    dest_file: "Inter[opsz,wght].ttf"
  }
}
