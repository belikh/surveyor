# Provider-terms review — storage, caching and republication decisions

> **DRAFT — FOR HUMAN LEGAL SIGN-OFF.**
> This document is a draft prepared for review by qualified counsel. It is
> **not legal advice**, it is not a substitute for a lawyer's opinion, and
> none of its decisions is operative until the sign-off block at the end is
> completed by a human reviewer. No provider may become a production
> dependency, and no provider output may be treated as evidence, on the
> strength of this draft alone.

**Date**: 17 September 2026
**Issues**: #27 (B10, the review itself, labelled `ready-for-human`); #28 (B9, the Parallel delegation interface, blocked on this review); #24 (B6, the search/extract provider layer).
**Scope**: what Surveyor may **store**, **cache** and **republish** under the published terms of the providers the engine can use — Parallel (search and deep research), Tavily (search and extract), and the generic OpenAI-compatible/BYOK chat providers in the registry. It records a decision per provider and the single operative rule that keeps the engine compliant. It does not re-derive privacy law, defamation or copyright — those are in the companion reports — and it does not review Cloudflare's own terms.
**Method**: primary sources only, re-fetched and read on **17 September 2026** (web access was available during this pass). Every finding cites a clause number from the instrument it comes from: the Parallel Customer Terms (`customer-terms`), the Parallel Acceptable Use Policy, the Parallel privacy policy and FAQ, and the Tavily Platform Terms of Service (last updated 4 May 2026). Quotes are verbatim from those fetches; retrieval dates are in the source ledger. Anything that could not be verified from a primary source is marked **[unverified]**. The committed reports `docs/research/parallel-ai-api.md` (§4), `docs/research/web-research-integration.md` (§2.2, §2.4) and `docs/research/australian-legal-compliance.md` (§7, §9) supply the surrounding analysis and are not re-derived here. Australian English throughout.
**Status**: draft — no code changes, no provider enabled. Companion cross-links: `australian-legal-compliance.md`, `parallel-ai-api.md`, `web-research-integration.md`.

---

## 0. What this review decides

1. **One operative rule** (§1): snapshots private, provider output as pointers, only operator citations published. The rule is written to satisfy the strictest clause found (Parallel §2(b)–(c)) and is safe under the other providers' terms.
2. **A proposed decision per provider** (§3–§5): Parallel, Tavily, and the generic OpenAI-compatible/BYOK registry providers, each stating what may be stored, cached and republished, and what must not.
3. **A production gate**: no provider becomes a production dependency until a human signs off this review and the open questions in §8 are resolved — in particular the Parallel §4(b) training clause and the §4(d) Data Processing Addendum, and the Tavily §6.5 training clause. Issue #28 (B9) must not call the Parallel Task API in a live investigation before that sign-off.

The draft's proposed decisions are deliberately conservative: they keep every provider usable for **lead generation and synthesis planning** while making it impossible for provider output to become a published citation or an evidence copy. If counsel rejects the conservative reading, the alternative is a negotiated amendment or enterprise agreement with the provider — not a reinterpretation of the clause by the project.

---

## 1. The operative rule

The engine's compliance rests on three invariants, applied to every provider without exception:

1. **Snapshots are private.** A fetched page that will support a web claim is captured operator-side into an immutable snapshot (R2 object, content SHA-256, fetch timestamp, final URL, extractor version). Snapshots are the citation target; they never ship to the public report and are never made available to any third party.
2. **Provider output is a pointer, never evidence.** URLs, titles, publish dates, basis citations, excerpts and provider-generated answers may be held privately and transiently as leads for the operator, but they are never the thing a claim is validated against. The citation gate checks a snippet against the snapshot text, not against a provider's excerpt.
3. **Only the operator's citations are published.** The public report carries the operator's own prose and citations to public URLs (with fetch date and, optionally, the snapshot hash). No provider excerpt, no provider answer and no provider-generated text as such is republished.

Three supporting prohibitions, drawn from the clauses below, make the rule concrete:

