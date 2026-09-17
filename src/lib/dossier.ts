// Case dossier: one investigation's working file. Gathers the operator's
// angles, research lines with their findings, every report version and the
// operator's own notes, then renders one exportable Markdown document whose
// internal links resolve to the findings and versions they name. Findings
// and notes are sealed at rest and opened only on this operator-gated
// surface — never in a published report, whose own gates still apply.

import { z } from "zod";
import { openText, sealText, type VaultKit } from "./vault";

export interface DossierExhibit {
  doc_id: string;
  snippet: string;
}

export interface DossierAngle {
  id: string;
  title: string;
  /** "held" when flagged: the same rule the engine queue applies. */
  status: string;
  rationale: string;
  exhibits: DossierExhibit[];
  flags: string[];
}

export interface DossierLine {
  id: string;
  angle_id: string;
  status: string;
  spend_cap: number;
  spend_used: number;
  finding: string;
  citations: DossierExhibit[];
  flags: string[];
}

export interface DossierVersion {
  type: string;
  version: number;
  body: string;
  created_at: string;
}

export interface DossierNote {
  id: string;
  body: string;
  created_at: string;
}

export interface Dossier {
  generated_at: string;
  angles: DossierAngle[];
  lines: DossierLine[];
  versions: DossierVersion[];
  notes: DossierNote[];
}

const ExhibitSchema = z.object({
  doc_id: z.string(),
  snippet: z.string(),
});

function unwrap<T>(rows: T[] | { results: T[] }): T[] {
  return Array.isArray(rows) ? rows : rows.results;
}

/** The whole investigation state, sealed fields opened for the operator. */
export async function gatherDossier(
  db: D1Database,
  kit: VaultKit,
  now = new Date().toISOString(),
): Promise<Dossier> {
  const angles: DossierAngle[] = [];
  const angleRows = unwrap(
    await db
      .prepare(
        "SELECT id, title, status, rationale_envelope, exhibits_json, flags_json FROM angles ORDER BY rank ASC",
      )
      .all<{
        id: string;
        title: string;
        status: string;
        rationale_envelope: string;
        exhibits_json: string;
        flags_json: string | null;
      }>(),
  );
  for (const row of angleRows) {
    const flags = z.array(z.string()).parse(JSON.parse(row.flags_json ?? "[]"));
    angles.push({
      id: row.id,
      title: row.title,
      // A flagged heading reads as held, exactly as the angle queue shows it.
      status: flags.length > 0 ? "held" : row.status,
      rationale: await openText(kit, row.rationale_envelope),
      exhibits: z.array(ExhibitSchema).parse(JSON.parse(row.exhibits_json)),
      flags,
    });
  }

  const lines: DossierLine[] = [];
  const lineRows = unwrap(
    await db
      .prepare(
        "SELECT id, angle_id, status, spend_cap, spend_used, citations_json, findings_envelope, flags_json FROM research_lines ORDER BY created_at ASC",
      )
      .all<{
        id: string;
        angle_id: string;
        status: string;
        spend_cap: number;
        spend_used: number;
        citations_json: string;
        findings_envelope: string;
        flags_json: string | null;
      }>(),
  );
  for (const row of lineRows) {
    lines.push({
      id: row.id,
      angle_id: row.angle_id,
      status: row.status,
      spend_cap: Number(row.spend_cap),
      spend_used: Number(row.spend_used),
      finding: row.findings_envelope
        ? await openText(kit, row.findings_envelope)
        : "",
      citations: z.array(ExhibitSchema).parse(JSON.parse(row.citations_json)),
      flags: z.array(z.string()).parse(JSON.parse(row.flags_json ?? "[]")),
    });
  }

  const versions: DossierVersion[] = [];
  const versionRows = unwrap(
    await db
      .prepare(
        "SELECT type, version, body_envelope, created_at FROM report_versions ORDER BY type ASC, version ASC",
      )
      .all<{
        type: string;
        version: number;
        body_envelope: string;
        created_at: string;
      }>(),
  );
  for (const row of versionRows) {
    versions.push({
      type: row.type,
      version: Number(row.version),
      body: await openText(kit, row.body_envelope),
      created_at: row.created_at,
    });
  }

  const notes: DossierNote[] = [];
  const noteRows = unwrap(
    await db
      .prepare(
        "SELECT id, body_envelope, created_at FROM dossier_notes ORDER BY created_at ASC, id ASC",
      )
      .all<{ id: string; body_envelope: string; created_at: string }>(),
  );
  for (const row of noteRows) {
    notes.push({
      id: row.id,
      body: await openText(kit, row.body_envelope),
      created_at: row.created_at,
    });
  }

  return { generated_at: now, angles, lines, versions, notes };
}

