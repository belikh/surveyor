import { describe, it, expect } from "vitest";
import {
  GateConfigSchema,
  evaluateGates,
  renderBriefing,
  renderDossier,
  renderTimeline,
  renderSnapshot,
  renderLongform,
  type Evidence,
  type GateConfig,
} from "../src/lib/reports";

function ev(): Evidence {
  return {
    submissions: 12,
    addenda: 2,
    corpusDocs: 5,
    heldDocs: 1,
    corroborations: 4,
    angles: [
      { title: "Angle: roster", exhibits: [{ doc_id: "d1", snippet: "late" }] },
    ],
    lines: [
      {
        id: "l1",
        title: "Angle: roster",
        citations: [{ doc_id: "d1", snippet: "late" }],
        flags: [],
        created_at: "2026-09-01T00:00:00Z",
      },
    ],
    started_at: "2026-08-01T00:00:00Z",
    now: "2026-09-16T00:00:00Z",
  };
}

function gates(over: object = {}): GateConfig {
  return GateConfigSchema.parse({ manual_required: true, approved: false, ...over });
}

describe("evaluateGates", () => {
  it("blocks without manual approval by default", () => {
    const r = evaluateGates(gates(), ev());
    expect(r.ok).toBe(false);
    expect(r.unmet).toContain("manual-approval");
  });

  it("publishes on approval", () => {
    expect(evaluateGates(gates({ approved: true }), ev()).ok).toBe(true);
  });

  it("automatic gates combine when explicitly enabled", () => {
    const cfg = gates({
      approved: false,
      manual_required: false,
      min_submissions: 10,
      min_evidence: 1,
    });
    expect(evaluateGates(cfg, ev()).ok).toBe(true);
    expect(
      evaluateGates(gates({ manual_required: false, min_submissions: 50 }), ev())
        .unmet,
    ).toContain("min-submissions");
  });

  it("elapsed-time gate respects publish_after", () => {
    const cfg = gates({
      manual_required: false,
      publish_after: "2026-10-01T00:00:00Z",
    });
    expect(evaluateGates(cfg, ev()).unmet).toContain("publish-after");
    const past = gates({
      manual_required: false,
      publish_after: "2026-08-15T00:00:00Z",
    });
    expect(evaluateGates(past, ev()).ok).toBe(true);
  });
});

describe("renderers", () => {
  it("all five render from the same evidence with provenance", () => {
    const e = ev();
    for (const doc of [
      renderBriefing(e),
      renderDossier(e),
      renderTimeline(e),
      renderSnapshot(e),
      renderLongform(e),
    ]) {
      expect(doc.provenance).toBe("untrusted");
      expect(doc.body.length).toBeGreaterThan(0);
    }
  });

  it("dossier binds every claim to exhibits", () => {
    const d = renderDossier(ev());
    expect(d.body).toContain("d1");
    expect(d.body).toContain("late");
  });

  it("timeline orders by creation time", () => {
    const t = renderTimeline(ev());
    expect(t.body.indexOf("2026-09-01")).toBeGreaterThan(-1);
  });

  it("snapshot counts match the evidence", () => {
    const s = renderSnapshot(ev());
    expect(s.body).toContain("12");
    expect(s.body).toContain("5");
    expect(s.body).toContain("4");
  });

  it("long-form marks its scaffold honestly", () => {
    const l = renderLongform(ev());
    expect(l.body).toMatch(/scaffold/i);
  });
});
