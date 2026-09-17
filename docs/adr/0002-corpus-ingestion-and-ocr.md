# ADR-0002: Asynchronous ingestion lanes with vision OCR and a pre-mirror gate

**Status**: Accepted (wayfinder decision, 2026-09-14)

**Deciders**: operator (user), via wayfinder ticket `t03-corpus-ocr`

## Context

Operators hold evidence in any corporate format — PDFs, DOCX, XLSX, PPTX,
images, scans. The platform must turn those into machine-usable text without
ever grounding agent behaviour in un-gated content. The runtime is a Cloudflare
Worker: 128 MB isolate memory (shared across concurrent requests on the
isolate), 100 MB request body, and a per-request CPU budget measured in
milliseconds on the Free plan.

Primary source: the pre-split wayfinder corpus-OCR research (§1 limits table,
§3 native lane, §4 OCR lane, §5 rescue lane, §6 caps, §8 gate placement; not
carried into this repository), which cites developers.cloudflare.com directly.

## Decision

**Upload to R2; never parse in the request.** An upload streams the bytes to R2
and enqueues only the R2 key plus the file class. All extraction happens
asynchronously in a Queue consumer (15-minute wall time) or Workflow step.

**Lanes by file class.** Digital text parses natively (`pdfjs-serverless`/`unpdf`
for PDFs, `mammoth` for DOCX, SheetJS for XLSX, a JSZip text-run walk for PPTX,
direct decode for TXT/MD/CSV). Scanned PDFs and images go through **vision OCR
page-at-a-time**. The hardest material (garbled OCR, handwriting, dense tables)
gets a **multi-modal rescue capped at two pages per file** (superseded by
ADR-0011: the rescue lane is not built; scans rasterise in the browser and OCR
page-at-a-time instead — see the amendment below), after which the file stays
flagged for the journalist.

**The name-leak gate sits before the mirror.** `R2 bytes → lane parser/OCR →
name-leak gate (quarantine + pseudonymise, same semantics as the submission
path) → embeddings / FTS / agent context`. Nothing downstream of the gate —
mirror text, chunks, prompts, logs — ever sees raw third-party names. OCR output
is treated as untrusted input to the gate exactly like native text.

**Per-file status is operator-visible** (`parsed`, `OCRed`, `rescued`, `held`)
with an actionable reason, so the operator knows what the system understood and
what it did not.

## Consequences

**Positive**

- Hostile or oversized input cannot consume request CPU or memory: parsing is
  off the request path and every lane has a cap.
- The gate is a single choke point, so mirror purity does not depend on each
  parser behaving.
- Vision OCR runs in-Worker through the Workers AI binding with no extra egress
  and no third-party OCR vendor.

**Negative / trade-offs**

- Vision token cost is the dominant per-file cost driver, not CPU or storage.
- Fidelity losses are accepted and must be flagged: PPTX text runs miss layout,
  XLSX large sheets are sampled, rescues cover only two pages.
- **Open unknowns carried forward**: OCR accuracy on poor scans (needs a
  measured bake-off), and the PDF page-to-image render step, which has no canvas
  in Workers and must be resolved (client-side render, pre-split images, or a
  Container).
- In-Worker Tesseract is **rejected**: it needs Web Workers or `worker_threads`,
  and its WASM plus trained data exceeds the isolate budget.

## References

- Wayfinder ticket: `t03-corpus-ocr` (pre-split; not carried into this
  repository)
- Research: pre-split wayfinder corpus-OCR report (not carried into this
  repository)
- Remediation against the current build: R6
- **Amendment (2026-09-17)**: the two-page multi-modal rescue is superseded by
  ADR-0011 but not built; scans are rasterised in the browser and OCR'd
  page-at-a-time, and the open PDF page-to-image unknown is answered by
  ADR-0011.
- **Amendment (2026-09-17, campaign C1/C2)**: the named parser libraries
  (`pdfjs-serverless`/`unpdf`, `mammoth`, SheetJS, JSZip) are not used. The
  digital lanes are implemented dependency-free in `src/lib/pdf.ts`,
  `src/lib/zip.ts`, `src/lib/xml.ts` and `src/lib/ooxml.ts` over workerd's
  `DecompressionStream`, with the model pass as the fallback. Trade-off: no new
  supply-chain surface inside the Worker, at the cost of narrower format
  coverage (form XObjects, LZW/predictor streams, Type0 fonts without
  ToUnicode, encrypted PDFs and non-OOXML office variants fall back to the
  model pass); the limits are documented in code and in the C1/C2 receipts.
