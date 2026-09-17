// Sensitive-category consent (Privacy Act 1988 (Cth) s 6(1) "sensitive
// information"; APP 3.3). A source gives granular consent per category,
// before any tagged answer is stored; a category with no grant is refused,
// fail closed. Decisions are sealed — which categories a source consented
// to is itself sensitive information — while the wording version stays
// plaintext so an audit can group coverage without opening records.

import { z } from "zod";
import {
  categoryHmac,
  openText,
  sealText,
  toHex,
  type VaultKit,
} from "./vault";

/** The sensitive-information categories of s 6(1), as stable keys. */
export const SENSITIVE_CATEGORIES = [
  "health",
  "genetic",
  "biometric",
  "origin",
  "political",
  "religion",
  "union",
  "sexual_orientation",
  "criminal_record",
] as const;
export const SensitiveCategorySchema = z.enum(SENSITIVE_CATEGORIES);
export type SensitiveCategory = z.infer<typeof SensitiveCategorySchema>;

/** Software revision of the per-category prompts. Bump when they change:
 *  the digest recorded with each capture covers this revision. */
export const SENSITIVE_PROMPT_REVISION = 1;

export interface SensitiveCategoryInfo {
  label: string;
  /** The per-category wording shown to the source on the survey. */
  prompt: string;
}

export const SENSITIVE_CATEGORY_INFO: Record<
  SensitiveCategory,
  SensitiveCategoryInfo
> = {
  health: {
    label: "Health",
    prompt: "health information, including injury, illness, disability or treatment",
  },
  genetic: { label: "Genetic", prompt: "genetic information" },
  biometric: {
    label: "Biometric",
    prompt: "biometric information or biometric templates",
  },
  origin: { label: "Racial or ethnic origin", prompt: "racial or ethnic origin" },
  political: {
    label: "Political",
    prompt: "political opinions or membership of a political association",
  },
  religion: {
    label: "Religious or philosophical",
    prompt: "religious or philosophical beliefs or affiliations",
  },
  union: {
    label: "Union or professional association",
    prompt: "membership of a trade union or a professional or trade association",
  },
  sexual_orientation: {
    label: "Sexual orientation",
    prompt: "sexual orientation or practices",
  },
  criminal_record: { label: "Criminal record", prompt: "criminal record" },
};

export const ConsentDecisionSchema = z.object({
  category: SensitiveCategorySchema,
  granted: z.boolean(),
});
export type ConsentDecision = z.infer<typeof ConsentDecisionSchema>;

