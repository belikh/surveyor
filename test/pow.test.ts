import { describe, it, expect } from "vitest";
import { issueChallenge, verifyChallenge, solveChallenge } from "../src/lib/pow";
import { createPowKey } from "../src/lib/vault";

describe("pow", () => {
  it("issues a challenge the solver can satisfy at low difficulty", async () => {
    const key = await createPowKey("test-secret");
    const ch = await issueChallenge(key, 8);
    const nonce = await solveChallenge(ch.challenge, 8);
    const r = await verifyChallenge(key, ch.challenge, String(nonce), 8);
    expect(r.ok).toBe(true);
  });

  it("rejects weak nonces, expired challenges, and forged signatures", async () => {
    const key = await createPowKey("test-secret");
    const ch = await issueChallenge(key, 8);
    expect((await verifyChallenge(key, ch.challenge, "0", 8)).ok).toBe(false);
    const old = await issueChallenge(key, 8, Date.now() - 20 * 60 * 1000);
    const nonce = await solveChallenge(old.challenge, 8);
    expect(
      (await verifyChallenge(key, old.challenge, String(nonce), 8)).ok,
    ).toBe(false);
    const forged = ch.challenge.slice(0, -2) + "xx";
    expect((await verifyChallenge(key, forged, "0", 8)).ok).toBe(false);
  });
});
