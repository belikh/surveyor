// Report routes: five types from one evidence bundle, manual-first
// gates with opt-in automatics, append-only versioned history. Published
// reads are public; everything mutating is operator-gated.

import { Hono } from "hono";
import { z } from "zod";
import type { Bindings } from "../env";
import { getState } from "../state";
import { openText, sealText } from "../lib/vault";
import {
  GateConfigSchema,
  RENDERERS,
  type GateConfig,
} from "../lib/reports";
import { gatherEvidence } from "../lib/evidence";
import { liveClient } from "../lib/providers";
import {
  reportRow,
  publishReportVersion,
  GatesUnmet,
  ReportDisabled,
} from "../lib/publish";
import {
  LegalGateUnmet,
  LegalReviewBodySchema,
  ReplyAttemptBodySchema,
  listLegalSurface,
  pendingVersion,
  recordLegalReview,
  recordReplyAttempt,
} from "../lib/legal";

export const reports = new Hono<{ Bindings: Bindings }>();

const TypeParam = z.enum(["briefing", "dossier", "timeline", "snapshot", "longform"]);

function reportType(c: { req: { param(name: string): string }; json: (o: unknown, s: number) => Response }) {
  const t = TypeParam.safeParse(c.req.param("type"));
  if (!t.success) return null;
  return t.data;
}

function notFound(c: { json: (o: unknown, s: number) => Response }) {
  return c.json({ error: "not_found" }, 404);
}

reports.get("/:type", async (c) => {
  const app = await getState(c.env);
  const t = reportType(c);
  if (!t) return notFound(c);
  const row = await reportRow(c.env.DB, t);
  if (!row.enabled || row.current_version === 0) {
    return c.json({ error: "not_found", status: "draft" }, 404);
  }
  const ver = await c.env.DB.prepare(
    "SELECT version, body_envelope, created_at FROM report_versions WHERE type = ? AND version = ?",
  )
    .bind(t, row.current_version)
    .first<{ version: number; body_envelope: string; created_at: string }>();
  if (!ver) return c.json({ error: "not_found" }, 404);
  return c.json({
    type: t,
    version: ver.version,
    body: await openText(app.kit, ver.body_envelope),
    provenance: "untrusted",
    created_at: ver.created_at,
  });
});

reports.get("/:type/versions", async (c) => {
  const t = reportType(c);
  if (!t) return notFound(c);
  const rows = await c.env.DB.prepare(
    "SELECT version, created_at FROM report_versions WHERE type = ? ORDER BY version ASC",
  ).bind(t).all<{ version: number; created_at: string }>();
  const list = Array.isArray(rows) ? rows : rows.results;
  return c.json({ versions: list });
});

reports.get("/:type/draft", async (c) => {
  const t = reportType(c);
  if (!t) return notFound(c);
  const evidence = await gatherEvidence(c.env.DB);
  const doc = RENDERERS[t](evidence);
  return c.json({ ...doc, version: "draft" });
});

// Gate configuration lives here — never in the publish call itself, so a
// publish can never self-authorise by smuggling config in-request.
const ConfigBodySchema = z.object({
  config: GateConfigSchema.partial(),
  enabled: z.boolean().optional(),
});

reports.post("/:type/config", async (c) => {
  const t = reportType(c);
  if (!t) return notFound(c);
  const parsed = ConfigBodySchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_body" }, 422);
  const row = await reportRow(c.env.DB, t);
  const merged = GateConfigSchema.parse({ ...row.config, ...parsed.data.config });
  await c.env.DB.prepare(
    "UPDATE reports SET config_json = ?, enabled = ?, updated_at = ? WHERE type = ?",
  )
    .bind(
      JSON.stringify(merged),
      parsed.data.enabled ?? row.enabled ? 1 : 0,
      new Date().toISOString(),
      t,
    )
    .run();
  return c.json({ type: t, config: merged });
});

reports.post("/:type/approve", async (c) => {
  const t = reportType(c);
  if (!t) return notFound(c);
  const now = new Date().toISOString();
  const row = await reportRow(c.env.DB, t);
  const cfg = { ...row.config, approved: true };
  await c.env.DB.prepare(
    "UPDATE reports SET config_json = ?, approved_at = ?, updated_at = ? WHERE type = ?",
  ).bind(JSON.stringify(cfg), now, now, t).run();
  return c.json({ type: t, approved_at: now });
});

reports.post("/:type/publish", async (c) => {
  const app = await getState(c.env);
  const t = reportType(c);
  if (!t) return notFound(c);
  try {
    const client = await liveClient(c.env.DB, c.env);
    const { version } = await publishReportVersion(
      c.env.DB,
      app.kit,
      t,
      undefined,
      client,
    );
    return c.json({ type: t, version });
  } catch (err) {
    if (err instanceof GatesUnmet) {
      return c.json({ error: "gates_unmet", unmet: err.unmet }, 409);
    }
    if (err instanceof LegalGateUnmet) {
      return c.json({ error: "legal_gate_unmet", unmet: err.unmet }, 409);
    }
    if (err instanceof ReportDisabled) {
      return c.json({ error: "disabled" }, 409);
    }
    throw err;
  }
});

// The legal gate's two recorded parts, each tied to the pending version:
// the review itself, and the right-of-reply attempts (or the operator's
// explicit decision that no reply is required).
reports.post("/:type/legal", async (c) => {
  const app = await getState(c.env);
  const t = reportType(c);
  if (!t) return notFound(c);
  const parsed = LegalReviewBodySchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_body" }, 422);
  const row = await reportRow(c.env.DB, t);
  const recorded = await recordLegalReview(
    c.env.DB,
    app.kit,
    t,
    pendingVersion(row.current_version),
    parsed.data,
  );
  await app.audit("reports:legal-review-recorded");
  return c.json(recorded, 201);
});

reports.get("/:type/legal", async (c) => {
  const app = await getState(c.env);
  const t = reportType(c);
  if (!t) return notFound(c);
  const row = await reportRow(c.env.DB, t);
  const surface = await listLegalSurface(c.env.DB, app.kit, t);
  return c.json({
    type: t,
    pending_version: pendingVersion(row.current_version),
    ...surface,
  });
});

reports.post("/:type/reply", async (c) => {
  const app = await getState(c.env);
  const t = reportType(c);
  if (!t) return notFound(c);
  const parsed = ReplyAttemptBodySchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_body" }, 422);
  const row = await reportRow(c.env.DB, t);
  const recorded = await recordReplyAttempt(
    c.env.DB,
    app.kit,
    t,
    pendingVersion(row.current_version),
    parsed.data,
  );
  await app.audit("reports:right-of-reply-logged");
  return c.json(recorded, 201);
});

export default reports;
