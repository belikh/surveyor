# ADR-0012: Submitter file uploads under a controlled Principle I exception

**Status**: Accepted (2026-09-16, user-approved exception recorded in plan.md)

**Deciders**: operator (user), 2026-09-16 grilling

## Context

Sources could not attach documents. The operator wants submitter file uploads,
including OCR of scanned PDFs, which requires the file to reach a server. That
collides with **Principle I (NON-NEGOTIABLE): raw submitter-identifying
originals are NEVER persisted.** The constitution permits a violation only with
explicit user approval recorded in the spec's Complexity Tracking table. No
server-side rasteriser exists (ADR-0011), so rasterisation must be client-side
while OCR runs server-side.

## Decision

- **In scope**: submitter file uploads, built alongside R6.
- **Pipeline**: digital-text PDFs are extracted **in-browser** and submitted as
  text only. Scanned PDFs are rasterised **in-browser** (self-hosted PDF.js);
  the page images upload **through the Worker** (streamed, not buffered) into a
  **private R2 key**. The server vision-OCRs the pages, runs the name-leak gate,
  then **deletes** the raw bytes.
- **Failure**: a bounded **24 h retry window** keeps the raw pages for retry,
  then deletes them. The window is enforced by the scheduled raw-byte sweep
  (`src/lib/retention.ts`, A3), which deletes bytes no drain reached — even
  when a file never drains at all — and records a deletion receipt.
- **Limits**: no file-count limit; **50 MB per file**; **200 MB per
  submission**; PDFs, images, docx/xlsx.
- **Custody**: extracted text joins the submission's **testimony only**,
  quarantined and sealed like free-text. Reaching the corpus mirror requires a
  separate, audited operator promotion.
- **Consent**: the source-facing copy discloses upload, processing to text, and
  deletion, with the same identifying-detail stripping as written answers.
- **Control as claimed**: private and transient. The carve-out **does not claim
  an at-rest seal** — chunked AES-GCM sealing at 50 MB was rejected as
  disproportionate, and presigned direct-to-R2 was rejected to avoid new S3
  credentials and a plaintext path that skips the Worker.

The exception is recorded in `specs/002-investigation-platform/plan.md`
(Complexity Tracking) as a user-approved violation of Principle I.

## Consequences

**Positive**

- Sources can attach evidence without the platform pretending raw bytes never
  touch a disk.
- The exception is narrow: one table, one lane, private, bounded, deleted.
- Client-side rasterisation keeps the document on the source's device wherever
  OCR is unnecessary.

**Negative / trade-offs**

- Raw submitter pages exist unencrypted in the operator's private R2 for a
  bounded window — the platform's strongest promise is weakened by exactly that
  much, and the threat model states it.
- 50 MB per file through the Worker consumes Worker bandwidth and request
  budget; the per-submission cap is the outer bound.
- Malformed or hostile documents reach the vision lane; the existing size caps,
  lane classification, and gate remain the mitigations.

## References

- Spec FR-045–FR-050; plan.md Complexity Tracking
- Related: ADR-0011 (rasterisation), ADR-0002 (ingestion custody)
