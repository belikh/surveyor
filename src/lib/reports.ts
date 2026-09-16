// Report domain: gate evaluation, five deterministic renderers, two-tier
// update routing. Renderers are extractive scaffolds over the same
// evidence bundle; the LLM prose pass for long-form runs at serving time
// and its output stays fenced. Every render carries provenance.

import { z } from "zod";
import { DEFAULT_CADENCE_MS } from "./schedule";

export const GateConfigSchema = z.object({
  /** Manual approval gates by default; opt-out is explicit. */
  manual_required: z.boolean().default(true),
  approved: z.boolean().default(false),
  /** Publish uncited journalist-pass claims (annotated) instead of stripping. */
  allow_uncited: z.boolean().default(false),
  min_submissions: z.number().int().min(0).optional(),
  min_evidence: z.number().int().min(0).optional(),
  publish_after: z.string().datetime().optional(),
  frequency: z
    .enum(["manual", "scheduled", "per-n", "full-dynamic"])
    .default("scheduled"),
  /** Digest cadence for scheduled; submission threshold for per-n. */
  cadence_ms: z.number().int().positive().default(DEFAULT_CADENCE_MS),
  threshold_n: z.number().int().positive().default(5),
});
export type GateConfig = z.infer<typeof GateConfigSchema>;

export interface ExhibitRef {
  doc_id: string;
  snippet: string;
}

export const ExhibitRefSchema = z.object({
  doc_id: z.string().min(1).max(128),
  snippet: z.string().min(1).max(2000),
});

export interface EvidenceAngle {
  title: string;
  exhibits: ExhibitRef[];
}

export interface EvidenceLine {
  id: string;
  title: string;
  citations: ExhibitRef[];
  /** Retained suspicion flags (reviewed-approved lines carry them visibly). */
  flags: string[];
  created_at: string;
}

export interface Evidence {
  submissions: number;
  addenda: number;
  corpusDocs: number;
  heldDocs: number;
  corroborations: number;
  angles: EvidenceAngle[];
  lines: EvidenceLine[];
  started_at: string;
  now: string;
}

export interface GateVerdict {
  ok: boolean;
  unmet: string[];
}

/** All enabled gates must be satisfied; manual approval is one of them
 *  unless the operator explicitly opted out. */
export function evaluateGates(
  config: GateConfig,
  evidence: Evidence,
): GateVerdict {
  const unmet: string[] = [];
  if (config.manual_required && !config.approved) {
    unmet.push("manual-approval");
  }
  if (
    config.min_submissions !== undefined &&
    evidence.submissions < config.min_submissions
  ) {
    unmet.push("min-submissions");
  }
  const evidenceCount =
    evidence.corpusDocs +
    evidence.lines.reduce((n, l) => n + l.citations.length, 0);
  if (config.min_evidence !== undefined && evidenceCount < config.min_evidence) {
    unmet.push("min-evidence");
  }
  if (
    config.publish_after !== undefined &&
    evidence.now < config.publish_after
  ) {
    unmet.push("publish-after");
  }
  return { ok: unmet.length === 0, unmet };
}

export interface RenderedDoc {
  type: string;
  body: string;
  provenance: "untrusted";
}

/** Render caps: unbounded corpus text must never inflate a report. */
const MAX_LINES = 50;
const MAX_TITLE = 200;
const MAX_SNIPPET = 500;

function cap(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function cites(line: EvidenceLine): string {
  const flagMark =
    line.flags.length > 0 ? ` [flagged: ${line.flags.map((f) => cap(f, 64)).join(", ")}]` : "";
  return (
    line.citations
      .slice(0, MAX_LINES)
      .map((c) => `[${cap(c.doc_id, MAX_TITLE)}: ${cap(c.snippet, MAX_SNIPPET)}]`)
      .join(" ") + flagMark
  );
}

export function renderBriefing(e: Evidence): RenderedDoc {
  const lines = e.lines
    .slice(0, MAX_LINES)
    .map((l) => `- ${cap(l.title, MAX_TITLE)} (${l.citations.length} citations)`)
    .join("\n");
  return {
    type: "briefing",
    provenance: "untrusted",
    body:
      `Live briefing — ${e.submissions} submissions, ${e.corpusDocs} corpus documents, ` +
      `${e.corroborations} corroborations.\n` +
      (lines || "No research lines complete yet."),
  };
}

export function renderDossier(e: Evidence): RenderedDoc {
  const claims = e.lines
    .slice(0, MAX_LINES)
    .map((l) => `## ${cap(l.title, MAX_TITLE)}\n${cites(l)}`)
    .join("\n\n");
  return {
    type: "dossier",
    provenance: "untrusted",
    body: `# Evidence dossier\n\n${claims || "No cited claims yet."}`,
  };
}

export function renderTimeline(e: Evidence): RenderedDoc {
  const rows = [...e.lines]
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .slice(0, MAX_LINES)
    .map((l) => `- ${l.created_at.slice(0, 10)}: ${cap(l.title, MAX_TITLE)}`)
    .join("\n");
  return {
    type: "timeline",
    provenance: "untrusted",
    body: `# Timeline (investigation opened ${e.started_at.slice(0, 10)})\n\n${rows || "Nothing dated yet."}`,
  };
}

export function renderSnapshot(e: Evidence): RenderedDoc {
  const citations = e.lines.reduce((n, l) => n + l.citations.length, 0);
  return {
    type: "snapshot",
    provenance: "untrusted",
    body:
      `# Data snapshot\n\n- Submissions: ${e.submissions} (+${e.addenda} addenda)\n` +
      `- Corpus documents: ${e.corpusDocs} parsed, ${e.heldDocs} held\n- Angles: ${e.angles.length}\n` +
      `- Research lines: ${e.lines.length}\n- Citations: ${citations}\n` +
      `- Corroborations: ${e.corroborations}`,
  };
}

export function renderLongform(e: Evidence): RenderedDoc {
  const sections = e.lines
    .slice(0, MAX_LINES)
    .map((l) => `## ${cap(l.title, MAX_TITLE)}\n\n[Exhibit-backed draft pending journalist pass.]\n${cites(l)}`)
    .join("\n\n");
  return {
    type: "longform",
    provenance: "untrusted",
    body:
      `# Investigation (scaffold draft — prose pass pending)\n\n${sections || "No sections yet."}`,
  };
}

export const RENDERERS: Record<string, (e: Evidence) => RenderedDoc> = {
  briefing: renderBriefing,
  dossier: renderDossier,
  timeline: renderTimeline,
  snapshot: renderSnapshot,
  longform: renderLongform,
};

export const REPORT_TYPES = Object.keys(RENDERERS);
