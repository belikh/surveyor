# ADR-0013: OAuth client switches to PKCE (amends ADR-0008)

**Status**: Accepted (2026-09-16, user decision under grilling)

**Deciders**: operator (user), remediation R2 follow-up

## Context

ADR-0008 adopted wizard OAuth consent for BYOK key entry but flagged an open
unknown: a self-hosted open-source install cannot keep a shared
`client_secret`, and PKCE support for public clients was unverified. Research
against Cloudflare's primary docs establishes that Cloudflare OAuth **does**
support the authorization-code flow with **PKCE (S256, token-endpoint auth
method `none`)** for public clients, and that `client_secret` is unnecessary
with PKCE. OAuth scope names equal API-token permission names.

## Decision

- The wizard uses a **PKCE public client**: `code_verifier` / `code_challenge`
  (S256), no `client_secret`.
- A **project-owned public client id** ships as a var (`CF_OAUTH_CLIENT_ID`);
  operators may override it. The client id is public by design; no secret is
  embedded.
- The transient-token flow is unchanged: the code is exchanged at
  `https://dash.cloudflare.com/oauth2/token`, and the access token returns to
  the wizard in the URL fragment, never server-stored.
- Access-token lifetime and refresh support are **not documented**; the flow
  assumes a short-lived token and asks the operator to reconnect if it expires.

## Consequences

**Positive**

- Removes the embedded-secret weakness from ADR-0008.
- No per-operator OAuth client registration friction (they may still override).
- Smaller scope surface: the token carries only consented scopes.

**Negative / trade-offs**

- The project must register and publish the OAuth client id before the trial;
  registration is a human step.
- Token lifetime is undocumented, so long console sessions may need a
  reconnect. This is handled with an error path, not a promise.
- The operator still registers nothing, but the project owns an OAuth app whose
  verification/review status is outside the code.

## References

- Amends ADR-0008; spec FR-002/FR-004
- Primary sources: developers.cloudflare.com OAuth client docs
