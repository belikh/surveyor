// Angle proposal + storage, shared by the operator propose route and the
// automatic retrigger path. Grounding is structural: exhibit-free angles are
// dropped by the proposers, and every stored angle is fenced (untrusted).

import { unwrap } from "./evidence";
import { normaliseTopic, proposeAngles, rankAngles } from "./engine";
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
  // Open the sealed mirror text for parsed docs only; held lanes have no
  // text yet and contribute nothing.
  const rows = await db
    .prepare("SELECT id, text_envelope FROM corpus_docs WHERE status = 'parsed'")
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
  for (let i = 0; i < ranked.length; i++) {
    const a = ranked[i];
    const id = crypto.randomUUID();
    await db
      .prepare(
        "INSERT INTO angles (id, title, topics_json, rationale_envelope, exhibits_json, rank, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)",
      )
      .bind(
        id,
        a.title,
        JSON.stringify(canonicalTopics),
        await sealText(kit, a.rationale),
        JSON.stringify(a.exhibits),
        i,
        now,
      )
      .run();
    stored.push({ id, title: a.title, exhibits: a.exhibits, status: "queued" });
  }
  return { angles: stored, tier, dropped };
}
