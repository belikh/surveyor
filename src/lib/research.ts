// Research-line tool loop (B1): one capped, read-only pass over the gated
// mirror per line, run as a Workflow step. The tool surface is search (FTS
// over the mirror) and fetch (one document's gated text) — there is no
// action capability and no write path. A keyless installation runs a
// deterministic floor; a configured provider may drive the same tools.
// Step or token caps halt the line into held rather than burning past them,
// and model failures fall back to the floor with a telemetry row.

import { z } from "zod";
import { searchMirror } from "./rounds";
import { flagSuspicious } from "./engine";
import { openText, sealText, type VaultKit } from "./vault";
import { validateWebCitation } from "./snapshot";
import { recordTurn } from "./telemetry";
import type { ModelClient } from "./serve";

/** Per-line caps. Steps count model turns; tokens are approximated from
 *  prompt and completion length because the client exposes text only.
 *  Spend is metered from provider-reported usage and the line's own
 *  spend_cap takes precedence over the default here. */
export interface LoopCaps {
  steps: number;
  tokens: number;
  spend: number;
  wallMs: number;
}

export const RESEARCH_CAPS: LoopCaps = {
  steps: 8,
  tokens: 20_000,
  spend: 20_000,
  wallMs: 120_000,
};

/** Real-spend wiring for the loop: the line's cap, its recorded total, a
 *  meter that persists provider-reported usage, and an injectable clock. */
export interface LoopBudget {
  spendCap: number;
  spendUsed: number;
  meter?: (tokens: number) => Promise<number>;
  now?: () => number;
}

export interface Citation {
  /** Corpus evidence: the mirrored document's id. */
  doc_id?: string;
  /** Web evidence: the immutable snapshot's id (ADR-0017). */
  snapshot_id?: string;
  snippet: string;
}

export interface CorpusToolbox {
  search(query: string): Promise<Array<{ doc_id: string; snippet: string }>>;
  fetch(docId: string): Promise<{ doc_id: string; text: string } | null>;
}

/** Statuses whose gated text sits in the mirror. Held docs are raw: the
 *  toolbox cannot reach them. */
const MIRRORED = "status IN ('parsed', 'OCRed', 'rescued')";

export function buildCorpusToolbox(
  db: D1Database,
  kit: VaultKit,
): CorpusToolbox {
  return {
    async search(query: string) {
      const hits = await searchMirror(db, [query], 4);
      return hits.map((h) => ({ doc_id: h.id, snippet: h.snippet }));
    },
    async fetch(docId: string) {
      const row = await db
        .prepare(
          `SELECT id, text_envelope FROM corpus_docs WHERE id = ? AND ${MIRRORED}`,
        )
        .bind(docId)
        .first<{ id: string; text_envelope: string }>();
      if (!row) return null;
      return { doc_id: row.id, text: await openText(kit, row.text_envelope) };
    },
  };
}

export interface AngleBrief {
  title: string;
  topics: string[];
  rationale: string;
  exhibits: Citation[];
}

export type LoopOutcome =
  | {
      kind: "findings";
      findings: string;
      citations: Citation[];
      tier: string;
      steps: number;
    }
  | {
      kind: "held";
      flags: string[];
      reason: string;
      tier: string;
      steps: number;
    };

const ActionSchema = z.union([
  z.object({ tool: z.literal("search"), query: z.string().min(1).max(512) }),
  z.object({ tool: z.literal("fetch"), doc_id: z.string().min(1).max(128) }),
  z.object({
    tool: z.literal("final"),
    findings: z.string().min(1).max(50_000),
    citations: z
      .array(
        z.object({
          doc_id: z.string().min(1).max(128).optional(),
          snapshot_id: z.string().min(1).max(128).optional(),
          snippet: z.string().min(1).max(2000),
        }),
      )
      .max(64),
  }),
]);

/** ~4 characters per token both ways. Used only for the token runaway cap
 *  when a client reports no usage; spend is metered from real usage. */
