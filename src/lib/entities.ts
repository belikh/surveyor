// Entity index over gated text. Person nodes are the quarantine pseudonyms
// the gate writes into gated text (`[person A]`), joined to sealed entities
// by HMAC only. Extraction reads gated text and the HMACs the gate already
// computed — it never sees or stores a raw name, and a rerun writes no new
// rows. Revealing one is a break-glass operator action that writes an audit
// record and returns the name to that caller only.

import { z } from "zod";
import { openText, sealText, type VaultKit } from "./vault";

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

/** Where a revealed person appears: one link per pseudonym occurrence. */
export interface EntityRevealLink {
  submission_id: string;
  label: string;
}

/** The sealed part of a reveal record: the operator states who and why. */
export const RevealRecordSchema = z.object({
  revealed_by: z.string().min(1).max(200),
  reason: z.string().min(1).max(2000),
});
export type RevealRecord = z.infer<typeof RevealRecordSchema>;

export interface EntityRevealView {
  id: string;
  name_hmac: string;
  /** Where the revealed person appears: submission + pseudonym label. */
  links: EntityRevealLink[];
  revealed_by: string;
  reason: string;
  revealed_at: string;
}

export interface RevealedEntity {
  /** The break-glass output: the one place a name is returned. */
  name: string;
  reveal: EntityRevealView;
}

/**
 * Break-glass: open the sealed name behind an HMAC, return it to the
 * caller, and write one audit record with who/when/why. An HMAC with no
 * sealed entity is a refusal — nothing is returned and nothing is written.
 * The name is not stored in the audit; another read needs another reveal.
 */
export async function revealEntity(
  db: D1Database,
  kit: VaultKit,
  nameHmac: string,
  input: RevealRecord,
  now = new Date().toISOString(),
): Promise<RevealedEntity | null> {
  const rows = await db
    .prepare(
      "SELECT submission_id, label, name_envelope FROM entities " +
        "WHERE name_hmac = ? ORDER BY submission_id, label",
    )
    .bind(nameHmac)
    .all<{ submission_id: string; label: string; name_envelope: string }>();
  const list = Array.isArray(rows) ? rows : rows.results;
  if (list.length === 0) return null;
  // Every row under one HMAC is the same name (the HMAC is the join key).
  const name = await openText(kit, list[0].name_envelope);
  const record = RevealRecordSchema.parse(input);
  const seen = new Set<string>();
  const links: EntityRevealLink[] = [];
  for (const row of list) {
    const key = `${row.submission_id}\u0000${row.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ submission_id: row.submission_id, label: row.label });
  }
  const id = crypto.randomUUID();
  await db.batch([
    db
      .prepare(
        "INSERT INTO entity_reveals (id, name_hmac, links_json, record_envelope, revealed_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        id,
        nameHmac,
        JSON.stringify(links),
        await sealText(kit, JSON.stringify(record)),
        now,
      ),
    db
      .prepare("INSERT INTO audit (ts, action) VALUES (?, ?)")
      .bind(now, "entities:revealed"),
  ]);
  return {
    name,
    reveal: {
      id,
      name_hmac: nameHmac,
      links,
      revealed_by: record.revealed_by,
      reason: record.reason,
      revealed_at: now,
    },
  };
}

/**
 * The operator-facing reveal audit: every record, newest first, opened for
 * the operator. Names are not part of the record and never appear here —
 * the audit proves the action, the reveal hands over the name.
 */
export async function listEntityReveals(
  db: D1Database,
  kit: VaultKit,
): Promise<EntityRevealView[]> {
  const rows = await db
    .prepare(
      "SELECT id, name_hmac, links_json, record_envelope, revealed_at " +
        "FROM entity_reveals ORDER BY revealed_at DESC, id",
    )
    .all<{
      id: string;
      name_hmac: string;
      links_json: string;
      record_envelope: string;
      revealed_at: string;
    }>();
  const list = Array.isArray(rows) ? rows : rows.results;
  const out: EntityRevealView[] = [];
  for (const row of list) {
    const record = RevealRecordSchema.parse(
      JSON.parse(await openText(kit, row.record_envelope)),
    );
    out.push({
      id: row.id,
      name_hmac: row.name_hmac,
      links: z
        .array(
          z.object({
            submission_id: z.string(),
            label: z.string(),
          }),
        )
        .parse(JSON.parse(row.links_json)),
      revealed_by: record.revealed_by,
      reason: record.reason,
      revealed_at: row.revealed_at,
    });
  }
  return out;
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
