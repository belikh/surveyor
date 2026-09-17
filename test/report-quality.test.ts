import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DOCS,
  GAPS,
  HELD_STRINGS,
  LINES,
  MARKER_SCRIPTED,
  PATHS,
  REPRODUCE_COMMAND,
  SCRIPTED,
  bodyCitations,
  citationResolves,
  runEvaluation,
  type QualityResults,
} from "./helpers/report-quality";
import { REPORT_TYPES } from "../src/lib/reports";
import { injectionFlags } from "../src/lib/engine";

// D9 (#52): the report-quality evaluation is a measured runbook, not a unit
// test. These guards keep it honest:
//   - a fresh run is deterministic, so its numbers reproduce;
//   - the committed evidence is exactly a fresh run of the committed fixtures;
//   - the pipeline never delivers a quote its source does not contain, never
//     leaks a held line, and never publishes a marker or an uncited claim;
//   - the live-model lanes appear as explicit gaps, never as fabricated
//     numbers.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = path.join(root, "evidence/report-quality/results.json");

function committed(): QualityResults & {
  run_at?: string;
  environment?: Record<string, string>;
} {
  return JSON.parse(readFileSync(EVIDENCE, "utf8"));
}

const NON_SNAPSHOT = REPORT_TYPES.filter((t) => t !== "snapshot");

