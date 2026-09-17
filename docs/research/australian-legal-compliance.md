# Australian legal compliance — research for Surveyor

**Date**: 17 September 2026
**Status**: Research note. **This is not legal advice.** It maps Australian legal
obligations onto Surveyor's design so the project can decide what to build and
what to put in operator documentation. Before relying on any of it for a live
investigation, a qualified Australian lawyer must review the specific facts
(who the operator is, where the sources are, what is published, how recordings
were obtained).

**Scope**: an operator who is either an Australian journalist or a union,
running a single workplace investigation; anonymous worker testimony; ingestion
of workplace documents; an AI engine proposing research angles and drafting
reports; publication gated by a human.

**Method**: primary sources only — legislation.gov.au, the OAIC, state
legislation/regulator sites, departmental guidance. Where a source could not be
read directly at research time, the item is marked **[unverified]**; the
instrument and section are still named so a lawyer or later pass can check it.
Two jurisdictions (NSW, some state surveillance Acts) were unreachable in full
and are treated accordingly. Quotations are verbatim from the compiled text
unless marked otherwise. Australian English throughout.

**Conventions used below**

- **(a) operator duty** — something the human operator must do or decide; no
  software can discharge it.
- **(b) software feature** — a capability Surveyor should implement so the
  operator can meet the duty.
- **(c) both** — the duty is the operator's, but the software must supply the
  machinery (evidence, records, defaults) without which the duty cannot be met
  reliably.

---

## 0. Executive summary

1. **A union operator is covered by the Privacy Act regardless of turnover.**
   A small business operator that is an association of employees registered or
   recognised under the *Fair Work (Registered Organisations) Act 2009* is
   treated as an organisation (Privacy Act 1988 (Cth) s 6E(1C); OAIC, *Small
   business*). A journalist operator may fall under the small-business
   exemption (s 6D) or the journalism exemption (s 7B(4)), but both are narrow
   and fact-dependent, and the journalism exemption requires a public
   commitment to published privacy standards.
2. **The employee-records exemption does not protect the operator.** It applies
   to the employer of the individual whose record it is, not to a journalist or
   union holding an employer's HR material (s 7B(3); OAIC, *Employee records
   exemption*). Workplace documents ingested into Surveyor are therefore
   ordinary personal information under the APPs unless another exemption
   applies.
3. **Cross-border disclosure is the sharpest structural issue.** Surveyor runs
   on Cloudflare's global network, uses BYOK model providers overseas, and
   Cloudflare offers no Australian jurisdiction for R2 or D1. APP 8 and s 16C
   make the operator accountable for how those overseas recipients handle
   personal information. This is manageable with contracts and notices, but
   Surveyor currently neither records the disclosure nor supports an APP 8
   consent/notice.
4. **Retention and deletion is the second sharpest.** APP 11.2 requires
   destruction or de-identification once information is no longer needed. The
   repository itself records that held corpus bytes in R2 have no retention cap
   (`THREAT-MODEL.md` T3) and teardown cannot purge Cloudflare backups/logs
   (T10).
5. **The Notifiable Data Breaches scheme applies** if any APP-covered operator
   suffers an eligible data breach: assess within 30 days (s 26WH), notify the
   OAIC and at-risk individuals as soon as practicable (ss 26WK–26WL). The
   platform currently has detection signals but no assessment/notification
   workflow.
6. **Whistleblower identity is criminal-law territory.** Corporations Act 2001
   Part 9.4AAA makes unauthorised disclosure of a whistleblower's identity an
   offence (s 1317AAE) and protects only defined disclosures (s 1317AA,
   s 1317AAD). Surveyor's identity separation is a good foundation, but its
   notices must not promise statutory protection the law does not give.
7. **Covert recordings split into two legal questions** — recording and
   publishing. Victoria and the Northern Territory permit one-party recording
   and carve out a public-interest exception for publication (Vic SDA 1999
   ss 6, 11; NT SDA 2007 ss 11, 15); other states vary and were **[unverified]**
   here. Surveyor should capture provenance and consent, and gate publication
   behind a legal review.
8. **Defamation is the publication risk**, but the uniform Defamation Acts
   reward exactly the behaviours Surveyor already has (grounded citations,
   corroboration, human gate) and add two it lacks (right of reply; a
   legal-review point). Serious harm is now an element (s 10A); the public
   interest defence is s 29A and is not limited to journalists.
9. **Shield laws protect a promise, not anonymity in the abstract.** The
   Commonwealth and uniform Evidence Acts give a journalist privilege over an
   informant's identity only if the journalist promised confidentiality
   (Evidence Act 1995 (Cth) s 126K); a court can override it. Surveyor's source
   promise is therefore a legal act and should be recorded.
10. **AI-specific law is not yet in force.** The Voluntary AI Safety Standard
    (2024, updated 2025) and the *Guidance for AI Adoption* (21 October 2025)
    are voluntary; the mandatory-guardrails proposals (2024) were consulted on,
    not enacted. The binding AI-adjacent obligation is privacy law — including
    the new APP 1.7 automated-decision disclosure commencing
    **10 December 2026**.

---

## 1. Privacy Act 1988 (Cth) and the Australian Privacy Principles

**Primary instruments**

- *Privacy Act 1988* (Cth), compilation 104 (registered 4 June 2026):
  <https://www.legislation.gov.au/C2004A03712/latest/text> (all section
  references below are from this compilation unless otherwise stated).
- *Privacy and Other Legislation Amendment Act 2024* (Cth) (POLAA 2024),
  No. 128 of 2024: <https://www.legislation.gov.au/C2024A00128>.
- OAIC, *Australian Privacy Principles guidelines* (chapter pages and PDFs):
  <https://www.oaic.gov.au/privacy/australian-privacy-principles/australian-privacy-principles-guidelines>.

### 1.1 Which regime binds the operator

| Obligation | Instrument and section | Requirement, plainly | Duty or feature |
|---|---|---|---|
| Union operator is covered regardless of size | Privacy Act s 6E(1C); OAIC, *Small business* (list: "employee associations registered or recognised under the *Fair Work (Registered Organisations) Act 2009*") | An employees' association registered under the FW(RO) Act is treated as an organisation; APPs apply in full | **(a)** — the union cannot opt out by turnover |
| Small-business exemption | Privacy Act s 6D(1)–(3) (turnover ≤ $3m); s 6D(4)(c)–(d) (trading in personal information) | A journalist operating a small business is exempt **unless** they disclose personal information for a benefit, service or advantage, or collect it by providing one, without consent or legal authority | **(a)** — a legal characterisation of the operator's conduct |
| Journalism exemption | Privacy Act s 7B(4) | A **media organisation** is exempt for acts "in the course of journalism" only while "publicly committed to observe standards that … deal with privacy" and that are "published in writing" by it or a body representing media organisations | **(a)+(b)** — duty to adopt/commit to standards; feature to publish the commitment and evidence it |
| Employee-records exemption | Privacy Act s 7B(3); s 6(1) "employee record"; OAIC, *Employee records exemption* | Exempts an employer's handling of its **own** employee records; it "does not cover contractors and subcontractors when they handle the personal information of the employees of another organisation" | **(a)** — do not assume ingested HR files are exempt |
| Coverage of the operator's own staff | Privacy Act ss 6D, 7B(3) | If the operator is a small business and only handles its own employees' records, parts of its own staff administration may be outside the APPs; this does not cover the workers whose documents are investigated | **(a)** |
| "Personal information" | Privacy Act s 6(1) | Information or opinion about an identified or reasonably identifiable individual, true or not, recorded or not | **(a)** — classification decision |

