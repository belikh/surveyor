// Privacy and collection notice generator (APP 1.3–1.7, APP 5). Both
// documents are built from the installation's actual data flows — hosting,
// the operator-configured providers, the keyless tier and the human check —
// so the published instruments describe what the software actually does.
// Versions are append-only and each carries the data-flow snapshot it was
// generated from, so an audit can see what was disclosed, and when.

import { z } from "zod";
import { resolveChain } from "./registry";
import type { SetupState } from "./setup";

export const NOTICE_TYPES = ["privacy", "collection"] as const;
export const NoticeTypeSchema = z.enum(NOTICE_TYPES);
export type NoticeType = z.infer<typeof NoticeTypeSchema>;

/** The operator identity the notices must carry (APP 1.3(a), APP 5.1(a)). */
export const NoticeOperatorSchema = z.object({
  operator_name: z.string().min(1).max(200),
  operator_contact: z.string().min(1).max(500),
});
export type NoticeOperator = z.infer<typeof NoticeOperatorSchema>;

export interface NoticeProvider {
  label: string;
  kind: string;
  model: string;
  capabilities: string[];
}

export interface AutomatedDecision {
  name: string;
  what: string;
  /** Kinds of personal information the program uses (APP 1.7 content). */
  personal_information: string[];
  human_review: string;
}

export interface NoticeDataFlows {
  generated_at: string;
  instrument_title: string | null;
  hosting: { provider: string; services: string[]; note: string };
  providers: NoticeProvider[];
  workers_ai: boolean;
  turnstile: boolean;
  storage_classes: string[];
  anonymity: string[];
  automated_decisions: AutomatedDecision[];
}

/** What the installation actually stores, in operator-facing plain language. */
export const STORAGE_CLASSES = [
  "Submission testimony — sealed with authenticated encryption; no name or account is required to give it.",
  "Quarantined names — sealed; a name is revealed only through an audited operator action.",
  "Attachments — raw files held only until their text is extracted, then deleted; the extracted text becomes sealed testimony.",
  "Corpus documents — raw bytes held only until parsed or OCRed; the name-gated text is searchable in the operator's mirror.",
  "Published reports — the words the operator has approved, kept as an append-only version history.",
  "Operational receipts — audit actions and delivery counts; they record that something happened, not what was said.",
];

/** The anonymity posture, stated honestly (no Tor, no source-side E2E). */
export const ANONYMITY_LIMITS = [
  "This installation reads and logs no IP address, user agent or referrer for the survey.",
  "Transport is TLS, and testimony and names are sealed with authenticated encryption at rest.",
  "There is no Tor service and no source-side end-to-end encryption: text is unsealed inside the operator's Cloudflare Worker while it is processed, and a configured model provider processes the text it is sent.",
  "An access code is the only key to a submission; anyone who holds the code can read and continue it.",
];

/**
 * The decisions the shipped software makes that could reasonably be expected
 * to significantly affect a person's rights or interests, with the personal
 * information each uses (APP 1.7). Keep this list tracking the code: the
 * generator regenerates the notice when the operator changes the install.
 */
export function automatedDecisions(): AutomatedDecision[] {
  return [
    {
      name: "Name quarantine before storage",
      what: "Names are detected in testimony and corpus documents and replaced with markers such as [person A] before anything is sealed or made searchable.",
      personal_information: ["names", "surrounding text in testimony and documents"],
      human_review:
        "quarantined entities are visible to the operator, and revealing one is an audited action.",
    },
    {
      name: "Evidence gating before the searchable mirror",
      what: "Text must pass the name-leak gate before it enters the searchable corpus mirror; a document that fails stays held until the operator drains it.",
      personal_information: ["document text", "names in documents"],
      human_review:
        "every held document is visible to the operator with a reason for the hold.",
    },
    {
      name: "Flag handling",
      what: "Model output carrying suspicion flags is held for review and excluded from reports.",
      personal_information: ["generated text", "research findings"],
      human_review:
        "a person clears or rejects each flag before the item can be used.",
    },
    {
      name: "Uncited-claim handling",
      what: "Claims that cannot be bound to a validated citation are annotated and stripped unless the operator explicitly approves them.",
      personal_information: ["report text", "research findings"],
      human_review:
        "the operator approves any uncited claim that is published.",
    },
    {
      name: "Scheduled publication (only when enabled)",
      what: "When the operator configures and enables automatic publish gates, a scheduled evaluation can publish a report version without a person pressing publish.",
      personal_information: ["submissions", "corpus text", "research findings"],
      human_review:
        "manual approval is the default; automatic gates are an explicit opt-in, and every published version records the decision.",
    },
  ];
}

