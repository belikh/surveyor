# ADR-0011: Ingestion — native parse, toMarkdown fallback, browser rasterisation

**Status**: Accepted (2026-09-16, user decisions under grilling)

**Deciders**: operator (user), remediation R6

## Context

R6 requires real extraction: digital documents text-parse; scans OCR. Research
established that **no server-side PDF rasteriser is viable on Workers**: workerd
forbids runtime Wasm compilation, and every WASM PDF renderer (MuPDF, PDFium,
pdfjs+canvas) fetches its `.wasm` at runtime; MuPDF's workerd support is an open,
unresolved issue. Cloudflare does document `env.AI.toMarkdown()` (PDF, office,
images, HTML, and more) and a current vision-model catalogue.

## Decision

- **Digital documents** parse natively in JS where a reliable library exists,
  with **`env.AI.toMarkdown` as the fallback** for formats the native lane
  cannot handle.
- **Scans and images** go through **vision OCR** (page-at-a-time).
- Provider entries gain a **`capabilities: ["vision"]` tag**; the OCR lane
  routes only to capable entries; the wizard asks for capabilities. Keyless
  fallback is a workers-AI vision model (OCR-specialist); BYOK DeepSeek Flash
  is an option.
- **Rasterisation happens in the browser**: a self-hosted PDF.js renderer (CSP
  `self`) turns scanned PDF pages into images for both the operator corpus
  uploader and the submitter survey. **Digital-text PDFs are extracted
  in-browser and submitted as text only** — no upload.
- When the vision lane is unavailable or its allowance is exhausted, the file
  **stays held with an actionable reason** naming the missing capability.

## Consequences

**Positive**

- No server-side rasteriser, no Container, no third-party OCR service; the $0
  free-tier promise holds.
- Capability tagging stops the lane routing images to a text-only model.
- Browser extraction means digital documents never leave the submitter's
  device at all.

**Negative / trade-offs**

- The browser carries PDF.js (bundle and complexity), and rasterising large
  PDFs is bounded by the submitter's device.
- A PDF-only scan that cannot be rasterised (e.g. no browser path) stays held;
  MuPDF-WASM remains a tracked research spike, not a dependency.
- `toMarkdown` is an AI call: neuron cost and a network dependency for the
  fallback lane.

## References

- Remediation: R6; spec FR-009–FR-017
- Research: pre-split wayfinder corpus-OCR report (not carried into this
  repository)
- Related: ADR-0002 (ingestion), ADR-0012 (submitter files)
