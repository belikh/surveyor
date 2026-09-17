# ADR-0016: Anonymity deviation — transport and storage guarantees, not network anonymity or source-side encryption

**Status**: Accepted (2026-09-17, campaign grilling)

**Deciders**: operator (user), campaign #1

## Context

Anonymous sources are the platform's premise, but the platform's guarantees
have limits that must be stated rather than buried. Surveyor runs on
Cloudflare Workers, D1 and R2; the operator holds the key material and is the
data controller. Two capabilities outsiders often fold into "anonymous" are
not part of the build: network anonymity (Tor/onion services) and source-side
end-to-end encryption (keys the server never holds).

## Decision

- **In scope and stated as the guarantee**: TLS in transit; AES-256-GCM
  sealing at rest for testimony and quarantined names; no IP address, user
  agent or referrer read or logged; access codes stored as HMAC only;
  quarantine before storage.
- **Out of scope, stated plainly in `README.md` and `THREAT-MODEL.md`**: Tor,
  onion services, and source-side end-to-end encryption. There is no
  network-level anonymity: a source's connection metadata is visible to their
  network path and to Cloudflare even though the application logs none of it.
- **The operator can decrypt sealed rows by design**, because the operator owns
  the installation and carries the controller's duties. The platform does not
  promise cryptography against the party who holds the keys.
- The threat model carries the residual risks: stylometry, traffic analysis,
  key custody, and the attachment raw-bytes window (ADR-0012).

## Consequences

**Positive**

- The promise matches the mechanics: no source is told to trust a Tor or
  end-to-end guarantee the build does not give.
- The minimal-identity surface stays small: no accounts, no source keys to
  lose, no recovery flow to attack.
- What is claimed (TLS, sealing, no logs) is verifiable by an auditor.

**Negative / trade-offs**

- Sources facing a high-capability adversary may need Tor or end-to-end
  encryption, which Surveyor cannot give; the honest answer is that another
  tool or a separate tunnel must supply them.
- The operator is a trusted party with decryption capability: an operator
  compromise or account takeover exposes testimony, bounded by access controls
  and audit records but not cryptographically.
- The no-logs claim covers the application, not the network path or
  Cloudflare's own account telemetry.

## References

- Campaign: #1 (anonymity posture; out of scope)
- `THREAT-MODEL.md` (T1, T11, documented limits)
- Related: ADR-0012 (attachment exception), ADR-0019 (compliance posture)