export interface CollectFlowsInput {
  setup: SetupState;
  /** Presence test for a provider key slot; values are never read here. */
  hasSecret: (slot: string) => boolean;
  workersAi: boolean;
  turnstile: boolean;
  now?: string;
}

export function collectDataFlows(input: CollectFlowsInput): NoticeDataFlows {
  const chain = resolveChain(input.setup, input.hasSecret);
  return {
    generated_at: input.now ?? new Date().toISOString(),
    instrument_title: input.setup.instrument?.title ?? null,
    hosting: {
      provider: "Cloudflare",
      services: ["Workers", "D1", "R2", "Queues", "Workflows"],
      note:
        "Cloudflare runs on a global network and offers no Australian " +
        "storage jurisdiction for D1 or R2 (European Union, United States " +
        "and FedRAMP only), so information may be stored or processed " +
        "outside Australia.",
    },
    providers: chain.entries.map((p) => ({
      label: p.label,
      kind: p.kind,
      model: p.model,
      capabilities: p.capabilities ?? [],
    })),
    workers_ai: input.workersAi,
    turnstile: input.turnstile,
    storage_classes: STORAGE_CLASSES,
    anonymity: ANONYMITY_LIMITS,
    automated_decisions: automatedDecisions(),
  };
}

function subject(flows: NoticeDataFlows): string {
  return flows.instrument_title
    ? `the anonymous survey "${flows.instrument_title}"`
    : "an anonymous workplace investigation";
}

/** Recipient list for the disclosure section, derived from the flows. */
function recipientLines(flows: NoticeDataFlows): string[] {
  const lines = [
    `- **Cloudflare** — hosting and storage for this installation (${flows.hosting.services.join(", ")}). ${flows.hosting.note}`,
  ];
  for (const p of flows.providers) {
    const caps =
      p.capabilities.length > 0
        ? `; capabilities: ${p.capabilities.join(", ")}`
        : "";
    lines.push(
      `- **${p.label}** (${p.kind}; model: ${p.model}${caps}) — configured by the operator for model calls. Its processing may occur outside Australia.`,
    );
  }
  if (flows.workers_ai) {
    lines.push(
      "- **Cloudflare Workers AI** — the keyless baseline tier used for document conversion and drafting when no provider key is configured; processed on Cloudflare's network.",
    );
  }
  if (flows.providers.length === 0 && !flows.workers_ai) {
    lines.push(
      "- No model provider key is configured: model-assisted steps run on deterministic fallbacks and no text is sent to an external model provider.",
    );
  }
  if (flows.turnstile) {
    lines.push(
      "- **Cloudflare Turnstile** — the human check on the public survey; your browser connects to Cloudflare to score the request when it is enabled.",
    );
  }
  return lines;
}

function automatedDecisionLines(flows: NoticeDataFlows): string[] {
  const lines: string[] = [];
  flows.automated_decisions.forEach((d, i) => {
    lines.push(`${i + 1}. **${d.name}.** ${d.what}`);
    lines.push(
      `   Personal information used: ${d.personal_information.join("; ")}. Human review: ${d.human_review}`,
    );
  });
  lines.push("");
  lines.push(
    "Australian Privacy Principle 1.7 (from 10 December 2026) requires this disclosure.",
  );
  return lines;
}

function contactLines(operator: NoticeOperator): string[] {
  return [operator.operator_name, operator.operator_contact];
}

function footer(type: string, version: number): string[] {
  return [
    "---",
    `This ${type} was generated by Surveyor from the installation's actual data flows (version ${version}). It is a template for the operator to review before publishing, and it is not legal advice.`,
  ];
}

