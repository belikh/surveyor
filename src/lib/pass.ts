// Journalist pass (R7): one model-written pass per report type through the
// provider registry. Grounding is enforced — a citation counts only when its
// snippet occurs in the cited mirrored document. Uncited claims are annotated
// in drafts and stripped on publish unless the operator approved them. All
// prose is fenced (untrusted) and versioned by the publisher. One pass per
// type; the pass runs inside the engine's scheduled-publish step or inline at
// manual publish.

import { z } from "zod";
import { unwrap } from "./evidence";
import type { Evidence } from "./reports";
import { openText, sealText, type VaultKit } from "./vault";
import type { ModelClient } from "./serve";
import { recordTurn } from "./telemetry";

export const ExhibitSchema = z.object({
  doc_id: z.string().min(1).max(128),
  snippet: z.string().min(1).max(2000),
});

const BlockSchema = z.object({
  heading: z.string().max(200).optional(),
  text: z.string().min(1).max(4000),
  citations: z.array(ExhibitSchema).max(8),
});

const TimelineEntrySchema = z.object({
  date: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
  paragraph: z.string().min(1).max(2000),
  citations: z.array(ExhibitSchema).max(8),
});

export const PassOutputSchema = z.object({
  blocks: z.array(BlockSchema).max(20).optional(),
  entries: z.array(TimelineEntrySchema).max(50).optional(),
  lead: z.string().max(2000).optional(),
});
export type PassOutput = z.infer<typeof PassOutputSchema>;
export type TimelineEntry = z.infer<typeof TimelineEntrySchema>;

export const PASS_DOC_BUDGET = 6000;

/** Per-pass spend cap (ADR-0010): provider-reported tokens for the one
 *  model call a pass makes. A pass that reports more stops there; the
 *  caller falls back to the deterministic render rather than buying more. */
export interface PassCaps {
  tokens: number;
}

export const PASS_CAPS: PassCaps = { tokens: 20_000 };

export interface PassResult {
  /** Rendered prose for the non-snapshot types; null when unusable. */
  body: string | null;
  /** Snapshot lead paragraph; null when unusable. */
  lead: string | null;
  tier: string;
  uncited: number;
  dropped: number;
}

interface Doc {
  id: string;
  text: string;
}

function citeLine(citations: Array<{ doc_id: string; snippet: string }>): string {
  return citations
    .map((c) => `[${cap(c.doc_id, 200)}: ${cap(c.snippet, 500)}]`)
    .join(" ");
}

