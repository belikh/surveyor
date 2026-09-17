// Recording provenance and the publication gate (C8). Audio/video evidence
// carries provenance — recorder, date, place, jurisdiction, consent status —
// captured with the recording at ingest. Free text is sealed; jurisdiction
// and consent status stay plaintext so the gate can decide without opening
// a record. A recording is jurisdiction-sensitive unless every party
// consented: one-party and unknown-consent recordings turn on the
// surveillance law of the place they were made, so a human legally reviews
// them before they reach a report. The review is recorded against the
// version that would release it, never an earlier one.

import { z } from "zod";
import { openText, sealText, type VaultKit } from "./vault";
import { unwrap } from "./evidence";
import type { Evidence } from "./reports";

/** Consent recorded with the recording; anything but `all_parties` needs a
 *  jurisdiction-specific legal review before publication. */
export const ConsentStatusSchema = z.enum([
  "all_parties",
  "one_party",
  "unknown",
]);
export type ConsentStatus = z.infer<typeof ConsentStatusSchema>;

export const RecordingProvenanceSchema = z.object({
  recorder: z.string().min(1).max(200),
  recorded_at: z.string().min(1).max(64),
  place: z.string().min(1).max(300),
  jurisdiction: z.string().min(1).max(120),
  consent_status: ConsentStatusSchema,
});
export type RecordingProvenance = z.infer<typeof RecordingProvenanceSchema>;

/** The lanes whose evidence is a recording. */
export function isRecordingLane(lane: string): boolean {
  return lane === "held-audio" || lane === "held-video";
}

export type RecordingProvenanceParse =
  | { ok: true; value: RecordingProvenance | null }
  | { ok: false; error: string };

/** Parse the ingest header (percent-encoded JSON). Absent means null —
 *  the recording is stored without provenance and the gate treats it as
 *  unknown, never as consent. */
export function parseRecordingProvenanceHeader(
  raw: string | undefined,
): RecordingProvenanceParse {
  if (raw === undefined || raw === "") return { ok: true, value: null };
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return { ok: false, error: "recording provenance is not percent-encoded" };
  }
  let json: unknown;
  try {
    json = JSON.parse(decoded);
  } catch {
    return { ok: false, error: "recording provenance is not JSON" };
  }
  const parsed = RecordingProvenanceSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      error:
        `invalid recording provenance: ` +
        `${parsed.error.issues[0]?.message ?? "schema"}`,
    };
  }
  return { ok: true, value: parsed.data };
}

const DetailSchema = z.object({
  recorder: z.string(),
  recorded_at: z.string(),
  place: z.string(),
});

/** Seal the free-text detail; the gate fields stay columns. */
export async function captureRecordingProvenance(
  db: D1Database,
  kit: VaultKit,
  docId: string,
  provenance: RecordingProvenance,
  now = new Date().toISOString(),
): Promise<void> {
  const detail = JSON.stringify({
    recorder: provenance.recorder,
    recorded_at: provenance.recorded_at,
    place: provenance.place,
  });
  await db
    .prepare(
      "INSERT INTO recording_provenance " +
        "(doc_id, jurisdiction, consent_status, detail_envelope, created_at) " +
        "VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(doc_id) DO UPDATE SET " +
        "jurisdiction = excluded.jurisdiction, " +
        "consent_status = excluded.consent_status, " +
        "detail_envelope = excluded.detail_envelope, " +
        "created_at = excluded.created_at",
    )
    .bind(
      docId,
      provenance.jurisdiction,
      provenance.consent_status,
      await sealText(kit, detail),
      now,
    )
    .run();
}

export interface RecordingProvenanceView extends RecordingProvenance {
  doc_id: string;
  created_at: string;
}

/** Every captured provenance record, opened for the operator, by doc id. */
export async function listRecordingProvenance(
  db: D1Database,
  kit: VaultKit,
): Promise<Map<string, RecordingProvenanceView>> {
  const rows = unwrap(
    await db
      .prepare("SELECT * FROM recording_provenance")
      .all<Record<string, string>>(),
  );
  const out = new Map<string, RecordingProvenanceView>();
  for (const row of rows) {
    const detail = DetailSchema.parse(
      JSON.parse(await openText(kit, row.detail_envelope)),
    );
    out.set(row.doc_id, {
      doc_id: row.doc_id,
      recorder: detail.recorder,
      recorded_at: detail.recorded_at,
      place: detail.place,
      jurisdiction: row.jurisdiction,
      consent_status: ConsentStatusSchema.parse(row.consent_status),
      created_at: row.created_at,
    });
  }
  return out;
}

