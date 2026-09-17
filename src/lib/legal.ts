// Publication legal gate (defamation ss 29A/30; the statutory privacy
// tort): the legal review and the right-of-reply record are tied to the
// version they release, so a stale approval never carries to a new version
// and publication blocks until both are recorded. Reviewer names, notes and
// reply detail are sealed; the version and reply outcome stay plaintext for
// the gate check and the audit list.

import { z } from "zod";
import { openText, sealText, type VaultKit } from "./vault";

export const ReplyOutcomeSchema = z.enum([
  "awaiting",
  "responded",
  "declined",
  "no_response",
]);
export type ReplyOutcome = z.infer<typeof ReplyOutcomeSchema>;

export const LegalReviewBodySchema = z.object({
  reviewer: z.string().min(1).max(200),
  /** False only when no person or organisation is a subject of the report. */
  reply_required: z.boolean().default(true),
  notes: z.string().max(4000).default(""),
});
export type LegalReviewBody = z.infer<typeof LegalReviewBodySchema>;

export const ReplyAttemptBodySchema = z.object({
  subject: z.string().min(1).max(200),
  channel: z.string().min(1).max(100),
  outcome: ReplyOutcomeSchema,
  response: z.string().max(4000).default(""),
  notes: z.string().max(4000).default(""),
  attempted_at: z.string().datetime().optional(),
});
export type ReplyAttemptBody = z.infer<typeof ReplyAttemptBodySchema>;

const LegalRecordSchema = z.object({
  reviewer: z.string().min(1).max(200),
  notes: z.string().max(4000).default(""),
});

const ReplyRecordSchema = z.object({
  subject: z.string().min(1).max(200),
  channel: z.string().min(1).max(100),
  response: z.string().max(4000).default(""),
  notes: z.string().max(4000).default(""),
});

export class LegalGateUnmet extends Error {
  constructor(public readonly unmet: string[]) {
    super(`legal gate unmet: ${unmet.join(", ")}`);
    this.name = "LegalGateUnmet";
  }
}

export interface LegalGateVerdict {
  ok: boolean;
  unmet: string[];
}

/** The version a record made now would release. */
export function pendingVersion(currentVersion: number): number {
  return currentVersion + 1;
}

/** A legal review for the version, and a right-of-reply attempt logged
 *  against it (or an explicit decision that no reply is required), are both
 *  needed before that version can publish. */
export async function legalGateStatus(
  db: D1Database,
  type: string,
  version: number,
): Promise<LegalGateVerdict> {
  const unmet: string[] = [];
  const record = await db
    .prepare(
      "SELECT reply_required FROM report_legal_records WHERE report_type = ? AND version = ?",
    )
    .bind(type, version)
    .first<{ reply_required: number }>();
  if (!record) {
    unmet.push("legal-review");
  } else if (Number(record.reply_required) === 1) {
    const count = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM right_of_reply_attempts WHERE report_type = ? AND version = ?",
      )
      .bind(type, version)
      .first<{ n: number }>();
    if (Number(count?.n ?? 0) === 0) unmet.push("right-of-reply");
  }
  return { ok: unmet.length === 0, unmet };
}

export interface LegalReviewRecorded {
  type: string;
  version: number;
  reply_required: boolean;
  recorded_at: string;
}

export async function recordLegalReview(
  db: D1Database,
  kit: VaultKit,
  type: string,
  version: number,
  body: LegalReviewBody,
  now = new Date().toISOString(),
): Promise<LegalReviewRecorded> {
  const record = LegalRecordSchema.parse({
    reviewer: body.reviewer,
    notes: body.notes,
  });
  await db
    .prepare(
      "INSERT INTO report_legal_records " +
        "(id, report_type, version, reply_required, record_envelope, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(report_type, version) DO UPDATE SET " +
        "reply_required = excluded.reply_required, " +
        "record_envelope = excluded.record_envelope, " +
        "created_at = excluded.created_at",
    )
    .bind(
      crypto.randomUUID(),
      type,
      version,
      body.reply_required ? 1 : 0,
      await sealText(kit, JSON.stringify(record)),
      now,
    )
    .run();
  return {
    type,
    version,
    reply_required: body.reply_required,
    recorded_at: now,
  };
}

export interface ReplyAttemptRecorded {
  id: string;
  type: string;
  version: number;
  outcome: ReplyOutcome;
  attempted_at: string;
}

export async function recordReplyAttempt(
  db: D1Database,
  kit: VaultKit,
  type: string,
  version: number,
  body: ReplyAttemptBody,
  now = new Date().toISOString(),
): Promise<ReplyAttemptRecorded> {
  const attemptedAt = body.attempted_at ?? now;
  const record = ReplyRecordSchema.parse({
    subject: body.subject,
    channel: body.channel,
    response: body.response,
    notes: body.notes,
  });
  const id = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO right_of_reply_attempts " +
        "(id, report_type, version, outcome, attempted_at, record_envelope, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      id,
      type,
      version,
      body.outcome,
      attemptedAt,
      await sealText(kit, JSON.stringify(record)),
      now,
    )
    .run();
  return { id, type, version, outcome: body.outcome, attempted_at: attemptedAt };
}

export interface LegalRecordView {
  version: number;
  reviewer: string;
  reply_required: boolean;
  notes: string;
  created_at: string;
}

export interface ReplyAttemptView {
  id: string;
  version: number;
  outcome: ReplyOutcome;
  subject: string;
  channel: string;
  response: string;
  notes: string;
  attempted_at: string;
  created_at: string;
}

/** The operator-facing audit view: every release record and every attempt,
 *  opened for the operator, newest versions first. */
export async function listLegalSurface(
  db: D1Database,
  kit: VaultKit,
  type: string,
): Promise<{ records: LegalRecordView[]; replies: ReplyAttemptView[] }> {
  const recordRows = await db
    .prepare(
      "SELECT version, reply_required, record_envelope, created_at " +
        "FROM report_legal_records WHERE report_type = ? ORDER BY version DESC",
    )
    .bind(type)
    .all<{
      version: number;
      reply_required: number;
      record_envelope: string;
      created_at: string;
    }>();
  const records: LegalRecordView[] = [];
  for (const row of Array.isArray(recordRows) ? recordRows : recordRows.results) {
    const opened = LegalRecordSchema.parse(
      JSON.parse(await openText(kit, row.record_envelope)),
    );
    records.push({
      version: Number(row.version),
      reviewer: opened.reviewer,
      reply_required: Number(row.reply_required) === 1,
      notes: opened.notes,
      created_at: row.created_at,
    });
  }

  const replyRows = await db
    .prepare(
      "SELECT id, version, outcome, attempted_at, record_envelope, created_at " +
        "FROM right_of_reply_attempts WHERE report_type = ? " +
        "ORDER BY version DESC, attempted_at ASC",
    )
    .bind(type)
    .all<{
      id: string;
      version: number;
      outcome: string;
      attempted_at: string;
      record_envelope: string;
      created_at: string;
    }>();
  const replies: ReplyAttemptView[] = [];
  for (const row of Array.isArray(replyRows) ? replyRows : replyRows.results) {
    const opened = ReplyRecordSchema.parse(
      JSON.parse(await openText(kit, row.record_envelope)),
    );
    replies.push({
      id: row.id,
      version: Number(row.version),
      outcome: ReplyOutcomeSchema.parse(row.outcome),
      subject: opened.subject,
      channel: opened.channel,
      response: opened.response,
      notes: opened.notes,
      attempted_at: row.attempted_at,
      created_at: row.created_at,
    });
  }
  return { records, replies };
}