**Plainly**: for a union investigation the APPs apply to the whole pipeline —
submissions, corpus, prompts, reports, logs. For a sole journalist the
threshold question is whether the small-business exemption is lost (e.g. by
publication for a benefit) or whether the journalism exemption applies; the
journalism exemption is act-specific and requires a published privacy-standard
commitment. Neither route removes the APP 8/NDB consequences if the operator is
covered.

### 1.2 The APPs that bite on this design

| APP | Instrument | Requirement | Duty or feature | Concrete Surveyor implication |
|---|---|---|---|---|
| APP 1.2 | Sch 1 cl 1.2 | Reasonable steps to implement practices, procedures and systems that ensure APP compliance and handle inquiries/complaints | **(c)** | A generated operator compliance pack: policy, complaint route, roles, review receipts |
| APP 1.3–1.6 | Sch 1 cll 1.3–1.6; OAIC Ch 1 | Clearly expressed, up-to-date APP privacy policy; available free and in requested form | **(b)** | Wizard-generated privacy policy and collection notice, versioned with the installation |
| APP 1.7–1.9 | Sch 1 cll 1.7–1.9, inserted by POLAA 2024 Sch 1 Pt 15, **commencing 10 December 2026** | Privacy policy must state the kinds of personal information used by computer programs making decisions that could reasonably be expected to significantly affect an individual's rights or interests | **(c)** | An "automated decisions" register in the wizard; update policy automatically when the engine auto-gates/auto-publishes |
| APP 2.1 | Sch 1 cl 2.1 | Individuals must have the option not to identify, or to use a pseudonym | **(b)** | Already core (anonymous survey); record it as the APP 2 compliance mechanism |
| APP 3.2–3.6 | Sch 1 cll 3.2–3.6 | Collect only what is reasonably necessary; sensitive information (health, union membership, political opinions, sexual orientation) requires consent; lawful and fair means; collect from the individual | **(c)** | Survey must capture granular consent for sensitive categories; corpus ingestion should record why each category is "reasonably necessary" |
| APP 4.1–4.3 | Sch 1 cll 4.1–4.3 | Unsolicited personal information: decide within a reasonable period whether it could have been collected; if not, destroy or de-identify | **(b)** | A triage lane for documents uploaded by sources that were not requested; deletion receipt |
| APP 5.1–5.2 | Sch 1 cll 5.1–5.2 | Notify at or before collection of identity/purposes, overseas disclosure and countries, access/complaint routes | **(c)** | Consent/notice text shown before intake; overseas-recipient list pulled from the provider registry |
| APP 6.1–6.2 | Sch 1 cll 6.1–6.2; OAIC Ch 6 | Use/disclose only for the primary purpose, or a permitted secondary purpose (consent; reasonable expectation; legal requirement; permitted general situation) | **(a)+(b)** | Publishing the investigation should be disclosed as a purpose at intake; sending text to a model provider is a secondary use/disclosure needing a lawful basis |
| APP 6.5 | Sch 1 cl 6.5 | Written note of enforcement-related uses/disclosures | **(b)** | Audit note on any such disclosure |
| APP 8.1–8.3 | Sch 1 cll 8.1–8.3; s 16C; OAIC Ch 8 and *Sending personal information overseas* | Before disclosing personal information to an overseas recipient, take reasonable steps to ensure it will not breach the APPs; the operator is accountable for the recipient's breach; exceptions include substantially similar law and express consent after being informed | **(c)** | Provider/Cloudflare register; APP 8 consent flag; contractual measures; do not rely on "substantially similar law" without advice |
| APP 9 | Sch 1 cl 9 | Do not adopt government related identifiers (e.g. tax file numbers, Medicare numbers) as identifiers | **(b)** | Quarantine/ignore identifiers in ingestion; never use them as keys |
| APP 10 | Sch 1 cl 10; OAIC, *AI products* guidance | Reasonable steps to ensure collected/used/disclosed personal information is accurate, complete and up to date | **(c)** | Citation binding, corroboration ticks, hallucination fences, operator review |
| APP 11.1, 11.3 | Sch 1 cll 11.1, 11.3 | Reasonable steps to protect personal information from misuse, interference, loss, unauthorised access/modification/disclosure; measures include technical **and** organisational | **(c)** | Encryption at rest/in transit, key custody, access control, audit logs, staff/operator procedures |
| APP 11.2 | Sch 1 cl 11.2; OAIC Ch 11 | Destroy or de-identify personal information no longer needed for a permitted purpose; includes archived/back-up copies | **(b)** | **Retention engine**: schedules per data class, hard deletes, verification receipts, back-up handling |
| APP 12–13 | Sch 1 cll 12, 13 | Access to, and correction of, personal information; exceptions include unreasonable impact on others' privacy | **(b)** | A data-subject request workflow; note third-party names will usually support a refusal on privacy grounds |
| s 13G | Privacy Act s 13G | Civil penalty for a **serious** interference with privacy — for a body corporate up to the greater of $50m, 3× benefit or 30% of adjusted turnover | **(a)** — but the exit price shapes the security case |

**Plainly**: the operator is choosing legal bases; the software supplies the
notices, consent records, retention, audit and minimisation that make the bases
real. Nothing here requires an SDK; it requires defaults and receipts.

### 1.3 Notifiable Data Breaches (NDB)

| Obligation | Instrument and section | Requirement, plainly | Duty or feature |
|---|---|---|---|
| Assess suspected breach | Privacy Act s 26WH | Reasonable and expeditious assessment, all reasonable steps to complete within **30 days** of becoming aware | **(c)** |
| Define an eligible breach | Privacy Act s 26WE | Unauthorised access/disclosure (or loss likely to lead to it) that a reasonable person would conclude is likely to result in **serious harm** | **(c)** |
| Notify | Privacy Act ss 26WK, 26WL; s 26WP (secrecy inconsistency) | Prepare a statement containing identity, description, kinds of information and recommended steps; give it to the Commissioner and notify at-risk individuals as soon as practicable | **(b)+(a)** |
| Enforcement hook | Privacy Act s 13(4A) | Failure to comply with ss 26WH(2), 26WK(2), 26WL(3) is taken to be an interference with privacy | **(a)** |
| OAIC guidance | OAIC, *About the Notifiable Data Breaches scheme*; *When to report* | Report via the OAIC NDB form; individuals must get recommendations | **(a)** |

