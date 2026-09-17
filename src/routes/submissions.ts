// Operator read surface for submissions (the console's submissions
// section). Everything here is operator-only: threads, structured answers,
// consent decisions and attachment state name one source's testimony.
// Quarantine is kept: message bodies are unsealed for the operator but
// carry pseudonyms, never names — attachment filenames stay sealed so a
// name in a filename cannot bypass the break-glass reveal. No access-code
// material (HMAC or code) ever leaves this route.

import { Hono } from "hono";
import { z } from "zod";
import type { Bindings } from "../env";
import { getState } from "../state";
import { openText, type VaultKit } from "../lib/vault";
import {
  ConsentCaptureSchema,
  type SensitiveCategory,
} from "../lib/consent";
import { resolveEntityLinks } from "../lib/entities";
import { isSettledStatus } from "../lib/mirror";

export const submissions = new Hono<{ Bindings: Bindings }>();

const UuidParam = z.string().uuid().max(64);

interface SubmissionRow {
  id: string;
  status: string;
  kind: string;
  parent_id: string | null;
  round: number;
  created_at: string;
  write_count: number;
}

interface AttachmentRow {
  id: string;
  submission_id: string;
  media_type: string;
  size_bytes: number;
  status: string;
  lane: string | null;
  reason: string | null;
  retry_after: string | null;
  raw_key: string | null;
  created_at: string;
}

function unwrap<T>(rows: T[] | { results: T[] }): T[] {
  return Array.isArray(rows) ? rows : rows.results;
}

async function submissionById(
  db: D1Database,
  id: string,
): Promise<SubmissionRow | null> {
  return db
    .prepare(
      "SELECT id, status, kind, parent_id, round, created_at, write_count FROM submissions WHERE id = ?",
    )
    .bind(id)
    .first<SubmissionRow>();
}

async function attachmentsFor(
  db: D1Database,
  id: string,
): Promise<AttachmentRow[]> {
  const rows = await db
    .prepare(
      "SELECT id, submission_id, media_type, size_bytes, status, lane, reason, retry_after, raw_key, created_at FROM attachments WHERE submission_id = ? ORDER BY created_at ASC, id ASC",
    )
    .bind(id)
    .all<AttachmentRow>();
  return unwrap(rows);
}

function attachmentView(row: AttachmentRow) {
  return {
    id: row.id,
    media_type: row.media_type,
    size_bytes: row.size_bytes,
    status: row.status,
    lane: row.lane,
    reason: row.reason,
    // Whether raw bytes are still held (their deletion window is running).
    raw_retained: row.raw_key !== null,
    retry_after: row.retry_after,
    created_at: row.created_at,
  };
}

/** The effective consent decision per category: latest capture wins. */
async function consentView(db: D1Database, kit: VaultKit, id: string) {
  const rows = await db
    .prepare(
      "SELECT wording_version, record_envelope, created_at FROM consent_records WHERE submission_id = ? ORDER BY created_at ASC, id ASC",
    )
    .bind(id)
    .all<{ wording_version: number; record_envelope: string; created_at: string }>();
  const captures = [];
  const effective = new Map<SensitiveCategory, boolean>();
  for (const row of unwrap(rows)) {
    const capture = ConsentCaptureSchema.parse(
      JSON.parse(await openText(kit, row.record_envelope)),
    );
    for (const d of capture.decisions) effective.set(d.category, d.granted);
    captures.push({
      wording_version: capture.wording_version,
      captured_at: capture.captured_at,
      decisions: capture.decisions,
    });
  }
  return {
    captures,
    effective: [...effective.entries()].map(([category, granted]) => ({
      category,
      granted,
    })),
  };
}

// The submissions index: source traffic without opening a database console.
// Consent decisions are opened per row (one installation, one operator).
submissions.get("/", async (c) => {
  const app = await getState(c.env);
  const rows = await c.env.DB.prepare(
    "SELECT id, status, kind, parent_id, round, created_at, write_count FROM submissions ORDER BY created_at DESC, id DESC",
  ).all<SubmissionRow>();
  const list = unwrap(rows);
  const out = [];
  for (const sub of list) {
    const attachments = await attachmentsFor(c.env.DB, sub.id);
    const settled = attachments.filter((a) => isSettledStatus(a.status));
    const held = attachments.filter((a) => a.status === "held");
    const consent = await consentView(c.env.DB, app.kit, sub.id);
    const lastActivity = attachments.reduce(
      (latest, a) => (a.created_at > latest ? a.created_at : latest),
      sub.created_at,
    );
    out.push({
      id: sub.id,
      status: sub.status,
      kind: sub.kind,
      parent_id: sub.parent_id,
      round: sub.round,
      created_at: sub.created_at,
      last_activity: lastActivity,
      consent_captures: consent.captures.length,
      consent: consent.effective,
      attachments: {
        total: attachments.length,
        settled: settled.length,
        held: held.length,
        raw_retained: attachments.filter((a) => a.raw_key !== null).length,
      },
    });
  }
  return c.json({ submissions: out });
});

// One submission's testimony in one place: the reply thread (structured
// answers included, quarantine pseudonyms intact), consent coverage,
// attachment lane state and the entity pseudonyms this submission touches.
submissions.get("/:id", async (c) => {
  const id = UuidParam.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const app = await getState(c.env);
  const sub = await submissionById(c.env.DB, id.data);
  if (!sub) return c.json({ error: "not_found" }, 404);

  const msgRows = await c.env.DB.prepare(
    "SELECT seq, role, kind, body_envelope FROM messages WHERE submission_id = ? ORDER BY seq ASC",
  )
    .bind(id.data)
    .all<{ seq: number; role: string; kind: string; body_envelope: string }>();
  const messages = [];
  for (const row of unwrap(msgRows)) {
    messages.push({
      seq: row.seq,
      role: row.role,
      kind: row.kind,
      body: await openText(app.kit, row.body_envelope),
    });
  }

  const attachments = (await attachmentsFor(c.env.DB, id.data)).map(
    attachmentView,
  );

  // Entity pseudonyms: labels and HMACs only. `sealed` proves the sealed
  // name exists without opening it; reveal is a separately audited act.
  const links = (await resolveEntityLinks(c.env.DB)).filter(
    (l) => l.submission_id === id.data,
  );
  const entities = links.map((l) => ({
    label: l.label,
    hmac: l.name_hmac,
    sealed: l.sealed,
  }));

  const topicRows = await c.env.DB.prepare(
    "SELECT topic, source FROM topics WHERE submission_id = ? ORDER BY topic ASC",
  )
    .bind(id.data)
    .all<{ topic: string; source: string }>();

  const lastActivity = attachments.reduce(
    (latest, a) => (a.created_at > latest ? a.created_at : latest),
    sub.created_at,
  );

  return c.json({
    submission: {
      id: sub.id,
      status: sub.status,
      kind: sub.kind,
      parent_id: sub.parent_id,
      round: sub.round,
      created_at: sub.created_at,
      last_activity: lastActivity,
      write_count: sub.write_count,
    },
    messages,
    consent: await consentView(c.env.DB, app.kit, id.data),
    attachments,
    entities,
    topics: unwrap(topicRows),
  });
});

export default submissions;