function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function excerpt(text: string, terms: string[]): string {
  const lower = text.toLowerCase();
  const hit = terms.find((t) => t.length > 3 && lower.includes(t.toLowerCase()));
  if (hit === undefined) return text.trim().slice(0, 300);
  const start = Math.max(0, lower.indexOf(hit.toLowerCase()) - 60);
  return text.slice(start, start + 300).trim();
}

function draftFinding(angle: AngleBrief, citations: Citation[]): string {
  const excerpts = citations
    .map((c) => `"${c.snippet}" (${c.doc_id ?? c.snapshot_id})`)
    .join("; ");
  return (
    `Research on "${angle.title}" found ${citations.length} grounded ` +
    `exhibit(s): ${excerpts}`
  );
}

/**
 * Deterministic floor: search the mirror for the angle's vocabulary, fetch
 * the hits and cite exact excerpts. The angle's own exhibits are the
 * fallback — they were grounded when the angle was proposed. No grounded
 * exhibit means the line is held, never an invented finding.
 */
export async function floorLoop(
  toolbox: CorpusToolbox,
  angle: AngleBrief,
): Promise<LoopOutcome> {
  const terms = [
    ...angle.title.toLowerCase().match(/[a-z0-9]+/g) ?? [],
    ...angle.topics.flatMap((t) => t.toLowerCase().match(/[a-z0-9]+/g) ?? []),
  ];
  const citations: Citation[] = [];
  const hits = await toolbox.search(terms.join(" "));
  for (const hit of hits.slice(0, 3)) {
    const doc = await toolbox.fetch(hit.doc_id);
    if (!doc) continue;
    const snippet = excerpt(doc.text, terms);
    if (snippet.length > 0) {
      citations.push({ doc_id: doc.doc_id, snippet });
    }
  }
  if (citations.length === 0) {
    for (const exhibit of angle.exhibits.slice(0, 3)) citations.push(exhibit);
  }
  if (citations.length === 0) {
    return {
      kind: "held",
      flags: ["ungrounded"],
      reason: "no mirrored document matched the angle",
      tier: "extractive",
      steps: 1,
    };
  }
  return {
    kind: "findings",
    findings: draftFinding(angle, citations),
    citations,
    tier: "extractive",
    steps: 1,
  };
}

/**
 * Provider-driven loop: each model turn is one step and asks for exactly
 * one tool action. A final action counts only citations whose snippet
 * occurs verbatim in a document this line fetched; anything less degrades
 * to the floor. Unknown tools, unparseable turns and provider errors are
 * model failures and degrade the same way.
 *
 * Spend is real: every call's provider-reported usage lands on the line's
 * spend row, and the moment that total reaches the line cap the loop holds
 * the line rather than buying another turn.
 */
