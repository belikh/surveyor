# Report-quality evaluation — published evidence

Record of `npm run quality:report` (D9, #52). This is a runbook, not a unit
test: it seeds a fixture investigation into an in-memory D1, runs every
deterministic and scripted report path over it, and writes the measurements
to [`results.json`](results.json). `test/report-quality.test.ts` re-runs the
evaluation inside `npm test` and fails when the committed evidence no longer
reproduces.

Run 2026-09-17 on node v24.19.0 / linux-x64 (exact environment and timestamp
in `results.json`). No network and no model calls: the provider is scripted
with published fixture outputs and every number below was measured
in-process.

## Method

- **Fixture investigation** — four corpus documents (three mirrored, one
  held) and two research lines (one complete with two validated citations,
  one held and flagged). The held document and line carry distinctive text
  and snippets so a leak into any body is detectable. Every doc, line,
  citation and flag is published in `results.json` under `investigation`,
  with a SHA-256 over the whole definition.
- **Scripted provider outputs** — for each report type, a mixed fixture of
  six claims with a known truth: two supportable, one fabricated snippet (a
  document exists but does not contain the quote), one unknown document id,
  one held document (not mirrored) and one uncited. A separate marker
  fixture carries citation-valid prose with an injection marker. Snapshot is
  lead-only, so its fixture is a lead. The provider client returns the
  fixture JSON verbatim; this measures what the pipeline does with known
  input, not what a live model writes (see "Remaining gap").
- **Paths measured** — the five deterministic renderers over the evidence
  bundle (`src/lib/reports.ts` via `gatherEvidence`); the journalist pass in
  draft mode (uncited claims annotated) and through
  `publishReportVersion` in publish mode (strict stripping, sealed
  append-only version); and `publishReportVersion` against the marker
  fixture (deterministic fallback). Every path runs for every report type:
  20 measurements, each carrying the SHA-256 of the delivered body.
- **Metrics** — claims are the scripted claims (or evidence lines for the
  deterministic and fallback paths); citations are the `[doc_id: snippet]`
  pairs the delivered body carries.
  - `citation_accuracy` — proposed citations that occur verbatim in a
    mirrored document, over proposed citations. It scores the *proposal*
    side; the mixed fixture is 40% valid by construction. `null` for the
    lead-only snapshot.
  - `quote_fidelity` — delivered quotes that occur verbatim in their cited
    source, over delivered quotes. `null` when a path delivers no quotes.
  - `claim_coverage` — supportable claims delivered, over supportable claims
    proposed. `null` for the lead-only snapshot.
  - `fabricated_quotes_delivered`, `held_content_leaked` and `marker_in_body`
    are the hard enforcement counters: zero (or false) on every measurement.
    `uncited_markers` and `unsupported_claims_delivered` are non-zero in
    drafts — that is the annotation — and must be zero in published versions.
  - `control_present` — the body carries its positive control: the clean
    line, a grounded scripted claim, or the snapshot's citation tally. A
    leak-free measurement cannot pass by delivering nothing.

## Results (this run)

```
report_type  path                     outcome                 claims  quotes  fidelity  uncited  leak  marker
briefing     deterministic            deterministic-render    1/1     0       -         0        false false
briefing     journalist-draft         model-prose             6/6     2       1         4        false false
briefing     publish-version          model-prose             2/6     2       1         0        false false
briefing     publish-marker-fallback  deterministic-fallback  1/1     0       -         0        false false
dossier      deterministic            deterministic-render    1/1     2       1         0        false false
dossier      journalist-draft         model-prose             6/6     2       1         4        false false
dossier      publish-version          model-prose             2/6     2       1         0        false false
dossier      publish-marker-fallback  deterministic-fallback  1/1     2       1         0        false false
timeline     deterministic            deterministic-render    1/1     0       -         0        false false
timeline     journalist-draft         model-prose             6/6     2       1         4        false false
timeline     publish-version          model-prose             2/6     2       1         0        false false
timeline     publish-marker-fallback  deterministic-fallback  1/1     0       -         0        false false
snapshot     deterministic            deterministic-render    0/0     0       -         0        false false
snapshot     journalist-draft         model-prose             0/0     0       -         0        false false
snapshot     publish-version          model-prose             0/0     0       -         0        false false
snapshot     publish-marker-fallback  deterministic-fallback  0/0     0       -         0        false false
longform     deterministic            deterministic-render    1/1     2       1         0        false false
longform     journalist-draft         model-prose             6/6     2       1         4        false false
longform     publish-version          model-prose             2/6     2       1         0        false false
longform     publish-marker-fallback  deterministic-fallback  1/1     2       1         0        false false

path                     n  citation accuracy  quote fidelity  claim coverage  fabricated  unsupported  uncited  leaks  fallbacks
deterministic            5  1                  1               1               0           0            0        0      0
journalist-draft         5  0.4                1               1               0           16           16       0      0
publish-version          5  0.4                1               1               0           0            0        0      0
publish-marker-fallback  5  1                  1               1               0           0            0        0      5
```

## Findings

- **No fabricated quote reached a report.** The scripted provider proposed
  five citations of which two resolve in the mirror; across all 20
  measurements the delivered bodies carried only those validated quotes (or
  none, for the renderers that do not print excerpts) and
  `fabricated_quotes_delivered` was zero everywhere. The pass grounds each
  citation against the opened mirror text and an unresolvable snippet is
  dropped before rendering, so a quote in a draft or a version is one the
  source actually contains.
- **Uncited-claim stripping is measured end to end.** Drafts delivered all
  six claims and annotated the four unsupported ones with `[uncited]`;
  published versions carried only the two supportable claims — zero
  unsupported claims, zero `[uncited]` markers — while keeping claim coverage
  at 1 (every supportable claim survived to the sealed version). This is
  ADR-0010's annotate-then-strip rule, measured rather than asserted.
- **Held material never reached a report.** The held line (flagged, citation
  pointing at the held document) and the held document's text appeared in
  none of the 20 bodies, and every body's positive control was present — the
  clean line for evidence-backed paths, a grounded scripted claim for the
  model paths, the statistics tally for snapshot. The upstream rule that
  turns a flagged finding into a held line is B3 (#21); what this evaluation
  measures is the report surface — a held line, whatever made it held,
  reaches no report type.
- **Marker prose is rejected wholesale.** All five marker fixtures fell back
  to the deterministic render at publish, so no version carried the marker
  and none carried the model prose that contained it. The deterministic
  fallback retains the clean line, which is why the fallback rows still show
  a present control.
- **The lead-only snapshot is treated honestly.** Snapshot is statistics plus
  a model-written lead by design (ADR-0010), so its claim and quote metrics
  are `null` rather than zero, and the measurement instead checks the lead
  (present in the draft and the version) and the statistics control.
- **Briefing and timeline render no excerpts by design.** Their
  deterministic bodies carry claim titles and citation counts, not
  `[doc_id: snippet]` pairs; their fidelity is therefore `null` (no quotes to
  verify) rather than a failure.

## Remaining gap (explicit, not estimated)

- `live-model-citation-accuracy` — the share of a live provider's proposed
  citations that resolve in the mirror. The scripted fixture fixes this at
  0.4 by construction; how a real model performs is unmeasured.
- `live-model-claim-coverage` — whether a live provider's prose covers the
  supportable facts at all, and how often it invents claims. A scripted
  output cannot measure generation quality.

Closing them needs a live BYOK provider (or Workers AI run): replay the same
fixture investigation and scripted claim mix against a real provider, and
append the measured proposal-side numbers beside the enforcement numbers
here. Until then the reproducible claim covers the pipeline's enforcement
only — that no report delivers a quote its mirror does not contain, no
uncited claim reaches a version, and no held or marker-laden material
reaches any report type.

## Reproduce

```sh
npm ci
npm run quality:report                    # rebuild the harness and write results.json
node scripts/report-quality.mjs --check   # compare without writing; exits non-zero on drift
```

`npm test` includes the same comparison, so committed evidence that no
longer matches the fixtures and paths fails CI.

## Where the findings are linked from

- ADR-0010 (journalist pass) — amendment of 2026-09-17: the cite-bound,
  annotate-then-strip rules now carry this measured evidence and state the
  remaining live-model gap.
- README "Living reports" — the report bullet now points here.
- THREAT-MODEL T8 (auto-publish poisoning / defamation) and §5 (open
  unknowns) — the held-lines and uncited-stripping mitigations cite this
  evidence, and the live-model gap is recorded as an open unknown.
