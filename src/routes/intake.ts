// Anonymous intake routes: challenge, create (PoW + Turnstile), steps,
// resume-by-code, addendum children, adaptive rounds. PUBLIC surface —
// sources hold no credentials; anti-spam is PoW plus human-verification.

import { Hono } from "hono";
import { z } from "zod";
import type { Bindings } from "../env";
import { getState } from "../state";
import { issueChallenge, verifyChallenge } from "../lib/pow";
import {
  accessCode,
  categoryHmac,
  codeHmac,
  nameHmac,
  sealText,
  type VaultKit,
} from "../lib/vault";
import {
  SENSITIVE_CATEGORIES,
  buildConsentRecord,
  consentCoverage,
  consentVersionOf,
  inheritConsent,
  latestConsentDecisions,
  type SensitiveCategory,
} from "../lib/consent";
import {
  AddendumBodySchema,
  CreateBodySchema,
  QUESTIONS_PER_ROUND,
  ResumeBodySchema,
  RoundsBodySchema,
  StepsBodySchema,
  quarantineText,
  type QuarantineHit,
} from "../lib/intake";
import { groundedQuestions, ROUNDS_MAX } from "../lib/rounds";
import { normaliseTopic } from "../lib/engine";
import { completeAndRetrigger } from "../lib/retrigger";
import { recordTurn } from "../lib/telemetry";
import { liveClient } from "../lib/providers";
import {
  ATTACH_MAX_BYTES,
  ATTACH_TOTAL_BYTES,
  attachmentLane,
  drainAttachmentById,
} from "../lib/attachments";

type Env = { Bindings: Bindings };

export const intake = new Hono<{ Bindings: Bindings }>();

/** Per-answer ceiling on quarantined name claims. Scrubbing still covers the
 *  whole answer; only the entity rows a single answer can mint are bounded. */
const MAX_HITS_PER_ANSWER = 32;

/** Per-submission ceiling on appended rows (messages + entities + category
 *  presence), reserved atomically before the batch. Derived from the survey
 *  shape — the initial upload (≤32 answers × ≤3 names × ≤9 categories) plus
 *  every round (≤3×3) plus attachment testimony — with generous headroom,
 *  never from the request. */
const WRITE_BUDGET_ROWS =
  32 * (4 + SENSITIVE_CATEGORIES.length) +
  ROUNDS_MAX * QUESTIONS_PER_ROUND * (1 + SENSITIVE_CATEGORIES.length) +
  128;

/** Env is a boundary too: clamp difficulty into the sanctioned range. */
function difficulty(env: Bindings): number {
  const d = Number(env.POW_DIFFICULTY ?? "16");
  if (!Number.isFinite(d)) return 16;
  return Math.min(24, Math.max(8, Math.floor(d)));
}

async function verifyPow(
  kit: VaultKit,
  env: Bindings,
  proof: { challenge: string; nonce: string },
): Promise<{ ok: boolean; reason?: string }> {
  return verifyChallenge(kit.powKey, proof.challenge, proof.nonce, difficulty(env));
}

const IdParamSchema = z.string().uuid().max(64);

function idOr404(c: {
  req: { param(name: string): string };
  json: (o: unknown, s: number) => Response;
}): string | Response {
  const parsed = IdParamSchema.safeParse(c.req.param("id"));
  if (!parsed.success) return c.json({ error: "not_found" }, 404);
  return parsed.data;
}

/**
 * Resolve a submission only when the supplied access code matches its code
 * HMAC. An unknown id and a mismatched code return the same null, so these
 * routes stop doubling as a submission-existence oracle.
 */
