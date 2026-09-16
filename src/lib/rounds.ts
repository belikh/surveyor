// Corpus-grounded follow-up rounds (R4). The provider registry generates
// questions from gated mirror excerpts; validation fences the output before
// it reaches a source; every failure degrades to the static pool with a
// telemetry row. Never re-asks settled ground — the caller owns the ledger.

import { z } from "zod";
import { nextQuestions } from "./intake";
import type { ModelClient, Turn } from "./serve";

/** Rounds served per submission before it completes. */
export const ROUNDS_MAX = 3;

const QuestionSchema = z.object({
  topic: z.string().min(1).max(64),
  question: z.string().min(1).max(300),
});
const GroundedSchema = z.object({
  questions: z.array(QuestionSchema).max(4),
});

const INJECTION_MARKERS = [
  "ignore previous instructions",
  "ignore all instructions",
  "system prompt",
  "jailbreak",
  "[system]",
];

export interface RoundQuestion {
  topic: string;
  question: string;
}

export interface RoundResult {
  questions: RoundQuestion[];
  tier: string;
  dropped: number;
}

/** FTS lookup over the gated mirror; terms are sanitised into quoted words. */
export async function searchMirror(
  db: D1Database,
  terms: string[],
  limit = 4,
): Promise<Array<{ id: string; snippet: string }>> {
  const words = terms
    .flatMap((t) => t.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((w) => w.length > 2)
    .slice(0, 8);
  if (words.length === 0) return [];
  // Words are [a-z0-9] only, so prefix queries are injection-safe.
  const query = words.map((w) => `${w}*`).join(" OR ");
  const rows = await db
    .prepare(
      "SELECT doc_id AS id, substr(text, 1, 400) AS snippet FROM corpus_fts WHERE corpus_fts MATCH ? LIMIT ?",
    )
    .bind(query, limit)
    .all<{ id: string; snippet: string }>();
  return Array.isArray(rows) ? rows : rows.results;
}

function safe(q: RoundQuestion): boolean {
  const lower = q.question.toLowerCase();
  return !INJECTION_MARKERS.some((m) => lower.includes(m));
}

/**
 * Generate one round of questions: grounded in the mirror when a provider
 * exists, the static pool otherwise. Output is schema-validated and filtered
 * against the covered ledger before it can reach a source.
 */
export async function groundedQuestions(
  db: D1Database,
  client: ModelClient | null,
  covered: Set<string>,
  recordTurn: (t: Turn) => Promise<void>,
): Promise<RoundResult> {
  const statics = nextQuestions(covered);
  if (!client) return { questions: statics, tier: "static", dropped: 0 };

  const excerpts = await searchMirror(db, [...covered]);
  if (excerpts.length === 0) {
    return { questions: statics, tier: "static-empty-mirror", dropped: 0 };
  }
  const mirror = excerpts.map((e) => `[${e.id}] ${e.snippet}`).join("\n");
  const coveredList = [...covered].slice(0, 40).join(", ") || "(none)";
  let raw: string;
  try {
    raw = await client.complete(
      "You are an investigative interviewer. Using only the corpus excerpts " +
        "below, propose up to 3 new follow-up questions for a source. Settled " +
        `topics (never repeat): ${coveredList}. Reply with JSON ` +
        '{"questions":[{"topic":"...","question":"..."}]} and nothing else.' +
        `\n\nCorpus excerpts:\n${mirror}`,
    );
  } catch {
    await recordTurn({ tier: "static-fallback", toolCalls: 0, label: "rounds" });
    return { questions: statics, tier: "static-fallback", dropped: 0 };
  }
  await recordTurn({ tier: client.tier, toolCalls: 0, label: "rounds" });
  let parsed: z.infer<typeof GroundedSchema>;
  try {
    parsed = GroundedSchema.parse(JSON.parse(raw));
  } catch {
    await recordTurn({ tier: "static-fallback", toolCalls: 0, label: "rounds" });
    return { questions: statics, tier: "static-fallback", dropped: 0 };
  }
  const seen = new Set<string>();
  const kept: RoundQuestion[] = [];
  let dropped = 0;
  for (const q of parsed.questions) {
    if (covered.has(q.topic) || seen.has(q.topic) || !safe(q)) {
      dropped++;
      continue;
    }
    seen.add(q.topic);
    kept.push(q);
  }
  if (kept.length === 0) {
    return { questions: statics, tier: "static-fallback", dropped };
  }
  return { questions: kept, tier: client.tier, dropped };
}
