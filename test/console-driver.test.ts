// Console driver tests (#67) over the DOM-stub seam. They assert external
// behaviour only: what renders, which controls exist, which requests go out,
// what a confirmation requires — never driver internals.

import { describe, it, expect } from "vitest";
import {
  bootConsole,
  type Responder,
  type StubResponse,
} from "./helpers/console-dom";

const STATUS = {
  degraded: false,
  warning: null,
  provisioned: true,
  operator_token_set: true,
  build: { commit: "abc1234", local: false },
};

function responder(routes: Record<string, StubResponse>): Responder {
  return (path) => {
    const clean = path.split("?")[0];
    if (Object.hasOwn(routes, clean)) return routes[clean];
    throw new Error(`unstubbed fetch: ${path}`);
  };
}

const emptyLists: Record<string, StubResponse> = {
  "/api/status": { body: STATUS },
  "/api/submissions": { body: { submissions: [] } },
  "/api/corpus": { body: { docs: [] } },
  "/api/engine/angles": { body: { angles: [] } },
  "/api/engine/lines": { body: { lines: [] } },
  "/api/reports": { body: { types: [] } },
  "/api/providers": { body: { entries: [], degraded: true, warning: null } },
};

function authOf(call: { init?: RequestInit }): string | undefined {
  return (call.init?.headers as Record<string, string> | undefined)?.authorization;
}

describe("console boot and gating (F3, #67)", () => {
  it("never shows a green status when /api/status cannot be read", async () => {
    const h = await bootConsole(() => {
      throw new Error("network down");
    });
    expect(h.text()).toContain("Status unknown");
    expect(h.text()).not.toContain("Provisioned");
  });

  it("states an unprovisioned installation plainly and links to /setup", async () => {
    const h = await bootConsole(
      responder({
        "/api/status": {
          body: {
            degraded: true,
            warning: "Not provisioned — open the wizard to boot the installation.",
            provisioned: false,
            operator_token_set: false,
            build: { commit: "deadbeef", local: false },
          },
        },
      }),
    );
    expect(h.text()).toContain("Not provisioned");
    expect(h.text()).toContain("deadbeef");
    expect(h.text()).toContain("/setup");
    // Only the public status call left the page.
    expect(h.calls.map((c) => c.path)).toEqual(["/api/status"]);
  });

  it("fires no list request until the operator token is set", async () => {
    const h = await bootConsole(responder(emptyLists));
    expect(h.calls.map((c) => c.path)).toEqual(["/api/status"]);
    expect(h.text()).toContain("Set the operator token above");
    // A gated section renders the gate, not the controls.
    await h.setToken("op-token");
    const paths = h.calls.map((c) => c.path);
    for (const expected of [
      "/api/submissions",
      "/api/corpus",
      "/api/engine/angles",
      "/api/engine/lines",
      "/api/reports",
    ]) {
      expect(paths, expected).toContain(expected);
    }
    // Every request after the first status call carries the bearer token.
    for (const call of h.calls.slice(1)) {
      expect(authOf(call), call.path).toBe("Bearer op-token");
    }
  });

  it("renders no corpus controls while gated (#corpus)", async () => {
    const h = await bootConsole(responder(emptyLists), { hash: "#corpus" });
    expect(h.buttons().map((b) => b.text())).not.toContain("Upload files");
    expect(h.text()).toContain("Operator token required");
    expect(h.calls.map((c) => c.path)).toEqual(["/api/status"]);
  });
});

