import { describe, it, expect } from "vitest";
import {
  dueCheck,
  DEFAULT_CADENCE_MS,
  type ReportPolicy,
  type ReportStats,
} from "../src/lib/schedule";

const NOW = "2026-09-16T12:00:00Z";

function policy(over: Partial<ReportPolicy> = {}): ReportPolicy {
  return {
    type: "briefing",
    frequency: "scheduled",
    last_rendered_at: "2026-09-15T12:00:00Z",
    last_count: 10,
    cadence_ms: DEFAULT_CADENCE_MS,
    threshold_n: 5,
    ...over,
  };
}

function stats(over: Partial<ReportStats> = {}): ReportStats {
  return { submissions: 10, ...over };
}

describe("dueCheck", () => {
  it("manual never fires", () => {
    const r = dueCheck(
      policy({ frequency: "manual", last_rendered_at: "2020-01-01T00:00:00Z" }),
      stats({ submissions: 999 }),
      NOW,
    );
    expect(r.due).toBe(false);
    expect(r.reason).toMatch(/manual/i);
  });

  it("scheduled fires past cadence, skips within it", () => {
    expect(dueCheck(policy(), stats(), NOW).due).toBe(true);
    expect(
      dueCheck(
        policy({ last_rendered_at: "2026-09-16T11:00:00Z" }),
        stats(),
        NOW,
      ).due,
    ).toBe(false);
  });

  it("per-n fires at threshold only", () => {
    expect(
      dueCheck(policy({ frequency: "per-n", last_count: 10 }), stats({ submissions: 14 }), NOW).due,
    ).toBe(false);
    expect(
      dueCheck(policy({ frequency: "per-n", last_count: 10 }), stats({ submissions: 15 }), NOW).due,
    ).toBe(true);
  });

  it("full-dynamic fires on any change and carries the danger marking", () => {
    const changed = dueCheck(
      policy({ frequency: "full-dynamic", last_count: 10 }),
      stats({ submissions: 11 }),
      NOW,
    );
    expect(changed.due).toBe(true);
    expect(changed.danger).toBe(true);
    const still = dueCheck(
      policy({ frequency: "full-dynamic", last_count: 10 }),
      stats({ submissions: 10 }),
      NOW,
    );
    expect(still.due).toBe(false);
  });
});
