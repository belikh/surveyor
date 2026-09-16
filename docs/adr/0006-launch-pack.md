# ADR-0006: Launch pack is a seven-asset, URL-only, operator-identity-free bundle

**Status**: Accepted (wayfinder decision, 2026-09-14; prototype accepted by operator)

**Deciders**: operator (user), via wayfinder ticket `t06-launch-pack`

## Context

The investigation is taken public by distributing a submissions URL. The pack
must be immediately usable on social channels, regenerable when the URL rotates,
and must never expose the operator. A cheap concrete prototype (a stub pack in
the live predecessor shape) was used to raise fidelity and reacted to.

Primary source: `.scratch/cloudflare-native/issues/t06-launch-pack.md` and
`.scratch/cloudflare-native/prototype-launch-pack.md`.

## Decision

The launch pack is **seven assets**:

1. The bare submissions URL.
2. A square QR render.
3. A story-format (9:16) QR render.
4. Short share copy.
5. Long share copy.
6. DM share copy.
7. QR alt text.

**The QR payload is the bare URL only** — no query string, no fragment, no
tracking parameters. The pack is **regenerable on URL rotation** and carries
**zero operator identity**: copy must pass a structural audit that rejects
tracking vectors, operator-supplied forbidden terms, and banned claim phrases.

## Consequences

**Positive**

- Immediate publication: paste the copy, attach a render, done.
- Anonymity floor is enforced mechanically at generation time, not by proofreading.
- Regeneration on rotation means a burned URL costs a click, not a redesign.

**Negative / trade-offs**

- URL-only QR gives up attribution/tracking as a deliberate feature.
- The audit can only reject operator terms the operator supplies; it cannot know
  an unlisted identifying phrase.
- v1 uses `workers.dev` hostnames only. Custom domains per installation are out
  of scope pending the documented anonymity trade-off.

## References

- Wayfinder ticket: `.scratch/cloudflare-native/issues/t06-launch-pack.md`
- Prototype: `.scratch/cloudflare-native/prototype-launch-pack.md`
