// Submitter attachments (FR-045-FR-050). Raw bytes are private and transient:
// streamed to R2, extracted through the shared lanes, gated, then deleted. On
// failure the file stays sealed for a bounded retry window. Extracted text
// becomes testimony only — never corpus mirror material — and quarantined
// names are sealed exactly as free-text names are.

import type { Bindings } from "../env";
import { getState } from "../state";
import { nameHmac, openText, sealText } from "./vault";
import {
  entityIndexRows,
  entityIndexStatements,
  type SealedEntityRef,
} from "./entities";
import { recordTurn } from "./telemetry";
import { runDrain, type HeldDoc } from "./drain";
import { buildLaneHandlers } from "./lanes";
import { isSettledStatus } from "./mirror";

export const ATTACH_MAX_BYTES = 50 * 1024 * 1024;
export const ATTACH_TOTAL_BYTES = 200 * 1024 * 1024;
export const ATTACH_RETRY_MS = 24 * 60 * 60 * 1000;

/** Lane for a submitter attachment; "rejected" means unsupported type. */
export function attachmentLane(mediaType: string, filename: string): string {
  const m = mediaType.toLowerCase();
  const f = filename.toLowerCase();
  if (m.startsWith("image/")) return "held-ocr";
  if (m === "application/pdf" || f.endsWith(".pdf")) return "held-pdf";
  if (m.includes("wordprocessingml") || f.endsWith(".docx")) return "held-docx";
  if (m.includes("spreadsheetml") || f.endsWith(".xlsx")) return "held-xlsx";
  if (m.includes("presentationml") || f.endsWith(".pptx")) return "held-pptx";
  return "rejected";
}

