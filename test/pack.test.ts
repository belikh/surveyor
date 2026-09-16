import { describe, it, expect } from "vitest";
import { auditPack, type LaunchPack } from "../src/lib/pack";

function goodPack(): LaunchPack {
  return {
    submissions_url: "https://survey.example/s/abc123",
    qr_square_svg: "<svg>qr</svg>",
    qr_story_svg: "<svg>qr-tall</svg>",
    copy_short: "Current or former staff: an independent anonymous survey is open. No accounts, no tracking. https://survey.example/s/abc123",
    copy_long:
      "An anonymous survey is collecting testimony. Submissions are encrypted before storage and identifying details are never kept. https://survey.example/s/abc123",
    copy_dm: "Hi — this anonymous survey may matter to you: https://survey.example/s/abc123",
    alt_text: "QR code linking to an anonymous survey",
  };
}

describe("auditPack", () => {
  it("passes a clean pack with all seven assets", () => {
    expect(auditPack(goodPack(), [])).toEqual({ ok: true });
  });

  it("rejects tracking parameters in the URL", () => {
    const p = goodPack();
    p.submissions_url = "https://survey.example/s/abc123?utm_source=x";
    const r = auditPack(p, []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/tracking/i);
  });

  it("rejects known tracking params even without values", () => {
    const p = goodPack();
    p.submissions_url = "https://survey.example/s/abc123?fbclid=zzz";
    expect(auditPack(p, []).ok).toBe(false);
  });

  it("rejects operator identity terms anywhere in the pack", () => {
    const r = auditPack(goodPack(), ["Acme Corp", "J. Smith"]);
    // control: clean without the terms present passes
    expect(r.ok).toBe(true);
    const p = goodPack();
    p.copy_long = "Acme Corp invites you to a survey.";
    const r2 = auditPack(p, ["Acme Corp", "J. Smith"]);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toMatch(/identity/i);
  });

  it("rejects copy that makes tracking-adjacent claims", () => {
    const p = goodPack();
    p.copy_short = "Log in with your employee account to continue.";
    const r = auditPack(p, []);
    expect(r.ok).toBe(false);
  });
});