async function submissionByCode(
  c: { env: Bindings },
  id: string,
  accessCode: string,
): Promise<{
  id: string;
  status: string;
  round: number;
  parent_id: string | null;
} | null> {
  const app = await getState(c.env);
  const row = await c.env.DB.prepare(
    "SELECT id, code_hmac, status, round, parent_id FROM submissions WHERE id = ?",
  )
    .bind(id)
    .first<{
      id: string;
      code_hmac: string;
      status: string;
      round: number;
      parent_id: string | null;
    }>();
  if (!row) return null;
  const hmac = await codeHmac(app.kit, accessCode);
  if (hmac !== row.code_hmac) return null;
  return {
    id: row.id,
    status: row.status,
    round: row.round,
    parent_id: row.parent_id,
  };
}

async function verifyTurnstile(
  env: Bindings,
  token: string | undefined,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  // Disabled-until-set: no secret, no gate (existing PoW-only tests stay).
  if (!env.TURNSTILE_SECRET) return true;
  if (!token) return false;
  try {
    const res = await fetchImpl(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `secret=${encodeURIComponent(env.TURNSTILE_SECRET)}&response=${encodeURIComponent(token)}`,
      },
    );
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}

intake.get("/challenge", async (c) => {
  const app = await getState(c.env);
  return c.json(await issueChallenge(app.kit.powKey, difficulty(c.env)));
});

intake.post("/", async (c) => {
  const app = await getState(c.env);
  const parsed = CreateBodySchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_body" }, 422);
  const pow = await verifyPow(app.kit, c.env, parsed.data.pow);
  if (!pow.ok) return c.json({ error: "pow_failed", detail: pow.reason }, 422);
  const human = await verifyTurnstile(
    c.env,
    parsed.data.turnstile_token,
    fetch,
  );
  if (!human) return c.json({ error: "turnstile_failed" }, 403);

  const code = accessCode();
  const hmac = await codeHmac(app.kit, code);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const statements = [
    c.env.DB.prepare(
      "INSERT INTO submissions (id, code_hmac, status, kind, parent_id, round, created_at) VALUES (?, ?, 'open', 'original', NULL, 0, ?)",
    ).bind(id, hmac, now),
  ];
  // Consent commits with the submission: a source who declines a category
  // has that on record before any answer can be written.
  if (parsed.data.consent) {
    const setup = await app.loadSetup();
    const record = await buildConsentRecord(
      app.kit,
      id,
      parsed.data.consent,
      consentVersionOf(setup.instrument),
      setup.instrument?.consent ?? "",
      now,
    );
    statements.push(
      c.env.DB.prepare(
        "INSERT INTO consent_records (id, submission_id, wording_version, record_envelope, created_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(
        record.id,
        record.submission_id,
        record.wording_version,
        record.record_envelope,
        record.created_at,
      ),
    );
  }
  await c.env.DB.batch(statements);
  return c.json({ id, access_code: code }, 201);
});