/** The finding anchor in the rendered document. */
export function findingAnchor(lineId: string): string {
  return `finding-${lineId}`;
}

/** The report-version anchor in the rendered document. */
export function versionAnchor(type: string, version: number): string {
  return `report-${type}-v${version}`;
}

/**
 * Render the dossier as one Markdown file. Explicit anchors make the
 * contents links deterministic in any renderer: every `#finding-…` and
 * `#report-…` link resolves inside this file.
 */
export function renderDossier(dossier: Dossier): string {
  const out: string[] = [];
  out.push("# Case dossier", "");
  out.push(
    `Generated ${dossier.generated_at}. Model-derived findings are ` +
      "untrusted: verify before publication.",
    "",
  );

  const linesByAngle = new Map<string, DossierLine[]>();
  for (const line of dossier.lines) {
    const list = linesByAngle.get(line.angle_id) ?? [];
    list.push(line);
    linesByAngle.set(line.angle_id, list);
  }

  out.push("## Contents", "");
  out.push("Findings:", "");
  if (dossier.lines.length === 0) out.push("- (none yet)", "");
  for (const line of dossier.lines) {
    const angle = dossier.angles.find((a) => a.id === line.angle_id);
    out.push(
      `- [${angle?.title ?? "Untitled angle"} — ${line.status}]` +
        `(#${findingAnchor(line.id)})`,
    );
  }
  out.push("");
  out.push("Report versions:", "");
  if (dossier.versions.length === 0) out.push("- (none yet)", "");
  for (const v of dossier.versions) {
    out.push(
      `- [${v.type} v${v.version}](#${versionAnchor(v.type, v.version)})`,
    );
  }
  out.push("");

  out.push("## Angles", "");
  if (dossier.angles.length === 0) out.push("None yet.", "");
  for (const angle of dossier.angles) {
    out.push(
      `### ${angle.title} — ${angle.status} ` +
        `<a id="angle-${angle.id}"></a>`,
      "",
      `Rationale: ${angle.rationale}`,
      "",
    );
    if (angle.flags.length > 0) {
      out.push(`Flags: ${angle.flags.join(", ")}`, "");
    }
    const lines = linesByAngle.get(angle.id) ?? [];
    if (lines.length > 0) {
      out.push(
        `Lines: ${lines
          .map((l) => `[${l.status}](#${findingAnchor(l.id)})`)
          .join(", ")}`,
        "",
      );
    }
  }

  out.push("## Findings", "");
  if (dossier.lines.length === 0) out.push("None yet.", "");
  for (const line of dossier.lines) {
    const angle = dossier.angles.find((a) => a.id === line.angle_id);
    out.push(
      `### ${angle?.title ?? "Untitled angle"} — ${line.status} ` +
        `<a id="${findingAnchor(line.id)}"></a>`,
      "",
      `Spend: ${line.spend_used}/${line.spend_cap}`,
      "",
      line.finding.trim() || "(no finding recorded yet)",
      "",
    );
    if (line.citations.length > 0) {
      out.push(
        `Citations: ${line.citations
          .map((c) => `${c.doc_id} ("${c.snippet}")`)
          .join(", ")}`,
        "",
      );
    }
    if (line.flags.length > 0) {
      out.push(`Flags: ${line.flags.join(", ")}`, "");
    }
  }

  out.push("## Report versions", "");
  if (dossier.versions.length === 0) out.push("None yet.", "");
  for (const v of dossier.versions) {
    out.push(
      `### ${v.type} v${v.version} — ${v.created_at} ` +
        `<a id="${versionAnchor(v.type, v.version)}"></a>`,
      "",
      v.body.trim(),
      "",
    );
  }

  out.push("## Operator notes", "");
  if (dossier.notes.length === 0) out.push("None yet.", "");
  for (const note of dossier.notes) {
    out.push(`- ${note.created_at}: ${note.body}`);
  }
  out.push("");
  return out.join("\n");
}

export const DossierNoteSchema = z.object({
  note: z.string().min(1).max(4000),
});

/** Append one operator note, sealed at rest. */
export async function addDossierNote(
  db: D1Database,
  kit: VaultKit,
  note: string,
  now = new Date().toISOString(),
): Promise<DossierNote> {
  const body = DossierNoteSchema.parse({ note }).note;
  const id = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO dossier_notes (id, body_envelope, created_at) VALUES (?, ?, ?)",
    )
    .bind(id, await sealText(kit, body), now)
    .run();
  return { id, body, created_at: now };
}
