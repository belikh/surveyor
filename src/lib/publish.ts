// Shared publish path: one code path for the operator endpoint and the
// scheduler. Stored config only — publish can never smuggle gates.

import { z } from "zod";
import type { VaultKit } from "./vault";
import { sealText } from "./vault";
import {
  GateConfigSchema,
  RENDERERS,
  evaluateGates,
  type GateConfig,
} from "./reports";
import { gatherEvidence } from "./evidence";
import { injectionFlags } from "./engine";
import { runJournalistPass } from "./pass";
import { recordTurn } from "./telemetry";
import type { ModelClient } from "./serve";

export type ReportType =
  | "briefing"
  | "dossier"
  | "timeline"
  | "snapshot"
  | "longform";

export interface ReportRow {
  type: string;
  config: GateConfig;
  status: string;
  enabled: boolean;
  corroborations: number;
  pending_topics: string[];
  current_version: number;
  sched_last_count: number;
  sched_total: number;
  approved_at: string | null;
}

export class GatesUnmet extends Error {
  constructor(public readonly unmet: string[]) {
    super(`gates unmet: ${unmet.join(", ")}`);
    this.name = "GatesUnmet";
  }
}

export class ReportDisabled extends Error {
  constructor() {
    super("report disabled");
    this.name = "ReportDisabled";
  }
}

function toReportRow(row: Record<string, string | number | null>): ReportRow {
  // Stored config is operator input: parse, never cast.
  const config = GateConfigSchema.parse(JSON.parse(String(row.config_json)));
  let pending: unknown = [];
  try {
    pending = JSON.parse(String(row.pending_topics_json ?? "[]"));
  } catch {
    pending = [];
  }
  return {
    type: String(row.type),
    config,
    status: String(row.status),
    enabled: Number(row.enabled ?? 1) === 1,
    corroborations: Number(row.corroborations ?? 0),
    sched_last_count: Number(row.sched_last_count ?? 0),
    sched_total: Number(row.sched_total ?? 0),
    pending_topics: Array.isArray(pending)
      ? pending.filter((t): t is string => typeof t === "string")
      : [],
    current_version: Number(row.current_version ?? 0),
    approved_at: row.approved_at === null ? null : String(row.approved_at),
  };
}

export async function reportRow(
  db: D1Database,
  type: string,
): Promise<ReportRow> {
  const row = await db
    .prepare("SELECT * FROM reports WHERE type = ?")
    .bind(type)
    .first<Record<string, string | number | null>>();
  if (row) return toReportRow(row);
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO reports (type, config_json, status, enabled, corroborations, pending_topics_json, current_version, sched_last_count, sched_total, approved_at, updated_at) VALUES (?, ?, 'draft', 1, 0, '[]', 0, 0, 0, NULL, ?)",
    )
    .bind(type, JSON.stringify({}), now)
    .run();
  return toReportRow({
    type,
    config_json: "{}",
    status: "draft",
    enabled: 1,
    corroborations: 0,
    pending_topics_json: "[]",
    current_version: 0,
    sched_last_count: 0,
    sched_total: 0,
    approved_at: null,
  });
}

export async function publishReportVersion(
  db: D1Database,
  kit: VaultKit,
  type: ReportType,
  banner?: string,
  client?: ModelClient | null,
): Promise<{ version: number }> {
  const row = await reportRow(db, type);
  if (!row.enabled) throw new ReportDisabled();
  const evidence = await gatherEvidence(db, row.corroborations);
  const verdict = evaluateGates(row.config, evidence);
  if (!verdict.ok) throw new GatesUnmet(verdict.unmet);

  const deterministic = RENDERERS[type](evidence);
  let body = deterministic.body;
  if (client) {
    // Journalist pass (R7): model prose when a provider is configured; the
    // deterministic render is the fallback. Publish strips uncited claims
    // unless the operator approved them.
    const pass = await runJournalistPass(
      db,
      kit,
      type,
      client,
      evidence,
      !row.config.allow_uncited,
    );
    // The model-authored prose is untrusted output: it gets the same
    // injection review as line findings before it can reach a version. A
    // flagged swap falls back to the deterministic body, which is built
    // only from gated content.
    const modelText =
      pass && (type === "snapshot" ? pass.lead : pass.body)?.trim();
    if (modelText && injectionFlags(modelText).length > 0) {
      await recordTurn(db, {
        tier: pass.tier,
        toolCalls: 0,
        label: "journalist-pass:held",
        outcome: "injection-marker",
      });
    } else if (pass && type === "snapshot" && pass.lead) {
      body = injectLead(deterministic.body, pass.lead);
    } else if (pass?.body) {
      body = pass.body;
    }
  }
  const withBanner = banner ? `${banner}\n\n${body}` : body;

  // Allocate the version atomically: two concurrent publishes computing
  // current_version + 1 from the same read both wrote the same number.
  const bumped = await db
    .prepare(
      "UPDATE reports SET current_version = current_version + 1 WHERE type = ? AND enabled = 1 RETURNING current_version",
    )
    .bind(type)
    .first<{ current_version: number }>();
  if (!bumped) throw new ReportDisabled();
  const version = Number(bumped.current_version);
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        "INSERT INTO report_versions (id, type, version, body_envelope, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(crypto.randomUUID(), type, version, await sealText(kit, withBanner), now),
    db
      .prepare(
        "UPDATE reports SET status = 'published', pending_topics_json = '[]', updated_at = ? WHERE type = ?",
      )
      .bind(now, type),
  ]);
  return { version };
}

/** Put the snapshot's model-written lead under the title. */
function injectLead(statsBody: string, lead: string): string {
  const nl = statsBody.indexOf("\n");
  if (nl === -1) return `${statsBody}\n\n${lead}`;
  return `${statsBody.slice(0, nl)}\n\n${lead}\n${statsBody.slice(nl)}`;
}

// Re-export the row type guard for routes that list versions.
export const ReportVersionSchema = z.object({
  version: z.number(),
  created_at: z.string(),
});
