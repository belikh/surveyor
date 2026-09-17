# ADR-0007: Provider registry implemented on the Vercel AI SDK

**Status**: Accepted (implemented 2026-09-16; ratifies the wayfinder decision)

**Deciders**: operator (user), via remediation R2

## Context

The wayfinder decision (`t01-tenant-byok`, Q10; pre-split, not carried into
this repository) ratified "AI SDK provider packages behind a registry
interface". The inherited build silently contradicted it: `ai` and `@ai-sdk/openai-compatible`
were removed from `package.json` and `serve.ts` hand-rolled a `fetch` to
`/chat/completions`. R2 required the decision be **implemented or amended by
ADR** — not left contradicted. The operator chose implementation.

## Decision

Implement the registry on the **Vercel AI SDK**: `ai@7` with
`@ai-sdk/openai-compatible@3`. `buildChainClient` constructs an
`OpenAICompatibleProvider` per chain entry and calls `generateText` with
`maxRetries: 0`, preserving the existing contract and semantics:

- entries are attempted in the operator's order;
- a missing secret skips the entry;
- transport errors, `429`, and `5xx` fall through to the next entry;
- other `4xx` surface loudly;
- an empty completion falls through;
- exhaustion throws `chain exhausted: …`;
- the `ModelClient` interface (`tier`, `complete(prompt)`) is unchanged, so
  `serve.ts`/`engine.ts`/`corpus.ts` callers are untouched.

`fetch` remains injectable for tests.

## Consequences

**Positive**

- The ratified decision is now true; the registry is a real provider layer.
- Provider request shaping, retries, and error taxonomy are library-owned
  (constitution IV) rather than bespoke.
- The wayfinder's "N custom OpenAI-compatible entries" model maps directly.

**Negative / trade-offs**

- **Bundle growth**: the worker bundle moved from ~380 KB to ~1.3 MB
  uncompressed. The Workers limit is 64 MiB uncompressed (the old 3/10 MB gzip
  rule was retired), so this is comfortable, but it is a real cost to record.
- The decision named AI SDK **v5**; implementation uses the current major
  (**v7**). This is a version drift, not a design change; `v5` was the latest at
  decision time.
- The SDK pulls `zod` as a peer; the project already depends on `zod`.

## References

- Wayfinder ticket: `t01-tenant-byok` (pre-split; not carried into this
  repository)
- Remediation: R2
- Tests: `surveyor/test/chain.test.ts`
