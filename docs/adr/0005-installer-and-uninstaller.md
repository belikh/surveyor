# ADR-0005: Two-phase install; deploy button primary, scoped token fallback

**Status**: Accepted (wayfinder decision, 2026-09-14)

**Deciders**: operator (user), via wayfinder ticket `t02-installer`

## Context

A self-serve platform needs a provisioning story a non-engineer can complete in
a browser, and a teardown story whose wipe claims are honest. The installer must
run inside the operator's own account and must never route a secret through an
LLM or a transcript. The options surveyed (against Cloudflare primary sources)
were deploy-to-Cloudflare buttons, Workers for Platforms, wrangler-guided
deploy, and direct API provisioning.

Primary source: `.scratch/cloudflare-native/research/installer-mechanism.md`
(§1 deploy buttons, §3 wrangler, §4 direct API, §5 teardown, §6 recommendation).

## Decision

**Two-phase install.**

1. **Provision.** The preferred path is a **deploy-to-Cloudflare button**,
   which clones a public template repo and auto-provisions Worker, D1, R2,
   Queue, Workflow, cron, and Workers AI into the operator's account. A
   **scoped-token paste fallback** exists for private mirrors and restricted
   orgs, with a minimal documented scope set and revoke-after-install guidance.
2. **Configure.** The installation's **own first-run wizard** (in the
   operator's account, praetorian Mac OS 9 styled) collects provider keys, the
   corpus seed, and the instrument. The wizard is **code, not an LLM**: it
   provisions through the Cloudflare APIs directly and writes secrets straight
   into the secret store, so constitution II's transcript rule is satisfied
   structurally rather than by procedure.

**Teardown is a wizard screen**, backed by a shipped, tested teardown routine
that keeps an install manifest (the resources and names it created) and refuses
to touch anything else. It must empty R2 before deleting the bucket and report a
per-resource **wipe / not-wiped receipt**: scripted deletes are claimed;
Cloudflare account logs, analytics, and backup retention are explicitly *not*.

## Consequences

**Positive**

- Lowest-friction install path, with a fallback for restricted environments.
- Secrets never transit a model or a transcript.
- Teardown honesty is built in: the receipt names what could not be wiped.

**Negative / trade-offs**

- The button path requires a **public** GitHub/GitLab repository and is an
  interactive dashboard click-through; there is **no documented unattended API**
  for a wizard to drive the button itself.
- Teardown **cannot** claim purge of Cloudflare-side backups/logs/analytics, nor
  removal of the cloned Git repo, the Workers Builds project, or resources added
  later outside the manifest.
- Workers for Platforms is rejected for per-owner installs (wrong tenancy,
  $25/month gate).
- The minimal token scope set and deploy-button D1-migration reliability remain
  **unverified** until a live deploy-destroy trial (see R3, #27, and T16 #23).

## References

- Wayfinder ticket: `.scratch/cloudflare-native/issues/t02-installer.md`
- Research: `.scratch/cloudflare-native/research/installer-mechanism.md`
- Remediation against the current build: R3 (#27)
