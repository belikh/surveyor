# Competitor landscape — automated journalism and investigation platforms

**Date**: 17 September 2026
**Scope**: broad automated-journalism field, compared honestly against Surveyor
**Method**: primary sources only — official sites, repositories, documentation.
Repository metadata (licence, activity, stars) read from the GitHub API on
17 September 2026. Where a fact could not be established from a primary source,
it is marked **[unverified]**.

**Conventions**: "self-hostable" means the vendor publishes the code and
deployment instructions for the operator's own infrastructure; it does not mean
the operation is trivial. "AI grounding with citations" means the system is
documented as producing claims with source citations against a corpus (private
or web). "Dead" means no releases or commits for over 12 months, or a product
page replaced by unrelated content.

---

## 1. Surveyor as the baseline

Surveyor's own claims are in `README.md`: anonymous submissions (survey wizard,
proof-of-work, optional human verification, originals never stored, third-party
names in encrypted quarantine); corpus ingestion (PDFs, office docs, scans,
held lanes gated before any mirror); grounded research (angles with cited
exhibits, capped research lines, bounded significance judge); living reports
(five report types, manual-first publish gates, scheduled or per-N updates,
append-only history). One installation per investigation, self-contained in the
operator's Cloudflare account, AGPL-3.0, BYOK provider registry
(`docs/adr/0001-tenant-isolation-and-byok.md`, `docs/adr/0007-ai-sdk-registry.md`,
`docs/adr/0014-licence-and-repository-split.md`).

Honest state of the build, from the repo itself:

- The journalist pass exists in code: `src/lib/pass.ts` runs one model-written,
  cite-bound pass per report type and strips uncited claims on publish unless
  the operator approves them (`src/lib/pass.ts:106-205`). The ADR index still
  lists "the journalist pass does not exist" as a deviation
  (`docs/adr/README.md`), so that index is now partially stale.
- Vision OCR and capability-tagged routing exist in `src/lib/lanes.ts:14-31`;
  the ADR index still lists "no vision, no `env.AI`" for ADR-0002, also stale.
- The live significance judge is wired (`src/lib/retrigger.ts:109-118`).
- Known real gaps the repo states itself: no OCR accuracy bake-off, no retention
  cap for held raw bytes, no dead-letter queue, OAuth/provisioning untested
  against a live account, no Tor/onion path, `workers.dev` hostnames only, and
  teardown cannot purge Cloudflare-side backups or logs
  (`THREAT-MODEL.md` §3 T3, T7, T10; §4; `docs/adr/0006-launch-pack.md:44-47`).

That honesty matters for the comparison below: Surveyor is a working
single-investigation platform with a unique combination, not yet a hardened
product.

---

## 2. Comparison set A — whistleblower / anonymous intake

