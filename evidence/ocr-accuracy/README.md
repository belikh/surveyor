# OCR accuracy bake-off — published evidence

Record of `npm run bakeoff:ocr` (D8, #51). This is a runbook, not a unit
test: it synthesises a fixture corpus from published ground truth, runs
every deterministic extraction path over it, and writes the measurements to
[`results.json`](results.json). `test/bakeoff.test.ts` re-runs the bake-off
inside `npm test` and fails when the committed evidence no longer
reproduces.

Run 2026-09-17 on node v24.19.0 / linux-x64 (exact environment and
timestamp in `results.json`). No network and no model calls: every number
below was measured in-process.

## Method

- **Corpus** — eight fixtures: five PDF, two DOCX, one XLSX, one PPTX.
  Each is synthesised deterministically by `test/helpers/bakeoff.ts` from
  its published ground truth, using the same builders the native-parser
  tests use, so no binaries are committed. `results.json` carries each
  fixture's definition (lane, format, what it stresses, ground truth),
  byte length and SHA-256.
- **Paths measured** — native PDF, DOCX, XLSX and PPTX parsing through the
  lane dispatch (`extractNativeText`), and PDF.js text extraction. The
  PDF.js run uses the same library and version the browser lane bundles
  (pdfjs-dist 5.7.284, legacy build) and mirrors the joining in
  `src/frontend/pdf-tools-entry.ts`; it is an in-process run, not a browser
  run (the browser check is A6, #7).
- **Metrics** — whitespace-normalised text. `char_accuracy` is
  `1 - Levenshtein(characters) / length(ground truth)`; `word_accuracy` is
  the same over words; `exact` is normalised equality. For a
  `no text layer` fixture, accuracy is `null` and `exact` means the path
  produced no text. A text fixture with no output scores 0, never a pass.
- **Deliberately not measured** — `env.AI.toMarkdown` document conversion
  and vision OCR over rasterised scans both need a live Workers AI
  binding on a deployed account, which this environment does not have.
  They are recorded in `gaps` in `results.json` with no numbers; see
  "Remaining gap" below.

## Results (this run)

```
fixture             path          outcome  exact  char   word
pdf-plain           native-pdf    text     true   1      1
pdf-plain           pdfjs-text    text     true   1      1
pdf-multipage       native-pdf    text     true   1      1
pdf-multipage       pdfjs-text    text     true   1      1
pdf-cmap            native-pdf    text     true   1      1
pdf-cmap            pdfjs-text    text     true   1      1
pdf-scanlike        native-pdf    empty    true   -      -
pdf-scanlike        pdfjs-text    empty    true   -      -
pdf-lzw             native-pdf    empty    false  0      0
pdf-lzw             pdfjs-text    text     true   1      1
docx-paragraphs     native-docx   text     true   1      1
docx-inline         native-docx   text     true   1      1
xlsx-sheet          native-xlsx   text     true   1      1
pptx-slides         native-pptx   text     true   1      1

path          fixtures  exact  mean char  mean word
native-pdf    5        4      0.75       0.75
native-docx   2        2      1          1
native-xlsx   1        1      1          1
native-pptx   1        1      1          1
pdfjs-text    5        5      1          1
```

## Findings

- **The native parsers are exact within their supported subset**: 13 of
  14 measurements, covering plain and multipage PDF, PDF Type0/ToUnicode
  CMaps, DOCX paragraphs/tables/inline runs, XLSX shared and inline
  strings with numbers and multiple sheets, and PPTX shape order and
  tables.
- **The one measured miss is a documented boundary, not a defect**:
  `pdf-lzw` has an LZW-filtered content stream, outside the native
  parser's filter set (Flate/ASCIIHex/ASCII85). The native path correctly
  produces nothing so the drain falls back to the model lane; PDF.js reads
  the same bytes exactly. The fallback lane is therefore load-bearing for
  real corpora, and its accuracy is the part of this bake-off that still
  needs a live measurement.
- **Scans are the vision lane's job and are correctly refused by the
  deterministic paths**: `pdf-scanlike` (vector-only page) yields no text
  on either path, as designed. No deterministic OCR exists in the Worker,
  so scan accuracy is only knowable from the model lane.

## Remaining gap (explicit, not estimated)

- `workers-ai-toMarkdown` — the `env.AI.toMarkdown` document-conversion
  fallback in the drain lane (`src/lib/drain.ts`).
- `workers-ai-vision-ocr` — vision-model OCR over browser-rasterised scan
  pages (ADR-0011).

Closing them needs a live Workers AI account: run the same corpus plus
scan/rasterised variants (PNG/TIFF pages, low-contrast, rotated, and
LZW/unsupported-filter documents) through `env.AI.toMarkdown` and a vision
model, and append the results as new paths in `results.json`. Until then
the reproducible claim covers the deterministic paths only, and issue #51
stays open.

## Reproduce

```sh
npm ci
npm run bakeoff:ocr                 # rebuild the harness and write results.json
node scripts/ocr-bakeoff.mjs --check  # compare without writing; exits non-zero on drift
```

`npm test` includes the same comparison, so committed evidence that no
longer matches the corpus and parsers fails CI.

## Where the findings are linked from

- ADR-0002 (corpus ingestion) amendment of 2026-09-17 — the OCR-quality
  open unknown now points here and states the remaining model-lane gap.
- THREAT-MODEL §5 (open unknowns) — the OCR-accuracy line now carries this
  evidence and scope.
