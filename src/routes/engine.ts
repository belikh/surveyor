// Engine routes: angle proposal grounded in the sealed mirror,
// operator-visible queue with approve gates, research lines with spend
// caps and citation requirements, ledger-backed retrigger, flag-and-gate
// poisoning posture. Operator-gated throughout; findings stay fenced.

import { Hono } from "hono";
import { z } from "zod";
import type { Bindings } from "../env";
import { getState } from "../state";
import { judgeSignificance, normaliseTopic } from "../lib/engine";
import { judgeSignificanceLive } from "../lib/serve";
import { recordTurn } from "../lib/telemetry";
import { liveClient } from "../lib/providers";
import { proposeAndStoreAngles } from "../lib/angles";
import { finishLine } from "../lib/research";

export const engine = new Hono<{ Bindings: Bindings }>();

/** Normalise the two D1 `.all()` shapes (real D1 vs test facade). */
function unwrap<T>(rows: T[] | { results: T[] }): T[] {
  return Array.isArray(rows) ? rows : rows.results;
}

const ExhibitSchema = z.object({
  doc_id: z.string().min(1).max(128),
  snippet: z.string().min(1).max(2000),
});

const ProposeSchema = z.object({
  topics: z.array(z.string().min(1).max(64)).min(1).max(32),
  mode: z.enum(["floor", "live"]).default("floor"),
});

const LineSchema = z.object({
  angle_id: z.string().uuid().max(64),
  spend_cap: z.number().int().min(1).max(1_000_000),
});

const CitationSchema = z.object({
  doc_id: z.string().min(1).max(128),
  snippet: z.string().min(1).max(2000),
});

const CompleteSchema = z.object({
  citations: z.array(CitationSchema).max(64),
  findings: z.string().max(50_000),
});

const RetriggerSchema = z.object({
  topics: z.array(z.string().min(1).max(64)).min(1).max(64),
  mode: z.enum(["floor", "live"]).default("floor"),
});

const UuidParam = z.string().uuid().max(64);

engine.post("/angles/propose", async (c) => {
  const app = await getState(c.env);
  const parsed = ProposeSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_body" }, 422);
  // Ledger first: the topic sets the investigation has actually researched.
  // The serving-time LLM judge may only narrow this set, never widen it.
  const settled = await ledgerTopics(c.env.DB);
  const fresh = judgeSignificance(parsed.data.topics, settled);
  const droppedTopics = parsed.data.topics
    .filter((t) => !fresh.includes(t))
    .map((t) => ({ topic: t, reason: "settled" }));
  let client: Awaited<ReturnType<typeof liveClient>> = null;
  if (parsed.data.mode === "live") {
    client = await liveClient(c.env.DB, c.env);
    if (!client) {
      await recordTurn(c.env.DB, {
        tier: "extractive",
        toolCalls: 0,
        label: "angles-live",
      });
    }
  }
  const result = await proposeAndStoreAngles(c.env.DB, app.kit, fresh, {
    client,
    recordTurn: (t) => recordTurn(c.env.DB, t),
  });
  return c.json({ ...result, dropped_topics: droppedTopics });
});

engine.get("/angles", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT id, title, exhibits_json, flags_json, rank, status, created_at FROM angles ORDER BY rank ASC",
  ).all<{ id: string; title: string; exhibits_json: string; flags_json: string | null; rank: number; status: string; created_at: string }>();
  const list = unwrap(rows);
  return c.json({
    angles: list.map((a) => {
      const flags = z.array(z.string()).parse(JSON.parse(a.flags_json ?? "[]"));
      return {
        ...a,
        exhibits: z.array(ExhibitSchema).parse(JSON.parse(a.exhibits_json)),
        exhibits_json: undefined,
        flags_json: undefined,
        // A flagged heading reads as held: it is reviewable and cannot be
        // approved until the flags are explicitly cleared.
        status: flags.length > 0 ? "held" : a.status,
        flags,
        provenance: "untrusted",
      };
    }),
  });
});