### A1. SecureDrop (Freedom of the Press Foundation)
- **What it does**: open-source whistleblower submission system that media
  organisations and NGOs install to accept documents from anonymous sources;
  Tor-only source interface, air-gapped journalist workstation, no third parties
  in the server path, metadata minimisation, encryption in transit and at rest.
  Sources are told to use Tor Browser and to set security to "Safest".
  ([securedrop.org](https://securedrop.org/), [overview](https://securedrop.org/overview/))
- **Licence**: AGPL-3.0 ([repo](https://github.com/freedomofpress/securedrop),
  [README licence section](https://github.com/freedomofpress/securedrop#license)).
- **Hosting**: self-hosted, on-premises hardware owned by the newsroom; the
  Workstation is a separate hardened client.
- **Maintained**: yes, very active — 3,882 stars, 14,519 commits, last push
  2026-09-16; release 2.16.1 (8 July 2026) and Workstation 1.9.0 (2 September
  2026). ([releases](https://github.com/freedomofpress/securedrop/releases/tag/2.16.1), [workstation](https://github.com/freedomofpress/securedrop-workstation/releases/tag/1.9.0))
- **Owner/funding**: project of Freedom of the Press Foundation, donor-funded
  ([securedrop.org](https://securedrop.org/)).
- **AI**: none. No AI features documented.
- **Outputs**: documents and messages to journalists; no report generation.
- **Related**: **SecureDrop Protocol** is a proof-of-concept (v0.4) for
  end-to-end encrypted whistleblowing, peer-reviewed at ACM CCS 2026; explicitly
  "not intended for production use". ([repo](https://github.com/freedomofpress/securedrop-protocol))

### A2. GlobaLeaks
- **What it does**: free, open-source whistleblowing framework; anyone can set up
  a secure reporting platform, adopted "by more than 30,000 organizations"
  according to the project; audited repeatedly (iSecPartners, Cure53,
  LeastAuthority, Subgraph, Radically Open Security, ISGroup); claims compliance
  with ISO 37002, EU Directive 2019/1937 and GDPR; 70+ languages.
  ([globaleaks.org](https://www.globaleaks.org/))
- **Licence**: AGPL-3.0 with additional terms under section 7 (the additional
  terms are designed to make whistleblowers aware of the technology and to push
  administrators to stay updated). ([repo](https://github.com/globaleaks/globaleaks-whistleblowing-software))
- **Hosting**: self-hosted (Debian package and Docker); Tor support; ISO 27001
  design claims.
- **Maintained**: yes — 1,516 stars, last push 2026-09-15.
- **Owner/funding**: community-driven project; funded by donations and sponsors
  including Open Technology Fund ([funding page](https://www.globaleaks.org/about/funding/), [sponsors list](https://www.globaleaks.org/)).
- **AI**: none documented.
- **Outputs**: reports and two-way communication inside the platform; no
  automated research or report generation.

### A3. Hush Line (Science & Design)
- **What it does**: "End-to-end encrypted, anonymous tip lines and chat";
  no self-hosting required, managed service with a free tier; sources need no
  account or download; PGP/OpenPGP.js client-side encryption for tip lines
  (server-side encryption when JavaScript is disabled); two-way E2EE chat for
  logged-in users; Tor onion service; text-only by design (no file attachments);
  human-verified accounts; tools including an "OCR Vision Assistant", email
  validation, and in-app message decryption.
  ([hushline.app](https://hushline.app/))
- **Licence**: AGPL-3.0 ([repo](https://github.com/scidsg/hushline)).
- **Hosting**: managed SaaS is the promoted path ("no self-hosting required");
  the code is public.
- **Maintained**: yes — 134 stars, last push 2026-09-03; security audits published
  by Subgraph (2024 full, 2025 preliminary) ([hushline.app](https://hushline.app/)).
- **Owner/funding**: Science & Design, Inc. (dba Hush Line), a US 501(c)(3)
  non-profit; funded by Knight Foundation, Open Technology Fund, Psst.org and
  the Data Empowerment Fund ([hushline.app](https://hushline.app/)).
- **AI**: the OCR Vision Assistant is an AI feature; no grounded research or
  report generation.

### A4. Publeaks (Netherlands)
- **What it does**: Dutch foundation letting sources securely and anonymously
  send tips and documents to a coalition of Dutch media (NOS, NRC, De
  Telegraaf, De Volkskrant, Follow the Money, Investico and regional titles);
  source chooses recipients; login with a unique code via Tor; journalists can
  ask follow-up questions.
  ([publeaks.nl](https://publeaks.nl/))
- **Licence/technology**: not the foundation's own software — Publeaks lists
  GlobaLeaks and Free Press Unlimited as partners and links its secure
  submission surface to a GlobaLeaks-style app ([publeaks.nl](https://publeaks.nl/)).
- **Hosting**: operated for the foundation (Greenhost listed as partner).
- **Maintained**: site live with 2026 content; still onboarding media partners.
- **Owner/funding**: Stichting Publeaks; funded by member contributions, Stimuleringsfonds
  voor de Journalistiek, Stichting Democratie en Media, Digital News Initiative
  Fund and others ([publeaks.nl](https://publeaks.nl/)).
- **AI**: none documented.

### A5. Deaddrop
- **[unverified]**: "DeadDrop" is widely described as the 2013 predecessor of
  SecureDrop (built by Aaron Swartz and Kevin Poulsen at Wired), but no primary
  source was reachable from this environment: `aaronsw.com/weblog/deaddrop` did
  not return article content and the Internet Archive snapshot returned only
  page scaffolding. No separate product or repository named "Deaddrop" was found
  on the GitHub API search for whistleblower tooling. Treat Deaddrop as
  historical lineage of SecureDrop, not a current system.

### A6. OnionShare (current alternative)
- **What it does**: open-source tool to share files, host onion sites, chat and
  "create a private dropdown" (receive files) over the Tor network; desktop and
  mobile apps built with Guardian Project and The Calyx Institute.
  ([onionshare.org](https://onionshare.org/))
- **Licence**: GPL-3.0 (`LICENSE.txt`, [repo](https://github.com/onionshare/onionshare)).
- **Hosting**: runs on the operator's machine; no server needed.
- **Maintained**: yes — 7,089 stars, last push 2026-09-09.
- **AI**: none.
- **Relevance**: an intake transport, not an investigation platform; it has no
  persistent case management or research layer.

### Set A summary

| System | OSS / licence | Hosting | Tor | E2EE | Files in | AI grounding | Reports | Closest layer to Surveyor |
|---|---|---|---|---|---|---|---|---|
| SecureDrop | AGPL-3.0 | self-hosted, hardened | yes | protocol research; workstation model | yes | no | no | intake depth |
| GlobaLeaks | AGPL-3.0 + §7 terms | self-hosted | yes | platform crypto, audits | yes | no | no | intake breadth |
| Hush Line | AGPL-3.0 | managed SaaS (code public) | yes | PGP / E2EE chat | no (text only) | OCR assistant only | no | intake usability |
| Publeaks | GlobaLeaks-based | operated | yes | per GlobaLeaks | yes | no | no | regional coalition model |
| OnionShare | GPL-3.0 | operator machine | yes | transport-level | yes | no | no | simple drop box |
| Surveyor A-layer | AGPL-3.0 | self-hosted (Cloudflare) | no | no E2EE; sealed at rest | yes | name-quarantine gate | — | — |

---

## 3. Comparison set B — investigation knowledge bases / document tooling

### B1. OCCRP Aleph
- **What it does**: data platform for investigative journalists to search and
  browse documents and structured data, make scanned documents searchable,
  cross-reference people and companies against hundreds of datasets, and
  visualise relationship networks and timelines.
  ([docs.alephdata.org](https://docs.alephdata.org/))
- **Licence**: MIT for the open-source repo ([alephdata/aleph](https://github.com/alephdata/aleph)).
- **Critical status**: **the open-source edition is sunsetting.** The repo README
  states maintenance officially ends after 31 December 2025; the team rewrote
  the codebase as **Aleph Pro**, a hosted SaaS. Aleph Pro beta launched
  15 December 2025; free for non-profit journalism with a 1TB budget, at-cost for
  public-interest groups, paid tiers otherwise; on-premise deployment only under
  an Enterprise tier; planned features include risk scoring, confidence-labelled
  connections and knowledge-graph generation.
  ([sunsetting notice](https://raw.githubusercontent.com/alephdata/aleph/develop/README.rst), [Aleph Pro FAQ](https://www.occrp.org/en/announcement/aleph-pro-frequently-asked-questions-on-the-future-of-occrps-investigative-data-platform/))
- **Maintained**: legacy repo last pushed 2026-02-20 (2,431 stars); successor is
  proprietary SaaS.
- **Owner**: OCCRP ([occrp.org](https://www.occrp.org/)).
- **AI**: Aleph Pro advertises "automated risk scoring and flagging" as new;
  no citation-grounded report generation documented in the FAQ.

### B2. DocumentCloud (MuckRock)
- **What it does**: "Analyze, Annotate, Publish. Turn documents into data."
  Uploads, OCR, full-text search, annotation, collaboration and publishing of
  document sets ([repo](https://github.com/MuckRock/documentcloud)).
- **Licence**: AGPL-3.0 for backend and frontend.
- **Hosting**: SaaS at documentcloud.org; the backend and frontend are public and
  self-hostable, but the documented dev path requires Squarelet, Docker, MinIO
  and ~11GB of Docker disk ([README](https://github.com/MuckRock/documentcloud)).
- **Maintained**: very active — last push 2026-09-16.
- **Owner**: MuckRock Foundation, a non-profit ([MuckRock repo](https://github.com/MuckRock/muckrock)).
- **AI**: strong add-on ecosystem, and several are AI/ML: a GPT-4o add-on to
  "analyze, categorize and structure" documents
  ([gpt-addon](https://github.com/MuckRock/documentcloud-gpt-addon)); Whisper
  transcription ([whisper-addon](https://github.com/MuckRock/documentcloud-whisper-addon));
  Google Cloud Vision OCR and Azure Document Intelligence OCR
  ([cloud-vision-ocr](https://github.com/MuckRock/documentcloud-cloud-vision-ocr), [azure OCR](https://github.com/MuckRock/documentcloud-azure-document-intelligence-ocr-addon));
  Google entity extraction ([entity extractor](https://github.com/MuckRock/documentcloud-google-entity-extractor-addon));
  a summarise add-on ([summarize-addon](https://github.com/MuckRock/documentcloud-summarize-addon)).
- **Outputs**: annotated documents and publications, not living investigation
  reports.

### B3. MuckRock
- **What it does**: non-profit collaborative news site giving the public tools
  for government transparency, including FOIA request tooling — the repository
  contains `muckrock/foia` and `muckrock/foiamachine` apps
  ([repo](https://github.com/MuckRock/muckrock), [apps](https://github.com/MuckRock/muckrock/tree/master/muckrock)).
- **Licence**: AGPL-3.0; active (last push 2026-09-16; 125 stars).
- **AI**: the development environment documents an `OPENAI_API_KEY`, indicating
  AI functionality in the product ([README](https://github.com/MuckRock/muckrock)).
- **Note**: muckrock.com itself blocked this environment's fetches (Cloudflare
  bot protection), so page-level feature claims are **[unverified]** beyond the
  repository evidence.

### B4. Google Pinpoint (Journalist Studio)
- **What it does**: upload and analyse large document collections with Google
  Search and ML: search forms, handwritten documents, images, audio
  transcriptions, email archives and PDFs; filter by key people, organisations
  and locations; transcribe audio/video; turn similarly structured tables into
  spreadsheets; collaborate with custom labels; private by default.
  ([Pinpoint](https://journaliststudio.google.com/pinpoint/about/))
- **Licence/hosting**: proprietary Google SaaS, free for journalists;
  no self-hosting.
- **AI**: generative AI features are in early access by application
  ([Pinpoint](https://journaliststudio.google.com/pinpoint/about/)).
- **Maintained**: live in Google's Journalist Studio suite ([studio](https://journaliststudio.google.com/)).

### B5. Overview
- **What it did**: open-source large document-set visualisation platform
  ([repo](https://github.com/overview/overview-server)).
- **Status**: effectively dead. The last push to the server repo was 2023-01-07
  (271 stars); `overviewproject.org` now serves unrelated document-storage SEO
  content ([overviewproject.org](https://www.overviewproject.org/)) and
  `overviewdocs.com` redirects to a GitHub repository page
  ([overviewdocs.com](https://www.overviewdocs.com/)).

### B6. ICIJ Datashare
- **What it does**: "A self-hosted search engine to find stories in any files":
  ingests PDFs, emails, spreadsheets, images and archives; OCR on scans; named
  entity extraction; team/server mode; plugin architecture; REST API.
  ([repo](https://github.com/ICIJ/datashare), [datashare.icij.org](https://datashare.icij.org/))
- **Licence**: AGPL-3.0.
- **Hosting**: self-hosted (JDK 21, PostgreSQL, Elasticsearch, Redis, Docker);
  "no external cloud services required" per the README.
- **Maintained**: very active — last push 2026-09-16; 757 stars.
- **Owner**: International Consortium of Investigative Journalists (ICIJ).
- **AI**: none documented in the README; the strength is deterministic extraction
  and search.

### B7. Bellingcat tooling
- **What it is**: a curated catalogue, not a platform. Bellingcat's Online Open
  Source Investigation Toolkit indexes satellite, geolocation, image/video,
  social media, people, company, conflict and archiving tools.
  ([toolkit](https://bellingcat.gitbook.io/toolkit))
- **Own tooling**: repositories such as Auto Archiver (MIT; automatically
  archives links/videos/social content from Google Sheets)
  ([auto-archiver](https://github.com/bellingcat/auto-archiver)).
- **Relevance**: Bellingcat is a practitioner community and tool directory; it
  ships no integrated investigation platform.

### Set B summary

| System | OSS / licence | Self-host | Ingest breadth | Entity/KG | AI with citations | Reports | Status |
|---|---|---|---|---|---|---|---|
| Aleph | MIT, sunsetting | yes (legacy) | docs + CSV/SQL + scans | yes, watchlists/graph | risk scoring in Pro (claimed) | search/leads | legacy dead; Pro SaaS |
| DocumentCloud | AGPL-3.0 | possible, heavy | docs + audio (add-ons) | entity add-on | GPT/Whisper/OCR add-ons | annotated docs | very active |
| MuckRock | AGPL-3.0 | yes | FOIA requests + docs | — | OPENAI key in dev | published requests | active |
| Pinpoint | proprietary | no | docs + AV + email + tables | entity filters | gen-AI early access | collections | live |
| Overview | open source (unstated licence in API) | yes | document sets | — | no | visualisations | dead |
| Datashare | AGPL-3.0 | yes | docs, email, archives + OCR | NER | no | search results | very active |
| Bellingcat toolkit | mixed (directory) | n/a | n/a | n/a | n/a | n/a | active catalogue |
| Surveyor B-layer | AGPL-3.0 | yes (Cloudflare) | PDFs, office, scans | name gate, no KG | cite-bound pass | — | — |

---

## 4. Comparison set C — AI research and report automation

### C1. OpenAI deep research
- **What it does**: agentic multi-step research across the web (and uploaded
  files), producing a cited report "at the level of a research analyst";
  trained with end-to-end reinforcement learning for browsing and Python tool
  use; reports carry citations to sentences/passages; February 2026 update added
  MCP/app connections and the ability to restrict web search to trusted sites.
  ([OpenAI](https://openai.com/index/introducing-deep-research/))
- **Licence**: proprietary SaaS.
- **Threat model**: none for sources; no anonymity story. Content leaves the
  user's control into OpenAI's service.
- **Stated limitations**: can hallucinate, struggles to distinguish authoritative
  sources from rumour, weak confidence calibration
  ([OpenAI](https://openai.com/index/introducing-deep-research/)).
- **Outputs**: chat reports.

### C2. Anthropic Claude Research
- **What it does**: agentic research across web plus connected Google Workspace
  (Gmail, Calendar, Docs) with inline citations; Enterprise "cataloging" uses
  retrieval-augmented generation over an organisation's document index.
  ([Claude blog](https://claude.com/blog/research))
- **Licence**: proprietary SaaS.
- **Outputs**: cited answers and briefings inside Claude.

### C3. Perplexity Sonar Deep Research
- **What it does**: "Expert-level research model conducting exhaustive searches
  and generating comprehensive reports"; documented in the Sonar API alongside
  Sonar, Sonar Pro and Sonar Reasoning Pro.
  ([Perplexity docs](https://docs.perplexity.ai/docs/sonar/models))
- **Licence**: proprietary SaaS/API.
- **Threat model**: web-grounded; no private-corpus or source-protection model.

### C4. Google Gemini Deep Research
- **What it does**: agentic planner that searches and browses the web — and
  optionally the user's Gmail, Drive and Chat — then synthesises "multi-page
  reports", with Audio Overviews and Canvas interactive content; can ingest
  uploaded files; available in 150 countries and 45+ languages; a "thinking
  panel" shows progress.
  ([Gemini](https://gemini.google/overview/deep-research/))
- **Licence**: proprietary SaaS.
- **Point of difference**: the only mainstream deep-research agent documented to
  ground on a user's private workspace documents as well as the web.
- **AI/corpus distinction**: grounded in the user's own documents but with no
  citation-validation gate documented and no source-protection model.

### C5. Google NotebookLM
- **What it does**: source-grounded research and note-making ("AI Research Tool
  & Thinking Partner") ([notebooklm.google](https://notebooklm.google/)).
- **Caveat**: the product page is JavaScript-only; specific feature claims
  (citations, briefing docs, audio overviews) are **[unverified]** from primary
  sources in this session.

### C6. STORM (Stanford OVAL)
- **What it does**: LLM system that researches a topic on the internet and
  generates a Wikipedia-like article with citations; separates pre-writing
  (research + outline) from writing; Co-STORM adds human–AI collaborative
  discourse and a mind map; can ground on user-provided documents via VectorRM.
  ([repo](https://github.com/stanford-oval/storm))
- **Licence**: MIT.
- **Hosting**: self-hosted Python package (`knowledge-storm`); research preview
  hosted at Stanford.
- **Maintained**: 31,420 stars but last push 2025-09-30 (GitHub API, 17 Sep
  2026) — roughly a year stale.
- **AI grounding**: yes, with citations; academic paper NAACL 2024.

### C7. GPT Researcher
- **What it does**: autonomous research agent that plans, runs parallel web
  search, validates sources and writes long-form reports with inline citations;
  supports many LLM providers and retrievers, local document stores, MCP;
  outputs text/Markdown/PDF/DOCX/JSON.
  ([repo](https://github.com/assafelovic/gpt-researcher), [gptr.dev](https://gptr.dev/))
- **Licence**: Apache-2.0 (repo `LICENSE`); the marketing site claims MIT
  ([gptr.dev](https://gptr.dev/)) — a documented discrepancy.
- **Hosting**: self-hosted; BYOK for model and search providers.
- **Maintained**: very active — 29,488 stars, last push 2026-08-27.
- **Claimed benchmark**: #1 on CMU's DeepResearchGym (May 2025) ahead of
  Perplexity and OpenAI Deep Research, per its own site (vendor claim).

### C8. LangChain Open Deep Research
- **Status**: MIT, but **archived** by the owner; last push 2026-08-10
  ([repo](https://github.com/langchain-ai/open_deep_research)).
- **Relevance**: evidence that the OSS deep-research category is consolidating
  and some flagship projects are being retired.

### C9. Elicit
- **What it does**: AI research over ~125M academic papers; generates research
  reports "based on a process inspired by systematic reviews", with
  sentence-level citations; systematic-review screening and extraction;
  API/MCP.
  ([Elicit](https://elicit.com/))
- **Licence**: proprietary SaaS.
- **Threat model**: academic corpora; no source confidentiality.
- **Quality posture**: publishes evaluations of its own accuracy
  ([Elicit blog](https://blog.elicit.com/elicit-reports-eval/)).

### C10. Newsroom AI tools
- **DocumentCloud GPT add-on** (see B2) — AI document analysis inside an
  existing newsroom tool ([repo](https://github.com/MuckRock/documentcloud-gpt-addon)).
- **Full Fact AI** — claim detection, labelling, repeat-claim matching and media
  monitoring for fact-checkers; BERT-based classifiers plus a generative matching
  model; licenced to 40+ fact-checking organisations in three languages across
  30 countries; processes ~a third of a million sentences on a typical weekday.
  ([Full Fact AI](https://fullfact.org/ai/))
- **Google Pinpoint generative AI** — early access, by application (see B4).
- **Historical automated-newsroom systems** — Press Association's RADAR
  (Reporters And Data And Robots), AP's automated earnings stories, the
  Washington Post's Heliograf and Reuters' Lynx Insight are frequently cited, but
  no live primary source for these was reachable in this session: `radarai.org`
  now redirects to [pa.media](https://radarai.org/) with no active RADAR service
  page, and AP/Reuters AI pages returned 404/401. Treat the specific claims about
  these systems as **[unverified]**; RADAR's redirect is evidence the project
  page is gone, not proof of shutdown.

### Set C summary

| System | OSS / licence | Self-host | Corpus | Citations | Report output | Source anonymity | Status |
|---|---|---|---|---|---|---|---|
| OpenAI deep research | proprietary | no | web + uploads | yes | chat report | none | active |
| Claude Research | proprietary | no | web + Workspace | yes | answers/briefs | none | active |
| Perplexity Sonar DR | proprietary | no | web | yes | report | none | active |
| Gemini Deep Research | proprietary | no | web + Gmail/Drive/Chat | yes (claimed) | multi-page report | none | active |
| STORM | MIT | yes | web + user docs | yes | Wikipedia-like article | none | stale |
| GPT Researcher | Apache-2.0 | yes (BYOK) | web + local docs | yes | multi-format report | none | active |
| LangChain ODR | MIT | yes | web | yes | report | none | archived |
| Elicit | proprietary | no | academic papers | yes | research report | none | active |
| Full Fact AI | proprietary licence | no | news/social/TV feeds | matching | claim alerts | none | active |
| Surveyor C-layer | AGPL-3.0 | yes (BYOK) | the operator's gated corpus | yes, validated | five living types | full intake model | in progress |

---

## 5. Comparison set D — workplace / union-specific tooling

### D1. AllVoices
- **What it does**: "AI-native employee relations platform" for employers:
  anonymous reporting, whistleblower hotline, HR case management, workplace
  investigations, performance improvement, leave/accommodation workflows, data
  insights, HRIS integrations; AI drafts investigation plans, summarises
  evidence across documents/screenshots/audio/video, and writes reports.
  ([AllVoices](https://www.allvoices.co/))
- **Licence/hosting**: proprietary multi-tenant SaaS; SOC 2 Type 2, GDPR, CCPA,
  ISO badges displayed; "zero LLM training use" pledge.
- **Threat model**: employee anonymity is a product feature, but the platform is
  procured and controlled by the employer — the party being investigated is the
  customer. Encryption, not E2EE, and no source-held keys are documented.
- **AI grounding**: AI summarisation and report drafting over case evidence; no
  published citation-validation method.
- **Owner**: venture-backed company; customers listed include Airbnb, Chipotle,
  Zapier, Zoom.

### D2. Vault Platform (now Diligent)
- **What it does**: "Active Integrity" platform: mobile and open reporting
  channels (anonymous or "GoTogether" group reporting), Resolution Hub case
  management, Integrity Intelligence analytics.
  ([Vault](https://vaultplatform.com/))
- **Status**: acquired by Diligent (May 2025), marketed as AI-driven ethics and
  compliance under Diligent's Speak Up offering.
  ([press release](https://vaultplatform.com/press/press-releases/diligent-acquires-vault-ushering-in-a-new-era-of-ai-powered-ethics-and-compliance/))
- **Licence/hosting**: proprietary SaaS.
- **Threat model**: employer-controlled; anonymity by configuration.

### D3. Whispli
- **What it does**: enterprise whistleblowing and disclosures: secure anonymous
  intake ("Safe Inbox"), 70+ languages, web/mobile/voice, AI-powered voice
  hotline with transcription, conflict-of-interest and gifts registers, case
  workflows, immutable audit trails, board reporting.
  ([Whispli](https://www.whispli.com/))
- **Threat model claims**: no collection of IP addresses, device identifiers or
  metadata; reporters represented by pictograms; ISO 27001 and SOC 2 Type II;
  regional hosting (EU, US, UK, UAE, Australia, Asia); "your keys stay yours"
  ([Whispli](https://www.whispli.com/), [trust centre](https://www.whispli.com/trust-center)).
- **Licence/hosting**: proprietary SaaS, self-managed configuration.
- **AI**: voice intake transcription, triage assistance
  ([AI features](https://www.whispli.com/ai-features)).

### D4. NAVEX (incumbent compliance vendor)
- **What it does**: NAVEX One GRC platform; whistleblowing and incident
  management products include EthicsPoint Professional, EthicsPoint Essentials,
  WhistleB and Disclosure Management; "Nira" is an AI agent built into the
  platform; 2026 benchmark report analyses 2.37M reports across 4,000+
  organisations.
  ([NAVEX](https://www.navex.com/en-us/))
- **Owner**: NAVEX; majority stake acquired by a consortium led by Goldman Sachs
  Alternatives including Blackstone (announcement on the homepage).
- **Licence/hosting**: proprietary SaaS.
- **Threat model**: employer-controlled hotline; anonymity is a configured
  channel, not a structural guarantee.

### D5. Coworker.org
- **What it does**: non-profit, peer-based platform for worker campaigns —
  petitions, organising support, resource library, a Solidarity Fund for
  workers facing retaliation, and a Bossware/employment-tech database of 550+
  labour technology products.
  ([Coworker](https://home.coworker.org/))
- **Licence/hosting**: proprietary SaaS; 501(c)(4) non-profit.
- **AI**: none documented.
- **Relevance**: collective action and campaigning, not investigation or
  evidence tooling.

### D6. Callisto
- **What it does**: encrypted "Callisto Vault" for survivors to make a
  timestamped record and optionally **match** with others harmed by the same
  perpetrator; designed to expose serial offenders without a formal report and
  to reduce defamation exposure.
  ([Callisto](https://www.projectcallisto.org/))
- **Licence/hosting**: proprietary non-profit service.
- **Threat model**: strong survivor-privacy design; campus-focused rather than
  general workplace.
- **Relevance**: the closest thing to "anonymous corroboration matching" in the
  surveyed landscape — the idea Surveyor implements as corroborations across
  submissions.

### D7. Worker Info Exchange (WIE)
- **What it does**: UK non-profit helping workers reclaim workplace data:
  subject-access/portability requests at scale, data investigations into
  algorithmic management, and data trusts with unions; litigation against Uber
  over algorithmic "dynamic pay".
  ([WIE](https://www.workerinfoexchange.org/))
- **Licence/hosting**: not a software product.
- **Relevance**: the strongest existing practice of **documenting algorithmic
  workplace harm with data**, but it is a service/research organisation, not an
  automated platform.

### D8. Union operational software
- **UnionWare**: union management software (membership, dues, grievance
  tracking, organising modules); Canadian; "more than 200 unions"; explicitly
  not sold as SaaS subscriptions ([UnionWare](https://unionware.com/)).
- **UnionTrack ENGAGE**: union membership-engagement software
  ([UnionTrack](https://uniontrack.com/)).
- **Relevance**: these manage union operations and grievances for the union
  itself; they are not anonymous intake or investigation platforms.

### D9. Labour journalism
- Newsrooms such as **The Bureau of Investigative Journalism**
  ([thebureauinvestigates.com](https://www.thebureauinvestigates.com/)) publish
  investigative work, but their product is journalism, not an investigation
  platform. No labour-journalism project was found in this survey that ships a
  platform comparable to Surveyor; the closest workplace-facing software is the
  employer hotline/case-management category above.

### Set D summary

| System | OSS / licence | Hosting | Who it serves | Anonymity model | AI grounding | Investigation reports | Status |
|---|---|---|---|---|---|---|---|
| AllVoices | proprietary | SaaS | employer | configured, employer-controlled | summarisation/drafting | yes, for the employer | active |
| Vault/Diligent | proprietary | SaaS | employer | configured | claimed (AI automation) | yes, for the employer | active |
| Whispli | proprietary | SaaS | employer | no IP/device metadata; keys claim | voice AI, triage | yes, for the employer | active |
| NAVEX | proprietary | SaaS | employer | channel anonymity | Nira AI agent | yes, for the employer | active |
| Coworker | proprietary | SaaS | workers (collective) | low | none | no | active |
| Callisto | proprietary | service | survivors | strong, matching | none | no | active |
| WIE | n/a service | n/a | workers/unions | subject-access legal route | analysis by staff | reports/litigation | active |
| UnionWare / UnionTrack | proprietary | hosted/self | union staff | n/a | none | grievance records | active |
| Surveyor D-layer | AGPL-3.0 | self-hosted | journalist/union operator | structural (quarantine, no originals) | cite-bound pass | living reports | in progress |

---

## 6. Synthesis

### 6.1 Closest competitors overall (by layer)

| Layer | Closest competitor | Overlap | What the competitor has that Surveyor does not | What Surveyor has that the competitor does not |
|---|---|---|---|---|
| Anonymous intake | **Hush Line** (managed) and **SecureDrop** (hardened) | anonymous tips, two-way contact, Tor | E2EE (PGP/OpenPGP.js; SecureDrop protocol), Tor/onion, mature operational security, audits, 22–70+ languages | name-quarantine gate before any model; proof-of-work; browser-side extraction; integration with the rest of the stack |
| Corpus / document KB | **DocumentCloud** and **ICIJ Datashare** | ingest, OCR, search, entity handling | audio/video transcription, email/archive ingest, entity extraction, knowledge graphs, mature self-hosting, APIs, add-on ecosystem, years of production use | pre-mirror name-leak gate; quarantine + pseudonymisation; held lanes with actionable reasons; corpus fed directly into the research engine |
| Grounded research + reports | **GPT Researcher** (OSS, BYOK) and **Gemini Deep Research** (SaaS) | multi-source research, cited long-form reports | breadth of web/private-workspace sources, provider/model breadth, benchmarks, polished UIs, volume of users | research is bound to the operator's own gated corpus, citation-exact validation, capped spend per line, held-line exclusion, no web dependency |
| Living reports + publish gates | **None found** | — | — | five report types, manual-first gates, scheduled/per-N cadence, append-only history, poison flags |
| Workplace positioning | **Whispli / AllVoices / NAVEX** | workplace concerns, anonymous intake, AI drafting | compliance certifications, integrations, case management for investigators, industrial-scale user base | the operator is the journalist/union, not the employer: no conflict where the investigated party controls the evidence |

The single closest **overall** competitor depends on the frame:

- If the frame is "an anonymous tip line with a modern managed experience":
  **Hush Line**. It is the only other system with open code, a non-profit owner,
  a free tier, anonymous intake and two-way E2EE chat — but it stops at the
  intake layer.
- If the frame is "evidence tooling plus AI for journalists": **DocumentCloud**,
  with its GPT/Whisper/OCR add-ons, is the closest, but it has no anonymous
  intake, no research engine and no living-report cadence.
- If the frame is "research and report generation with citations": **GPT
  Researcher** or **OpenAI/Gemini Deep Research**, which are more capable at
  their layer but have no intake, no corpus governance and no publish gates.

No surveyed system combines more than two of Surveyor's four pillars.

### 6.2 Where Surveyor is genuinely ahead

1. **Corpus governance before model exposure (unique in the surveyed set).**
   The name-leak gate sits between extraction and any mirror, embedding, prompt
   or log write, with quarantined names and pseudonymisation, and the same gate
   applies to OCR output (`docs/adr/0002-corpus-ingestion-and-ocr.md`,
   `SECURITY.md` "Names never in the mirror"). DocumentCloud, Datashare, Aleph
   and the deep-research agents all send extracted content to models or indexes
   without an equivalent deterministic gate. Hush Line's E2EE protects messages
   from the service but does no name-gating of corpus content (it has no corpus).
2. **Structural isolation and custody: one investigation per install, BYOK,
   no platform account.** ADR-0001 rejects multi-tenancy so there is no shared
   database, queue or cross-tenant blast radius; provider keys and data live in
   the operator's own account (`docs/adr/0001`, `docs/adr/0008`,
   `docs/adr/0009`). Every SaaS competitor (AllVoices, Whispli, NAVEX, Aleph
   Pro, Pinpoint, Claude, OpenAI, Perplexity) holds the customer's data; the
   self-hostable competitors (SecureDrop, GlobaLeaks, Datashare, DocumentCloud,
   GPT Researcher) either lack a BYOK registry, lack per-investigation
   isolation, or require substantially more infrastructure to operate. The
   degraded-keyless mode (`docs/adr/0001`) is also unusual: most research agents
   hard-fail without API keys.
3. **Publish safety for adversarial input.** Manual-first gates, opt-in
   automatic gates stored with the report (not accepted at publish time),
   append-only published history, held-line exclusion from every report, and a
   two-tier rewrite routed by a bounded judge
   (`docs/adr/0004-report-outputs-and-publish-gates.md`; implemented in
   `src/lib/reports.ts:63-97`, `src/lib/pass.ts`). No competitor reviewed here
   has an equivalent model: AI report generators publish whatever they produce,
   and employer hotline platforms have case workflows but no reader-facing
   publish gates.
4. **Citations that are validated, not just rendered.** A citation counts only
   when its snippet occurs in the cited mirrored document, and uncited claims
   are annotated in drafts and stripped on publish unless explicitly approved
   (`src/lib/pass.ts:150-205`). The deep-research products cite sources but
   Surveyor's rule is enforced by validation against the operator's own corpus —
   a stronger, auditable guarantee for the report types it does produce.

### 6.3 Where Surveyor lags — candidate requirement gaps

Each gap is a capability a rival documents that Surveyor's docs do not claim.

1. **Source-side cryptography and network anonymity.** No E2EE, no Tor/onion
   service, no PGP for notifications; `workers.dev` hostnames only, with custom
   domains explicitly out of scope (`docs/adr/0006-launch-pack.md:44-47`).
   SecureDrop (Tor + workstation), Hush Line (PGP/OpenPGP.js + onion) and
   GlobaLeaks (Tor) all do this. Surveyor's own threat model admits the
   `workers.dev` limitation and the absence of a network-adversary story.
   Severity: high for workplace whistleblowing.
2. **Ingest breadth and extraction quality.** No audio/video transcription
   (DocumentCloud's Whisper add-on; Pinpoint; Whispli Voice AI), no email or
   archive ingest (Datashare's README documents emails and archives; Pinpoint
   lists e-mail archives), no table extraction (Pinpoint; DocumentCloud's
   Tabula add-on), no entity extraction or knowledge graph (Datashare NER;
   Aleph's cross-dataset entity matching; Pinpoint entity filters), and no
   measured OCR accuracy — the OCR bake-off is still an open unknown
   (`THREAT-MODEL.md` §5). Severity: high.
3. **No retention cap for held raw bytes.** A corpus file that never drains
   keeps its bytes indefinitely; the threat model calls this "a defect until a
   retention cap is implemented" (`THREAT-MODEL.md` T3). No rival reviewed here
   states an equivalent unmet obligation in its own documentation — which is
   evidence about disclosure, not proof that their retention is better.
   Severity: medium-high (custody and deletion promises).
4. **Two-way source contact is rudimentary.** Surveyor stores structured message
   rows (`src/routes/intake.ts:219-226`) and access codes
   (`src/lib/vault.ts:113-115`), but there is no documented source↔journalist
   chat experience comparable to Hush Line's E2EE chat, SecureDrop's source
   login, or GlobaLeaks' two-way messaging. Severity: medium-high for
   investigative follow-up.
5. **Investigator-side case management.** AllVoices, Whispli, Vault and NAVEX
   ship investigation workflows, interview prep, evidence review, task routing
   and audit-ready records; Surveyor has an angle queue, research lines and
   reports, but no case file, no interview tools, no legal-defensibility
   workflow. Severity: medium (required for workplace/union adoption).
6. **Compliance and procurement posture.** No SOC 2, ISO 27001/37002 mapping,
   GDPR data-processing documentation or regional hosting options; GlobaLeaks
   advertises ISO 37002/EU Directive/GDPR alignment, Whispli holds ISO 27001 and
   SOC 2 Type II with regional hosting, AllVoices displays SOC 2/GDPR/ISO
   badges. Severity: medium-high in the workplace segment.
7. **Localisation and accessibility.** Surveyor is single-language (Australian
   English) across its UI (`src/frontend/*.ts` use `lang="en-AU"`); rivals
   advertise 22 (SecureDrop), 70+ (GlobaLeaks, Whispli) and 45+ (Gemini Deep
   Research) languages. Severity: medium.
8. **External-source research.** Surveyor's engine is corpus-only by design
   (`docs/adr/0003-digest-angles-and-research-engine.md`). Deep-research systems
   add web, academic (OpenAI, Gemini, Perplexity, Elicit) and private workspace
   (Gemini: Gmail/Drive/Chat; Claude: Workspace + enterprise RAG) sources.
   For workplace investigations, external records (company registries, court
   filings, press archives) are often decisive. Severity: medium.
9. **Operational maturity of the platform itself.** No live trial for the OAuth
   or provisioning paths, no dead-letter queue, no retry-after-cap retry path,
   and teardown cannot purge Cloudflare-side logs/backups
   (`docs/adr/0008`, `docs/adr/0009`, `THREAT-MODEL.md` T7, T10). Rivals have
   years of production deployments and published security audits (SecureDrop,
   GlobaLeaks, Hush Line). Severity: high for a first investigation.
10. **Published quality evidence.** Elicit publishes evaluations of its report
    accuracy; GPT Researcher and STORM cite benchmarks and papers. Surveyor has
    no measured OCR bake-off, no report-quality evaluation, and no published
    penetration-test result beyond its own Niro workflow (`README.md`; the Niro
    reports are 30-day CI artefacts, not published evidence). Severity: medium.

### 6.4 Does the specific combination already exist?

**No surveyed system combines all four pillars** — anonymous intake, corpus
ingestion with pre-model governance, grounded research over that corpus, and
gated living reports — in one self-hosted, BYOK package. The nearest overlaps
are: Hush Line (intake only, managed), DocumentCloud (corpus + AI add-ons),
Datashare (corpus, self-hosted), GPT Researcher (research + report, BYOK),
SecureDrop (intake, hardened). The Cloudflare-native, one-install-per-
investigation deployment shape was not found anywhere else in this landscape,
and no competitor publishes a pre-mirror name-leak gate or publish gates for
auto-generated reports. On the evidence available, the combination is
**genuinely novel**; the individual capabilities within it are not.

### 6.5 Honest verdict on "better than the best current system online"

This is a per-dimension question, not a single score. Qualitative scores below
(1 = absent, 5 = best-in-class), with the best comparator named. These are
judgements from the documented evidence, not benchmarks.

| Dimension | Surveyor | Best current | Notes |
|---|---|---|---|
| Source anonymity / threat model | 2.5 | SecureDrop 5, Hush Line 4.5 | no Tor/E2EE; strong storage sealing; `workers.dev` only |
| Intake usability (low-friction, mobile) | 3.5 | Hush Line 5 | survey framing and PoW are good; no mobile app, no multi-language |
| Corpus ingest breadth | 2.5 | Datashare 4.5, DocumentCloud 4.5 | documents and scans only; no AV, email, tables, entity graph |
| Corpus governance / custody | 4.5 | none comparable | pre-mirror name gate, quarantine, held lanes; retention cap missing |
| Grounded research with citations | 3.5 | OpenAI/Gemini DR 4.5, GPT Researcher 4 | validation is stronger; breadth and model capability far behind |
| Living reports / publish safety | 4 | no direct comparator | unique design; unproven in production |
| Self-hosting / BYOK / isolation | 5 | GPT Researcher 4 | one install per investigation and BYOK registry are unmatched |
| Deployment and ops maturity | 2 | Hush Line 5, GlobaLeaks 4.5 | live-trial gaps, no DLQ, provisioner unverified |
| Compliance / procurement | 1 | Whispli 5, NAVEX 5, GlobaLeaks 4.5 | no certifications, no DPA, no regional hosting |
| Localisation / accessibility | 1.5 | GlobaLeaks 5 | English-only UI |
| Investigator case management | 2.5 | AllVoices 4.5, Whispli 4.5 | angle queue and lines exist; no case file/interviews |
| Novelty of the whole | 5 | — | combination not found elsewhere |

**Verdict**: Surveyor is not, today, better than the best current system online
on most dimensions. It is ahead on custody/isolation, corpus governance and
publish safety — the dimensions its constitution prioritises — and behind on
source-side cryptography, ingest breadth, AI capability and breadth, compliance,
localisation and operational maturity. Its honest claim is narrower and
defensible: *for a journalist or union running a single workplace
investigation, entirely inside infrastructure they control, Surveyor is the
only system that carries a source from anonymous intake through a
name-gated corpus to a cite-validated, gated living report — provided the
operator accepts the unproven production paths and the weaker network-anonymity
model.*

The "better than the best current system" ambition is achievable **per
dimension** but not yet as a whole. The realistic roadmap to that claim:
close gap 1 (or document an explicit, honest decision not to), close gap 2,
finish the live-trial items already tracked, and publish measured extraction
and report-quality evidence so the grounding claim is verifiable by others.

---

## Appendix — primary sources consulted

| # | Source | Used for |
|---|---|---|
| 1 | https://securedrop.org/ | SecureDrop overview, releases, ownership |
| 2 | https://github.com/freedomofpress/securedrop | licence, activity, features |
| 3 | https://github.com/freedomofpress/securedrop-protocol | E2EE protocol research status |
| 4 | https://www.globaleaks.org/ | GlobaLeaks claims, funding, languages |
| 5 | https://github.com/globaleaks/globaleaks-whistleblowing-software | licence, activity |
| 6 | https://hushline.app/ | Hush Line features, threat model, funding, pricing |
| 7 | https://github.com/scidsg/hushline | licence, activity |
| 8 | https://publeaks.nl/ | Publeaks operation, partners, funding |
| 9 | https://onionshare.org/ | OnionShare features |
| 10 | https://github.com/onionshare/onionshare | licence, activity |
| 11 | https://docs.alephdata.org/ | Aleph capabilities |
| 12 | https://raw.githubusercontent.com/alephdata/aleph/develop/README.rst | Aleph sunsetting notice |
| 13 | https://www.occrp.org/en/announcement/aleph-pro-frequently-asked-questions-on-the-future-of-occrps-investigative-data-platform/ | Aleph Pro model, pricing, plans |
| 14 | https://github.com/MuckRock/documentcloud | DocumentCloud licence, self-hosting, activity |
| 15 | https://github.com/MuckRock/documentcloud-gpt-addon (+ whisper, cloud-vision-ocr, azure OCR, entity extractor, summarize repos) | DocumentCloud AI add-ons |
| 16 | https://github.com/MuckRock/muckrock | MuckRock licence, activity, AI key |
| 17 | https://journaliststudio.google.com/pinpoint/about/ | Pinpoint capabilities, gen-AI early access |
| 18 | https://journaliststudio.google.com/ | Journalist Studio suite |
| 19 | https://github.com/overview/overview-server ; https://www.overviewproject.org/ ; https://www.overviewdocs.com/ | Overview status |
| 20 | https://github.com/ICIJ/datashare | Datashare licence, features, activity |
| 21 | https://bellingcat.gitbook.io/toolkit | Bellingcat toolkit scope |
| 22 | https://github.com/bellingcat/auto-archiver | Bellingcat OSS tool, licence |
| 23 | https://openai.com/index/introducing-deep-research/ | OpenAI deep research capabilities and limitations |
| 24 | https://claude.com/blog/research | Claude Research and Workspace cataloging |
| 25 | https://docs.perplexity.ai/docs/sonar/models | Sonar Deep Research |
| 26 | https://gemini.google/overview/deep-research/ | Gemini Deep Research scope |
| 27 | https://notebooklm.google/ | NotebookLM (page title only; feature claims unverified) |
| 28 | https://github.com/stanford-oval/storm | STORM licence, function, activity |
| 29 | https://github.com/assafelovic/gpt-researcher ; https://gptr.dev/ | GPT Researcher licence, capabilities, claimed benchmark |
| 30 | https://github.com/langchain-ai/open_deep_research | archived status |
| 31 | https://elicit.com/ | Elicit capabilities and accuracy posture |
| 32 | https://fullfact.org/ai/ | Full Fact AI scale and method |
| 33 | https://www.allvoices.co/ | AllVoices products, AI features, security claims |
| 34 | https://vaultplatform.com/ and press release | Vault features, Diligent acquisition |
| 35 | https://www.whispli.com/ and https://www.whispli.com/trust-center | Whispli features, anonymity claims, certifications |
| 36 | https://www.navex.com/en-us/ | NAVEX products, AI agent, ownership, benchmark |
| 37 | https://home.coworker.org/ | Coworker.org scope |
| 38 | https://www.projectcallisto.org/ | Callisto matching model |
| 39 | https://www.workerinfoexchange.org/ | WIE activities and litigation |
| 40 | https://unionware.com/ ; https://uniontrack.com/ | union operational software |
| 41 | https://www.thebureauinvestigates.com/ | labour journalism context |
| 42 | GitHub API (api.github.com/repos/…) | licences, stars, last-push dates, archived flags, all read 2026-09-17 |