export function buildPrivacyNotice(
  operator: NoticeOperator,
  flows: NoticeDataFlows,
  version: number,
): string {
  return [
    "# Privacy policy",
    "",
    `**${operator.operator_name}** — version ${version}, generated ${flows.generated_at.slice(0, 10)}.`,
    "",
    `This policy explains how ${operator.operator_name} ("we", "the operator") handles personal information collected through this Surveyor installation: ${subject(flows)}.`,
    "",
    "## Who we are",
    "",
    ...contactLines(operator),
    "",
    "## What we collect",
    "",
    "- Testimony and answers you give through the survey, sealed before storage.",
    "- Quarantined names found in testimony or documents, kept sealed and separate from the pseudonym.",
    "- Files you choose to attach, until their text is extracted and becomes sealed testimony.",
    "- Documents the operator ingests as evidence, including the gated text used for research.",
    "- Reports and their version history once the operator publishes them.",
    "",
    "We do not collect or log your IP address, user agent, referrer, account details or contact details for the survey.",
    "",
    "## Sensitive information",
    "",
    "Testimony may contain sensitive information — for example union membership, health information, political opinions or sexual orientation. It is collected only where you choose to give it, under the consent wording shown on the survey.",
    "",
    "## How we collect it",
    "",
    "- From you, when you answer the survey or send an attachment under your access code.",
    "- From workplace documents the operator ingests as evidence.",
    "",
    "## Why we collect it",
    "",
    "- To let you give testimony and to run the investigation.",
    "- To validate and corroborate evidence against the corpus.",
    "- To draft and publish reports. Publication is a human act: by default a person approves every published version.",
    "- To meet legal obligations that apply to the investigation.",
    "",
    "## Who we disclose it to",
    "",
    "We do not sell personal information or disclose it for advertising. This installation is self-hosted in the operator's own Cloudflare account, and personal information may be disclosed to the following recipients to run the investigation:",
    "",
    ...recipientLines(flows),
    "",
    "Overseas recipients may be subject to different privacy laws. Australian Privacy Principle 8 makes the operator accountable for how these recipients handle personal information, and the operator's data-flow register records each recipient.",
    "",
    "## How we hold it",
    "",
    ...flows.storage_classes.map((s) => `- ${s}`),
    "",
    "## Anonymity and its limits",
    "",
    ...flows.anonymity.map((s) => `- ${s}`),
    "",
    "## Automated decisions",
    "",
    "Computer programs help run this investigation. The following decisions, which could reasonably be expected to significantly affect a person's rights or interests, are made or shaped by software:",
    "",
    ...automatedDecisionLines(flows),
    "",
    "## Retention and deletion",
    "",
    "Personal information is kept only while it is needed for the investigation and for the operator's legal obligations, then deleted or de-identified (Australian Privacy Principle 11.2). Raw attachment bytes are deleted once their text has been extracted, and held corpus bytes are deleted once their lane drains. Published report versions and audit receipts are kept as the investigation's record.",
    "",
    "## Access, correction and complaints",
    "",
    `Write to ${operator.operator_contact} to ask for access to, or correction of, your personal information, or to make a privacy complaint. If you are not satisfied, you can complain to the Office of the Australian Information Commissioner (OAIC): www.oaic.gov.au, 1300 363 992.`,
    "",
    "## Changes to this policy",
    "",
    "Versions are append-only: the version number and generation date sit at the top of this document, and regenerating the policy as the installation changes does not alter earlier versions.",
    "",
    ...footer("privacy policy", version),
  ].join("\n");
}

export function buildCollectionNotice(
  operator: NoticeOperator,
  flows: NoticeDataFlows,
  version: number,
): string {
  return [
    "# Collection notice",
    "",
    `**${operator.operator_name}** — version ${version}, generated ${flows.generated_at.slice(0, 10)}.`,
    "",
    `This notice is given before your personal information is collected through ${subject(flows)} (Australian Privacy Principle 5). The privacy policy holds the full detail.`,
    "",
    "## Who we are",
    "",
    ...contactLines(operator),
    "",
    "## What we collect and why",
    "",
    "- The words you give us through the survey, so you can tell your story and the investigation can use it.",
    "- Files you choose to attach, so documents you hold can become evidence.",
    "- Names found in testimony or documents, kept sealed so identifying details do not travel with the text.",
    "",
    "We do not read or log your IP address, user agent or referrer, and we ask for no account, email address or phone number.",
    "",
    "## Sensitive information",
    "",
    "Where you tell us something sensitive — union membership, health information, political opinions, sexual orientation — we collect it only with your consent, given under the wording shown on the survey.",
    "",
    "## What happens if you do not provide it",
    "",
    "You choose what to answer. If you leave something out, the operator cannot use it in the investigation; nothing else about your use of the survey changes.",
    "",
    "## Who else sees it",
    "",
    ...recipientLines(flows),
    "",
    "## Automated decisions",
    "",
    "Computer programs help run this investigation. In particular they quarantine names before storage, gate evidence before it becomes searchable, and hold flagged or uncited output for a person to review. A report publishes without human approval only when the operator has deliberately enabled automatic gates:",
    "",
    ...automatedDecisionLines(flows),
    "",
    "## Access, correction and complaints",
    "",
    `Write to ${operator.operator_contact} to ask for access to, or correction of, your personal information, or to make a privacy complaint. You can also complain to the Office of the Australian Information Commissioner (OAIC): www.oaic.gov.au, 1300 363 992.`,
    "",
    "## Changes to this notice",
    "",
    "Versions are append-only: the version number and generation date sit at the top of this document, and regenerating the notice as the installation changes does not alter earlier versions.",
    "",
    ...footer("collection notice", version),
  ].join("\n");
}

