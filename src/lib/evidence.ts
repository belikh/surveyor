// Shared evidence bundle: one read path for renders, publish, and the
// scheduler. Only complete (cleared) lines and approved angles feed it;
// held and rejected material never reaches a render.

import { z } from "zod";
import { MIRRORED_SQL } from "./mirror";
import {
  ExhibitRefSchema,
  type Evidence,
  type ExhibitRef,
} from "./reports";

/** Normalise the two D1 `.all()` shapes (real D1 vs test facade). */
export function unwrap<T>(rows: T[] | { results: T[] }): T[] {
  return Array.isArray(rows) ? rows : rows.results;
}

export async function gatherEvidence(db: D1Database): Promise<Evidence> {
  const submissionCount = await db
    .prepare("SELECT COUNT(*) AS n FROM submissions WHERE kind = 'original'")
    .first<{ n: number }>();
  const addendaCount = await db
    .prepare("SELECT COUNT(*) AS n FROM submissions WHERE kind = 'addendum'")
    .first<{ n: number }>();
  const parsedCount = await db
    .prepare(`SELECT COUNT(*) AS n FROM corpus_docs WHERE ${MIRRORED_SQL}`)
    .first<{ n: number }>();
  const heldCount = await db
    .prepare("SELECT COUNT(*) AS n FROM corpus_docs WHERE status = 'held'")
    .first<{ n: number }>();
  const ang = await db
    .prepare(
      "SELECT id, title, exhibits_json FROM angles WHERE status IN ('approved')",
    )
    .all<{ id: string; title: string; exhibits_json: string }>();
  const approvedAngles = unwrap(ang);
  const lin = await db
    .prepare(
      "SELECT research_lines.id AS id, angles.title AS title, research_lines.citations_json AS citations_json, research_lines.flags_json AS flags_json, research_lines.created_at AS created_at FROM angles JOIN research_lines ON research_lines.angle_id = angles.id WHERE research_lines.status = 'complete' AND angles.status = 'approved'",
    )
    .all<{
      id: string;
      title: string;
      citations_json: string;
      flags_json: string;
      created_at: string;
    }>();
  const lines = unwrap(lin);
  const started = await db
    .prepare("SELECT MIN(created_at) AS m FROM submissions")
    .first<{ m: string | null }>();
  return {
    submissions: submissionCount?.n ?? 0,
    addenda: addendaCount?.n ?? 0,
    corpusDocs: parsedCount?.n ?? 0,
    heldDocs: heldCount?.n ?? 0,
    angles: approvedAngles.map((a) => ({
      title: a.title,
      exhibits: z.array(ExhibitRefSchema).parse(JSON.parse(a.exhibits_json)) as ExhibitRef[],
    })),
    lines: lines.map((l) => ({
      id: l.id,
      title: l.title,
      citations: z.array(ExhibitRefSchema).parse(JSON.parse(l.citations_json)) as ExhibitRef[],
      flags: z.array(z.string()).parse(JSON.parse(l.flags_json ?? "[]")) as string[],
      created_at: l.created_at,
    })),
    started_at: started?.m ?? new Date().toISOString(),
    now: new Date().toISOString(),
  };
}
