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
  codeHmac,
  nameHmac,
  sealText,
  type VaultKit,
} from "../lib/vault";
import {
  AddendumBodySchema,
  CreateBodySchema,
  ResumeBodySchema,
  StepsBodySchema,
  quarantineText,
} from "../lib/intake";
import { groundedQuestions, ROUNDS_MAX } from "../lib/rounds";
import { completeAndRetrigger } from "../lib/retrigger";
import { recordTurn } from "../lib/telemetry";
import { liveClient } from "../lib/providers";
import {
  ATTACH_MAX_BYTES,
  ATTACH_TOTAL_BYTES,
  attachmentBytes,
  attachmentLane,
  drainAttachmentById,
} from "../lib/attachments";

type Env = { Bindings: Bindings };

export const intake = new Hono<{ Bindings: Bindings }>();

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
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO submissions (id, code_hmac, status, kind, parent_id, round, created_at) VALUES (?, ?, 'open', 'original', NULL, 0, ?)",
    ).bind(id, hmac, now),
  ]);
  return c.json({ id, access_code: code }, 201);
});

intake.post("/:id/steps", async (c) => {
  const app = await getState(c.env);
  const idOr = idOr404(c);
  if (typeof idOr !== "string") return idOr;
  const id = idOr;
  const parsed = StepsBodySchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_body" }, 422);
  const sub = await c.env.DB.prepare(
    "SELECT id FROM submissions WHERE id = ?",
  ).bind(id).first();
  if (!sub) return c.json({ error: "not_found" }, 404);

  const existing = await c.env.DB.prepare(
    "SELECT MAX(seq) AS maxSeq FROM messages WHERE submission_id = ?",
  ).bind(id).first<{ maxSeq: number | null }>();
  let seq = (existing?.maxSeq ?? -1) + 1;
  const batch: Array<{ sql: string; params?: unknown[] }> = [];
  for (const a of parsed.data.answers) {
    const { scrubbed, hits } = quarantineText(a.value);
    const envelope = await sealText(app.kit, scrubbed);
    batch.push({
      sql: "INSERT INTO messages (submission_id, seq, role, kind, body_envelope) VALUES (?, ?, 'submitter', 'structured', ?)",
      params: [id, seq++, envelope],
    });
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
      params: [id, a.topic],
    });
  }
  // FakeD1.batch takes prepared statements; real D1 too — build them here.
  await c.env.DB.batch(
    batch.map((b) => c.env.DB.prepare(b.sql).bind(...(b.params ?? []))),
  );
  return c.json({ saved: parsed.data.answers.length });
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
  const sub = await c.env.DB.prepare("SELECT id FROM submissions WHERE id = ?")
    .bind(id)
    .first();
  if (!sub) return c.json({ error: "not_found" }, 404);
  if (!c.env.CORPUS) return c.json({ error: "attachments_unavailable" }, 503);
  const filename = (c.req.query("filename") ?? "attachment").slice(0, 256);
  const mediaType = (c.req.query("media_type") ?? "application/octet-stream").slice(
    0,
    128,
  );
  if (attachmentLane(mediaType, filename) === "rejected") {
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
  const used = await attachmentBytes(c.env.DB, id);
  if (used + bytes.length > ATTACH_TOTAL_BYTES) {
    return c.json(
      { error: "quota_exceeded", detail: "200 MB per submission" },
      413,
    );
  }
  const attId = crypto.randomUUID();
  const key = `attachments/${id}/${attId}`;
  await c.env.CORPUS.put(key, bytes);
  await c.env.DB.prepare(
    "INSERT INTO attachments (id, submission_id, filename, media_type, size_bytes, status, raw_key, reason, retry_after, created_at) VALUES (?, ?, ?, ?, ?, 'uploaded', ?, NULL, NULL, ?)",
  )
    .bind(
      attId,
      id,
      await sealText(app.kit, filename),
      mediaType,
      bytes.length,
      key,
      new Date().toISOString(),
    )
    .run();
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
  return c.json({ id: childId, access_code: parsed.data.access_code }, 201);
});

intake.post("/:id/rounds", async (c) => {
  const app = await getState(c.env);
  const idOr = idOr404(c);
  if (typeof idOr !== "string") return idOr;
  const id = idOr;
  const me = await c.env.DB.prepare(
    "SELECT id, round, parent_id FROM submissions WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; round: number; parent_id: string | null }>();
  if (!me) return c.json({ error: "not_found" }, 404);
  // Rounds are bounded; on exhaustion the submission completes and the
  // pipeline retriggers on genuinely new ground (R4).
  if (me.round >= ROUNDS_MAX) {
    const retrigger = await completeAndRetrigger(c.env.DB, app.kit, c.env, id);
    return c.json({ questions: [], done: true, retrigger });
  }
  const family = me.parent_id ? [id, me.parent_id] : [id];
  const placeholders = family.map(() => "?").join(",");
  const listed = await c.env.DB.prepare(
    `SELECT topic FROM topics WHERE submission_id IN (${placeholders})`,
  )
    .bind(...family)
    .all<{ topic: string }>();
  const rows = Array.isArray(listed) ? listed : listed.results;
  const covered = new Set(rows.map((r) => r.topic));

  const client = await liveClient(c.env.DB, c.env);
  const result = await groundedQuestions(c.env.DB, client, covered, (t) =>
    recordTurn(c.env.DB, t),
  );
  if (result.questions.length === 0) {
    const retrigger = await completeAndRetrigger(c.env.DB, app.kit, c.env, id);
    return c.json({ questions: [], done: true, retrigger });
  }
  await c.env.DB.prepare(
    "UPDATE submissions SET round = round + 1 WHERE id = ?",
  )
    .bind(id)
    .run();
  return c.json({ questions: result.questions });
});

export default intake;