describe("console sections (#67)", () => {
  it("renders home counts and decision links", async () => {
    const h = await bootConsole(
      responder({
        ...emptyLists,
        "/api/status": { body: STATUS },
        "/api/submissions": {
          body: {
            submissions: [
              { id: "s-1", status: "open", round: 1, created_at: "2026-01-01T00:00:00Z", last_activity: "2026-01-02T00:00:00Z", consent_captures: 1, consent: [], attachments: { total: 1, settled: 0, held: 1, raw_retained: 1 } },
            ],
          },
        },
        "/api/corpus": {
          body: {
            docs: [
              { id: "d-1", filename: "notes.txt", lane: "native", status: "parsed", verdict: "clean", reason: null },
            ],
          },
        },
        "/api/engine/angles": {
          body: {
            angles: [
              { id: "a-1", title: "Roster timing", rank: 0, status: "queued", flags: [], exhibits: [], created_at: "" },
            ],
          },
        },
        "/api/engine/lines": {
          body: {
            lines: [
              { id: "l-1", angle_id: "a-1", angle_title: "Roster timing", status: "held", spend_cap: 100, spend_used: 5, citation_count: 2, flags: ["injection"], created_at: "" },
            ],
          },
        },
        "/api/reports": {
          body: {
            types: [
              { type: "briefing", enabled: true, status: "draft", current_version: 2, pending_version: 3, frequency: "scheduled", cadence_ms: 86400000, threshold_n: 5, manual_required: true, allow_uncited: false, approved: false, approved_at: null, gates: { ok: true, unmet: [] } },
            ],
          },
        },
      }),
    );
    await h.setToken("op-token");
    expect(h.text()).toContain("Angles awaiting review");
    expect(h.text()).toContain("Reports published");
    expect(h.text()).toContain("Engine — angles awaiting a decision");
    expect(h.text()).toContain("Submissions — source traffic");
  });

  it("renders the corpus by lane and renders the API's error token", async () => {
    const h = await bootConsole(
      responder({
        ...emptyLists,
        "/api/corpus": {
          body: {
            docs: [
              { id: "d-1", filename: "minutes.txt", lane: "native", status: "parsed", verdict: "clean", reason: null },
              { id: "d-2", filename: "scan.pdf", lane: "held-ocr", status: "held", verdict: "pending", reason: "no vision provider configured" },
            ],
          },
        },
        "/api/corpus/drain": {
          body: { drained: 1, outcomes: [{ id: "d-2", status: "held", reason: "no vision provider configured" }] },
        },
      }),
      { hash: "#corpus" },
    );
    await h.setToken("op-token");
    expect(h.text()).toContain("minutes.txt");
    expect(h.text()).toContain("scan.pdf");
    expect(h.text()).toContain("Mirror");
    expect(h.text()).toContain("Held lanes");
    expect(h.text()).toContain("no vision provider configured");
    await h.click("Drain held documents");
    const drain = h.calls.find((c) => c.path === "/api/corpus/drain");
    expect(drain?.init?.method).toBe("POST");

    const bad = await bootConsole(
      responder({
        ...emptyLists,
        "/api/corpus": { status: 401, body: { error: "unauthorised" } },
      }),
      { hash: "#corpus" },
    );
    await bad.setToken("wrong-token");
    expect(bad.text()).toContain("unauthorised");
  });

  it("renders a flagged angle as held and offers review, not approval", async () => {
    const h = await bootConsole(
      responder({
        ...emptyLists,
        "/api/engine/angles": {
          body: {
            angles: [
              { id: "a-held", title: "Suspicious angle", rank: 0, status: "held", flags: ["injection"], exhibits: [], created_at: "" },
              { id: "a-open", title: "Clean angle", rank: 1, status: "queued", flags: [], exhibits: [], created_at: "" },
            ],
          },
        },
      }),
      { hash: "#engine" },
    );
    await h.setToken("op-token");
    expect(h.text()).toContain("injection");
    const labels = h.buttons().map((b) => b.text().trim());
    expect(labels).toContain("Review — approve");
    expect(labels).toContain("Review — reject");
    // The held angle is never offered plain approval.
    expect(labels.filter((l) => l === "Approve")).toHaveLength(1);
    await h.click("Review — approve");
    const review = h.calls.find(
      (c) => c.path === "/api/engine/angles/a-held/review",
    );
    expect(review?.init?.method).toBe("POST");
  });

  it("renders empty states honestly", async () => {
    const subs = await bootConsole(responder(emptyLists), {
      hash: "#submissions",
    });
    await subs.setToken("op-token");
    expect(subs.text()).toContain("No submissions yet");

    const engine = await bootConsole(responder(emptyLists), {
      hash: "#engine",
    });
    await engine.setToken("op-token");
    expect(engine.text()).toContain("No angles proposed yet");
    expect(engine.text()).toContain("No research lines yet");
  });
});