/**
 * A recording is jurisdiction-sensitive unless every party's consent is
 * recorded. Absent provenance is unknown, so it is sensitive.
 */
export function jurisdictionSensitive(
  provenance: { consent_status: string } | null,
): boolean {
  return provenance === null || provenance.consent_status !== "all_parties";
}

export class RecordingGateUnmet extends Error {
  constructor(
    public readonly unmet: string[],
    public readonly doc_ids: string[],
  ) {
    super(`recording gate unmet: ${unmet.join(", ")}`);
    this.name = "RecordingGateUnmet";
  }
}

export interface RecordingGateVerdict {
  ok: boolean;
  unmet: string[];
  /** Cited recordings still awaiting a review for this version. */
  doc_ids: string[];
}

/**
 * The gate verdict for a release: every jurisdiction-sensitive recording
 * cited by the evidence bundle needs a review row for the exact version.
 * Recordings that appear in the corpus but reach no citation are not this
 * gate's concern.
 */
export async function recordingGateStatus(
  db: D1Database,
  evidence: Evidence,
  type: string,
  version: number,
): Promise<RecordingGateVerdict> {
  const cited = new Set<string>();
  for (const angle of evidence.angles) {
    for (const exhibit of angle.exhibits) cited.add(exhibit.doc_id);
  }
  for (const line of evidence.lines) {
    for (const citation of line.citations) cited.add(citation.doc_id);
  }
  if (cited.size === 0) return { ok: true, unmet: [], doc_ids: [] };

  const rows = unwrap(
    await db
      .prepare(
        "SELECT id, lane FROM corpus_docs " +
          "WHERE lane IN ('held-audio', 'held-video')",
      )
      .all<{ id: string; lane: string }>(),
  );
  const pending: string[] = [];
  for (const row of rows) {
    if (!cited.has(row.id)) continue;
    const provenance =
      (await db
        .prepare(
          "SELECT consent_status FROM recording_provenance WHERE doc_id = ?",
        )
        .bind(row.id)
        .first<{ consent_status: string }>()) ?? null;
    if (!jurisdictionSensitive(provenance)) continue;
    const reviewed = await db
      .prepare(
        "SELECT 1 AS ok FROM recording_reviews " +
          "WHERE report_type = ? AND version = ? AND doc_id = ?",
      )
      .bind(type, version, row.id)
      .first<{ ok: number }>();
    if (!reviewed) pending.push(row.id);
  }
  return pending.length === 0
    ? { ok: true, unmet: [], doc_ids: [] }
    : { ok: false, unmet: ["recording-review"], doc_ids: pending };
}

export const RecordingReviewBodySchema = z.object({
  doc_id: z.string().min(1).max(128),
  reviewer: z.string().min(1).max(200),
  notes: z.string().max(4000).default(""),
});
export type RecordingReviewBody = z.infer<typeof RecordingReviewBodySchema>;

export interface RecordingReviewRecorded {
  type: string;
  version: number;
  doc_id: string;
  recorded_at: string;
}

/** Record a legal review of one recording for the pending version. Returns
 *  null when the doc is not a recording, so a review never attaches to
 *  evidence the gate does not police. */
export async function recordRecordingReview(
  db: D1Database,
  kit: VaultKit,
  type: string,
  version: number,
  body: RecordingReviewBody,
  now = new Date().toISOString(),
): Promise<RecordingReviewRecorded | null> {
  const doc = await db
    .prepare("SELECT lane FROM corpus_docs WHERE id = ?")
    .bind(body.doc_id)
    .first<{ lane: string }>();
  if (!doc || !isRecordingLane(doc.lane)) return null;
  await db
    .prepare(
      "INSERT INTO recording_reviews " +
        "(id, report_type, version, doc_id, record_envelope, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(report_type, version, doc_id) DO UPDATE SET " +
        "record_envelope = excluded.record_envelope, " +
        "created_at = excluded.created_at",
    )
    .bind(
      crypto.randomUUID(),
      type,
      version,
      body.doc_id,
      await sealText(
        kit,
        JSON.stringify({ reviewer: body.reviewer, notes: body.notes }),
      ),
      now,
    )
    .run();
  return {
    type,
    version,
    doc_id: body.doc_id,
    recorded_at: now,
  };
}