export async function liveLoop(
  client: ModelClient,
  toolbox: CorpusToolbox,
  angle: AngleBrief,
  caps: LoopCaps,
  budget: LoopBudget,
): Promise<LoopOutcome> {
  const header =
    `Research the investigative angle "${angle.title}" using only the ` +
    `read-only corpus tools below. Rationale: ${angle.rationale}\n` +
    `Reply with one JSON object and nothing else.\n` +
    `{"tool":"search","query":"..."} — search the gated mirror\n` +
    `{"tool":"fetch","doc_id":"..."} — read one mirrored document\n` +
    `{"tool":"final","findings":"...","citations":[{"doc_id":"...",` +
    `"snippet":"..."}]} — finish; every snippet must occur verbatim in a ` +
    `document you fetched.`;
  const transcript: string[] = [];
  const fetched = new Map<string, string>();
  const now = budget.now ?? Date.now;
  const started = now();
  let steps = 0;
  let tokens = 0;
  let spendUsed = budget.spendUsed;
  const capped = (reason: string): LoopOutcome => ({
    kind: "held",
    flags: ["cap-exceeded"],
    reason,
    tier: client.tier,
    steps,
  });
  while (true) {
    if (steps >= caps.steps || tokens >= caps.tokens) {
      return capped(`caps exhausted after ${steps} step(s)`);
    }
    if (spendUsed >= budget.spendCap) {
      return capped(
        `spend cap reached (${spendUsed} of ${budget.spendCap} tokens)`,
      );
    }
    if (now() - started >= caps.wallMs) {
      return capped(`wall-time budget exhausted after ${steps} step(s)`);
    }
    const prompt = [header, ...transcript].join("\n");
    let raw: string;
    try {
      let reported = 0;
      raw = await client.complete(prompt, (usage) => {
        reported += usage.tokens;
      });
      tokens += reported > 0 ? reported : approxTokens(prompt) + approxTokens(raw);
      if (reported > 0) {
        spendUsed = budget.meter
          ? await budget.meter(reported)
          : spendUsed + reported;
      }
    } catch {
      const floor = await floorLoop(toolbox, angle);
      return { ...floor, tier: "extractive-fallback", steps };
    }
    steps++;
    // The call just paid for pushed the line to its cap: halt here, before
    // another turn is bought, even if this turn carried a final action.
    if (spendUsed >= budget.spendCap) {
      return capped(
        `spend cap reached (${spendUsed} of ${budget.spendCap} tokens)`,
      );
    }
    let action: z.infer<typeof ActionSchema>;
    try {
      action = ActionSchema.parse(JSON.parse(raw));
    } catch {
      const floor = await floorLoop(toolbox, angle);
      return { ...floor, tier: "extractive-fallback", steps };
    }
    if (action.tool === "search") {
      const hits = await toolbox.search(action.query);
      transcript.push(`search "${action.query}" -> ${JSON.stringify(hits)}`);
      continue;
    }
    if (action.tool === "fetch") {
      const doc = await toolbox.fetch(action.doc_id);
      if (doc) fetched.set(doc.doc_id, doc.text);
      transcript.push(
        `fetch ${action.doc_id} -> ${doc ? doc.text.slice(0, 2000) : "not found"}`,
      );
      continue;
    }
    const citations = action.citations.filter((ci) => {
      const key =
        ci.snapshot_id !== undefined && ci.doc_id === undefined
          ? `snapshot:${ci.snapshot_id}`
          : ci.doc_id !== undefined && ci.snapshot_id === undefined
            ? ci.doc_id
            : "";
      const text = fetched.get(key);
      return text !== undefined && text.includes(ci.snippet);
    });
    if (citations.length > 0) {
      return {
        kind: "findings",
        findings: action.findings,
        citations,
        tier: client.tier,
        steps,
      };
    }
    const floor = await floorLoop(toolbox, angle);
    return { ...floor, tier: "extractive-fallback", steps };
  }
}

export type FinishResult =
  | { ok: true; id: string; status: "complete" | "held"; flags: string[] }
  | { ok: false; error: string; detail?: string };

/**
 * The one completion path, shared by the operator route and the workflow:
 * citations are the price of completion, every cited doc must be in the
 * mirror and every snippet must occur verbatim in its gated text, every
 * cited snapshot must still hash to its recorded digest and contain its
 * snippet, and suspicious findings are held rather than stored complete.
 */