describe("report-quality evaluation (D9, #52)", () => {
  it("parses rendered citations exactly and validates them against the mirror", () => {
    expect(
      bodyCitations(
        "Claim. [doc-roster: penalty rates were disputed] [doc-minutes: a snippet]",
      ),
    ).toEqual([
      { doc_id: "doc-roster", snippet: "penalty rates were disputed" },
      { doc_id: "doc-minutes", snippet: "a snippet" },
    ]);
    // The flag marker and the uncited annotation are not citations.
    expect(bodyCitations("[flagged: injection-marker:system prompt]")).toEqual([]);
    expect(bodyCitations("[uncited]")).toEqual([]);

    expect(
      citationResolves({ doc_id: "doc-roster", snippet: "penalty rates were disputed" }),
    ).toBe(true);
    // A snippet absent from its document, an unknown document and a held
    // (unmirrored) document all fail validation.
    expect(
      citationResolves({
        doc_id: "doc-roster",
        snippet: "the union threatened industrial action",
      }),
    ).toBe(false);
    expect(citationResolves({ doc_id: "doc-unknown", snippet: "anything" })).toBe(false);
    expect(
      citationResolves({ doc_id: "doc-scan", snippet: "fourteen late payments" }),
    ).toBe(false);
  });

  it("declares a fixture truth that the mirror bears out", () => {
    for (const spec of [...SCRIPTED, ...MARKER_SCRIPTED]) {
      for (const claim of spec.claims) {
        const resolved = claim.citations.filter((c) => citationResolves(c));
        switch (claim.kind) {
          case "grounded":
          case "marker":
            expect(resolved.length, `${spec.id} ${claim.text}`).toBeGreaterThan(0);
            break;
          case "fabricated-snippet":
          case "unknown-doc":
          case "held-doc":
          case "uncited":
            expect(resolved.length, `${spec.id} ${claim.text}`).toBe(0);
            break;
        }
      }
    }
    expect(DOCS.some((d) => d.status === "held")).toBe(true);
    expect(LINES.some((l) => l.status === "held" && l.flags.length > 0)).toBe(true);
    expect(HELD_STRINGS.length).toBeGreaterThan(0);

    // Every fixture snippet is short enough to render untruncated and safe
    // for the citation parser, so the fidelity metric is not confounded by
    // display caps or bracket bytes.
    const citations = [
      ...LINES.flatMap((l) => l.citations),
      ...[...SCRIPTED, ...MARKER_SCRIPTED].flatMap((s) =>
        s.claims.flatMap((c) => c.citations),
      ),
    ];
    for (const c of citations) {
      expect(c.snippet.length).toBeLessThanOrEqual(500);
      expect(c.snippet).not.toMatch(/[\[\]]/);
      expect(c.doc_id).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("is deterministic: a fresh run repeats exactly", async () => {
    const first = await runEvaluation();
    const second = await runEvaluation();
    expect(second).toEqual(first);
  });

  it("never delivers a fabricated quote, a leaked held line or a marker", async () => {
    const results = await runEvaluation();
    for (const m of results.measurements) {
      const where = `${m.path}/${m.report_type}`;
      expect(m.error, where).toBeNull();
      expect(m.fabricated_quotes_delivered, where).toBe(0);
      if (m.quote_fidelity !== null) expect(m.quote_fidelity, where).toBe(1);
      expect(m.held_content_leaked, where).toBe(false);
      expect(m.marker_in_body, where).toBe(false);
      // The positive control proves the body is not vacuous: an empty report
      // would otherwise pass the leak checks trivially.
      expect(m.control_present, where).toBe(true);
    }
    for (const s of results.summary) expect(s.held_content_leaks, s.path).toBe(0);
  });

  it("annotates uncited claims in drafts and strips them on publish", async () => {
    const results = await runEvaluation();
    const find = (pathId: string, type: string) =>
      results.measurements.find((m) => m.path === pathId && m.report_type === type)!;

    for (const type of NON_SNAPSHOT) {
      const draft = find("journalist-draft", type);
      const unsupported = draft.claims_proposed - draft.claims_supportable;
      expect(unsupported, type).toBeGreaterThan(0);
      // Drafts deliver every claim; the unsupported ones carry the marker.
      expect(draft.claims_delivered, type).toBe(draft.claims_proposed);
      expect(draft.claims_delivered_unsupported, type).toBe(unsupported);
      expect(draft.uncited_markers, type).toBe(unsupported);
      expect(draft.claim_coverage, type).toBe(1);

      const published = find("publish-version", type);
      // Publish keeps every supportable claim and no unsupported one.
      expect(published.claims_delivered, type).toBe(published.claims_supportable);
      expect(published.claims_delivered_unsupported, type).toBe(0);
      expect(published.uncited_markers, type).toBe(0);
      expect(published.claim_coverage, type).toBe(1);
      expect(published.citations_delivered, type).toBe(published.citations_valid);
      expect(published.version, type).toBe(1);
    }

    // Snapshot is lead-only by design (ADR-0010): no claims, and the lead
    // is present in both the draft and the published version.
    for (const pathId of ["journalist-draft", "publish-version"]) {
      const snapshot = find(pathId, "snapshot");
      expect(snapshot.claims_proposed).toBe(0);
      expect(snapshot.claim_coverage).toBeNull();
      expect(snapshot.lead_delivered).toBe(true);
    }
  });

  it("rejects the whole model prose when a marker rides in it", async () => {
    const results = await runEvaluation();
    const fallbacks = results.measurements.filter(
      (m) => m.path === "publish-marker-fallback",
    );
    expect(fallbacks).toHaveLength(REPORT_TYPES.length);
    for (const m of fallbacks) {
      expect(m.outcome).toBe("deterministic-fallback");
      expect(m.marker_in_body).toBe(false);
      expect(m.control_present).toBe(true);
    }
    // The fixture really does carry a marker the production check flags, so
    // the fallback rows are not passing vacuously.
    for (const spec of MARKER_SCRIPTED) {
      expect(injectionFlags(JSON.stringify(spec.output)).length).toBeGreaterThan(0);
    }
  });

  it("measures every report type through every published path", async () => {
    const results = await runEvaluation();
    for (const type of REPORT_TYPES) {
      for (const p of PATHS) {
        expect(
          results.measurements.find(
            (m) => m.report_type === type && m.path === p.id,
          ),
          `${type}/${p.id}`,
        ).toBeDefined();
      }
    }
    // Every model-prose measurement names the scripted fixture it used;
    // nothing claims a live provider.
    for (const m of results.measurements) {
      if (m.outcome === "model-prose") {
        expect(m.scripted).toMatch(/^scripted-/);
      }
    }
  });

  it("publishes evidence that reproduces: committed results match a fresh run", async () => {
    const fresh = await runEvaluation();
    const stored = committed();
    expect(stored.reproduce).toBe(REPRODUCE_COMMAND);
    expect(stored.version).toBe(1);
    expect(stored.investigation).toEqual(fresh.investigation);
    expect(stored.measurements).toEqual(fresh.measurements);
    expect(stored.summary).toEqual(fresh.summary);
    expect(stored.gaps).toEqual(GAPS);
  });

  it("records the live-model lanes as explicit, unmeasured gaps", () => {
    const stored = committed();
    expect(stored.gaps.length).toBeGreaterThan(0);
    for (const gap of stored.gaps) {
      expect(gap.reason).toMatch(/live/i);
      expect(gap.measured).toBe(false);
      expect(gap).not.toHaveProperty("citation_accuracy");
      expect(gap).not.toHaveProperty("quote_fidelity");
    }
  });
});