describe("console human gates (#67)", () => {
  const reportsRoute: StubResponse = {
    body: {
      types: [
        { type: "briefing", enabled: true, status: "draft", current_version: 0, pending_version: 1, frequency: "manual", cadence_ms: 86400000, threshold_n: 5, manual_required: true, allow_uncited: false, approved: false, approved_at: null, gates: { ok: false, unmet: ["manual-approval"] } },
      ],
    },
  };

  it("publish demands confirmation naming the pending version", async () => {
    const h = await bootConsole(
      responder({ ...emptyLists, "/api/reports": reportsRoute }),
      { hash: "#reports", confirm: () => false },
    );
    await h.setToken("op-token");
    await h.click("Publish v1");
    expect(h.confirms[0]).toContain("version 1");
    expect(
      h.calls.some((c) => c.path === "/api/reports/briefing/publish"),
    ).toBe(false);
  });

  it("reveal requires who and why, and a confirmation", async () => {
    const routes: Record<string, StubResponse> = {
      "/api/status": { body: STATUS },
      "/api/submissions": { body: { submissions: [] } },
      "/api/intake/consent/coverage": {
        body: { captures: 0, submissions: 0, by_version: [], categories: [], gaps: [] },
      },
      "/api/intake/entities/groups": { body: { groups: [] } },
      "/api/intake/entities/links": { body: { links: [] } },
      "/api/intake/entities/reveals": { body: { reveals: [] } },
      "/api/intake/entities/reveal": {
        status: 201,
        body: { name: "Ada Example", reveal: {} },
      },
    };
    let allow = false;
    const h = await bootConsole(responder(routes), {
      hash: "#submissions",
      confirm: () => allow,
    });
    await h.setToken("op-token");
    await h.click("Reveal name");
    expect(
      h.calls.some((c) => c.path === "/api/intake/entities/reveal"),
    ).toBe(false);
    expect(h.text()).toContain("All three fields are required");

    const byPlaceholder = (p: string) =>
      h.inputs().find((i) => (i.attrs.placeholder || "").includes(p))!;
    byPlaceholder("Entity HMAC").value = "a".repeat(64);
    byPlaceholder("Revealed by").value = "J. Operator";
    byPlaceholder("Reason").value = "Legal review";
    // Confirmation refused: still nothing leaves the page.
    await h.click("Reveal name");
    expect(
      h.calls.some((c) => c.path === "/api/intake/entities/reveal"),
    ).toBe(false);
    // Confirmed: the reveal is a POST carrying who and why.
    allow = true;
    await h.click("Reveal name");
    const reveal = h.calls.find(
      (c) => c.path === "/api/intake/entities/reveal",
    );
    expect(reveal?.init?.method).toBe("POST");
    expect(String(reveal?.init?.body)).toContain("J. Operator");
    expect(String(reveal?.init?.body)).toContain("Legal review");
  });

  it("teardown demands an explicit confirmation and reports the receipt", async () => {
    const h = await bootConsole(
      responder({
        ...emptyLists,
        "/api/launch-pack": {
          body: {
            submissions_url: "https://survey.example/s/abc",
            qr_square_svg: "<svg></svg>",
            qr_story_svg: "<svg></svg>",
            copy_short: "copy",
            copy_long: "copy",
            copy_dm: "copy",
            alt_text: "alt",
          },
        },
        "/api/telemetry": { body: [] },
        "/api/teardown": {
          body: {
            wiped: { d1: "deleted" },
            not_wiped: ["cloudflare-account-logs-and-analytics (outside our control)"],
          },
        },
      }),
      { hash: "#launch", confirm: () => false },
    );
    await h.setToken("op-token");
    await h.click("Uninstall the installation");
    expect(h.confirms[0]).toContain("cannot be undone");
    expect(h.calls.some((c) => c.path === "/api/teardown")).toBe(false);
  });
});