intake.post("/:id/steps", async (c) => {
  const app = await getState(c.env);
  const idOr = idOr404(c);
  if (typeof idOr !== "string") return idOr;
  const id = idOr;
  const parsed = StepsBodySchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_body" }, 422);
  const sub = await submissionByCode(c, id, parsed.data.access_code);
  if (!sub) return c.json({ error: "not_found" }, 404);
  if (sub.status !== "open") {
    return c.json({ error: "submission_closed" }, 409);
  }

  // Granular consent first: an answer tagged with a category the source
  // declined — or never decided — is refused, never stored (APP 3.3).
  const decisions = await latestConsentDecisions(c.env.DB, app.kit, id);
  const accepted: typeof parsed.data.answers = [];
  const refused: Array<{ topic: string; categories: SensitiveCategory[] }> =
    [];
  for (const a of parsed.data.answers) {
    const blocked = (a.sensitive_categories ?? []).filter(
      (category) => decisions.get(category) !== true,
    );
    if (blocked.length > 0) {
      refused.push({ topic: a.topic, categories: blocked });
    } else {
      accepted.push(a);
    }
  }

  // Prepare (scrub + cap) before the reservation so the budget is exact.
  const prepared: Array<{
    topic: string;
    scrubbed: string;
    hits: QuarantineHit[];
    categories: SensitiveCategory[];
  }> = accepted.map((a) => {
    const { scrubbed, hits } = quarantineText(a.value);
    return {
      topic: a.topic,
      scrubbed,
      hits: hits.slice(0, MAX_HITS_PER_ANSWER),
      categories: a.sensitive_categories ?? [],
    };
  });
  const newRows =
    prepared.length +
    prepared.reduce((n, p) => n + p.hits.length + p.categories.length, 0);
  if (newRows > 0) {
    // Reserve the write budget atomically: a single guarded UPDATE means
    // concurrent requests serialise on the submission row rather than all
    // reading the same stale count.
    const reservation = await c.env.DB.prepare(
      "UPDATE submissions SET write_count = write_count + ? WHERE id = ? AND write_count + ? <= ?",
    )
      .bind(newRows, id, newRows, WRITE_BUDGET_ROWS)
      .run();
    if (reservation.meta.changes === 0) {
      return c.json(
        {
          error: "write_budget_exceeded",
          detail: "per-submission write budget reached",
        },
        429,
      );
    }

    const existing = await c.env.DB.prepare(
      "SELECT MAX(seq) AS maxSeq FROM messages WHERE submission_id = ?",
    ).bind(id).first<{ maxSeq: number | null }>();
    let seq = (existing?.maxSeq ?? -1) + 1;
    const batch: Array<{ sql: string; params?: unknown[] }> = [];
    for (const { topic, scrubbed, hits, categories } of prepared) {
      const messageSeq = seq++;
      const envelope = await sealText(app.kit, scrubbed);
      batch.push({
        sql: "INSERT INTO messages (submission_id, seq, role, kind, body_envelope) VALUES (?, ?, 'submitter', 'structured', ?)",
        params: [id, messageSeq, envelope],
      });
      for (const category of categories) {
        batch.push({
          sql: "INSERT INTO message_categories (submission_id, seq, category_hmac) VALUES (?, ?, ?)",
          params: [id, messageSeq, await categoryHmac(app.kit, category)],
        });
      }
      for (const h of hits) {
        batch.push({
          sql: "INSERT INTO entities (submission_id, label, name_envelope, name_hmac) VALUES (?, ?, ?, ?)",
          params: [
            id,
            h.label,
            await sealText(app.kit, h.name),
            await nameHmac(app.kit, h.name),
          ],
        });
      }
      batch.push({
        sql: "INSERT INTO topics (submission_id, topic, source) VALUES (?, ?, 'baseline') ON CONFLICT(submission_id, topic) DO NOTHING",
        params: [id, normaliseTopic(topic)],
      });
    }
    // FakeD1.batch takes prepared statements; real D1 too — build them here.
    await c.env.DB.batch(
      batch.map((b) => c.env.DB.prepare(b.sql).bind(...(b.params ?? []))),
    );
  }
  return c.json({ saved: prepared.length, refused });
});

/** Operator gate for the manual attachment drain (the queue is automatic). */
function operatorDenied(c: {
  req: { header(name: string): string | undefined };
  env: Bindings;
}): 401 | 404 | null {
  const expected = c.env.OPERATOR_TOKEN;
  if (!expected) return 404;
  const got = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const a = new TextEncoder().encode(got);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return 401;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0 ? null : 401;
}

