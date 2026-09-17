// Angle proposal + storage, shared by the operator propose route and the
// automatic retrigger path. Grounding is structural: exhibit-free angles are
// dropped by the proposers, and every stored angle is fenced (untrusted).

import { MIRRORED_SQL } from "./mirror";
import { unwrap } from "./evidence";
import {
  flagSuspicious,
  normaliseTopic,
  proposeAngles,
  rankAngles,
} from "./engine";
import { proposeAnglesLive, type ModelClient, type Turn } from "./serve";
import { openText, sealText, type VaultKit } from "./vault";

export interface StoredAngle {
  id: string;
  title: string;
  exhibits: unknown;
  status: string;
}

export interface ProposeResult {
  angles: StoredAngle[];
  tier: string;
  dropped: number;
}

/** Propose ranked, grounded angles for `topics` and store them queued. */
export async function proposeAndStoreAngles(
  db: D1Database,
  kit: VaultKit,
  topics: string[],
  opts: {
    client: ModelClient | null;
    recordTurn: (t: Turn) => Promise<void>;
  },
): Promise<ProposeResult> {
  // Open the sealed mirror text for settled docs only; held lanes have no
  // text yet and contribute nothing.
  const rows = await db
    .prepare(
      `SELECT id, text_envelope FROM corpus_docs WHERE ${MIRRORED_SQL}`,
    )
    .all<{ id: string; text_envelope: string }>();
  const docs = await Promise.all(
    unwrap(rows).map(async (d) => ({
      doc_id: d.id,
      text: await openText(kit, d.text_envelope),
    })),
  );

  let ranked = rankAngles(proposeAngles(docs, topics));
  let tier = "extractive";
  let dropped = 0;
  if (opts.client) {
    const live = await proposeAnglesLive(
      opts.client,
      docs,
      topics,
      opts.recordTurn,
    );
    ranked = live.angles;
    tier = live.tier;
    dropped = live.dropped;
  }

  const now = new Date().toISOString();
  const stored: StoredAngle[] = [];
  const canonicalTopics = topics.map(normaliseTopic);
  const insertedTopics = new Set<string>();
  // Re-derive settled ground immediately before each insert: two concurrent
  // proposes (or a propose racing a retrigger) can both pass the ledger
  // check, and without this the same canonical topic would be stored twice
  // and billed twice.
  const settledNow = async (): Promise<Set<string>> => {
    const rows = await db
      .prepare("SELECT topics_json FROM angles")
      .all<{ topics_json: string }>();
    const settled = new Set<string>();
    for (const row of unwrap(rows)) {
      try {
        const ts = JSON.parse(row.topics_json) as unknown;
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
  };
  let skipped = 0;
  for (let i = 0; i < ranked.length; i++) {
    const a = ranked[i];
    const settled = await settledNow();
    const duplicate =
      canonicalTopics.length > 0 &&
      canonicalTopics.every(
        (t) => settled.has(t) && !insertedTopics.has(t),
      );
    if (duplicate) {
      skipped++;
      continue;
    }
    // Suspicion review applies to the heading itself, exactly as it does on
    // the research-line completion path: the title carries the (untrusted)
    // topic wording into the published report.
    const flags = flagSuspicious(a.title, a.exhibits);
    const id = crypto.randomUUID();
    await db
      .prepare(
        "INSERT INTO angles (id, title, topics_json, rationale_envelope, exhibits_json, rank, status, flags_json, created_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)",
      )
      .bind(
        id,
        a.title,
        JSON.stringify(canonicalTopics),
        await sealText(kit, a.rationale),
        JSON.stringify(a.exhibits),
        i,
        JSON.stringify(flags),
        now,
      )
      .run();
    for (const t of canonicalTopics) insertedTopics.add(t);
    stored.push({
      id,
      title: a.title,
      exhibits: a.exhibits,
      status: flags.length > 0 ? "held" : "queued",
    });
  }
  return { angles: stored, tier, dropped: dropped + skipped };
}