**Surveyor today**: detection flags exist but are "probabilistic and never
auto-actioned" (`THREAT-MODEL.md` §4). There is no incident object, no 30-day
clock, no OAIC statement builder. That is a gap, not a design flaw.

### 1.4 Statutory tort for serious invasions of privacy

| Obligation | Instrument and section | Requirement, plainly | Duty or feature |
|---|---|---|---|
| Cause of action | Privacy Act Sch 2 cl 7 (inserted by POLAA 2024 Sch 2, **commenced 10 June 2025**) | Intrusion upon seclusion or misuse of information; reasonable expectation of privacy; intentional or reckless; serious; public interest in privacy outweighs countervailing public interests | **(a)** |
| Truth is no defence | Sch 2 cl 7(7) | It is immaterial whether the information was true | **(a)** |
| Defences | Sch 2 cl 8 | Lawful authority, consent, necessity, defence of persons/property; where publication is involved, defamation-style defences (absolute privilege, public documents, fair report) are imported | **(a)+(b)** |
| Journalist exemption | Sch 2 cl 15 | Schedule does not apply to a **journalist** (professional capacity; subject to standards of professional conduct or a code of practice) collecting/preparing/publishing journalistic material; immaterial whether the conduct breached those standards | **(a)+(b)** — union-run investigations may not qualify |
| Remedies and time limits | Sch 2 cll 11, 14 | Damages (no aggravated damages; damages for emotional distress available); time limits on proceedings | **(a)** |

**Plainly**: a true story can still ground a privacy tort claim if the intrusion
or misuse is serious and the public-interest balance fails. The human gate is
the defence; the software should record the public-interest reasoning at
publication time.

### 1.5 Reform commencement dates (POLAA 2024)

