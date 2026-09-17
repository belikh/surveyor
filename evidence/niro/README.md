# Published Niro penetration-test evidence

`.github/workflows/niro-find.yml` uploads each completed run's
`penetration-test-report.pdf` and `knowledge.tar` as GitHub Actions artefacts
with 30-day retention. Retention is not publication: when the artefact expires
the security claim has nothing behind it. Completed reports are therefore
promoted into this directory — the PDF unchanged, with a run record carrying
its date, scope and provenance — and linked from the README's security claim.

## Published reports

| Date | Scope | Findings | Report |
|---|---|---|---|
| 2026-09-16 | Whole application, checkout mode, commit `2b029a8` | 1 high, 12 medium (all remediated in `5079e7c`) | [record](2026-09-16-penetration-test.md) · [PDF](2026-09-16-penetration-test-report.pdf) |

## Promoting a completed run

Repeat after every successful `Niro find` run:

1. Confirm the run finished and its report artefact exists:

   ```sh
   gh run list --workflow=niro-find.yml --limit 5
   ```

2. Download the report artefact into a scratch directory (the artefact is
   zipped; `gh run download` extracts it):

   ```sh
   gh run download <run-id> -n niro-penetration-test-report -D /tmp/niro-run
   ```

3. Read the report's cover page and findings list; the report itself is the
   source of truth for the date, the assessed target and the findings.

4. Copy the PDF in as `evidence/niro/<YYYY-MM-DD>-penetration-test-report.pdf`
   and record its checksum:

   ```sh
   cp /tmp/niro-run/penetration-test-report.pdf \
      evidence/niro/<YYYY-MM-DD>-penetration-test-report.pdf
   sha256sum evidence/niro/<YYYY-MM-DD>-penetration-test-report.pdf
   ```

5. Write `evidence/niro/<YYYY-MM-DD>-penetration-test.md` using the existing
   record as the template: date, scope, commit under test, workflow run link,
   tooling versions, every finding with its remediation commit, and the
   report's own blocked tests and coverage gaps. If a finding is not yet
   remediated, say so in the record as well as the table above — never let the
   claim imply coverage the report does not show.

6. Link the record from the README's "Security testing (Niro)" section and add
   a row to the table above.

7. Commit the PDF, the record, this table and the README link together.

The PDF is the unchanged artefact from the run; never edit it. The knowledge
bundle stays a 30-day CI artefact: it is raw run state, not a report, and it is
not promoted here.