// Submitter attachments (FR-045-FR-050): raw bytes stream through the Worker
// into a private R2 key, then drain to testimony and are deleted. Filenames
// are sealed; caps are per-file (50 MB) and per-submission (200 MB).
intake.post("/:id/attachments", async (c) => {
  const app = await getState(c.env);
  const idOr = idOr404(c);
  if (typeof idOr !== "string") return idOr;
  const id = idOr;
  const code = c.req.query("access_code") ?? "";
  const sub = await submissionByCode(c, id, code);
  if (!sub) return c.json({ error: "not_found" }, 404);
  if (sub.status !== "open") {
    return c.json({ error: "submission_closed" }, 409);
  }
  if (!c.env.CORPUS) return c.json({ error: "attachments_unavailable" }, 503);
  const filename = (c.req.query("filename") ?? "attachment").slice(0, 256);
  const mediaType = (c.req.query("media_type") ?? "application/octet-stream").slice(
    0,
    128,
  );
  // Decide the lane once, here, and persist it: the drain must never have to
  // re-derive it from the sealed filename (which can never match ".pdf").
  const lane = attachmentLane(mediaType, filename);
  if (lane === "rejected") {
    return c.json({ error: "rejected", detail: "unsupported type" }, 422);
  }
  const declared = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > ATTACH_MAX_BYTES) {
    return c.json({ error: "too_large", detail: "50 MB per file" }, 413);
  }
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.length === 0) return c.json({ error: "empty_file" }, 422);
  if (bytes.length > ATTACH_MAX_BYTES) {
    return c.json({ error: "too_large", detail: "50 MB per file" }, 413);
  }
  const attId = crypto.randomUUID();
  const key = `attachments/${id}/${attId}`;
  const now = new Date().toISOString();
  // Reserve quota and row in one statement: a read-then-write lets
  // concurrent uploads all pass the same stale SUM. INSERT ... SELECT ...
  // WHERE is a single SQLite statement, so D1 applies it under the write
  // lock and the quota cannot be raced.
  const reserved = await c.env.DB.prepare(
    "INSERT INTO attachments (id, submission_id, filename, media_type, size_bytes, status, raw_key, lane, reason, retry_after, created_at) " +
      "SELECT ?, ?, ?, ?, ?, 'uploaded', ?, ?, NULL, NULL, ? " +
      "WHERE (SELECT COALESCE(SUM(size_bytes), 0) FROM attachments WHERE submission_id = ?) + ? <= ?",
  )
    .bind(
      attId,
      id,
      await sealText(app.kit, filename),
      mediaType,
      bytes.length,
      key,
      lane,
      now,
      id,
      bytes.length,
      ATTACH_TOTAL_BYTES,
    )
    .run();
  if (reserved.meta.changes === 0) {
    return c.json(
      { error: "quota_exceeded", detail: "200 MB per submission" },
      413,
    );
  }
  // Bytes reach R2 only after the reservation; a failed write rolls the
  // reservation back so a rejected request leaves no orphan row.
  try {
    await c.env.CORPUS.put(key, bytes);
  } catch (err) {
    await c.env.DB.prepare("DELETE FROM attachments WHERE id = ?")
      .bind(attId)
      .run();
    throw err;
  }
  if (c.env.INGEST) {
    await c.env.INGEST.send({ doc_id: attId, lane: "attachment", kind: "attachment" });
  }
  return c.json({ id: attId, status: "uploaded" }, 201);
});

intake.post("/:id/attachments/drain", async (c) => {
  const denied = operatorDenied(c);
  if (denied) {
    return c.json(
      { error: denied === 404 ? "not_found" : "unauthorised" },
      denied,
    );
  }
  const idOr = idOr404(c);
  if (typeof idOr !== "string") return idOr;
  const listed = await c.env.DB.prepare(
    "SELECT id FROM attachments WHERE submission_id = ? AND (status = 'uploaded' OR status = 'held')",
  )
    .bind(idOr)
    .all<{ id: string }>();
  const rows = Array.isArray(listed) ? listed : listed.results;
  const outcomes = [];
  for (const row of rows) {
    outcomes.push({ id: row.id, ...(await drainAttachmentById(c.env, row.id)) });
  }
  return c.json({
    drained: outcomes.filter((o) =>
      ["parsed", "OCRed", "rescued"].includes(o.status),
    ).length,
    outcomes,
  });
});

intake.post("/resume", async (c) => {  const app = await getState(c.env);
  const parsed = ResumeBodySchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_body" }, 422);
  const hmac = await codeHmac(app.kit, parsed.data.access_code);
  const row = await c.env.DB.prepare(
    "SELECT id FROM submissions WHERE code_hmac = ? AND kind = 'original' LIMIT 1",
  ).bind(hmac).first<{ id: string }>();
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json({ id: row.id });
});

