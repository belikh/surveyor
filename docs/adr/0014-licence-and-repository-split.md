# ADR-0014: Licence and repository split

**Status**: Accepted (2026-09-16); publication is a human step

**Deciders**: operator (user), remediation R8

## Context

The destination is an open-source product anyone can deploy, but it has no
licence and no CI, and it currently lives inside a **private** repository whose
other contents are not publishable. Publishing from that repository would leak
material that must stay private. The operator chose the licence and the split
shape under grilling.

## Decision

**Licence: AGPL-3.0.** A source-protection tool must not be enclosed in an
un-auditable proprietary hosted service; network copyleft is the structural
deterrent. The full text ships at `surveyor/LICENSE`, with the rationale here.

**Repository split: a new public repository, squashed history.** The platform
is exported as a single commit of the `surveyor/` tree (excluding
`node_modules`, `dist`, `.wrangler`, `.dev.vars`) by
`surveyor/scripts/split-repo.sh`. Squashed rather than filtered history: a
filtered repository can still carry an unfortunate commit message or blob, and
losing the platform's early history is a cheap price for a hard privacy
guarantee.

**Publication is a human step.** Creating and pushing a public repository is
irreversible and outside the agent's remit; the script prints the exact
commands and the pre-publish checks (no predecessor references, exactly one
commit).

**CI and hygiene** live in the target repository: the workflow runs
`npm ci && npm run typecheck && npm test && npm run build` on every push/PR
touching the platform, with `npm run smoke:runtime` weekly. `CONTRIBUTING.md`,
`SECURITY.md`, and issue/PR templates ship in `surveyor/`.

## Consequences

**Positive**

- Releasing cannot leak the investigation: there is no carried history.
- AGPL-3.0 keeps any hosted derivative auditable.
- CI and contribution rules exist before the first public commit.

**Negative / trade-offs**

- History is lost; provenance of early design lives in this repository's ADRs
  and specs, which remain private (the public repo should carry the relevant
  ADRs too — copied by the export).
- Pushing the workflow requires the GitHub token to carry the `workflow`
  scope; the operator grants it (decided under grilling).
- The public repository and its OAuth client (ADR-0013) must be registered by
  the operator before the trial.

## References

- Remediation: R8; spec FR-041–FR-044
- Related: ADR-0013 (PKCE OAuth client)