| Reform | Commencement | Source |
|---|---|---|
| Most Schedule 1 amendments (incl. new APP 11.3 technical/organisational measures; children's online privacy code; s 13G serious interference penalties) | 11 December 2024 | POLAA 2024 s 2 table items 2, 6; Privacy Act endnote 3 |
| Statutory tort (Schedule 2) | **10 June 2025** | POLAA 2024 s 2 table item 8; Privacy Act endnote 3 |
| Automated decision-making transparency (Schedule 1 Part 15; APP 1.7–1.9) | **10 December 2026** | POLAA 2024 s 2 table item 7; OAIC Ch 1 |

### 1.6 Implied features (Privacy Act)

1. **Retention and deletion engine** (APP 11.2): per-class schedules, hard
   delete of D1 rows, R2 objects and queues, verified receipts, documented
   treatment of back-ups.
2. **Breach workflow** (Part IIIC): incident record, 30-day assessment clock,
   OAIC statement generator, individual notification templates.
3. **Cross-border disclosure register** (APP 8): every provider and Cloudflare
   service that can see personal information, with contract status and notice
   text.
4. **Policy/notice generator** (APP 1, 5, 1.7): versioned privacy policy,
   collection notice and automated-decision disclosure shipped with each
   installation.
5. **Consent and purpose capture** (APPs 3, 6): what the source consented to,
   what the purpose of collection was, which secondary uses are in scope.
6. **Minimisation defaults** (APP 3, 9): name quarantine, identifier
   stripping, no IP/UA/referrer logging, ephemeral by default.
7. **Audit trail** (APP 1.2, 11.1): append-only receipts for access, exports,
   publishes, deletions and key operations.

---

## 2. Whistleblower protections

**Primary instruments**

- *Corporations Act 2001* (Cth) Part 9.4AAA:
  <https://www.legislation.gov.au/C2004A00818/latest/text>.
- *Public Interest Disclosure Act 2013* (Cth):
  <https://www.legislation.gov.au/C2013A00133/latest/text>.
- *Fair Work (Registered Organisations) Act 2009* (Cth) Part 4A:
  <https://www.legislation.gov.au/C2004A03679/latest/text>.

### 2.1 Corporations Act 2001 Part 9.4AAA

| Obligation | Instrument and section | Requirement, plainly | Duty or feature |
|---|---|---|---|
| Qualifying disclosure | s 1317AA | A disclosure qualifies only if the discloser is an eligible whistleblower and makes it to ASIC/APRA/a prescribed body, an eligible recipient (officer, senior manager, auditor, actuary, authorised person), or a legal practitioner | **(a)** |
| Public interest / emergency disclosure to a journalist | s 1317AAD | A further disclosure to a journalist (or parliamentarian) qualifies only where the discloser first made a protected internal/regulator disclosure, **90 days** have passed, the discloser reasonably believes action is not being taken and that the further disclosure is in the public interest, gives written notice of intent, and discloses no more than necessary | **(a)** — the journalist's receipt is lawful only through this gateway |
| Identity confidentiality | s 1317AAE | A person who obtained identity information because of a qualifying disclosure must not disclose the identity, or information likely to lead to it, except to ASIC/APRA/AFP, a legal practitioner, a prescribed body or **with the discloser's consent**; the prohibition is an **offence** and a civil penalty provision | **(c)** |
| No adverse action | ss 1317AB, 1317AC | The discloser is not liable and contracts cannot be enforced on the basis of the disclosure; causing or threatening detriment because of a (possible) qualifying disclosure is an offence and a civil penalty provision | **(a)+(b)** — no adverse-action surface in software |
| Personal work-related grievances excluded | s 1317AADA | Purely personal grievances are not protected | **(a)** |

**Plainly**: if a worker tells a journalist or union about misconduct at their
employer, that is not automatically a protected disclosure. The operator must
not tell sources that it is. If it *is* a qualifying public-interest disclosure,
the operator inherits the s 1317AAE identity duty; Surveyor's quarantine and
access controls support that, but the operator must also avoid derivative
leaks (file names, timestamps, prose describing the worker's role).

### 2.2 Public Interest Disclosure Act 2013 (Cth)

| Obligation | Instrument and section | Requirement, plainly | Duty or feature |
|---|---|---|---|
| Protection | s 10 | A public official who makes a public interest disclosure is protected; disclosure categories are internal, external, emergency, legal practitioner and NACC | **(a)** |
| Reprisals | s 13; ss 14–16 civil remedies; s 19 offences | Taking a reprisal, including threats, is an offence and actionable | **(a)** |
| Identity | s 20 | Disclosing or using identifying information obtained as a public official is an offence (6 months' imprisonment / 30 penalty units) with narrow exceptions (purposes of the Act, legal advice, consent, already published) | **(c)** |
| Court protection | s 21 | A public official is not compellable to disclose identifying information to a court or tribunal except to give effect to the Act | **(a)** |

**Plainly**: the PID Act protects public officials disclosing to defined
recipients; a journalist or union is not a PID recipient. It still matters to
Surveyor because (i) some sources may be public officials who have already made
a PID disclosure, and (ii) the identity-protection standard (s 20 is criminal
law) is the standard of care Surveyor should meet for all sources.

### 2.3 Fair Work (Registered Organisations) Act 2009 Part 4A

| Obligation | Instrument and section | Requirement, plainly | Duty or feature |
|---|---|---|---|
| Protected disclosures | s 337A | A disclosure qualifies if the discloser is an officer/employee/member/contractor of an organisation or branch and makes it to the General Manager, an FWC Member or staff, an administrator under a scheme, or FWO staff — not to a journalist or the public | **(a)** |
| Protections | s 337B | Not actionable; qualified privilege in defamation; contracts cannot be terminated for it | **(a)** |
| Reprisals | ss 337BA–337BE | Reprisal definitions, civil remedies, costs, civil penalties, criminal offences | **(a)** |

**Plainly**: a union-run investigation is *about* a regulated entity (the
employer) under the Corporations Act, but the union's own members/officers who
disclose *about the union* only have the FW(RO) recipients in s 337A. A union
operator should not conflate its own Part 4A obligations with the employers'
Corporations Act obligations.

### 2.4 State and territory PID schemes

Every state and territory has a public interest disclosure regime with its own
recipient rules and identity protections **[unverified — listed but not read at
research time]**: NSW *Public Interest Disclosures Act 1994*; Qld *Public
Interest Disclosure Act 2010*; Vic *Public Interest Disclosures Act 2012*; SA
*Public Interest Disclosure Act 2018*; WA *Public Interest Disclosure Act
2003*; Tas *Public Interest Disclosure Act 2002*; ACT *Public Interest
Disclosure Act 2012*; NT *Public Interest Disclosure Act 2008*. The common
feature is that protection attaches to disclosures to specified recipients;
journalists and unions are generally not among them.

### 2.5 Implied features (whistleblower)

1. **Identity separation and encryption** already built (quarantine, HMAC
   access codes, no originals) — extend it: no identity in activity logs, no
   identity in prompts, no identity in exports by default.
2. **Break-glass controls**: any access to identity-adjacent data requires a
   second authorisation and writes an immutable receipt.
3. **Non-overpromising notice**: explicit text that Surveyor anonymity is not
   the same as statutory whistleblower protection, and guidance on the
   statutory pathways (Corporations Act s 1317AAD; PID recipients).
4. **"Protected disclosure" intake branch**: if a source says they are making a
   protected disclosure, route them to the statutory pathway and record the
   advice given.
5. **Derivative-leak checks**: lint report drafts for role/identity
   combinations that could re-identify a source before publish.
6. **Deletion on request / end of investigation** with verification (aligns
   with APP 11.2 and the s 1317AAE duty).

---

## 3. Workplace surveillance and covert recordings

**Position in one paragraph**: recording and publishing are separate offences.
Most jurisdictions regulate *recording* a private conversation; several also
regulate *communicating or publishing* the recording. Some allow a party to the
conversation to record it; some carve out a public-interest exception for
publication. A journalist or union that merely receives a recording is
generally not the recorder, but directing or procuring a recording can make
them a party to the offence, and publishing can be a separate offence even
where the recording was lawful.

### 3.1 Victoria (text read in full)

| Obligation | Instrument and section | Requirement, plainly | Duty or feature |
|---|---|---|---|
| Recording a conversation | *Surveillance Devices Act 1999* (Vic) s 6(1) | Offence to use a listening device to record "a private conversation to which the person is **not a party**" without each party's consent — a party may record their own conversation | **(a)** |
| Optical surveillance | Vic SDA s 7(1) | Same structure for private activities the person is not a party to | **(a)** |
| Toilets/change rooms | Vic SDA s 9B | Employer offence to observe/record workers in a toilet, washroom, change room or lactation room; publication of such records is separately prohibited | **(a)** |
| Publishing | Vic SDA s 11(1) | Offence to communicate or publish a record/report of a private conversation or activity made as a direct or indirect result of a surveillance device | **(a)** |
| Public-interest exception | Vic SDA s 11(2)(b)(i) | Does not apply to a communication or publication "no more than is reasonably necessary … in the public interest" | **(a)+(b)** — the software should assemble the material that evidences the public interest |
| Consent exception | Vic SDA s 11(2)(a) | Communication/publication with the express or implied consent of each party | **(b)** — consent capture |

### 3.2 Northern Territory (text read in full)

| Obligation | Instrument and section | Requirement, plainly | Duty or feature |
|---|---|---|---|
| Recording a conversation | *Surveillance Devices Act 2007* (NT) s 11(1) | Offence to use a listening device to record a private conversation "to which the person is **not a party**" without each party's consent | **(a)** |
| Publishing | NT SDA s 15(1) | Offence to communicate or publish a record/report of a private conversation/activity known to result from a listening/optical/tracking device | **(a)** |
| Public-interest exception | NT SDA s 15(2)(b)(i) | Exception where the communication/publication is "reasonably necessary … in the public interest" | **(a)+(b)** |
| Court order | NT SDA s 46 (title: "Order allowing publication or communication in public interest") | A court may allow publication in the public interest **[unverified — section title only]** | **(a)** |

### 3.3 New South Wales

The NSW regime is split: the *Workplace Surveillance Act 2005* (NSW) regulates
employer surveillance of workers — camera, computer and tracking surveillance,
including notice requirements and a prohibition in change rooms and toilets
**[unverified — Act text inaccessible; scope and section numbers must be
checked]** — while the *Surveillance Devices Act 2007* (NSW) covers listening
devices and optical surveillance devices. The Information and Privacy Commission NSW confirms both
Acts are administered by the NSW Department of Justice and that the IPC does
not administer or advise on them (IPC NSW, *Workplace surveillance*,
<https://www.ipc.nsw.gov.au/workplace-surveillance>). The full text of both
Acts was inaccessible from the official NSW site during this research
(Cloudflare and access issues, and the served PDFs were not readable), so the
specific section numbers and the publication/public-interest position are
**[unverified]**. The points that matter to Surveyor are likely to be:
employer notice obligations do not bind a journalist/union recipient;
recording a private conversation without consent may be an offence; and
publishing a recording can be an offence separate from recording. Treat NSW as
requiring a legal review before any recording is used.

### 3.4 Other jurisdictions (all [unverified] here)

| Jurisdiction | Instrument | Expected key provisions (verify before relying) |
|---|---|---|
| Queensland | *Invasion of Privacy Act 1971* (Qld) | Prohibition on using a listening device to record a private conversation (s 43), with a party-to-the-conversation exception; separate offence of communicating/publishing a recording made in contravention (s 44) |
| Western Australia | *Surveillance Devices Act 1998* (WA) | Recording private conversations (s 5) and publishing/communicating (s 9) |
| South Australia | *Surveillance Devices Act 2016* (SA) | Recording private conversations (s 5) and communication/publication (s 8) |
| Australian Capital Territory | *Listening Devices Act 1992* (ACT); *Workplace Privacy Act 2011* (ACT) | Listening device offences plus a workplace-specific regime restricting employer surveillance of worker emails/computers |
| Tasmania | *Listening Devices Act 1991* (Tas) | Listening device offences; check whether Tasmania remains a two-party-consent jurisdiction |
| Commonwealth | *Telecommunications (Interception and Access) Act 1979* (Cth) | Interception and stored-communications offences; relevant where a recording captures a carriage service rather than an in-person conversation |

**Guidance for the operator (not a substitute for advice)**. Do not ask or
encourage a worker to record a conversation covertly; take recordings as they
come; record who made the recording, when, where, and what consents exist;
treat publication as a separate legal question; and document the public
interest (alleged misconduct, attempts to obtain the material lawfully, why
publication is necessary and proportionate).

### 3.5 Implied features (surveillance)

1. **Provenance and consent metadata** on every uploaded audio/video file:
   recorder, date/place, jurisdiction, consent status, chain of custody.
2. **Jurisdiction-aware ingestion warnings** when a recording is uploaded
   (e.g. "Vic/NT: party recording permitted; publication has a public-interest
   exception — legal review required before publish").
3. **Separate publish gate for recordings** that cannot be bypassed by a
   report-level approval.
4. **Public-interest dossier**: an operator-facing record of why publication is
   in the public interest, attached to the item and preserved in the audit
   trail.
5. **No auto-transcription-to-mirror** without the same name gate as other
   corpus material (already the design).

---

## 4. Defamation

**Primary instruments**: the uniform Defamation Acts 2005 (each State and
Territory). This note reads the Victorian Act (*Defamation Act 2005* (Vic),
version 006, as at 11 September 2024, <https://www.legislation.vic.gov.au>);
the core provisions are uniform across the scheme, though each jurisdiction
should be checked for local variations and for when it adopted the 2020–21
model amendments (serious harm, public interest defence). Limitation periods
are in each jurisdiction's limitation statute (Vic: one year, extendable to
three — *Limitation of Actions Act 1958* (Vic), noted in the Defamation Act).

| Obligation | Instrument and section | Requirement, plainly | Duty or feature |
|---|---|---|---|
| Serious harm | Vic Defamation Act s 10A | Serious harm to reputation is an **element** of the cause of action; for excluded corporations it means serious financial loss | **(a)+(b)** — no auto-publish of a serious allegation without an operator decision |
| Truth | s 25 | Defence if the imputations are substantially true | **(b)** — evidence chain and citations make truth provable |
| Contextual truth | s 26 | Defence where contextual imputations are substantially true and the remaining imputations do no further harm | **(b)** — full-corpus context, not cherry-picked excerpts |
| Absolute privilege / public documents / fair report | ss 27–29 | Court, parliamentary and public-document reports are protected | **(b)** — citation to the underlying public document |
| Public interest defence | s 29A | Matter concerns an issue of public interest and the defendant reasonably believed publication was in the public interest; factors include distinguishing suspicion from fact, source integrity, confidential-source reason, whether the other side's story was sought, verification steps, and freedom of expression | **(c)** — these map directly to Surveyor's research lines, corroboration ticks and journalist pass |
| Qualified privilege | s 30 | Where the recipient has an interest and the conduct was reasonable; verification is a factor | **(c)** |
| Honest opinion | s 31 | Opinion, not fact, on a matter of public interest, based on proper material | **(b)** — grounding claims in cited exhibits shows the material basis |
| Innocent dissemination / digital intermediaries | ss 31A, 32 | Distributor defences; the 2024 digital-intermediary amendments define access-prevention steps | **(a)+(b)** — relevant to publication channels |
| Damages | ss 34–39A | Damages must bear a rational relationship to harm; non-economic loss cap; no exemplary damages; state of mind generally irrelevant; mitigation factors | **(a)** — insurance/legal posture |
| Limitation | Limitation of Actions Act 1958 (Vic), noted in Defamation Act | One year from publication, extendable to three in limited cases | **(a)** — retention must outlive the limitation horizon for published material, which pulls against APP 11.2 deletion; resolve explicitly |

**How the evidence chain helps**: truth (s 25), contextual truth (s 26) and
reasonableness (ss 29A, 30) are all proved by the same artefacts — an unbroken
record of what each exhibit says, where it came from, when the operator
reviewed it, what was corroborated, what was put to the subject, and what was
changed. Surveyor's append-only history and citation validation are
defensibility infrastructure; the right-of-reply workflow is the missing one.

### 4.1 Implied features (defamation)

1. **Right of reply**: a first-class object (who was approached, when, what
   response was received, whether it was included) — s 29A(3)(g).
2. **Suspicion/fact labelling** enforced in report rendering — s 29A(3)(b).
3. **Source-integrity record**: what the source provided, corroboration ticks,
   any confidentiality reason — s 29A(3)(e)–(f).
4. **Legal review insertion point** before first publish and on material
   changes (the repository currently records this as "fog" in
   `THREAT-MODEL.md` T8).
5. **Correction and retraction workflow** with versioned, append-only history.
6. **Citation validation**: strip or hold uncited claims on publish unless the
   operator explicitly approves (`src/lib/pass.ts`) — this is the technical
   enforcement of "substantially true" and "reasonable belief".

---

## 5. Journalist source protection (shield laws)

**Primary instruments**

- *Evidence Act 1995* (Cth) Div 1A of Pt 3.10:
  <https://www.legislation.gov.au/C2004A04858/latest/text> (fetched text is
  s 126J–126K).
- Uniform Evidence Acts in NSW, Vic, Tas, ACT and NT carry the equivalent
  journalist privilege (s 126K in the uniform scheme) **[unverified for those
  jurisdictions here]**.
- Qld, WA and SA have their own source-protection provisions
  **[unverified — verify current text and scope]**.
- Privacy Act s 66(1A) gives a journalist a reasonable excuse for refusing to
  give the OAIC information that would tend to reveal a confidential source
  (read in the compilation).

| Obligation | Instrument and section | Requirement, plainly | Duty or feature |
|---|---|---|---|
| Journalist privilege | Evidence Act 1995 (Cth) s 126K(1) | "If a journalist has promised an informant not to disclose the informant's identity", neither the journalist nor the employer is compellable to answer questions or produce documents that would disclose or enable ascertainment of the identity | **(a)+(b)** — the promise must be made and recorded |
| Court override | s 126K(2)–(3) | A court may order disclosure if the public interest in the evidence outweighs the adverse effect on the informant and the public interest in the news media's access to sources | **(a)** — the operator must not promise absolute confidentiality |
| Definitions | s 126J | "Journalist" — engaged and active in the publication of news; "informant" — a person who gives information in the normal course of the journalist's work expecting publication in a news medium | **(a)** — a union-run investigation may not fit; advise sources accordingly |
| OAIC investigations | Privacy Act s 66(1A)–(1B) | A journalist has a reasonable excuse for refusing to give information that would tend to reveal a confidential source in OAIC proceedings | **(a)** |
| Corporate whistleblowers | Corporations Act s 1317AAD; s 1317AAE | A journalist recipient of a qualifying public-interest disclosure is bound not to disclose the whistleblower's identity except in defined circumstances | **(c)** |

**Plainly**: the shield attaches to a promise. Surveyor's survey copy should
itself be the promise (or clearly disclaim one), and the installation should
record a hash/version of the promise made to each source cohort. No jurisdiction
gives absolute protection; the software should not claim it does.

### 5.1 Implied features (source protection)

1. **Promise versioning**: the exact confidentiality text shown, stored with
   the submission.
2. **Identity minimisation already built** — keep it absolute: no IP/UA/referrer
   logs, HMAC-only access codes, originals never persisted.
3. **Subpoena-ready records**: an export that can demonstrate the promise and
   the minimisation steps without exposing content.
4. **No accidental disclosure**: search (FTS mirror) must not expose
   identity-bearing text; exports default to redacted; access receipts.

---

## 6. Hosting and data residency

**Primary instruments/guidance**

- Privacy Act APP 8, s 16C; OAIC, *Sending personal information overseas* and
  APP 8 chapter.
- Vendor documentation for the actual platform: Cloudflare R2 data-location
  docs, D1 data-location docs, Data Localization Suite.

| Point | Source | Finding | Implication |
|---|---|---|---|
| No general Australian data-localisation law | Privacy Act (no localisation provision); the scheme regulates disclosure, not location | The Privacy Act does not require data to stay in Australia | Residency is a design choice, not a Privacy Act mandate |
| Cross-border disclosure rule | APP 8.1; s 16C | Before disclosing personal information overseas, take reasonable steps to ensure the recipient will not breach the APPs; the operator is accountable for the recipient's breach | Operator must select and contract recipients; explicit consent is a fallback for particular disclosures |
| "Use" vs "disclosure" | OAIC, *Sending personal information overseas* | Routing through overseas servers in transit is usually a **use**; providing information to an overseas cloud provider for storage may be a use only where a binding contract leaves the entity effective control; otherwise it is a disclosure | Cloudflare storage and BYOK providers must be assessed service by service |
| Contractual expectation | OAIC, APP 8 chapter paras 8.16–8.17 | OAIC generally expects an enforceable contract requiring APP-compliant handling, with breach notification and monitoring | Operator duty to review Cloudflare's and providers' terms for APP 8 coverage; Surveyor should record the outcome |
| No "substantially similar law" shortcut without advice | APP 8.2(a); OAIC guidance (no list of countries) | There is no OAIC adequacy list; substantial similarity is a question of fact | Do not assume the US/EU is adequate; use consent or contract |
| R2 storage location | Cloudflare, *R2 data location* | Location Hints are "best effort and not a guarantee"; Jurisdictional Restrictions guarantee storage within a jurisdiction; available jurisdictions are **eu, fedramp, us** — no Australia | Cannot pin R2 to Australia; default placement may be overseas |
| D1 location | Cloudflare, *D1 data location* | Jurisdictions limited to **eu** and **fedramp**; location hints (wnam/enam/weur/eeur/apac/oc) do not guarantee location | Cannot pin D1 to Australia |
| Worker execution | Cloudflare architecture (documented in DLS page: Regional Services controls where HTTPS traffic is decrypted/processed) | Workers run on the global edge; DLS regional controls target metadata/TLS inspection and are a paid add-on, not a general processing-location guarantee [vendor documentation, not independently verified] | Processing may occur outside Australia even if storage were pinned |
| Data Localization Suite | Cloudflare DLS | Customer Metadata Boundary and Regional Services control decryption/metadata, not general Worker or AI processing | Do not represent DLS as solving APP 8 |

**Plainly**: the correct posture is to disclose cross-border processing
honestly (APP 1.4(f)–(g), APP 5.2(i)–(j)), contract for it, minimise what
crosses, and never claim "data stays in Australia". If an operator has a
sector-specific localisation duty (health records, government contracts), a
Cloudflare-native installation may not meet it.

### 6.1 Implied features (hosting)

1. **Data-flow map** generated per installation: what is stored where, which
   subprocessors can access it, and the jurisdiction options actually chosen.
2. **APP 8 register and consent**: flag each overseas recipient, record the
   contract basis, and capture express consent where consent is the basis.
3. **Session/region receipts**: record the Cloudflare placement decisions
   (bucket jurisdiction, D1 location hint) in provisioning receipts.
4. **Honest residency documentation**: state in the operator pack that
   Australian jurisdiction pinning is unavailable on R2/D1 today.

---

## 7. AI-specific regulation and guidance

**Status at 17 September 2026**: no AI-specific Act is in force. The binding
obligations are privacy, defamation and the general law; AI-specific material
is voluntary or imminent.

| Instrument/guidance | Status and date | What it requires or expects | Duty or feature |
|---|---|---|---|
| *Voluntary AI Safety Standard* (DISR/National AI Centre) | Published 5 September 2024; updated 2 December 2025 | 10 voluntary guardrails for organisations across the AI supply chain, including transparency and accountability between developers and deployers | **(c)** — map the guardrails into the operator pack and model registry |
| *Guidance for AI Adoption* (National AI Centre) | Published 21 October 2025; evolves the VAISS and AI Ethics Principles | 6 essential practices for safe and responsible AI governance | **(c)** |
| Mandatory guardrails for high-risk AI | Proposals paper, 2024; consultation only, **not law** (DISR AI page as at research date) | Proposed obligations for high-risk settings; monitor | **(a)** — watch for commencement |
| National AI Plan | Published 2 December 2025 | Direction on capability, adoption and safety; includes the AI Safety Institute | **(a)** — policy context |
| OAIC, *Guidance on privacy and the use of commercially available AI products* | OAIC page (current at research date) | Privacy obligations apply to inputs and outputs; APP 6 for inputting personal information; APP 3 for generated/inferred personal information; APP 10 accuracy; APP 11 security; due diligence and human oversight; do not feed personal information into public tools | **(c)** — provider due diligence, no-training flags, human review, output controls |
| OAIC, *Guidance on privacy and developing and training generative AI models* | OAIC page | Privacy obligations through the training lifecycle | **(b)** — relevant if an operator fine-tunes |
| APP 1.7–1.9 (automated decision-making disclosure) | Privacy Act Sch 1, inserted by POLAA 2024, **commencing 10 December 2026** | Privacy policy must disclose the kinds of personal information used by computer programs making decisions that could significantly affect rights or interests | **(b)** — an automated-decisions register and policy generator |

**Plainly for Surveyor**: the AI engine is not specially regulated, but it
processes personal information, so the APPs apply end to end. The OAIC's AI
guidance effectively blesses Surveyor's existing controls (grounding,
citations, fences, human gate, no public tools) and demands two more:
provider due diligence with lifecycle review, and transparency in the privacy
policy. If the engine ever makes or substantially shapes a decision affecting
a person's rights or interests (for example selecting what is published
without a human), APP 1.7 will require disclosure.

### 7.1 Implied features (AI)

1. **Provider due diligence record**: model, provider, terms, training-on-data
   posture, retention, jurisdiction, review date.
2. **No-training / no-retention flags** surfaced at configuration time.
3. **Automated decisions register** (APP 1.7) with policy text generation.
4. **Output policing already present** — keep it; add "generated content about
   an identifiable person" labelling for the operator.
5. **Human-review evidence**: an operator approval receipt for every publish.

---

## 8. Obligations ranked by software implication

Ranked by how much legal risk is reduced per unit of build effort.

| Rank | Obligation | Instruments | Why it needs software |
|---|---|---|---|
| 1 | **Retention and deletion** | APP 11.2; s 13G risk | Nothing else in the platform enforces "no longer needed"; held R2 bytes are unbounded today (`THREAT-MODEL.md` T3); back-ups included |
| 2 | **Breach assessment and NDB notification** | Privacy Act ss 26WE–26WL | 30-day clock and OAIC statement are operationally impossible without an incident workflow |
| 3 | **Source identity protection and break-glass audit** | Corporations Act s 1317AAE; PID Act s 20; APP 11 | Criminal-law standard for identity; current quarantine is the strongest asset and needs receipts |
| 4 | **Cross-border disclosure register and APP 8 consent/notice** | APP 8; s 16C; APP 5.2(i)–(j) | Every installation uses overseas processors; today nothing records or discloses this |
| 5 | **Privacy policy / collection notice / ADM disclosure generator** | APP 1.3–1.7; APP 5 | Operator is legally required to publish these; the wizard already collects consent copy |
| 6 | **Publication legal gate (right of reply, legal review, recording gate)** | Defamation ss 29A/30; tort cl 8; SDA publication offences | The human gate exists architecturally; the legal artefacts do not |
| 7 | **Provenance/consent metadata for recordings** | Vic SDA ss 11(2)(a)–(b); NT SDA s 15(2) | Public-interest and consent exceptions are fact-based and must be provable |
| 8 | **Audit trail and evidence chain** | Defamation ss 25–26; tort; APP 1.2 | Mostly present (append-only history); needs exportable, verifiable receipts |
| 9 | **Data-flow map and residency receipts** | APP 8; APP 1.4(f)–(g) | Prevents false claims and supports the notice |
| 10 | **Sensitive-information consent capture** | APP 3.3 | Union membership, health, political opinions are likely in submissions and corpus |

---

## 9. Purely operator obligations (no software can discharge them)

1. **Classify the operator**: decide whether the Privacy Act applies (union =
   yes; journalist small business = analyse s 6D and the benefit/service/
   advantage test); if relying on the journalism exemption, adopt and publish
   privacy standards (s 7B(4)).
2. **Choose the legal basis for model-provider disclosures**: contract,
   consent, or another APP 6/8 exception; obtain legal advice before relying on
   "substantially similar law".
3. **Sign and assess processor terms** (Cloudflare and each BYOK provider) for
   APP 8 purposes and record the assessment.
4. **Set retention schedules** per data class and apply them (the software
   enforces, the operator decides).
5. **Make NDB decisions and notifications** — assess, prepare the statement,
   notify the OAIC and individuals.
6. **Handle access/correction complaints** and OAIC inquiries.
7. **Honour source promises in court**: assert the s 126K privilege or comply
   with an overriding order; never overpromise.
8. **Do not procure unlawful recordings**; make the publication decision on
   recordings after legal review.
9. **Defamation pre-publication decisions**: seek comment, decide what to
   publish, correct/retract, and manage limitation horizons.
10. **Comply with whistleblower recipient rules**: do not tell sources they
    have statutory protection unless the disclosure meets Corporations Act
    s 1317AA/1317AAD or a PID recipient rule.
11. **Appoint roles and train people** (APP 1.2 practices, procedures and
    systems; OAIC AI guidance due diligence and oversight).
12. **Decide whether the statutory privacy tort's journalist exemption
    applies** (professional capacity; standards/code) and document the
    public-interest reasoning if not.

---

## 10. Conflicts between Australian requirements and Surveyor's current design

Ranked by severity. Design facts are from the repository (`wrangler.toml`,
`RUNBOOK.md`, `THREAT-MODEL.md`, ADRs).

1. **Global data flows vs APP 8 accountability.** ADR-0001 makes each
   installation Cloudflare-native; `THREAT-MODEL.md` §4 concedes that
   anonymised text and gated excerpts leave the account to third-party
   providers and that Cloudflare terminates TLS and hosts D1/R2/Queues. Cloudflare
   offers **no Australian jurisdiction** for R2 or D1 (R2: eu/fedramp/us; D1:
   eu/fedramp), so residency pinning is unavailable. The requirement is not
   localisation but accountability and notice — neither is currently supported.
2. **No retention cap on held corpus bytes.** `THREAT-MODEL.md` T3: "a file
   that never drains ... retains its bytes indefinitely — this is a defect
   until a retention cap is implemented." APP 11.2 makes that a compliance
   defect, not just a security one, once the operator is APP-covered.
3. **Teardown cannot purge Cloudflare backups/logs.** `THREAT-MODEL.md` T10 and
   `RUNBOOK.md` §6 list account logs, analytics and backups as "not wiped".
   APP 11.2 covers archived and back-up copies; the operator pack must state
   the residual plainly, and retention design should assume it.
4. **No NDB workflow.** The platform has probabilistic detection flags but no
   incident record, 30-day assessment or notification statement — a direct gap
   against ss 26WH/26WK/26WL.
5. **No privacy policy/collection notice/ADM disclosure artefact.** The wizard
   collects "consent copy" (`RUNBOOK.md` §2) but APP 1.3–1.7 and APP 5 require
   more: a policy, specific notice matters including overseas disclosure, and
   (from 10 December 2026) automated-decision disclosure.
6. **FTS mirror holds gated text in plaintext.** `THREAT-MODEL.md` §4: "The FTS
   mirror holds gated text in plaintext for search." This is an intentional
   trade-off, but it is the largest remaining single-store exposure against
   APP 11 and the whistleblower identity offences; consider per-installation
   encryption or search-time decryption.
7. **Defamation right-of-reply and legal review are missing.** `THREAT-MODEL.md`
   T8 calls legal/defamation gates and a lawyer-review insertion point "fog".
   The citation machinery (`src/lib/pass.ts`) and append-only history already
   support the s 29A/30 factors; the reply and review artefacts do not exist.
8. **Whistleblower recipient rules are not surfaced.** Nothing in intake
   distinguishes a Corporations Act s 1317AAD public-interest disclosure from
   an ordinary tip. Sources may wrongly believe Surveyor confers protection.
9. **Recording provenance is not modelled.** There is no field for who
   recorded, consent, or jurisdiction, so the public-interest and consent
   exceptions in Vic/NT (and equivalents elsewhere) cannot be evidenced.
10. **Residency expectations vs product documentation.** `README.md` /
    `RUNBOOK.md` present "fully self-contained in your own Cloudflare account";
    an operator could read that as "Australian". It is not, and the docs should
    say so explicitly for APP 8/APP 5 purposes.
11. **Workers AI keyless tier is an undisclosed overseas recipient.**
    ADR-0001 treats Workers AI as a degraded-mode fallback, but from a privacy
    perspective it is another subprocessor that may process personal
    information; it belongs in the APP 8 register and the notice.
12. **Union-specific regime not reflected.** The FW(RO) Act's Part 4A
    recipient rules and the s 6E(1C) coverage decision should appear in the
    operator pack for union installations.

---

## 11. Source register (primary sources used)

Fetched and read on 17 September 2026 unless stated.

| Source | URL / identifier |
|---|---|
| Privacy Act 1988 (Cth), compilation 104 | <https://www.legislation.gov.au/C2004A03712/latest/text> |
| Privacy and Other Legislation Amendment Act 2024 (Cth) No. 128 | <https://www.legislation.gov.au/C2024A00128> |
| Corporations Act 2001 (Cth) Part 9.4AAA | <https://www.legislation.gov.au/C2004A00818/latest/text> |
| Public Interest Disclosure Act 2013 (Cth) | <https://www.legislation.gov.au/C2013A00133/latest/text> |
| Fair Work (Registered Organisations) Act 2009 (Cth) Part 4A | <https://www.legislation.gov.au/C2004A03679/latest/text> |
| Evidence Act 1995 (Cth) ss 126J–126K | <https://www.legislation.gov.au/C2004A04858/latest/text> |
| Defamation Act 2005 (Vic) (uniform scheme) | Victorian legislation, version 006 as at 11 Sep 2024 |
| Surveillance Devices Act 1999 (Vic) | Victorian legislation, version 042 as at 1 Dec 2021 |
| Surveillance Devices Act 2007 (NT) | NT legislation, as in force 1 June 2026 |
| Workplace Surveillance Act 2005 (NSW) / Surveillance Devices Act 2007 (NSW) | **Not read — official text inaccessible; see IPC NSW page** |
| IPC NSW, *Workplace surveillance* | <https://www.ipc.nsw.gov.au/workplace-surveillance> |
| OAIC, *Small business* | <https://www.oaic.gov.au/privacy/privacy-guidance-for-organisations-and-government-agencies/organisations/small-business> |
| OAIC, *Employee records exemption* | <https://www.oaic.gov.au/privacy/privacy-guidance-for-organisations-and-government-agencies/organisations/employee-records-exemption> |
| OAIC, APP Guidelines ch 1, 6, 8, 11 | <https://www.oaic.gov.au/privacy/australian-privacy-principles/australian-privacy-principles-guidelines> |
| OAIC, *Sending personal information overseas* | <https://www.oaic.gov.au/privacy/privacy-guidance-for-organisations-and-government-agencies/handling-personal-information/sending-personal-information-overseas> |
| OAIC, *Guide to securing personal information* | <https://www.oaic.gov.au/privacy/privacy-guidance-for-organisations-and-government-agencies/handling-personal-information/guide-to-securing-personal-information> |
| OAIC, *About the Notifiable Data Breaches scheme* | <https://www.oaic.gov.au/privacy/notifiable-data-breaches/about-the-notifiable-data-breaches-scheme> |
| OAIC, *Guidance on privacy and the use of commercially available AI products* | <https://www.oaic.gov.au/privacy/privacy-guidance-for-organisations-and-government-agencies/guidance-on-privacy-and-the-use-of-commercially-available-ai-products> |
| OAIC, *Guidance on privacy and developing and training generative AI models* | <https://www.oaic.gov.au/privacy/privacy-guidance-for-organisations-and-government-agencies/guidance-on-privacy-and-developing-and-training-generative-ai-models> |
| DISR, *Artificial intelligence* (incl. National AI Plan, AI Safety Institute, mandatory-guardrails status) | <https://www.industry.gov.au/science-technology-and-innovation/technology/artificial-intelligence> |
| DISR/NAIC, *Voluntary AI Safety Standard* | <https://www.industry.gov.au/publications/voluntary-ai-safety-standard> |
| Cloudflare, *R2 data location* | <https://developers.cloudflare.com/r2/reference/data-location/> |
| Cloudflare, *D1 data location* | <https://developers.cloudflare.com/d1/configuration/data-location/> |
| Cloudflare, *Data Localization Suite* | <https://developers.cloudflare.com/data-localization/> |

**Marked [unverified] in this note**: the full text and section numbers of the
NSW surveillance statutes; the Queensland, Western Australian, South
Australian, ACT and Tasmanian surveillance provisions; the state/territory
Evidence Act shield provisions in non-uniform jurisdictions (Qld, WA, SA); the
state and territory PID Acts; and NT SDA s 46. These should be checked against
the official texts before any live use.

---

## 12. Bottom line

For a union-run investigation, the Privacy Act applies in full; for a
journalist, coverage depends on the small-business and journalism exemptions,
and the journalism exemption requires a published privacy-standard commitment.
In both cases the platform's legal risk concentrates in four places: what
crosses borders, what is kept too long, what happens when identity leaks, and
what is published without a reply, a review and a record. Surveyor's existing
identity separation, grounding and human gate already do much of the work; the
missing pieces are retention, breach response, disclosure/notice, and the
publication gate's legal artefacts.