intake.post("/:id/addendum", async (c) => {
  const app = await getState(c.env);
  const idOr = idOr404(c);
  if (typeof idOr !== "string") return idOr;
  const id = idOr;
  const parsed = AddendumBodySchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_body" }, 422);
  const parent = await c.env.DB.prepare(
    "SELECT id, code_hmac FROM submissions WHERE id = ?",
  ).bind(id).first<{ id: string; code_hmac: string }>();
  if (!parent) return c.json({ error: "not_found" }, 404);
  const hmac = await codeHmac(app.kit, parsed.data.access_code);
  if (hmac !== parent.code_hmac) {
    return c.json({ error: "not_found" }, 404);
  }
  const pow = await verifyPow(app.kit, c.env, parsed.data.pow);
  if (!pow.ok) return c.json({ error: "pow_failed", detail: pow.reason }, 422);
  const human = await verifyTurnstile(
    c.env,
    parsed.data.turnstile_token,
    fetch,
  );
  if (!human) return c.json({ error: "turnstile_failed" }, 403);
  const childId = crypto.randomUUID();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO submissions (id, code_hmac, status, kind, parent_id, round, created_at) VALUES (?, ?, 'open', 'addendum', ?, 0, ?)",
    ).bind(childId, hmac, id, new Date().toISOString()),
  ]);
  // The addendum continues the same source under the same access code, so
  // the consent decisions carry over to the child submission.
  await inheritConsent(c.env.DB, id, childId);
  return c.json({ id: childId, access_code: parsed.data.access_code }, 201);
});

intake.post("/:id/rounds", async (c) => {
  const app = await getState(c.env);
  const idOr = idOr404(c);
  if (typeof idOr !== "string") return idOr;
  const id = idOr;
  const parsed = RoundsBodySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_body" }, 422);
  const me = await submissionByCode(c, id, parsed.data.access_code);
  if (!me) return c.json({ error: "not_found" }, 404);
  if (me.status !== "open") {
    return c.json({ error: "submission_closed" }, 409);
  }
  // Rounds are bounded; on exhaustion the submission completes and the
  // pipeline retriggers on genuinely new ground (R4). The retrigger detail
  // is internal: returning it to an anonymous caller would leak which
  // topics other sources or the operator have already raised.
  if (me.round >= ROUNDS_MAX) {
    await completeAndRetrigger(c.env.DB, app.kit, c.env, id);
    return c.json({ questions: [], done: true });
  }
  const family = me.parent_id ? [id, me.parent_id] : [id];
  const placeholders = family.map(() => "?").join(",");
  const listed = await c.env.DB.prepare(
    `SELECT topic FROM topics WHERE submission_id IN (${placeholders})`,
  )
    .bind(...family)
    .all<{ topic: string }>();
  const rows = Array.isArray(listed) ? listed : listed.results;
  const covered = new Set(rows.map((r) => normaliseTopic(r.topic)));

  const client = await liveClient(c.env.DB, c.env);
  const result = await groundedQuestions(c.env.DB, client, covered, (t) =>
    recordTurn(c.env.DB, t),
  );
  if (result.questions.length === 0) {
    await completeAndRetrigger(c.env.DB, app.kit, c.env, id);
    return c.json({ questions: [], done: true });
  }
  await c.env.DB.prepare(
    "UPDATE submissions SET round = round + 1 WHERE id = ?",
  )
    .bind(id)
    .run();
  return c.json({ questions: result.questions });
});

// Consent coverage (operator-only): per category, per wording version, and
// every stored category without a grant behind it. The audit answer to
// "was sensitive information collected lawfully?".
intake.get("/consent/coverage", async (c) => {
  const denied = operatorDenied(c);
  if (denied) {
    return c.json(
      { error: denied === 404 ? "not_found" : "unauthorised" },
      denied,
    );
  }
  const app = await getState(c.env);
  return c.json(await consentCoverage(c.env.DB, app.kit));
});

export default intake;
