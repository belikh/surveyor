# ADR-0008: BYOK key entry through wizard OAuth consent

**Status**: Accepted (implemented 2026-09-16; amended by ADR-0013; live trial pending)

**Deciders**: operator (user), via remediation R2

## Context

The platform's headline promise is bring-your-own-keys, yet no runtime code path
accepted a provider key: the wizard stored slot names only, and
`POST /api/setup` validated a key then discarded it. Writing a Worker secret at
runtime requires a Cloudflare API call, which requires a credential. The
remediation issue suggested a scoped Cloudflare token, but the operator rejected
manual token creation: "the operator isn't supposed to have to manually get keys
or anything like that."

## Decision

**Wizard OAuth consent.** The first-run wizard has a **Connect Cloudflare**
button. The installation redirects the operator to Cloudflare's OAuth
authorisation endpoint (`GET /api/oauth/start`); Cloudflare returns a code to
the installation (`GET /api/oauth/callback`), which exchanges it for a
short-lived access token and hands that token back to the wizard **in the URL
fragment** — client-side only, never sent to or stored by the server.

The wizard then submits the provider key (`POST /api/providers/key`) with:

- the transient OAuth token (in-flight only),
- the non-secret account id and script name,
- the provider entry (`kind`, `label`, `model`, `base_url`, `secret_slot`),
- the provider API key value.

The Worker: (1) proves the key with the existing save-time probe; (2) writes it
to the installation's own Worker secret store via
`PUT /accounts/{id}/workers/scripts/{script}/secrets`; (3) persists the provider
**slot name only** into setup state. Rotation repeats the write; removal
(`DELETE /api/providers/key/:slot`) deletes the secret and the entry.

Neither the Cloudflare token nor the provider key value is persisted, logged,
telemetered, returned, or reachable from D1 (asserted by test).

## Consequences

**Positive**

- No one manually creates a Cloudflare API token; consent is a click.
- Secret values transit memory only and land in Cloudflare's secret store.
- Rotation and removal are product features, not dashboard chores.
- The token is scoped to the consented OAuth grant, not a broad pasted token.

**Negative / trade-offs / open unknown**

- **OAuth client ownership.** A self-hosted open-source install needs a
  registered Cloudflare OAuth client. The shared-`client_secret` question was
  settled in **ADR-0013**: the wizard is a **PKCE public client** (S256,
  token-endpoint auth method `none`), no secret is embedded or sent, and
  `CF_OAUTH_CLIENT_ID` ships as a public var operators may override.
  Registration of the project's client id remains a human step before the
  live trial.
- **Live trial pending.** The full consent round-trip has not been exercised
  against a real Cloudflare account; only the module and routes are tested with
  a stub token endpoint.
- **Fragment token exposure.** The transient token is briefly in the browser URL
  fragment (history). It is short-lived and scoped, and is cleared from the URL
  on load, but this is a documented exposure, not a non-exposure.
- The operator still supplies the provider key value (that is what BYOK means);
  what they no longer do is obtain and scope a Cloudflare credential by hand.

## References

- Remediation: R2
- Related: ADR-0001 (tenancy/BYOK), ADR-0005 (installer), ADR-0007 (AI SDK)
- Tests: `surveyor/test/keyentry.test.ts`, `surveyor/test/oauth.test.ts`