export interface NoticeVersionMeta {
  type: NoticeType;
  version: number;
  created_at: string;
}

export interface NoticeVersion extends NoticeVersionMeta {
  body: string;
  data_flows: NoticeDataFlows;
  operator: NoticeOperator;
}

interface NoticeRow {
  type: string;
  version: number;
  body: string;
  data_flows_json: string;
  operator_json: string;
  created_at: string;
}

function toVersion(type: NoticeType, row: NoticeRow): NoticeVersion {
  return {
    type,
    version: Number(row.version),
    body: row.body,
    data_flows: JSON.parse(row.data_flows_json) as NoticeDataFlows,
    operator: NoticeOperatorSchema.parse(JSON.parse(row.operator_json)),
    created_at: row.created_at,
  };
}

/** Build and store one new version of each notice, from the same flow snapshot. */
export async function generateNotices(
  db: D1Database,
  operator: NoticeOperator,
  flows: NoticeDataFlows,
): Promise<NoticeVersionMeta[]> {
  const out: NoticeVersionMeta[] = [];
  for (const type of NOTICE_TYPES) {
    const row = await db
      .prepare("SELECT MAX(version) AS v FROM notice_versions WHERE type = ?")
      .bind(type)
      .first<{ v: number | null }>();
    const version = Number(row?.v ?? 0) + 1;
    const body =
      type === "privacy"
        ? buildPrivacyNotice(operator, flows, version)
        : buildCollectionNotice(operator, flows, version);
    const createdAt = new Date().toISOString();
    await db
      .prepare(
        "INSERT INTO notice_versions " +
          "(id, type, version, body, data_flows_json, operator_json, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        crypto.randomUUID(),
        type,
        version,
        body,
        JSON.stringify(flows),
        JSON.stringify(operator),
        createdAt,
      )
      .run();
    out.push({ type, version, created_at: createdAt });
  }
  return out;
}

export async function latestNotice(
  db: D1Database,
  type: NoticeType,
): Promise<NoticeVersion | null> {
  const row = await db
    .prepare(
      "SELECT type, version, body, data_flows_json, operator_json, created_at " +
        "FROM notice_versions WHERE type = ? ORDER BY version DESC LIMIT 1",
    )
    .bind(type)
    .first<NoticeRow>();
  return row ? toVersion(type, row) : null;
}

export async function listNoticeVersions(
  db: D1Database,
): Promise<NoticeVersionMeta[]> {
  const rows = await db
    .prepare(
      "SELECT type, version, created_at FROM notice_versions " +
        "ORDER BY type ASC, version ASC",
    )
    .all<{ type: string; version: number; created_at: string }>();
  const list = Array.isArray(rows) ? rows : rows.results;
  return list.map((r) => ({
    type: NoticeTypeSchema.parse(r.type),
    version: Number(r.version),
    created_at: r.created_at,
  }));
}

export async function noticeVersionAt(
  db: D1Database,
  type: NoticeType,
  version: number,
): Promise<NoticeVersion | null> {
  const row = await db
    .prepare(
      "SELECT type, version, body, data_flows_json, operator_json, created_at " +
        "FROM notice_versions WHERE type = ? AND version = ?",
    )
    .bind(type, version)
    .first<NoticeRow>();
  return row ? toVersion(type, row) : null;
}