4. **No training use.** Provider output and input are never used to train, fine-tune or distil any model, and are never assembled into a dataset for that purpose (Parallel §2(c)(vi)(A); Parallel AUP §1(c) "model scraping"; Tavily §6.5 as a prohibition by policy).
5. **No provider-output database.** Provider output is not accumulated into a searchable store or product feature; the engine keeps only the investigation's working set, bounded by the installation's retention policy (Parallel §2(b)(ii), §2(c)(vi)(B); Tavily §9.2 mitigated by query hygiene and the query-data opt-out).
6. **No cross-customer reuse.** One installation belongs to one operator; provider output for one investigation is never served, copied or cached for another end customer or any third party (Parallel §2(b)(i), §2(c)(xii); §1(f) End Customers are contractually bound, a public readership is not).

**Why this works, in one line per provider.** Parallel: the restrictive clauses are about copying, caching, storing and making output available to others and to competing services (§2(b), §2(c)); private pointers plus a private operator snapshot plus no republication stay on the permitted side of every quoted restriction, and the §4(b) training licence is addressed by not adding private material beyond what the investigation requires and by requesting the DPA/ZDR posture (§2.4 and question 4 in §8). Tavily: no storage prohibition was found in the general-use restrictions (§3.2), so private retention of leads is permitted; the sharp clauses are the broad input licence (§9.2), training for AI Functionality (§6.5) and the third-party-provider caveat (§6.7), addressed by query hygiene, the query-data opt-out, and keeping the corpus out of Tavily calls. Generic BYOK: the provider is a text processor, not an evidence source; the operator contracts with it directly, so the engine's job is to keep evidence and identity out of the prompt and to record the provider in the APP 8 register.

Enforcement points in the product (existing and planned): the citation gate (`src/lib/serve.ts:106-118`), the untrusted fence (ADR-0003), the publish gate, and tickets #25 (B7 snapshots and citation validation), #28 (B9 leads-only delegation), #29 (B11 leads re-fetched and snapshotted), #23 (B5 registry key capture).

---

## 2. Parallel (search and deep research)

Sources: Parallel Customer Terms and Conditions (`https://www.parallel.ai/customer-terms`), Acceptable Use Policy (`https://www.parallel.ai/acceptable-use-policy`), privacy policy (`https://www.parallel.ai/privacy-policy`) and FAQ (`https://docs.parallel.ai/resources/faqs`), all retrieved 17 September 2026. Clause numbers below are from the Customer Terms unless stated otherwise.

### 2.1 What the terms say