function cap(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function promptFor(type: string, evidence: Evidence, docs: Doc[]): string {
  const lines = evidence.lines
    .slice(0, 50)
    .map((l) => {
      const cites = l.citations
        .slice(0, 6)
        .map((c) => `${c.doc_id}: ${cap(c.snippet, 200)}`)
        .join(" | ");
      const flags = l.flags.length > 0 ? ` [flagged: ${l.flags.join(", ")}]` : "";
      return `- ${cap(l.title, 200)}${flags}\n  exhibits: ${cites}`;
    })
    .join("\n");
  const material = docs
    .slice(0, 10)
    .map((d) => `[${d.id}] ${cap(d.text, PASS_DOC_BUDGET / 10)}`)
    .join("\n");
  const shape =
    type === "timeline"
      ? '{"entries":[{"date":"...","label":"...","paragraph":"...","citations":[{"doc_id":"...","snippet":"..."}]}]}'
      : type === "snapshot"
        ? '{"lead":"..."}'
        : '{"blocks":[{"heading":"...","text":"...","citations":[{"doc_id":"...","snippet":"..."}]}]}';
  return (
    `You are a journalist writing the ${type} report of an investigation. ` +
    "Write only from the material below. Every paragraph or entry must carry " +
    "at least one citation that reproduces an exact snippet from a cited " +
    `document. Reply with JSON ${shape} and nothing else.\n\n` +
    `Research lines:\n${lines || "(none)"}\n\n` +
    `Corpus documents:\n${material || "(none)"}`
  );
}

/**
 * Run one pass and render its prose. Returns null when the provider fails,
 * exceeds the per-pass cap, or emits unusable output — the caller falls back
 * to the deterministic render. `strict` is publish mode: uncited claims are
 * dropped rather than annotated.
 */
export async function runJournalistPass(
  db: D1Database,
  kit: VaultKit,
  type: string,
  client: ModelClient,
  evidence: Evidence,
  strict: boolean,
  caps: PassCaps = PASS_CAPS,
): Promise<PassResult | null> {
  const rows = await db
    .prepare("SELECT id, text_envelope FROM corpus_docs WHERE status = 'parsed'")
    .all<{ id: string; text_envelope: string }>();
  const docs: Doc[] = [];
  for (const r of unwrap(rows)) {
    docs.push({ id: r.id, text: await openText(kit, r.text_envelope) });
  }
  const byId = new Map(docs.map((d) => [d.id, d.text]));

  let raw: string;
  let reported = 0;
  try {
    raw = await client.complete(promptFor(type, evidence, docs), (usage) => {
      reported += usage.tokens;
    });
  } catch {
    await recordTurn(db, {
      tier: "deterministic-fallback",
      toolCalls: 0,
      label: `pass:${type}`,
      outcome: "provider-error",
    });
    return null;
  }
  // The cap is checked on the provider's own report: an over-cap pass halts
  // gracefully — no prose is stored, the render falls back, and the record
  // says the cap was hit.
  if (reported > caps.tokens) {
    await recordTurn(db, {
      tier: client.tier,
      toolCalls: 0,
      label: `pass:${type}`,
      outcome: "capped",
    });
    return null;
  }
  await recordTurn(db, { tier: client.tier, toolCalls: 0, label: `pass:${type}` });

  let parsed: PassOutput;
  try {
    parsed = PassOutputSchema.parse(JSON.parse(raw));
  } catch {
    await recordTurn(db, {
      tier: "deterministic-fallback",
      toolCalls: 0,
      label: `pass:${type}`,
      outcome: "unparseable",
    });
    return null;
  }

  const ground = (cites: Array<{ doc_id: string; snippet: string }>) =>
    cites.filter((c) => byId.get(c.doc_id)?.includes(c.snippet) ?? false);

  if (type === "timeline") {
    const entries: TimelineEntry[] = [];
    let uncited = 0;
    for (const e of parsed.entries ?? []) {
      const citations = ground(e.citations);
      if (citations.length === 0) {
        uncited++;
        if (strict) continue;
      }
      entries.push({ ...e, citations });
    }
    await storeEntries(db, kit, type, entries);
    if (entries.length === 0) return null;
    return {
      body: renderTimelineEntries(entries),
      lead: null,
      tier: client.tier,
      uncited,
      dropped: 0,
    };
  }

  if (type === "snapshot") {
    const lead = parsed.lead?.trim() || null;
    return { body: null, lead, tier: client.tier, uncited: 0, dropped: 0 };
  }

  const blocks = parsed.blocks ?? [];
  if (blocks.length === 0) return null;
  const rendered: string[] = [];
  let uncited = 0;
  for (const b of blocks) {
    const citations = ground(b.citations);
    if (citations.length === 0) {
      uncited++;
      if (strict) continue;
    }
    rendered.push(
      (b.heading ? `## ${cap(b.heading, 200)}\n\n` : "") +
        b.text +
        (citations.length > 0 ? `\n\n${citeLine(citations)}` : " [uncited]"),
    );
  }
  if (rendered.length === 0) return null;
  return { body: rendered.join("\n\n"), lead: null, tier: client.tier, uncited, dropped: 0 };
}

/** Deterministic render of structured timeline entries. */
export function renderTimelineEntries(entries: TimelineEntry[]): string {
  return entries
    .map(
      (e) =>
        `- ${cap(e.date, 64)}: **${cap(e.label, 200)}** — ${e.paragraph}` +
        (e.citations.length > 0
          ? `\n  ${citeLine(e.citations)}`
          : " [uncited]"),
    )
    .join("\n");
}

/** Read the stored structured timeline entries (the production read path). */
export async function readTimelineEntries(
  db: D1Database,
  kit: VaultKit,
): Promise<TimelineEntry[]> {
  const rows = await db
    .prepare(
      "SELECT entry_envelope FROM report_entries WHERE report_type = 'timeline' ORDER BY position ASC",
    )
    .all<{ entry_envelope: string }>();
  const entries: TimelineEntry[] = [];
  for (const row of unwrap(rows)) {
    try {
      const parsed = TimelineEntrySchema.safeParse(
        JSON.parse(await openText(kit, row.entry_envelope)),
      );
      if (parsed.success) entries.push(parsed.data);
    } catch {
      // An unreadable row is skipped rather than failing the render.
    }
  }
  return entries;
}

/** Render the stored timeline entries, or null when none are stored so the
 *  caller can fall back to the deterministic evidence render. */
export async function renderStoredTimeline(
  db: D1Database,
  kit: VaultKit,
): Promise<string | null> {
  const entries = await readTimelineEntries(db, kit);
  return entries.length === 0 ? null : renderTimelineEntries(entries);
}

/** Replace this type's stored entries with the pass output (sealed). */
async function storeEntries(
  db: D1Database,
  kit: VaultKit,
  type: string,
  entries: TimelineEntry[],
): Promise<void> {
  await db.prepare("DELETE FROM report_entries WHERE report_type = ?").bind(type).run();
  const now = new Date().toISOString();
  for (let i = 0; i < entries.length; i++) {
    await db
      .prepare(
        "INSERT INTO report_entries (id, report_type, position, entry_envelope, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        crypto.randomUUID(),
        type,
        i,
        await sealText(kit, JSON.stringify(entries[i])),
        now,
      )
      .run();
  }
}
