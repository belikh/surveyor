# ADR-0009: Runtime provisioner and teardown via OAuth consent

**Status**: Accepted (implemented 2026-09-16; live trial pending)

**Deciders**: operator (user), via remediation R3

## Context

The platform's provisioner (`provisionStack`/`teardownStack`) existed and was
tested, but had **no runtime caller**: `POST /api/teardown` reset local setup
state and pointed at "the deploy dashboard using the provisioning receipt",
while no runtime code ever produced a receipt. R3 required a real installer:
either a Worker-side provisioner driven by a scoped token, or a documented
deploy-button flow whose descriptor and patching exist. The operator chose the
Worker-side provisioner, consistent with R2's OAuth consent (ADR-0008).

## Decision

**Worker-side provisioner using the transient, OAuth-consented token.**

- `createCloudflareApi` (`src/lib/cfapi.ts`) implements the existing
  `CloudflareApi` interface over the Cloudflare REST API with an injected
  `fetch`. Generated secret values are minted in-flight (SERVER_SECRET,
  ENCRYPTION_KEY, OPERATOR_TOKEN) and pushed straight to the secret store;
  operator-supplied slots are presence-checked only. Values never appear in a
  receipt, log, or return.
- `POST /api/provision` runs `provisionStack` and persists the receipt in D1
  (`provision`), so teardown has something real to work from.
- `POST /api/teardown` loads the receipt, runs `teardownStack` with the same
  transient token, resets local state, and returns the real wipe/not-wiped
  receipt. With no receipt it falls back to the honest local-reset receipt.
- **Teardown deletes the Worker last** (provision.ts order changed), because the
  uninstaller may be running inside the Worker it is deleting; deleting it
  earlier would terminate the request before the receipt is returned.
- The wizard's ready screen collects account id + script name and offers
  Connect Cloudflare, so teardown is one click with consent.

## Consequences

**Positive**

- Provisioning produces a persisted receipt at runtime; teardown is real and
  converges on already-deleted resources.
- No secret values reach any receipt (asserted by test).
- Reuses the R2 consent mechanism: no second credential path.

**Negative / trade-offs / open unknown**

- **Endpoint fidelity is unverified live.** The Cloudflare create/list/delete
  shapes for D1, R2, Queues, schedules, and secrets are taken from the primary
  sources in the pre-split wayfinder installer report. Workflows have no
  standalone API (they ship in the Worker bundle), so create/get/delete are
  identity operations. The **live deploy-destroy trial (A16 #17, A17 #18) must
  confirm every endpoint**.
- The Worker cannot create itself; `createWorker` is an identity operation
  because the provisioner runs inside the Worker. This is correct for the
  "ensure resources" semantics but means the Worker must already be deployed
  (deploy button or `wrangler deploy`).
- Deleting the Worker last means a crash after other resources are gone leaves
  the Worker running with no receipt-consumable backing; re-running teardown
  converges (already-gone tolerated).

## References

- Remediation: R3
- Related: ADR-0005 (installer mechanism), ADR-0008 (OAuth consent)
- Tests: `surveyor/test/provision.test.ts`, `surveyor/test/provision-runtime.test.ts`
