// Sealed-column enumeration and the at-rest audit coverage list.
//
// The schema's sealing conventions are: an `*_envelope` column holds an
// AES-256-GCM envelope, and a `filename` column is sealed too because a
// source or corpus filename may carry a person's name. The audit names the
// columns it inspects explicitly, so a new sealed column is a deliberate
// addition to the receipt rather than a silent one; the coverage gate
// (test/smoke.test.ts) enumerates the schema generically and fails when the
// receipt does not name a sealed column.

export interface SealedColumn {
  table: string;
  column: string;
}

/** Schema conventions: sealed values end in `_envelope`, filenames seal too. */
function isSealedColumn(name: string): boolean {
  return name.endsWith("_envelope") || name === "filename";
}

/** Split a CREATE TABLE body on commas at parenthesis depth zero. */
function tableClauses(body: string): string[] {
  const clauses: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      clauses.push(body.slice(start, i));
      start = i + 1;
    }
  }
  clauses.push(body.slice(start));
  return clauses;
}

/**
 * Sealed columns declared in a schema, by convention: any `*_envelope`
 * column, plus `filename` columns. Table constraints are ignored. Generic on
 * purpose — when another stream's table merges into schema.sql, its sealed
 * columns appear here whether or not anyone remembered to audit them.
 */
export function sealedColumnsFromSchema(schemaSql: string): SealedColumn[] {
  const out: SealedColumn[] = [];
  const createRe =
    /\bCREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*/gi;
  let match: RegExpExecArray | null;
  while ((match = createRe.exec(schemaSql))) {
    const open = schemaSql.indexOf("(", createRe.lastIndex);
    if (open === -1) continue;
    let depth = 0;
    let end = -1;
    for (let i = open; i < schemaSql.length; i++) {
      const ch = schemaSql[i];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) continue;
    for (const clause of tableClauses(schemaSql.slice(open + 1, end))) {
      const first = clause.trim().split(/\s+/)[0] ?? "";
      if (!first) continue;
      if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)$/i.test(first)) continue;
      if (isSealedColumn(first)) out.push({ table: match[1], column: first });
    }
  }
  return out;
}

/**
 * Sealed columns in the schema that a coverage list does not name. Empty
 * means the audit's receipt covers the whole sealed surface; anything else
 * is a gap to close, never to suppress.
 */
export function uncoveredSealedColumns(
  schemaSql: string,
  inspected: SealedColumn[],
): SealedColumn[] {
  const covered = new Set(inspected.map((c) => `${c.table}.${c.column}`));
  return sealedColumnsFromSchema(schemaSql).filter(
    (c) => !covered.has(`${c.table}.${c.column}`),
  );
}

/**
 * Every sealed column the at-rest audit inspects. Kept explicit so the
 * coverage gate fails when the schema gains a sealed column this list does
 * not name — a derived list would always pass and prove nothing.
 */
export const CIPHERTEXT_AUDIT_COLUMNS: SealedColumn[] = [
  { table: "messages", column: "body_envelope" },
  { table: "entities", column: "name_envelope" },
  { table: "entity_reveals", column: "record_envelope" },
  { table: "corpus_docs", column: "text_envelope" },
  { table: "corpus_docs", column: "filename" },
  { table: "web_snapshots", column: "text_envelope" },
  { table: "attachments", column: "filename" },
  { table: "angles", column: "rationale_envelope" },
  { table: "research_lines", column: "findings_envelope" },
  { table: "report_versions", column: "body_envelope" },
  { table: "report_entries", column: "entry_envelope" },
  { table: "breach_assessments", column: "record_envelope" },
  { table: "consent_records", column: "record_envelope" },
  { table: "report_legal_records", column: "record_envelope" },
  { table: "right_of_reply_attempts", column: "record_envelope" },
  { table: "recording_provenance", column: "detail_envelope" },
  { table: "recording_reviews", column: "record_envelope" },
  { table: "dossier_notes", column: "body_envelope" },
];

/** A sealed column plus the row key the reseal path updates it by. */
export interface ResealColumn extends SealedColumn {
  key: string;
}

/**
 * Every sealed column the key-rotation path re-seals. Kept explicit and
 * gated against CIPHERTEXT_AUDIT_COLUMNS (test/worker.test.ts): a sealed
 * column the audit inspects but rotation never touches would survive a key
 * change unreadable, so the gap fails a test rather than surfacing at read
 * time. The four `record_envelope` columns are streams B/C/D's additions;
 * the rotation path carries them alongside the original set.
 */
export const RESEAL_COLUMNS: ResealColumn[] = [
  { table: "messages", column: "body_envelope", key: "rowid" },
  { table: "entities", column: "name_envelope", key: "rowid" },
  { table: "corpus_docs", column: "text_envelope", key: "id" },
  { table: "corpus_docs", column: "filename", key: "id" },
  { table: "web_snapshots", column: "text_envelope", key: "id" },
  { table: "attachments", column: "filename", key: "id" },
  { table: "angles", column: "rationale_envelope", key: "id" },
  { table: "research_lines", column: "findings_envelope", key: "id" },
  { table: "report_versions", column: "body_envelope", key: "id" },
  { table: "report_entries", column: "entry_envelope", key: "id" },
  { table: "breach_assessments", column: "record_envelope", key: "id" },
  { table: "consent_records", column: "record_envelope", key: "id" },
  { table: "report_legal_records", column: "record_envelope", key: "id" },
  { table: "entity_reveals", column: "record_envelope", key: "id" },
  { table: "dossier_notes", column: "body_envelope", key: "id" },
  { table: "recording_provenance", column: "detail_envelope", key: "doc_id" },
  { table: "recording_reviews", column: "record_envelope", key: "id" },
  { table: "right_of_reply_attempts", column: "record_envelope", key: "id" },
];