/** One capture body: at most one decision per category, in any order. */
export const ConsentBodySchema = z
  .array(ConsentDecisionSchema)
  .max(SENSITIVE_CATEGORIES.length)
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    for (const d of list) {
      if (seen.has(d.category)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate consent category: ${d.category}`,
        });
      }
      seen.add(d.category);
    }
  });

/** The sealed record of one capture, as stored. */
export const ConsentCaptureSchema = z.object({
  decisions: z.array(ConsentDecisionSchema),
  wording_version: z.number().int().min(1),
  /** SHA-256 over the prompt revision and the operator's consent copy. */
  wording_sha256: z.string().length(64),
  captured_at: z.string().datetime(),
});
export type ConsentCapture = z.infer<typeof ConsentCaptureSchema>;

interface InstrumentWording {
  consent?: string;
  consent_version?: number;
}

/** The wording version in force: installations predating versioning are 1. */
export function consentVersionOf(instrument: InstrumentWording | null): number {
  return instrument?.consent_version ?? 1;
}

export async function consentWordingSha256(consentCopy: string): Promise<string> {
  const input = `sensitive-consent-v${SENSITIVE_PROMPT_REVISION}\n${consentCopy}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return toHex(new Uint8Array(digest));
}

/** Build the sealed capture row (without writing it), so a create can
 *  commit the submission and its consent record in one batch. */
export async function buildConsentRecord(
  kit: VaultKit,
  submissionId: string,
  decisions: ConsentDecision[],
  wordingVersion: number,
  consentCopy: string,
  now = new Date().toISOString(),
): Promise<{
  id: string;
  submission_id: string;
  wording_version: number;
  record_envelope: string;
  created_at: string;
}> {
  const capture: ConsentCapture = {
    decisions,
    wording_version: wordingVersion,
    wording_sha256: await consentWordingSha256(consentCopy),
    captured_at: now,
  };
  return {
    id: crypto.randomUUID(),
    submission_id: submissionId,
    wording_version: wordingVersion,
    record_envelope: await sealText(kit, JSON.stringify(capture)),
    created_at: now,
  };
}

export async function recordConsent(
  db: D1Database,
  kit: VaultKit,
  submissionId: string,
  decisions: ConsentDecision[],
  wordingVersion: number,
  consentCopy: string,
  now = new Date().toISOString(),
): Promise<void> {
  const row = await buildConsentRecord(
    kit,
    submissionId,
    decisions,
    wordingVersion,
    consentCopy,
    now,
  );
  await db
    .prepare(
      "INSERT INTO consent_records (id, submission_id, wording_version, record_envelope, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(
      row.id,
      row.submission_id,
      row.wording_version,
      row.record_envelope,
      row.created_at,
    )
    .run();
}

/** Every capture for a submission, oldest first. */
export async function listConsentRecords(
  db: D1Database,
  kit: VaultKit,
  submissionId: string,
): Promise<ConsentCapture[]> {
  const rows = await db
    .prepare(
      "SELECT record_envelope FROM consent_records WHERE submission_id = ? ORDER BY created_at ASC, id ASC",
    )
    .bind(submissionId)
    .all<{ record_envelope: string }>();
  const list = Array.isArray(rows) ? rows : rows.results;
  const out: ConsentCapture[] = [];
  for (const row of list) {
    out.push(
      ConsentCaptureSchema.parse(
        JSON.parse(await openText(kit, row.record_envelope)),
      ),
    );
  }
  return out;
}

/** The effective decision per category: the latest capture wins. */
export async function latestConsentDecisions(
  db: D1Database,
  kit: VaultKit,
  submissionId: string,
): Promise<Map<SensitiveCategory, boolean>> {
  const out = new Map<SensitiveCategory, boolean>();
  for (const capture of await listConsentRecords(db, kit, submissionId)) {
    for (const d of capture.decisions) out.set(d.category, d.granted);
  }
  return out;
}

/** An addendum continues the same source: its consent carries over. */
export async function inheritConsent(
  db: D1Database,
  parentId: string,
  childId: string,
): Promise<void> {
  const rows = await db
    .prepare(
      "SELECT wording_version, record_envelope, created_at FROM consent_records WHERE submission_id = ? ORDER BY created_at ASC, id ASC",
    )
    .bind(parentId)
    .all<{ wording_version: number; record_envelope: string; created_at: string }>();
  const list = Array.isArray(rows) ? rows : rows.results;
  for (const row of list) {
    await db
      .prepare(
        "INSERT INTO consent_records (id, submission_id, wording_version, record_envelope, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        crypto.randomUUID(),
        childId,
        row.wording_version,
        row.record_envelope,
        row.created_at,
      )
      .run();
  }
}

export interface ConsentCoverageRow {
  category: SensitiveCategory;
  granted: number;
  refused: number;
  undecided: number;
  /** Stored answers tagged with this category (HMAC-joined). */
  stored: number;
}

export interface ConsentCoverage {
  captures: number;
  submissions: number;
  by_version: Array<{ wording_version: number; captures: number }>;
  categories: ConsentCoverageRow[];
  /** Stored category presence with no grant behind it: an audit finding. */
  gaps: Array<{ submission_id: string; category: SensitiveCategory }>;
}

/** Coverage over all submissions: per category, per wording version, and
 *  every stored category that a grant does not cover. */
export async function consentCoverage(
  db: D1Database,
  kit: VaultKit,
): Promise<ConsentCoverage> {
  const rows = await db
    .prepare(
      "SELECT submission_id, wording_version, record_envelope FROM consent_records ORDER BY created_at ASC, id ASC",
    )
    .all<{
      submission_id: string;
      wording_version: number;
      record_envelope: string;
    }>();
  const list = Array.isArray(rows) ? rows : rows.results;

  const bySubmission = new Map<string, Map<SensitiveCategory, boolean>>();
  const byVersion = new Map<number, number>();
  for (const row of list) {
    const capture = ConsentCaptureSchema.parse(
      JSON.parse(await openText(kit, row.record_envelope)),
    );
    const map = bySubmission.get(row.submission_id) ?? new Map();
    for (const d of capture.decisions) map.set(d.category, d.granted);
    bySubmission.set(row.submission_id, map);
    const version = Number(row.wording_version);
    byVersion.set(version, (byVersion.get(version) ?? 0) + 1);
  }

  const categories: ConsentCoverageRow[] = SENSITIVE_CATEGORIES.map(
    (category) => ({
      category,
      granted: 0,
      refused: 0,
      undecided: 0,
      stored: 0,
    }),
  );
  const index = new Map(categories.map((r) => [r.category, r] as const));
  for (const decisions of bySubmission.values()) {
    for (const row of categories) {
      const granted = decisions.get(row.category);
      if (granted === true) row.granted++;
      else if (granted === false) row.refused++;
      else row.undecided++;
    }
  }

  const present = await db
    .prepare("SELECT submission_id, category_hmac FROM message_categories")
    .all<{ submission_id: string; category_hmac: string }>();
  const presentList = Array.isArray(present) ? present : present.results;
  const byHmac = new Map<string, SensitiveCategory>();
  for (const category of SENSITIVE_CATEGORIES) {
    byHmac.set(await categoryHmac(kit, category), category);
  }
  const gaps: ConsentCoverage["gaps"] = [];
  for (const row of presentList) {
    const category = byHmac.get(row.category_hmac);
    if (!category) continue;
    index.get(category)!.stored++;
    if (bySubmission.get(row.submission_id)?.get(category) !== true) {
      gaps.push({ submission_id: row.submission_id, category });
    }
  }

  return {
    captures: list.length,
    submissions: bySubmission.size,
    by_version: [...byVersion.entries()]
      .map(([wording_version, captures]) => ({ wording_version, captures }))
      .sort((a, b) => a.wording_version - b.wording_version),
    categories,
    gaps,
  };
}

/** The survey shell's sensitive panel payload, as an escaped data attribute. */
export function sensitiveConsentPanel(instrument: InstrumentWording | null): string {
  return JSON.stringify({
    version: consentVersionOf(instrument),
    prompt_revision: SENSITIVE_PROMPT_REVISION,
    categories: SENSITIVE_CATEGORIES.map((key) => ({
      key,
      label: SENSITIVE_CATEGORY_INFO[key].label,
      prompt: SENSITIVE_CATEGORY_INFO[key].prompt,
    })),
  });
}
