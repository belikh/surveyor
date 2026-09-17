# ADR-0001: One investigation per installation, bring-your-own-keys

**Status**: Accepted (wayfinder decision, 2026-09-14)

**Deciders**: operator (user), via wayfinder ticket `t01-tenant-byok`

## Context

The platform is open-source and self-serve: anyone should be able to launch an
anonymous-source investigation without an engineer driving a CLI on their own
machine. Two shapes were on the table.

1. **Hosted multi-tenant** — a platform account runs every investigation.
   Cloudflare's Workers for Platforms (dispatch namespaces) is the vendor
   mechanism: customer code runs as *user Workers* inside *our* account, routed
   by hostname.
2. **One investigation per installation** — the installer provisions a fully
   self-contained stack (Worker, D1, R2, Queue, Workflow, cron, Workers AI) into
   *the operator's* Cloudflare account. There is no platform account.

Separately, the LLM layer needed a model. The inherited predecessor used a fixed
chain (Groq → TokenRouter → Workers AI). The operator asked for a registry that
covers all providers and allows N custom entries.

Primary source: the pre-split wayfinder installer research (§2 for Workers for
Platforms and its $25/month gate; §3–§4 for the API-token provisioning path it
recommends instead). That report is not carried into this repository.

## Decision

**One investigation per installation.** Each installation is a self-contained
stack in the operator's own Cloudflare account, provisioned by the installer and
torn down by the uninstaller. There is no multi-investigation platform account
and no cross-installation data of any kind.

**Provider registry, not a fixed chain.** The LLM layer is a registry of
provider entries. Built-in OpenAI-compatible kinds (Groq, TokenRouter) plus N
custom entries (base URL, model, secret slot) are ordered by the operator and
attempted in that order. **Degraded keyless operation is a supported state**, not
an error: with no keys the installation runs static fallbacks and the Workers AI
binding, and the dashboard carries a visible warning.

**Secrets live in the operator's Cloudflare secret store**, written by wizard
code through the Cloudflare API. The wizard stores slot *names* only; values
never enter the installation's own state, logs, or a model.

## Consequences

**Positive**

- Isolation is structural: no shared database, no shared queue, no cross-tenant
  blast radius, and the operator holds custody of their own corpus and
  submissions.
- The "bring-your-own-keys" promise is literal — the keys and the data both stay
  in the operator's account.
- A degraded install is useful immediately, so procurement never blocks setup.

**Negative / trade-offs**

- Every installation pays its own resource floor; there is no pooled capacity.
- No cross-investigation features (federated search, platform-wide analytics)
  are possible without a later, separate design.
- The deploy-button install path requires a **public** GitHub/GitLab template
  repository, which constrains how the project is published (see ADR-0005 and
  R8).
- Workers for Platforms was **rejected** deliberately: its tenancy points the
  wrong way (customers' code inside the vendor's account, billed to the vendor)
  and it adds a $25/month plan gate on top of per-request usage.

## References

- Wayfinder ticket: `t01-tenant-byok` (pre-split; not carried into this
  repository)
- Research: pre-split wayfinder installer report §2, §4 (not carried into this
  repository)
