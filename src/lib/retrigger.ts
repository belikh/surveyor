// Automatic retrigger on new evidence (R4). Completion of a submission (or
// addendum) derives candidate topics, judges them against the
// investigation-level ledger, and queues grounded angles for genuinely new
// topics. The ledger is the idempotency backstop: settled ground never
// re-runs or rebills. All model output stays fenced (constitution III).

import type { Bindings } from "../env";
import { unwrap } from "./evidence";
import { judgeSignificance, normaliseTopic } from "./engine";
import { judgeSignificanceLive } from "./serve";
import { recordTurn } from "./telemetry";
import { liveClient } from "./providers";
import { proposeAndStoreAngles } from "./angles";
import type { VaultKit } from "./vault";

/** Hard per-event safety cap on newly opened research topics. */
export const RETRIGGER_CAP = 5;

export interface RetriggerResult {
  new_topics: string[];
  tier: string;
  angles_queued: number;
}

/**
 * Investigation ledger: topics already researched (angle proposal sets) plus
 * topics settled by *other* submissions. The completing submission's own
 * topics are excluded so its genuinely new ground surfaces.
 */
export async function investigationLedger(
  db: D1Database,
  excludeSubmissionId: string,
): Promise<Set<string>> {
  const settled = new Set<string>();
  const ang = await db
    .prepare("SELECT topics_json FROM angles")
    .all<{ topics_json: string }>();
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
  const others = await db
    .prepare("SELECT topic FROM topics WHERE submission_id != ?")
    .bind(excludeSubmissionId)
    .all<{ topic: string }>();
  for (const r of unwrap(others)) settled.add(normaliseTopic(r.topic));
  return settled;
}

/** Family topics: an addendum's candidates include its parent's. */
async function familyTopics(
  db: D1Database,
  submissionId: string,
): Promise<string[]> {
  const me = await db
    .prepare("SELECT parent_id FROM submissions WHERE id = ?")
    .bind(submissionId)
    .first<{ parent_id: string | null }>();
  const family = me?.parent_id ? [submissionId, me.parent_id] : [submissionId];
  const placeholders = family.map(() => "?").join(",");
  const rows = await db
    .prepare(
      `SELECT DISTINCT topic FROM topics WHERE submission_id IN (${placeholders})`,
    )
    .bind(...family)
    .all<{ topic: string }>();
  return [...new Set(unwrap(rows).map((r) => r.topic))];
}

/** Mark a submission complete (once) and retrigger on its new ground. */
export async function completeAndRetrigger(
  db: D1Database,
  kit: VaultKit,
  env: Bindings,
  submissionId: string,
): Promise<RetriggerResult> {
  const row = await db
    .prepare("SELECT status FROM submissions WHERE id = ?")
    .bind(submissionId)
    .first<{ status: string }>();
  if (row?.status === "complete") {
    // Already settled: no judge call, no re-bill.
    return { new_topics: [], tier: "already-complete", angles_queued: 0 };
  }
  await db
    .prepare("UPDATE submissions SET status = 'complete' WHERE id = ?")
    .bind(submissionId)
    .run();
  return retriggerOnCompletion(db, kit, env, submissionId);
}

export async function retriggerOnCompletion(
  db: D1Database,
  kit: VaultKit,
  env: Bindings,
  submissionId: string,
): Promise<RetriggerResult> {
  const candidates = (await familyTopics(db, submissionId)).slice(
    0,
    RETRIGGER_CAP,
  );
  if (candidates.length === 0) {
    return { new_topics: [], tier: "ledger-floor", angles_queued: 0 };
  }
  const ledger = await investigationLedger(db, submissionId);
  const floor = judgeSignificance(candidates, ledger).slice(0, RETRIGGER_CAP);
  let fresh = floor;
  let tier = "ledger-floor";
  const client = await liveClient(db, env);
  if (client && floor.length > 0) {
    const judged = await judgeSignificanceLive(client, floor, ledger, (t) =>
      recordTurn(db, t),
    );
    fresh = judged.topics;
    tier = judged.tier;
  }
  if (fresh.length === 0) {
    await recordTurn(db, {
      tier,
      toolCalls: 0,
      label: "retrigger",
      outcome: "no-new-topics",
    });
    return { new_topics: [], tier, angles_queued: 0 };
  }
  const result = await proposeAndStoreAngles(db, kit, fresh, {
    client,
    recordTurn: (t) => recordTurn(db, t),
  });
  await recordTurn(db, {
    tier: result.tier,
    toolCalls: 0,
    label: "retrigger",
    outcome: `queued:${result.angles.length}`,
  });
  return { new_topics: fresh, tier: result.tier, angles_queued: result.angles.length };
}