export async function finishLine(
  db: D1Database,
  kit: VaultKit,
  lineId: string,
  completion: { citations: Citation[]; findings: string },
): Promise<FinishResult> {
  const line = await db
    .prepare(
      "SELECT id, status, spend_cap, spend_used FROM research_lines WHERE id = ?",
    )
    .bind(lineId)
    .first<{
      id: string;
      status: string;
      spend_cap: number;
      spend_used: number;
    }>();
  if (!line) return { ok: false, error: "not_found" };
  if (line.status !== "running") {
    return { ok: false, error: "bad_state", detail: line.status };
  }
  if (completion.citations.length === 0) {
    return { ok: false, error: "citations_required" };
  }
  if (line.spend_used > line.spend_cap) {
    return { ok: false, error: "over_cap" };
  }
  // Validate each citation against its evidence copy, never against the
  // existence of a row: a corpus snippet must occur verbatim in the mirrored
  // text, and a web snippet must occur in the immutable snapshot the
  // installation fetched — never the live URL, and never a provider's
  // search fragment. A composed quote cannot complete a line either way.
  const citationFlags: string[] = [];
  for (const ci of completion.citations) {
    const isCorpus = ci.doc_id !== undefined && ci.snapshot_id === undefined;
    const isWeb = ci.snapshot_id !== undefined && ci.doc_id === undefined;
    // Exactly one evidence copy per citation: a row naming both (or
    // neither) is ambiguous and never valid.
    if (!isCorpus && !isWeb) {
      return {
        ok: false,
        error: "invalid_citation",
        detail: ci.doc_id ?? ci.snapshot_id ?? "missing",
      };
    }
    if (isWeb) {
      const check = await validateWebCitation(
        db,
        kit,
        ci.snapshot_id as string,
        ci.snippet,
      );
      if (!check.ok) {
        return { ok: false, error: check.error, detail: check.detail };
      }
      citationFlags.push(...check.flags);
      continue;
    }
    const row = await db
      .prepare(
        `SELECT text_envelope FROM corpus_docs WHERE id = ? AND ${MIRRORED}`,
      )
      .bind(ci.doc_id)
      .first<{ text_envelope: string }>();
    if (!row) {
      return { ok: false, error: "unknown_citation", detail: ci.doc_id };
    }
    let text: string;
    try {
      text = await openText(kit, row.text_envelope);
    } catch {
      return { ok: false, error: "invalid_citation", detail: ci.doc_id };
    }
    if (!text.includes(ci.snippet)) {
      return { ok: false, error: "invalid_citation", detail: ci.doc_id };
    }
  }
  const flags = [
    ...new Set([
      ...citationFlags,
      ...flagSuspicious(completion.findings, completion.citations),
    ]),
  ];
  const status = flags.length > 0 ? "held" : "complete";
  await db
    .prepare(
      "UPDATE research_lines SET status = ?, citations_json = ?, findings_envelope = ?, flags_json = ? WHERE id = ?",
    )
    .bind(
      status,
      JSON.stringify(completion.citations),
      await sealText(kit, completion.findings),
      JSON.stringify(flags),
      lineId,
    )
    .run();
  return { ok: true, id: lineId, status, flags };
}

export interface ResearchReceipt {
  line_id: string;
  status: "complete" | "held" | "skipped";
  tier: string;
  steps: number;
  citations: number;
  flags: string[];
  reason: string | null;
  /** Provider-reported tokens recorded on the line's spend row. */
  spend_used: number;
}

function parseStringArray(raw: string | undefined): string[] {
  try {
    const parsed = JSON.parse(raw ?? "[]") as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((t): t is string => typeof t === "string")
      : [];
  } catch {
    return [];
  }
}

function parseExhibits(raw: string | undefined): Citation[] {
  try {
    const parsed = z
      .array(z.object({ doc_id: z.string(), snippet: z.string() }))
      .parse(JSON.parse(raw ?? "[]"));
    return parsed;
  } catch {
    return [];
  }
}

/**
 * Run one research line end to end: read its angle, drive the loop (live
 * or keyless floor), finish through the shared completion path, and record
 * a telemetry turn with the step count and outcome. Already-finished lines
 * are skipped, so a Workflow resume cannot research or bill twice.
 */
