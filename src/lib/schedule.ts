// Frequency scheduler domain: pure due-checks over stored report policy.
// Manual never fires; scheduled fires past cadence; per-n fires at
// threshold; full-dynamic fires on any change and always carries the
// danger marking (poisoning posture: its renders stay flag-and-gated).

import type { VaultKit } from "./vault";
import { publishReportVersion, reportRow, GatesUnmet, ReportDisabled } from "./publish";
import { LegalGateUnmet } from "./legal";
import { unwrap } from "./evidence";
import type { ModelClient } from "./serve";

/** Default digest cadence: daily. */
export const DEFAULT_CADENCE_MS = 24 * 60 * 60 * 1000;

export type Frequency = "manual" | "scheduled" | "per-n" | "full-dynamic";

export interface ReportPolicy {
  type: string;
  frequency: Frequency;
  last_rendered_at: string | null;
  last_count: number;
  cadence_ms: number;
  threshold_n: number;
}

export interface ReportStats {
  submissions: number;
}

export interface DueVerdict {
  due: boolean;
  reason: string;
  /** True only for full-dynamic: the receipt must record the danger. */
  danger: boolean;
}

export function dueCheck(
  policy: ReportPolicy,
  stats: ReportStats,
  nowIso: string,
): DueVerdict {
  const now = Date.parse(nowIso);
  switch (policy.frequency) {
    case "manual":
      return { due: false, reason: "manual frequency never auto-fires", danger: false };
    case "scheduled": {
      const last = policy.last_rendered_at
        ? Date.parse(policy.last_rendered_at)
        : 0;
      if (now - last >= policy.cadence_ms) {
        return { due: true, reason: "cadence lapsed", danger: false };
      }
      return { due: false, reason: "within cadence", danger: false };
    }
    case "per-n":
      if (stats.submissions - policy.last_count >= policy.threshold_n) {
        return {
          due: true,
          reason: `threshold reached (+${stats.submissions - policy.last_count})`,
          danger: false,
        };
      }
      return { due: false, reason: "below threshold", danger: false };
    case "full-dynamic":
      if (stats.submissions !== policy.last_count) {
        return {
          due: true,
          reason: "new evidence since last render",
          danger: true,
        };
      }
      return { due: false, reason: "no change", danger: false };
  }
}

export interface EvalReceipt {
  type: string;
  action: "rendered" | "skipped";
  reason: string;
  danger: boolean;
  at: string;
}

const REPORT_TYPES = ["briefing", "dossier", "timeline", "snapshot", "longform"] as const;

export const FULL_DYNAMIC_BANNER =
  "> Automatically rendered on new evidence — review before sharing.";

/**
 * Evaluate every stored report row against its frequency policy and
 * render what is due through the shared publish path (gates still apply:
 * a due report with unmet gates is skipped, never forced). Every
 * evaluation writes a receipt — including rows with nothing published
 * yet and disabled rows.
 */
export async function evaluateAll(
  db: D1Database,
  kit: VaultKit,
  nowIso: string,
  client?: ModelClient | null,
): Promise<EvalReceipt[]> {
  const rows = unwrap(
    await db
      .prepare("SELECT type, config_json FROM reports")
      .all<{ type: string; config_json: string }>(),
  );
  const sub = await db
    .prepare("SELECT COUNT(*) AS n FROM submissions")
    .first<{ n: number }>();
  const docs = await db
    .prepare("SELECT COUNT(*) AS n FROM corpus_docs")
    .first<{ n: number }>();
  const lin = await db
    .prepare("SELECT COUNT(*) AS n FROM research_lines WHERE status = 'complete'")
    .first<{ n: number }>();
  const total = (sub?.n ?? 0) + (docs?.n ?? 0) + (lin?.n ?? 0);
  const submissions = sub?.n ?? 0;
  const receipts: EvalReceipt[] = [];
  for (const r of rows) {
    if (!(REPORT_TYPES as readonly string[]).includes(r.type)) continue;
    const row = await reportRow(db, r.type);
    if (!row.enabled) {
      receipts.push(await recordReceipt(db, r.type, "skipped", "disabled", false, nowIso));
      continue;
    }
    if (row.current_version === 0) {
      receipts.push(await recordReceipt(db, r.type, "skipped", "never published", false, nowIso));
      continue;
    }
    const ver = await db
      .prepare(
        "SELECT created_at FROM report_versions WHERE type = ? AND version = ?",
      )
      .bind(r.type, row.current_version)
      .first<{ created_at: string }>();
    const dynamic = row.config.frequency === "full-dynamic";
    const observed = dynamic ? total : submissions;
    const baseline = dynamic ? row.sched_total : row.sched_last_count;
    const withBaseline = dueCheck(
      {
        type: r.type,
        frequency: row.config.frequency,
        last_rendered_at: ver?.created_at ?? null,
        last_count: baseline,
        cadence_ms: row.config.cadence_ms,
        threshold_n: row.config.threshold_n,
      },
      // Full-dynamic watches the whole evidence surface (submissions of
      // any kind, corpus uploads, completed lines); per-n watches
      // submissions only.
      { submissions: observed },
      nowIso,
    );
    if (!withBaseline.due) {
      receipts.push(await recordReceipt(db, r.type, "skipped", withBaseline.reason, false, nowIso));
      continue;
    }
    try {
      await publishReportVersion(
        db,
        kit,
        r.type as (typeof REPORT_TYPES)[number],
        withBaseline.danger ? FULL_DYNAMIC_BANNER : undefined,
        client,
      );
      await db
        .prepare("UPDATE reports SET sched_last_count = ?, sched_total = ? WHERE type = ?")
        .bind(submissions, total, r.type)
        .run();
      receipts.push(await recordReceipt(db, r.type, "rendered", withBaseline.reason, withBaseline.danger, nowIso));
    } catch (err) {
      const reason =
        err instanceof GatesUnmet
          ? `gates unmet: ${err.unmet.join(", ")}`
          : err instanceof LegalGateUnmet
            ? `legal gate unmet: ${err.unmet.join(", ")}`
            : err instanceof ReportDisabled
              ? "disabled"
              : String((err as Error)?.message ?? err);
      receipts.push(await recordReceipt(db, r.type, "skipped", reason, withBaseline.danger, nowIso));
    }
  }
  return receipts;
}

async function recordReceipt(
  db: D1Database,
  type: string,
  action: "rendered" | "skipped",
  reason: string,
  danger: boolean,
  at: string,
): Promise<EvalReceipt> {
  await db
    .prepare(
      "INSERT INTO eval_receipts (id, type, at, action, reason, danger) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(crypto.randomUUID(), type, at, action, reason, danger ? 1 : 0)
    .run();
  return { type, action, reason, danger, at };
}