engine.post("/angles/:id/approve", async (c) => {
  const id = UuidParam.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const row = await c.env.DB.prepare(
    "SELECT id, status, flags_json FROM angles WHERE id = ?",
  ).bind(id.data).first<{ id: string; status: string; flags_json: string | null }>();
  if (!row) return c.json({ error: "not_found" }, 404);
  if (row.status !== "queued") {
    return c.json({ error: "bad_state", detail: row.status }, 409);
  }
  const flags = z.array(z.string()).parse(JSON.parse(row.flags_json ?? "[]"));
  if (flags.length > 0) {
    return c.json({ error: "needs_review", flags }, 409);
  }
  await c.env.DB.prepare(
    "UPDATE angles SET status = 'approved' WHERE id = ?",
  ).bind(id.data).run();
  return c.json({ id: id.data, status: "approved" });
});

const AngleReviewSchema = z.object({
  decision: z.enum(["approve", "reject"]),
});

// Held-angle review: approving clears the flags so the angle can be
// approved through the normal gate; rejecting removes it from the queue.
engine.post("/angles/:id/review", async (c) => {
  const id = UuidParam.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const parsed = AngleReviewSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_body" }, 422);
  const row = await c.env.DB.prepare(
    "SELECT id, status, flags_json FROM angles WHERE id = ?",
  ).bind(id.data).first<{ id: string; status: string; flags_json: string | null }>();
  if (!row) return c.json({ error: "not_found" }, 404);
  const flags = z.array(z.string()).parse(JSON.parse(row.flags_json ?? "[]"));
  if (row.status !== "queued" || flags.length === 0) {
    return c.json({ error: "bad_state", detail: row.status }, 409);
  }
  if (parsed.data.decision === "reject") {
    await c.env.DB.prepare("UPDATE angles SET status = 'rejected' WHERE id = ?")
      .bind(id.data)
      .run();
    return c.json({ id: id.data, status: "rejected", flags: [] });
  }
  await c.env.DB.prepare("UPDATE angles SET flags_json = '[]' WHERE id = ?")
    .bind(id.data)
    .run();
  return c.json({ id: id.data, status: "queued", flags: [] });
});

engine.post("/lines", async (c) => {
  const parsed = LineSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_body" }, 422);
  const angle = await c.env.DB.prepare(
    "SELECT id, status FROM angles WHERE id = ?",
  ).bind(parsed.data.angle_id).first<{ id: string; status: string }>();
  if (!angle) return c.json({ error: "not_found" }, 404);
  // Lines open only on approved angles: no spend before review.
  if (angle.status !== "approved") {
    return c.json({ error: "angle_not_approved" }, 409);
  }
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO research_lines (id, angle_id, status, spend_cap, spend_used, created_at) VALUES (?, ?, 'running', ?, 0, ?)",
  ).bind(id, angle.id, parsed.data.spend_cap, new Date().toISOString()).run();
  // Kick the staged pipeline: the Workflow owns long-running research
  // steps. Without the binding (tests/local) the line still exists and
  // completes through the inline path.
  let workflow_id: string | null = null;
  if (c.env.ENGINE) {
    try {
      const inst = await c.env.ENGINE.create({
        params: { line_id: id, angle_id: angle.id },
      });
      workflow_id = inst.id;
    } catch {
      workflow_id = null;
    }
  }
  return c.json({ id, status: "running", workflow_id });
});

engine.post("/lines/:id/complete", async (c) => {
  const app = await getState(c.env);
  const id = UuidParam.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const parsed = CompleteSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_body" }, 422);
  // Citations are the price of completion: none, no completion — and
  // every cited doc must exist in the mirror.
  const result = await finishLine(c.env.DB, app.kit, id.data, parsed.data);
  if (!result.ok) {
    const status = (
      result.error === "not_found"
        ? 404
        : result.error === "bad_state" || result.error === "over_cap"
          ? 409
          : 422
    ) as 404 | 409 | 422;
    return result.detail === undefined
      ? c.json({ error: result.error }, status)
      : c.json({ error: result.error, detail: result.detail }, status);
  }
  return c.json({ id: result.id, status: result.status, flags: result.flags });
});

async function ledgerTopics(db: D1Database): Promise<Set<string>> {
  // Settled ground is the investigation's own researched ground: the
  // canonical topic sets of stored angles. Raw submitter topics are
  // deliberately NOT unioned here — anyone can mint a PoW submission, so
  // treating client-supplied strings as settlement would let an anonymous
  // visitor veto operator research.
  const ang = await db.prepare("SELECT topics_json FROM angles").all<{
    topics_json: string;
  }>();
  const settled = new Set<string>();
  for (const a of unwrap(ang)) {
    try {
      const ts = JSON.parse(a.topics_json) as unknown;
      if (Array.isArray(ts)) {
        for (const t of ts) {
          if (typeof t === "string") settled.add(normaliseTopic(t));
        }
      }
    } catch {
      // Corrupt row: fail open on that row only, never on the ledger.
    }
  }
  return settled;
}