export async function attachmentBytes(
  db: D1Database,
  submissionId: string,
): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COALESCE(SUM(size_bytes), 0) AS n FROM attachments WHERE submission_id = ?",
    )
    .bind(submissionId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

interface AttachmentRow {
  id: string;
  submission_id: string;
  filename: string;
  media_type: string;
  status: string;
  raw_key: string | null;
  retry_after: string | null;
  lane: string | null;
}

/** The lane decided at upload, or one re-derived for legacy rows whose
 *  filename is still sealed. Unclassifiable rows fall back to "rejected" so
 *  they are terminated rather than re-selected forever. */
async function rowLane(app: Awaited<ReturnType<typeof getState>>, row: AttachmentRow): Promise<string> {
  if (row.lane) return row.lane;
  try {
    return attachmentLane(row.media_type, await openText(app.kit, row.filename));
  } catch {
    return "rejected";
  }
}

/**
 * Drain one attachment: R2 bytes → shared lane → gate → testimony message,
 * then delete the raw. Failures keep the raw for the bounded retry window.
 */
export async function drainAttachmentById(
  env: Bindings,
  attachmentId: string,
): Promise<{ status: string; reason: string | null }> {
  const app = await getState(env);
  const row = await env.DB.prepare(
    "SELECT id, submission_id, filename, media_type, status, raw_key, retry_after, lane FROM attachments WHERE id = ?",
  )
    .bind(attachmentId)
    .first<AttachmentRow>();
  if (!row || !row.raw_key || !env.CORPUS) {
    return { status: "ignored", reason: "attachment not drainable" };
  }
  if (row.status !== "uploaded" && row.status !== "held") {
    return { status: "ignored", reason: "attachment not pending" };
  }
  const now = new Date();
  if (
    row.status === "held" &&
    row.retry_after &&
    row.retry_after > now.toISOString()
  ) {
    return { status: "held", reason: "retry window not elapsed" };
  }
  const obj = await env.CORPUS.get(row.raw_key);
  if (!obj) {
    await env.DB.prepare(
      "UPDATE attachments SET status = 'held', reason = ?, retry_after = ? WHERE id = ?",
    )
      .bind(
        "raw bytes missing from the object store",
        new Date(now.getTime() + ATTACH_RETRY_MS).toISOString(),
        row.id,
      )
      .run();
    return { status: "held", reason: "raw bytes missing" };
  }
  const bytes = new Uint8Array(await obj.arrayBuffer());
  let b64 = "";
  for (const b of bytes) b64 += String.fromCharCode(b);
  const lane = await rowLane(app, row);
  const doc: HeldDoc = {
    id: row.id,
    lane,
    status: "held",
    bytes_b64: btoa(b64),
    raw_key: row.raw_key,
  };

  const handlers = await buildLaneHandlers(env);
  const { results } = await runDrain([doc], handlers);
  const r = results[0];
  if (!r) {
    // Terminal: no handler for this lane. Clear the raw bytes and record
    // the state so the row is never re-selected with no reason and no
    // bounded deletion time.
    await env.DB.prepare(
      "UPDATE attachments SET status = 'rejected', reason = ?, raw_key = NULL, retry_after = NULL WHERE id = ?",
    )
      .bind("unsupported attachment lane", row.id)
      .run();
    await env.CORPUS.delete(row.raw_key);
    await recordTurn(env.DB, {
      tier: "none",
      toolCalls: 0,
      label: `attachment:${lane}`,
      outcome: "rejected",
    });
    return { status: "rejected", reason: "no lane handler" };
  }

  if (isSettledStatus(r.outcome.status)) {
    const seqRow = await env.DB.prepare(
      "SELECT MAX(seq) AS maxSeq FROM messages WHERE submission_id = ?",
    )
      .bind(row.submission_id)
      .first<{ maxSeq: number | null }>();
    let seq = (seqRow?.maxSeq ?? -1) + 1;
    const statements = [
      env.DB.prepare(
        "INSERT INTO messages (submission_id, seq, role, kind, body_envelope) VALUES (?, ?, 'submitter', 'freetext', ?)",
      ).bind(
        row.submission_id,
        seq++,
        await sealText(app.kit, r.outcome.text),
      ),
    ];
    // Quarantine attachment names exactly as free-text names are sealed,
    // and index the gated testimony the gate produced (by HMAC, no names).
    // The sealed row keeps the lane label; the index node is the pseudonym
    // the gated text actually shows.
    const sealed: SealedEntityRef[] = [];
    for (let i = 0; i < r.outcome.hits.length; i++) {
      const hit = r.outcome.hits[i];
      const hmac = await nameHmac(app.kit, hit.name);
      sealed.push({ label: hit.label, hmac });
      statements.push(
        env.DB.prepare(
          "INSERT INTO entities (submission_id, label, name_envelope, name_hmac) VALUES (?, ?, ?, ?)",
        ).bind(
          row.submission_id,
          `[attachment-name ${i + 1}]`,
          await sealText(app.kit, hit.name),
          hmac,
        ),
      );
    }
    statements.push(
      ...entityIndexStatements(
        env.DB,
        entityIndexRows(row.submission_id, r.outcome.text, sealed),
      ),
    );
    statements.push(
      env.DB.prepare(
        "UPDATE attachments SET status = ?, reason = NULL, raw_key = NULL, retry_after = NULL WHERE id = ?",
      ).bind(r.outcome.status, row.id),
    );
    await env.DB.batch(statements);
    await env.CORPUS.delete(row.raw_key);
    await recordTurn(env.DB, {
      tier: r.tier,
      toolCalls: 0,
      label: `attachment:${doc.lane}`,
      outcome: r.outcome.status,
    });
    return { status: r.outcome.status, reason: null };
  }

  await env.DB.prepare(
    "UPDATE attachments SET status = 'held', reason = ?, retry_after = ? WHERE id = ?",
  )
    .bind(
      r.outcome.reason,
      new Date(now.getTime() + ATTACH_RETRY_MS).toISOString(),
      row.id,
    )
    .run();
  await recordTurn(env.DB, {
    tier: r.tier,
    toolCalls: 0,
    label: `attachment:${doc.lane}`,
    outcome: "held",
  });
  return { status: "held", reason: r.outcome.reason };
}
