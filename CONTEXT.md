# Context

Surveyor's domain language. A glossary only — implementation decisions live in `docs/adr/`.

## Actors

- **Operator** — the journalist, newsroom or union that runs an Installation. Holds the provider keys and the operator token; the only privileged role.
- **Source** — a person submitting testimony anonymously. Known to the platform only by an access code; never by account, IP address or contact detail.

## Intake

- **Submission** — the record of one source's testimony: sealed answers, access-code HMAC, attachments.
- **Access code** — the one-time secret returned when a submission is created; resumes the submission, answers rounds and manages attachments. Stored as an HMAC only.
- **Round** — a set of follow-up questions served within a submission. Static pool by default; corpus-grounded when a provider registry is configured.
- **Quarantine** — the mechanism that replaces third-party person names with `[person A]`-style markers before any text is sealed or mirrored.
- **Entity** — a quarantined person name: sealed, joined to the pseudonym by HMAC. Revealing it is an audited operator action.
- **Attachment** — a source-uploaded file, held raw in R2 only until its lane drains, then reduced to gated testimony and deleted.

## Corpus

- **Corpus** — the operator-owned body of documents ingested for one investigation.
- **Held lane** — an ingestion path for formats needing the model pass (scans, images, office documents, audio/video). Nothing reaches the mirror until it drains and passes the gate.
- **Mirror** — the searchable, name-gated copy of corpus text. The only text the research engine can read.
- **Recording provenance** — the metadata carried by audio/video evidence (recorder, date, place, jurisdiction, consent status) that the recording gate checks before publication.

## Engine

- **Angle** — a proposed line of investigation grounded in the corpus. Flagged angles are held for operator review.
- **Research line** — the unit of research work: one approved angle pursued to a finding, in v1 by an automated, capped tool loop over the mirror and optionally the web.
- **Finding** — a research line's conclusion, with citations validated against their source text; held when flagged.
- **Web snapshot** — the immutable R2 copy of a fetched web page; the evidence target for a web citation, never the live URL.
- **Flag** — a marker on suspicious model output that holds the item for operator review.
- **Journalist pass** — the model-driven drafting pass per report type; cite-bound, annotates uncited claims, which are stripped at publish unless explicitly approved.

## Reports

- **Report** — an output of one of five report types, rendered from evidence and published as an append-only version.
- **Publish gate** — a stored per-report condition (manual approval or automatic checks) evaluated before publication. Publication is a human act.
- **Launch pack** — the seven assets an investigation ships with (URL, QR, copy and variants).