const SpendSchema = z.object({
  amount: z.number().int().min(1).max(1_000_000),
});

engine.post("/lines/:id/spend", async (c) => {
  const id = UuidParam.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const parsed = SpendSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_body" }, 422);
  const amount = parsed.data.amount;
  // Atomic conditional increment: a read-then-write lets concurrent requests
  // all pass the cap check and last-writer-wins under-records the total.
  const res = await c.env.DB.prepare(
    "UPDATE research_lines SET spend_used = spend_used + ? WHERE id = ? AND status = 'running' AND spend_used + ? <= spend_cap",
  )
    .bind(amount, id.data, amount)
    .run();
  if (res.meta.changes === 0) {
    // Not applied: read once to name the reason.
    const line = await c.env.DB.prepare(
      "SELECT id, status, spend_cap, spend_used FROM research_lines WHERE id = ?",
    ).bind(id.data).first<{
      id: string;
      status: string;
      spend_cap: number;
      spend_used: number;
    }>();
    if (!line) return c.json({ error: "not_found" }, 404);
    if (line.status !== "running") {
      return c.json({ error: "bad_state", detail: line.status }, 409);
    }
    return c.json({ error: "over_cap" }, 409);
  }
  const updated = await c.env.DB.prepare(
    "SELECT spend_used FROM research_lines WHERE id = ?",
  ).bind(id.data).first<{ spend_used: number }>();
  return c.json({ id: id.data, spend_used: updated?.spend_used ?? amount });
});

const ReviewSchema = z.object({
  decision: z.enum(["approve", "reject"]),
});

engine.post("/lines/:id/review", async (c) => {
  const id = UuidParam.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const parsed = ReviewSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_body" }, 422);
  const line = await c.env.DB.prepare(
    "SELECT id, status FROM research_lines WHERE id = ?",
  ).bind(id.data).first<{ id: string; status: string }>();
  if (!line) return c.json({ error: "not_found" }, 404);
  // Only held lines need review; approved lines complete with their flags
  // retained, rejected lines leave the downstream set.
  if (line.status !== "held") {
    return c.json({ error: "bad_state", detail: line.status }, 409);
  }
  const next = parsed.data.decision === "approve" ? "complete" : "rejected";
  await c.env.DB.prepare(
    "UPDATE research_lines SET status = ? WHERE id = ?",
  ).bind(next, id.data).run();
  return c.json({ id: id.data, status: next });
});

engine.get("/lines/:id", async (c) => {
  const id = UuidParam.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const line = await c.env.DB.prepare(
    "SELECT id, angle_id, status, spend_cap, spend_used, citations_json, flags_json, created_at FROM research_lines WHERE id = ?",
  ).bind(id.data).first<Record<string, string | number>>();
  if (!line) return c.json({ error: "not_found" }, 404);
  // Findings stay sealed; every read carries the provenance fence marker.
  return c.json({
    ...line,
    citations: z.array(CitationSchema).parse(JSON.parse(String(line.citations_json))),
    citations_json: undefined,
    provenance: "untrusted",
  });
});

engine.post("/retrigger", async (c) => {
  const parsed = RetriggerSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_body" }, 422);
  const ledger = await ledgerTopics(c.env.DB);
  if (parsed.data.mode === "floor") {
    return c.json({ new_topics: judgeSignificance(parsed.data.topics, ledger), tier: "ledger-floor" });
  }
  const client = await liveClient(c.env.DB, c.env);
  if (!client) {
    await recordTurn(c.env.DB, {
      tier: "ledger-floor",
      toolCalls: 0,
      label: "judge-live",
    });
    return c.json({ new_topics: judgeSignificance(parsed.data.topics, ledger), tier: "ledger-floor" });
  }
  const live = await judgeSignificanceLive(
    client,
    parsed.data.topics,
    ledger,
    (t) => recordTurn(c.env.DB, t),
  );
  return c.json({ new_topics: live.topics, tier: live.tier });
});

export default engine;
