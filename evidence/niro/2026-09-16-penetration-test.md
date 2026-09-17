# Niro penetration-test run — 2026-09-16

Published evidence, promoted from the run's 30-day CI artefact. The unchanged
report sits beside this record:
[2026-09-16-penetration-test-report.pdf](2026-09-16-penetration-test-report.pdf).

## Date and scope

- **Date**: 2026-09-16 (the report's evidence date; the run ran
  2026-09-16T20:12Z–2026-09-16T22:11Z).
- **Scope**: the whole Surveyor application, in checkout mode — Niro started
  the committed `niro/` harness on the runner and tested the app at
  `http://127.0.0.1:8788`, the only host `niro/scope.yaml` authorises.
- **Commit under test**: `2b029a8`.
- **Tooling**: Niro Community Edition v0.1.80 (`find --autonomous`,
  `--include-findings=true`, debug logs not uploaded); agent GitHub Copilot CLI
  1.0.80 with DeepSeek `deepseek-flash` through the BYOK provider.

## Provenance

- Workflow run: [Niro find #35145113911](https://github.com/belikh/surveyor/actions/runs/35145113911),
  `workflow_dispatch` on `main`, goal "Pentest the whole Surveyor application
  (a Cloudflare Worker platform; start it locally with the committed
  niro/harness scripts)".
- Artefact: `niro-penetration-test-report` (run artefact 409,188 bytes zipped),
  downloaded with `gh run download 35145113911 -n niro-penetration-test-report`
  on 2026-09-17 and committed unchanged.
- PDF: 855,964 bytes, SHA-256
  `7f946eaeb8d224d2fd84b2861e97d9059786be4935175a4454c86f928fcb3650`.

## Findings

The run confirmed 13 findings: 1 high and 12 medium; no critical or low. Every
finding is remediated in `5079e7c` ("fix(security): remediate second Niro
pentest findings (1 high, 12 medium)"); that commit message names each
remediation. This record is a remediation history, not a re-test: no later Niro
run has re-tested the fixes.

| ID | Severity | Finding (report title) | Remediation in `5079e7c` |
|---|---|---|---|
| F-01 | High | Sealed identities and testimony decrypt with key constants published in the application source | Boot fails closed without `SERVER_SECRET`/`ENCRYPTION_KEY` (no development fallback); sealed-data routes return 503 `not_provisioned`; `/api/status` reports `provisioned`; an operator-gated re-seal route migrates envelopes after key rotation. |
| F-02 | Medium | Zero-width character inside an injection marker bypasses the research-line hold gate and the text is published | The injection matcher deletes invisible characters instead of splitting marker tokens on them. |
| F-03 | Medium | Public survey responses silently veto operator research on named subjects | Anonymous submission topics no longer veto operator research. |
| F-04 | Medium | Retrigger ledger treats zero-width and full-width topic variants as new, duplicating research angles and bills | Topics are NFKC-normalised and invisible-stripped; duplicate angle inserts are skipped. |
| F-05 | Medium | Unbounded record writes on anonymous intake steps; one request mints thousands of chosen-name rows | Name claims are capped per answer and the submission has an atomic write budget. |
| F-06 | Medium | Public survey topic bypasses injection review and publishes as a report heading | Angle headings are screened at store time; flagged angles read as held and cannot be approved until reviewed. |
| F-07 | Medium | Extension-only attachments are never drained; raw bytes persist indefinitely | Attachment lanes are decided once at upload; rows with no handler are terminated instead of stranding raw bytes. |
| F-08 | Medium | Provider key removal route issues deletion for any installation secret slot | Provider key deletion is limited to provider slots. |
| F-09 | Medium | Concurrent spend requests bypass a research line's spend cap and under-record spend | Spend caps are enforced with a single conditional UPDATE. |
| F-10 | Medium | IPv4-mapped IPv6 literal bypasses provider base-URL guard, sending server-side fetches to loopback and link-local | IPv4-mapped/compatible IPv6 literals are parsed and rejected. |
| F-11 | Medium | Custom-provider check follows a redirect to loopback and reports the internal 200 as success | The provider probe refuses redirects. |
| F-12 | Medium | Name scan misses names split by zero-width characters and stores them as a "clean", name-free corpus document | The name gate canonicalises format characters before matching and stores what it scanned. |
| F-13 | Medium | Survey completion response leaks internal topic ledger to anonymous callers | The anonymous completion response no longer leaks the retrigger detail. |

## What the run does not show

The report's own limitations section stands as published:

- **L-01 (blocked)**: a provider host name resolving to a private or loopback
  address did not reach a verdict within the per-test-case time budget.
- **G-01**: the ~200 MB per-submission attachment aggregate cap and its
  concurrent reservation accounting were not exhausted.
- **G-02**: the live Cloudflare API branches of the provider-key routes were
  exercised only to their validation boundary (no account credential or
  emulator on the runner).
- **G-03**: provider-authored journalist-pass prose could not be exercised
  (no provider key); only the deterministic body path was. `5079e7c` screens
  model-authored prose for injection, but no Niro run has re-tested it.

Coverage gaps G-01–G-03 remain open and are recorded here so the README claim
does not read as broader than the evidence.
