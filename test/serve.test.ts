import { describe, it, expect } from "vitest";
import {
  proposeAnglesLive,
  judgeSignificanceLive,
  type ModelClient,
  type Turn,
} from "../src/lib/serve";

const docs = [
  { doc_id: "d1", text: "Rosters are posted late on Tuesdays" },
  { doc_id: "d2", text: "Late rosters wreck sleep and family life" },
];

function turns() {
  const seen: Turn[] = [];
  return {
    seen,
    record: async (t: Turn) => {
      seen.push(t);
    },
  };
}

const goodClient: ModelClient = {
  tier: "test-model",
  complete: async () =>
    JSON.stringify({
      angles: [
        {
          title: "Late rosters",
          rationale: "Two exhibits agree.",
          exhibits: [
            { doc_id: "d1", snippet: "posted late" },
            { doc_id: "d2", snippet: "Late rosters" },
          ],
        },
      ],
    }),
};

describe("proposeAnglesLive", () => {
  it("returns grounded model angles with telemetry", async () => {
    const t = turns();
    const r = await proposeAnglesLive(goodClient, docs, ["roster"], t.record);
    expect(r.tier).toBe("test-model");
    expect(r.angles).toHaveLength(1);
    expect(r.angles[0].exhibits).toHaveLength(2);
    expect(t.seen).toEqual([
      { tier: "test-model", toolCalls: 0, label: "angles-live" },
    ]);
  });

  it("drops ungrounded exhibits and angles, never persists them", async () => {
    const bad: ModelClient = {
      tier: "test-model",
      complete: async () =>
        JSON.stringify({
          angles: [
            {
              title: "Invented",
              rationale: "Nope.",
              exhibits: [{ doc_id: "ghost", snippet: "nothing" }],
            },
            {
              title: "Half real",
              rationale: "One real exhibit.",
              exhibits: [
                { doc_id: "d1", snippet: "posted late" },
                { doc_id: "ghost", snippet: "nothing" },
              ],
            },
          ],
        }),
    };
    const t = turns();
    const r = await proposeAnglesLive(bad, docs, ["roster"], t.record);
    expect(r.angles.map((a) => a.title)).toEqual(["Half real"]);
    expect(r.angles[0].exhibits).toHaveLength(1);
    // Two ghost exhibits plus the angle left exhibit-free.
    expect(r.dropped).toBe(3);
  });

  it("degrades to the extractive floor when the model fails", async () => {
    const dead: ModelClient = {
      tier: "test-model",
      complete: async () => {
        throw new Error("overloaded");
      },
    };
    const t = turns();
    const r = await proposeAnglesLive(dead, docs, ["roster"], t.record);
    expect(r.tier).toBe("extractive-fallback");
    expect(r.angles.length).toBeGreaterThan(0);
    expect(t.seen.map((x) => x.tier)).toContain("extractive-fallback");
  });
});

describe("judgeSignificanceLive", () => {
  it("narrows but never widens the deterministic set", async () => {
    const narrow: ModelClient = {
      tier: "test-model",
      complete: async () => JSON.stringify({ keep: ["pay"] }),
    };
    const t = turns();
    const r = await judgeSignificanceLive(
      narrow,
      ["pay", "hours"],
      new Set(["roster"]),
      t.record,
    );
    expect(r.topics).toEqual(["pay"]);
    // Model invents "aliens": intersected out, ledger violation impossible.
    const wild: ModelClient = {
      tier: "test-model",
      complete: async () => JSON.stringify({ keep: ["pay", "aliens"] }),
    };
    const r2 = await judgeSignificanceLive(
      wild,
      ["pay"],
      new Set(["roster"]),
      t.record,
    );
    expect(r2.topics).toEqual(["pay"]);
  });

  it("falls back to the floor when the model fails", async () => {
    const dead: ModelClient = {
      tier: "test-model",
      complete: async () => {
        throw new Error("timeout");
      },
    };
    const t = turns();
    const r = await judgeSignificanceLive(
      dead,
      ["pay"],
      new Set(["roster"]),
      t.record,
    );
    expect(r.topics).toEqual(["pay"]);
    expect(r.tier).toBe("ledger-floor");
  });
});