| Clause | Text (abbreviated) | Effect on Surveyor |
|---|---|---|
| §1(b)–(e) | "Customer Input" is what an Authorized User submits; "Customer Output" is what the Services return; "Customer IP" is both | The corpus excerpts, research questions and any Parallel result are Customer IP |
| §1(f) | "End Customers" are the Customer's end customers who "have agreed to be bound by terms and conditions at least as protective of the Parallel IP as those hereunder" | A public readership has not agreed to anything; it is not an End Customer |
| §2(b) | Grant of use, then: "Customer Output generated from one query shall be primarily for the use of one End Customer only, and shall not be copied, cached, stored, or made available to other End Customers or other third parties"; and no copying, caching or storing "any significant portion of any Customer Output to create the AI and Data Selling Services" | Governs caching and storage of output; a single operator is one End Customer, but republication to a public readership is outside the End Customer frame |
| §2(c)(iv) | No "rent, lease, lend, sell, resell, license, sublicense, assign, distribute, publish, transfer, or otherwise make available the Services, Software, or Customer Outputs (except as expressly permitted under Section 2(b))" | Publishing output is permitted only through the §2(b) derivative-works route for End Customers |
| §2(c)(vi) | No use of output to "(A) create synthetic training data … or (B) create databases, data brokerage, data selling/reselling businesses … or (C) otherwise for any competitive purposes" | Bars training pipelines and output databases |
| §2(c)(xii) | No "intentionally or knowingly diverge requests of Authorized Users away from the Services (such as by making available Customer Outputs from previous queries for future uses …)" | The engine's re-use of prior output as context is the clause to check |
| §4(b) | Customer retains Customer IP "except for the license granted to Parallel in this Section 4(b)"; then the bullet: "Parallel may use Customer IP to train and improve the machine learning and other artificial intelligence models used to provide the Services. Customer IP used for training is not linked to any individual during training." | The training licence — see §2.2 |
| §4(c) | Parallel may collect and use "Usage Data" for operational, development, analytical and improvement purposes | Metadata (not the investigation's evidence) is within Parallel's usage-data rights |
| §4(d) | Before processing "Personal Data", Customer "shall separately execute Parallel's Data Processing Addendum made available by Parallel" | The DPA is a precondition to sending any personal data (testimony or corpus excerpts) to Parallel |
| §5(b) | Customer is responsible for the legality of inputs and must have the rights "and for Parallel to use them under this Agreement" | The operator, not Surveyor, warrants the right to send the material |
| §8(e) | No use of the Services or output "to make automated decisions without human oversight that have a significant adverse impact on individual rights in high-risk areas such as employment, healthcare, finance, legal, housing, insurance or social benefits" | The engine's human publish gate is the required posture; no automated decisioning |
| §10(c), (d) | On termination, delete/destroy/return Parallel IP copies and certify; §2(c), §4 and §8(e) survive | Retention must be bounded by the agreement's life; deletion is an operator duty |
| §11(a) | Entire agreement; supersedes "all prior and contemporaneous understandings, agreements, representations and warranties" | The FAQ's training promise is not incorporated into the contract |
| §11(f) | California law; exclusive jurisdiction San Francisco | Forum for any dispute |
| AUP §1(b) | No misuse or collection of "private information such as non-public contact details, health data, biometric or neural data … or confidential or proprietary data" without permission | Query design must not amount to harvesting private information about individuals |
| AUP §2 | Surveillance (tracking, targeting or reporting on identity, covert tracking); automated decisions about employability "without human review" | A workplace investigation must not drift into surveillance; the human gate is a requirement, not a nicety |
| AUP §3 | High-Risk Use Cases (legal, employment, …) require: human-in-the-loop, with content "reviewed by a qualified professional in that field prior to dissemination"; disclosure of AI involvement; no misrepresentation of AI origin | Directly conditions any published report that used Parallel |

### 2.2 The training clause (§4(b)) and the FAQ contradiction

The FAQ states: "Will you train models on my data? **Never.** Inputs and outputs remain yours. We do not use customer data to train any models. See our Terms of Service for details." (`docs.parallel.ai/resources/faqs`, retrieved 17 September 2026). The linked Customer Terms say the opposite. The §4(b) bullet grants Parallel a perpetual, sublicensable licence and then: "**Parallel may use Customer IP to train and improve the machine learning and other artificial intelligence models used to provide the Services. Customer IP used for training is not linked to any individual during training.**"

**Finding.** The contract, not the FAQ, is the operative instrument. §11(a) (entire agreement, superseding prior representations) means the FAQ's "Never" is a marketing statement and not a warranty that can be relied on. The de-linking sentence ("not linked to any individual during training") is a description of training practice, not a restriction on what may be sent. The conservative assumption is therefore that anything sent to Parallel may be used for training. The same over-claim appears in the FAQ's commercial-use answer — "you own the output you create with Parallel, including the right to reprint, sell, and merchandise" — which sits awkwardly beside §2(b)(i) and §2(c)(iv).

**Mitigation available under the contract.** §4(d) conditions personal-data processing on a separately executed DPA; the privacy policy describes API content for business customers as processed "as a processor on behalf of the customer under our Data Processing Addendum". Zero Data Retention is an enterprise offering. Neither a DPA nor ZDR is a published self-serve option **[unverified — request both from Parallel]**. Until the DPA is read by counsel, the proposed decision is: **do not send source testimony, quarantined names, or corpus excerpts to Parallel.** The Task API input is a research question crafted by the operator, not the material.

### 2.3 Output caching and republication (§2(b), §2(c))

§2(b)(i) prohibits copying, caching, storing or making output available "to other End Customers or other third parties"; §2(b)(ii) prohibits storing "any significant portion" of output to build databases; §2(c)(iv) prohibits publishing or distributing output except as §2(b) allows; §2(c)(xii) prohibits "making available Customer Outputs from previous queries for future uses". Read together:

- **Private reuse by one operator.** The operator is one End Customer of one installation, so keeping a Task run's basis (URLs, titles, excerpts, reasoning) for the same investigation is within the literal §2(b)(i) wording. But “previous queries for future uses” in §2(c)(xii) is broad enough to catch a cache that answers later research lines without a fresh call. The defensible reading, and the one this draft adopts, is: store the minimum (leads, not answer text), bound retention, and never treat a cached answer as evidence or as a substitute for a fresh retrieval.
- **Public republication.** A public readership is not an End Customer under §1(f), so the §2(b) derivative-works permission does not cleanly extend to publishing Parallel-derived text to the public. Publishing the operator's own report prose, grounded in operator snapshots of public pages, avoids "making available … Customer Outputs" in substance.
- **Gateway caching.** Cloudflare AI Gateway applies caching to the Parallel route. A gateway cache is the operator's own store, but it is still a place where output persists. **Decision: gateway caching off for provider routes**, so that no parallel copy of provider output exists outside the engine's bounded working set.

**Note on AI Gateway's Web Search page**: Cloudflare documents Parallel as a search-first provider through AI Gateway, which applies "logging, caching, rate limiting, and guardrails" to the request. The operator should consciously configure that route rather than accept defaults.

### 2.4 Proposed decision — Parallel

**Status: conditionally approved for lead-only use, subject to sign-off; NOT approved as an evidence source or for republication of its output.** The production-dependency gate for #28 (B9) remains closed until this review is signed and the §4(d)/training questions in §8 are answered.

| Question | Proposed answer |
|---|---|
| May be stored | URLs, titles, publish dates, citation lists and short excerpts from Task/Search results, held privately in the investigation's working set, bounded by the installation retention policy, never joined to another investigation. Provider *answers* (markdown reports, synthesised text) may be stored only as an operator-review draft with the same retention bound, never as evidence. |
| May be cached | Transient, in-flight response handling only. Gateway caching off. No durable provider-output database; no cross-query answer cache used to avoid a fresh call; no "significant portion" of output retained. |
| May be republished | Nothing generated by Parallel. The published report carries operator prose and operator-snapshot citations to public URLs. |
| Must not | Send source testimony, quarantined names, or corpus excerpts to Parallel before a DPA is executed and reviewed; use Parallel output to train or fine-tune anything; treat a Parallel citation as evidence; convert output into a database, API or searchable product; publish Parallel excerpts or answers; make automated decisions with significant adverse impact (§8(e)); misrepresent AI authorship (AUP §3). |
| Conditions | (1) Human, operator-side professional review before any dissemination of report content informed by Parallel (AUP §3). (2) DPA executed before any personal data is sent (§4(d)); ZDR/enterprise terms explored. (3) Query hygiene: questions, not testimony; AUP §1(b) respected. (4) Retention receipt for Parallel-derived leads, tied to the investigation's deletion. (5) Legal sign-off of this review before #28 ships. |

---

## 3. Tavily (search and extract)

Source: Tavily Platform Terms of Service, "Last updated: May 4, 2026" (`https://www.tavily.com/terms`), and the Help Centre article on the "Allow Use of Query Data" setting, both retrieved 17 September 2026.

### 3.1 What the terms say

| Clause | Text (abbreviated) | Effect on Surveyor |
|---|---|---|
| §1.3 / §1.6 / §1.7 | "Customer Input" is everything submitted, "Output" is what the Services deliver; "Services" includes "AI Functionality" but excludes Output | Query text is Customer Input; results are Output |
| §3.2 | General use restrictions: no modifying/copying the Services; no licensing/reselling; no framing/mirroring; no competitive product; (viii) no data mining except "reasonable use of Tavily APIs in accordance with this Agreement" | No storage prohibition on Output was found; bulk database-building remains restricted |
| §3.2(xv)–(xvi) | No dangerous/high-risk use; no automated decisions without human oversight in employment and similar sensitive areas | Mirrors the Parallel high-risk posture |
| §3.4 | Customer solely responsible for Customer Input and for privacy notices/consents | Operator duty; Surveyor supplies the machinery |
| §6.5 | "Tavily and its third-party artificial intelligence service providers may use, process, analyze, and retain Customer Input submitted to the AI Functionality and Outputs generated by the AI Functionality for purposes of training, improving, developing, and enhancing artificial intelligence models …" | The sharp training clause, scoped to "AI Functionality" |
| §6.6 | No automatic decision-making, or reliance on Output in isolation, where it has a legal or similarly significant effect on a person | Human gate required |
| §6.7 | Third-party AI providers "may not be required to maintain the confidentiality of any Customer Input or Output and may retain certain rights to use or disclose Customer Input and Output, including to further train their algorithmic models" | A subprocessor risk that must be in the APP 8 register |
| §8.2 | Customer represents and warrants that Customer Input does not contain government IDs, protected health information, biometric information, financial credentials, children's data, or GDPR special categories | Investigative queries about individuals can breach this warranty; query hygiene is required |
| §9.1 | Customer owns Customer Input; grants Tavily a licence to use it "to provide and improve Tavily's services" | Inputs remain the operator's, subject to the licence |
| §9.2 | A "worldwide, royalty-free, fully paid, transferable, assignable, sublicensable (through multiple tiers), perpetual, and irrevocable license" over Customer Input, to provide/support/monitor/analyse/improve the Services | The broadest clause in the Tavily set |
| Help Centre | Query-data setting: ON = "we may use your query data to enhance our services …"; OFF = "your query data will not be stored or used for improvements" | Opt-out exists; its contractual weight is a counsel question (§8) |

### 3.2 Reading

No clause in the general-use restrictions forbids retaining Output, and the data-mining carve-out expressly permits "reasonable use of Tavily APIs" (§3.2(viii)). Private retention of search-result metadata and page content extracted for the operator's own use is therefore defensible on the published terms read. The risks concentrate elsewhere: the broad input licence (§9.2), training for the AI Functionality endpoints (§6.5), third-party providers that may retain and train on input (§6.7), and the sensitive-data warranty (§8.2). For an investigative tool the query text itself is sensitive, so the mitigation is (a) turn the query-data setting off, (b) keep queries generic and free of testimony and special-category facts, and (c) treat `/search` and `/extract` — not the AI Functionality/research endpoints — as the permitted surface until counsel resolves the §6.5 scope question.

### 3.3 Proposed decision — Tavily

**Status: conditionally approved for lead-only use, subject to sign-off.**

| Question | Proposed answer |
|---|---|
| May be stored | Search-result metadata (URLs, titles, publish dates, snippets) and extracted page content, held privately and bounded by the investigation retention policy. The evidence copy is still the operator-side snapshot, not the Tavily response. |
| May be cached | Provider responses may be cached privately for the investigation (no storage prohibition found), but not as a page archive in place of the snapshot, and never exposed to any third party. |
| May be republished | Nothing from Tavily as evidence or report content. Operator prose and operator-snapshot citations only. |
| Must not | Send source testimony, quarantined names, health facts, biometric data, IDs or other §8.2 categories in queries; use Tavily to build a searchable output store; treat `include_answer`/AI-generated fields as evidence; use the AI Functionality/research endpoints with sensitive input before §6.5 is resolved; train anything on Tavily output. |
| Conditions | (1) Query-data setting off per installation, with the setting recorded in provisioning receipts. (2) Per-installation Tavily key (no shared project key). (3) Query hygiene rule in the operator pack. (4) Human publish gate unchanged. (5) Legal sign-off. |

---

## 4. Generic OpenAI-compatible / BYOK registry providers

### 4.1 What the registry is

The registry stores an ordered chain of provider entries per installation. The entry kinds are `groq`, `tokenrouter`, `openai-compatible`, `tavily` and `parallel` (`src/lib/setup.ts:35-41`); keys live only in the operator's Cloudflare secret store, in the allowed slots (`src/lib/setup.ts:21-26`); capability tags route chat, vision and search calls so a search entry is never spent on a chat call (`src/lib/registry.ts:22-30`). OpenAI-compatible entries are constructed by `buildChainClient` via the Vercel AI SDK (ADR-0007). Surveyor ships no provider keys and contracts with no model provider; the operator holds the account and accepts that provider's terms.

### 4.2 Findings across the class

- The engine sends **fenced, gated and quarantined text** — the model has no tools and no write path (ADR-0003; `THREAT-MODEL.md` T2/T6). The providers are processors of prompt text, not evidence sources.
- Training, retention and sublicensing postures **vary by provider and by tier**, and several providers train on free-tier inputs by default. The project cannot bind a provider the operator selected, and cannot rely on a provider's marketing page in place of the operator's own account terms.
- The compliance report already requires a **provider due-diligence record** per installation, surfaced as an APP 8 register entry (`docs/research/australian-legal-compliance.md` §7.1 item 1, §9 item 3). This review makes that record a gate: a provider entry is only "production ready" when its terms are recorded against the checklist below.

### 4.3 Proposed decision — generic BYOK providers

**Status: conditionally approved as processors of fenced prompt text, subject to sign-off and to the per-provider record.** No generic provider is approved as an evidence source, and provider output is never republished as such.

| Question | Proposed answer |
|---|---|
| May be stored | The engine's own drafts and structured extraction output, as internal working state, bounded by the same retention policy as the investigation. Provider API responses are not assembled into a searchable output product. |
| May be cached | Only transport-level caching the provider's API offers, under the operator's account settings. No provider-output cache reused across investigations. |
| May be republished | Nothing from the provider as evidence. Published reports contain operator prose and snapshot-validated citations; model-assisted prose passes the existing cite-bound journalist pass and the human publish gate. |
| Must not | Include source identity, access codes, raw submissions or un-gated corpus text in prompts; use provider output as an exhibit or citation; use a provider whose account terms prohibit the operator's use; train anything on provider input/output; enable a provider whose data may be used for training unless the operator accepts it in the due-diligence record. |
| Conditions | A per-provider record containing: provider and model; terms version and retrieval date; training-on-input posture and where it is switched off; retention window; jurisdiction and subprocessors; commercial-use permission for the operator's account tier; and the APP 8 basis. The wizard captures keys and capability tags together (#23/B5) so the record attaches to entries. |

### 4.4 What the record must not become

The register is an operator compliance artefact, not a legal opinion. Entries marked "accepted by operator" do not convert an unsuitable provider into a suitable one; unresolved answers go to counsel as open questions (§8).

---

## 5. Decision summary

| Provider | Use | Store (private) | Cache | Republish | Gate |
|---|---|---|---|---|---|
| **Parallel** | Search leads; Task API synthesis drafts for operator review | Leads and citations, bounded retention; no testimony or corpus before DPA | Transient only; AI Gateway caching off | Nothing from Parallel; operator citations only | Sign-off of this review; DPA/ZDR exploration; #28 stays blocked |
| **Tavily** | `/search`, `/extract` leads and page extraction | Result metadata and extracted content, private and bounded; evidence copy is the operator snapshot | Private response cache allowed; not an archive substitute | Nothing from Tavily; operator citations only | Query-data off; per-installation key; sign-off; §6.5 scope answer |
| **Generic BYOK** | Chat/vision/drafting over gated text | Engine working state only | Provider transport cache only; per-account | Nothing from the provider; operator prose only | Per-provider record completed; #23/B5 attachment; sign-off |

**Universal must-nots** (all providers): no training use; no provider-output database or resale; no cross-customer reuse; no provider output as an exhibit; no republication of provider excerpts; no automated decisioning with significant adverse impact; snapshots are never published or shared.

---

## 6. Where the rule is enforced in the product

| Invariant | Enforcement | Status |
|---|---|---|
| Snapshots private | Snapshot store with R2 object, hash, timestamp, placeholder for extractor version | #25 (B7) — not yet built |
| Provider output as pointers | Leads-only delegation; results cannot enter evidence directly; re-fetch and snapshot every lead before citation | #28 (B9), #29 (B11) — not yet built |
| Operator citations only | Citation gate validates snippets against mirrored/snapshot text; uncited claims stripped at publish unless explicitly approved | `src/lib/serve.ts:106-118`, `src/lib/pass.ts` — built |
| Human gate | Publish gate is a stored per-report condition; publication is a human act | `docs/adr/0004-report-outputs-and-publish-gates.md` — built |
| No training / no output database | Engineering posture plus this review; no dataset or fine-tuning path exists in the repo | structural |
| Provider due diligence | Registry entries capture keys and capabilities together; APP 8 register is a compliance-doc feature | #23 (B5) — partially built; register pending |

---

## 7. Limits of this review

- The terms were read on **17 September 2026** and change without notice; the retrieval date is part of every finding.
- Parallel's **DPA and subprocessor list were not read** and are not published at a discoverable URL **[unverified]**; the DPA is a §4(d) precondition the operator must satisfy.
- Tavily's **AI Functionality scope** (whether `/search` and `/extract` fall inside §6) was not resolved from a primary source; treated as an open question.
- The **contractual weight of Tavily's query-data opt-out** (help-centre setting versus §9.2 licence) was not resolved from a primary source; treated as an open question.
- Parallel's **default retention window for non-ZDR accounts** and the availability/price of ZDR and the DPA are **[unverified]**.
- No **copyright or fair-dealing opinion** is offered here; snapshotting for verification and quoting in publication are separate questions (see `web-research-integration.md` §2.2).
- No **privacy-law opinion** is offered; APP 8 accountability for each provider is mapped in `australian-legal-compliance.md`, not here.
- This document is **not legal advice** and must not be cited as such.

---

## 8. Consolidated open questions for counsel

Parallel:

1. **§2(c)(xii) scope**: does one operator's private reuse of a Task run's basis across research lines in the same investigation breach "making available Customer Outputs from previous queries for future uses"? If so, what is the maximum permitted reuse — same line only, same report only, or none without a fresh call?
2. **§2(b)(i) public readership**: is publishing an investigative report that was informed by Parallel output "making available … to other third parties"? Does the answer change if the report republishes no Parallel excerpt?
3. **§2(b)(ii) "significant portion"**: at what retention volume does storing Task basis metadata in D1 become storing "any significant portion" of output? Is per-investigation bounded retention enough?
4. **§4(b) training licence vs FAQ "Never"**: given §11(a), can the operator rely on the FAQ promise at all, or is the only reliable route a negotiated no-training term or ZDR? Does training "not linked to any individual" still process personal information for APP 8 and the Privacy Act?
5. **§4(d) DPA**: obtain and review the DPA and the subprocessor list; confirm the processing role, retention, deletion and cross-border terms before any personal data (including workplace documents) is sent.
6. **ZDR**: confirm availability, price and feature impact (interactions, memory) for a single-installation operator.
7. **AUP §2/§3**: does a union- or newsroom-run workplace investigation fall within "surveillance" or a "High-Risk Use Case"? If it is high-risk, who is a "qualified professional in that field" for the required pre-dissemination review?
8. **§2(b) derivative works**: does the permission to "modify, adapt, or create derivative works based on Customer Output" extend to a report published to a public readership, or only to materials for contractually bound End Customers?

Tavily:

9. **§6.5 scope**: do `/search` and `/extract` count as "AI Functionality"? If yes, is a no-training commitment available, and does the query-data opt-out bind Tavily contractually or only operationally?
10. **§9.2 licence**: is the broad input licence avoidable (enterprise amendment, DPA) or is query hygiene plus the opt-out the only mitigation? What does Tavily retention say about query logs on the account tier the operator uses?
11. **§8.2 warranty**: investigative queries will contain personal information about named individuals; do workplace facts ever fall inside the prohibited categories, and what representations does the operator need to give?
12. **§6.7 subprocessors**: which third-party AI providers process Tavily input, where, and under what retention/training terms — required for the APP 8 register.

Generic BYOK:

13. **APP 8 characterisation** per provider: is sending gated corpus text to the provider a "use" or a "disclosure", and what contract/consent basis does the operator rely on?
14. **Account-tier terms**: do the operator's chosen keys (including any free or consumer tiers) permit commercial publication of reports that used the provider, and do they train on inputs?
15. **Subprocessors and residency** per provider for the APP 8 register and the collection notice.

Cross-cutting:

16. **Publication of short quotations** from private snapshots (research/news reporting fair dealing; defamation context) — a copyright and defamation question for the same review.
17. **Retention of provider-derived leads**: how long may Parallel/Tavily-derived metadata be kept relative to the APP 11.2 deletion duty and the provider termination-deletion clauses (§10(c))?
18. **Change control**: who re-runs this review when a provider updates its terms, and how are operators notified?

---

## 9. Sign-off block (for the human reviewer)

> Completion of this block is the act that makes the review operative. Do not
> close #27 or remove `ready-for-human` until this is completed by the
> responsible human.

| Field | Entry |
|---|---|
| Reviewer name | |
| Role / qualification | |
| Date | |
| Decision | ☐ approve as drafted ☐ approve with conditions ☐ reject |
| Conditions / amendments | |
| Parallel §2.4 conditions met (DPA etc.) | ☐ yes ☐ no |
| Tavily §3.3 conditions met | ☐ yes ☐ no |
| May #28 (B9) proceed? | ☐ yes ☐ no |
| Notes | |

---

## Source ledger

Retrieved and read 17 September 2026 (web access available). Clause numbers in this document are from these versions.

| Source | URL | Used for |
|---|---|---|
| Parallel Customer Terms and Conditions | https://www.parallel.ai/customer-terms | §1(b)–(f), §2(b)–(c), §4(b)–(d), §5(b), §8(e), §10(c)–(d), §11(a), §11(f) |
| Parallel Acceptable Use Policy | https://www.parallel.ai/acceptable-use-policy | AUP §1(b)–(c), §2, §3, §4 |
| Parallel privacy policy | https://www.parallel.ai/privacy-policy | Processor role for API content; EU Search residency; retention |
| Parallel API FAQ | https://docs.parallel.ai/resources/faqs | Training and commercial-use answers; SOC-II; US storage |
| Tavily Platform Terms of Service (last updated 4 May 2026) | https://www.tavily.com/terms | §1.3, §1.6–1.7, §3.2, §3.4, §6.5–6.7, §8.2, §9.1–9.2 |
| Tavily Help Centre — "Allow Use of Query Data" setting | https://help.tavily.com/articles/4205958832-understanding-the-allow-use-of-query-data-setting | Query-data on/off behaviour |
| Cloudflare AI Gateway — Parallel provider page | https://developers.cloudflare.com/ai-gateway/usage/providers/parallel/ | Gateway route and caching posture |
| Cloudflare AI Gateway — Web Search providers | https://developers.cloudflare.com/ai-gateway/usage/web-search/ | Gateway caching on search routes |

Companion reports (committed, same retrieval date): `docs/research/parallel-ai-api.md` §4, `docs/research/web-research-integration.md` §1.2, §2.2, §2.4, §5, `docs/research/australian-legal-compliance.md` §7, §9.

*Draft for human legal sign-off. Not legal advice.*
