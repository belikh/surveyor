// Entity index over gated text. Person nodes are the quarantine pseudonyms
// the gate writes into gated text (`[person A]`), joined to sealed entities
// by HMAC only. Extraction reads gated text and the HMACs the gate already
// computed — it never sees or stores a raw name, and a rerun writes no new
// rows.

export interface IndexedEntity {
  submission_id: string;
  label: string;
  name_hmac: string;
}

/** A sealed entity as the gate produced it: pseudonym plus join key. */
export interface SealedEntityRef {
  label: string;
  hmac: string;
}

// The marker shape the quarantine gate writes into gated text.
const MARKER = /\[person [A-Za-z0-9]+\]/g;

/** The pseudonym markers present in gated text, deduped, first-seen order. */
export function entityMarkers(gatedText: string): string[] {
  const seen = new Set<string>();
  for (const match of gatedText.matchAll(MARKER)) {
    seen.add(match[0]);
  }
  return [...seen];
}

/**
 * Index rows for one gated document: only markers that actually occur in
 * the gated text, joined to their sealed entities by HMAC. Names are the
 * gate's business; this function only shuffles labels and HMACs.
 */
export function entityIndexRows(
  submissionId: string,
  gatedText: string,
  sealed: readonly SealedEntityRef[],
): IndexedEntity[] {
  const present = new Set(entityMarkers(gatedText));
  const seen = new Set<string>();
  const rows: IndexedEntity[] = [];
  for (const s of sealed) {
    if (!present.has(s.label)) continue;
    const key = `${s.label}\u0000${s.hmac}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ submission_id: submissionId, label: s.label, name_hmac: s.hmac });
  }
  return rows;
}

const INSERT =
  "INSERT INTO entity_index (submission_id, label, name_hmac) VALUES (?, ?, ?) " +
  "ON CONFLICT(submission_id, label, name_hmac) DO NOTHING";

/** Prepared index inserts, for callers batching the whole write. */
export function entityIndexStatements(
  db: D1Database,
  rows: readonly IndexedEntity[],
): D1PreparedStatement[] {
  return rows.map((r) =>
    db
      .prepare(INSERT)
      .bind(r.submission_id, r.label, r.name_hmac),
  );
}

/** Idempotent index write: the primary key makes a rerun a no-op. */
export async function writeEntityIndex(
  db: D1Database,
  rows: readonly IndexedEntity[],
): Promise<void> {
  if (rows.length === 0) return;
  await db.batch(entityIndexStatements(db, rows));
}

export interface EntityLink {
  submission_id: string;
  label: string;
  name_hmac: string;
  /** Sealed entity rows this link joins to by HMAC, counted, never opened. */
  sealed: number;
}

/**
 * Resolve index links by HMAC: the join to sealed entities is the HMAC, so
 * a link proves an entity exists without ever reading its envelope. Pass an
 * HMAC to resolve one person across every document that mentions them.
 */
export async function resolveEntityLinks(
  db: D1Database,
  nameHmac?: string,
): Promise<EntityLink[]> {
  const select =
    "SELECT i.submission_id, i.label, i.name_hmac, " +
    "(SELECT COUNT(*) FROM entities e WHERE e.name_hmac = i.name_hmac) AS sealed " +
    "FROM entity_index i";
  const stmt = nameHmac
    ? db.prepare(`${select} WHERE i.name_hmac = ? ORDER BY i.submission_id, i.label`).bind(nameHmac)
    : db.prepare(`${select} ORDER BY i.submission_id, i.label`);
  const rows = await stmt.all<EntityLink>();
  return Array.isArray(rows) ? rows : rows.results;
}