export async function runResearchLine(
  db: D1Database,
  kit: VaultKit,
  lineId: string,
  client: ModelClient | null,
  opts: { caps?: LoopCaps; now?: () => number } = {},
): Promise<ResearchReceipt> {
  const caps = opts.caps ?? RESEARCH_CAPS;
  const line = await db
    .prepare(
      "SELECT id, angle_id, status, spend_cap, spend_used FROM research_lines WHERE id = ?",
    )
    .bind(lineId)
    .first<{
      id: string;
      angle_id: string;
      status: string;
      spend_cap: number;
      spend_used: number;
    }>();
  if (!line) {
    return {
      line_id: lineId,
      status: "skipped",
      tier: "none",
      steps: 0,
      citations: 0,
      flags: [],
      reason: "line not found",
      spend_used: 0,
    };
  }
  if (line.status !== "running") {
    return {
      line_id: lineId,
      status: "skipped",
      tier: "none",
      steps: 0,
      citations: 0,
      flags: [],
      reason: `line ${line.status}`,
      spend_used: line.spend_used,
    };
  }
  const angleRow = await db
    .prepare(
      "SELECT title, topics_json, rationale_envelope, exhibits_json FROM angles WHERE id = ?",
    )
    .bind(line.angle_id)
    .first<{
      title: string;
      topics_json: string;
      rationale_envelope: string;
      exhibits_json: string;
    }>();
  let rationale = "";
  try {
    rationale = angleRow
      ? await openText(kit, angleRow.rationale_envelope)
      : "";
  } catch {
    rationale = "";
  }
  const angle: AngleBrief = {
    title: angleRow?.title ?? "Untitled angle",
    topics: parseStringArray(angleRow?.topics_json),
    rationale,
    exhibits: parseExhibits(angleRow?.exhibits_json),
  };
  const toolbox = buildCorpusToolbox(db, kit);
  // Real spend: the operator's per-line cap (falling back to the loop
  // default for legacy rows), metered from provider-reported usage.
  const spendCap = line.spend_cap > 0 ? line.spend_cap : caps.spend;
  let spendUsed = line.spend_used;
  const meter = async (tokens: number): Promise<number> => {
    await db
      .prepare(
        "UPDATE research_lines SET spend_used = spend_used + ? WHERE id = ? AND status = 'running'",
      )
      .bind(tokens, lineId)
      .run();
    spendUsed += tokens;
    return spendUsed;
  };
  const outcome = client
    ? await liveLoop(client, toolbox, angle, caps, {
        spendCap,
        spendUsed,
        meter,
        now: opts.now,
      })
    : await floorLoop(toolbox, angle);

  let receipt: ResearchReceipt;
  let telemetryOutcome: string;
  if (outcome.kind === "findings") {
    const finished = await finishLine(db, kit, lineId, {
      citations: outcome.citations,
      findings: outcome.findings,
    });
    receipt = finished.ok
      ? {
          line_id: lineId,
          status: finished.status,
          tier: outcome.tier,
          steps: outcome.steps,
          citations: outcome.citations.length,
          flags: finished.flags,
          reason: null,
          spend_used: spendUsed,
        }
      : {
          line_id: lineId,
          status: "skipped",
          tier: outcome.tier,
          steps: outcome.steps,
          citations: outcome.citations.length,
          flags: [],
          reason: finished.error,
          spend_used: spendUsed,
        };
    telemetryOutcome = finished.ok ? finished.status : finished.error;
  } else {
    await db
      .prepare(
        "UPDATE research_lines SET status = 'held', flags_json = ? WHERE id = ? AND status = 'running'",
      )
      .bind(JSON.stringify(outcome.flags), lineId)
      .run();
    receipt = {
      line_id: lineId,
      status: "held",
      tier: outcome.tier,
      steps: outcome.steps,
      citations: 0,
      flags: outcome.flags,
      reason: outcome.reason,
      spend_used: spendUsed,
    };
    telemetryOutcome = outcome.flags.includes("cap-exceeded")
      ? "capped"
      : "held";
  }
  await recordTurn(db, {
    tier: receipt.tier,
    toolCalls: outcome.steps,
    label: `line:${line.angle_id}`,
    outcome: telemetryOutcome,
  });
  return receipt;
}
