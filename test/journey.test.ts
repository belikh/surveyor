import { describe, it, expect } from "vitest";
import app from "../src/index";
import { FakeD1 } from "./helpers/d1";
import { provisionStack, teardownStack } from "../src/lib/provision";
import type { CloudflareApi } from "../src/lib/provision";
import {
  REQUIRED_SCOPES,
  checkScopes,
  REVOCATION_GUIDANCE,
} from "../src/lib/scopes";
import { issueChallenge, solveChallenge } from "../src/lib/pow";
import { createPowKey } from "../src/lib/vault";

const TOKEN = "op-token";

function makeEnv() {
  return {
    DB: new FakeD1() as never,
    OPERATOR_TOKEN: TOKEN,
    SERVER_SECRET: "server-secret-for-tests",
    ENCRYPTION_KEY: "e".padEnd(64, "0"),
    PUBLIC_BASE_URL: "https://survey.example",
    POW_SECRET: "pow-test-secret",
    POW_DIFFICULTY: "8",
  };
}

const auth = {
  "content-type": "application/json",
  authorization: `Bearer ${TOKEN}`,
};

async function callApp(
  env: Record<string, unknown>,
  path: string,
  init?: RequestInit,
) {
  return app.fetch(
    new Request(`https://survey.example${path}`, init),
    env as never,
  );
}

function corpusHeaders(filename: string, mediaType: string): Record<string, string> {
  return {
    authorization: `Bearer ${TOKEN}`,
    "x-filename": encodeURIComponent(filename),
    "content-type": mediaType,
  };
}

function fakeCloudflare(): CloudflareApi {
  const ids = {
    worker: "wrk-1",
    d1: "d1-1",
    r2: "r2-1",
    queue: "q-1",
    workflow: "wf-1",
  };
  return {
    createWorker: async () => ids.worker,
    getWorkerId: async () => ids.worker,
    createD1: async () => ids.d1,
    getD1Id: async () => ids.d1,
    createR2Bucket: async () => ids.r2,
    getR2BucketId: async () => ids.r2,
    createQueue: async () => ids.queue,
    getQueueId: async () => ids.queue,
    createWorkflow: async () => ids.workflow,
    getWorkflowId: async () => ids.workflow,
    putCronTrigger: async () => true,
    putSecret: async () => ({ set: true, written: true }),
    listR2Objects: async () => [],
    deleteR2Objects: async () => true,
    deleteWorker: async () => true,
    deleteD1: async () => true,
    deleteR2Bucket: async () => true,
    deleteQueue: async () => true,
    deleteWorkflow: async () => true,
    deleteCronTrigger: async () => true,
    deleteSecret: async () => true,
  };
}

describe("token fallback scopes", () => {
  it("declares minimal scopes and reports gaps loudly", () => {
    expect(REQUIRED_SCOPES.length).toBeGreaterThan(0);
    expect(checkScopes(REQUIRED_SCOPES).missing).toEqual([]);
    const short = checkScopes(["workers:write"]);
    expect(short.missing.length).toBeGreaterThan(0);
    expect(short.missing).not.toContain("workers:write");
  });

  it("revocation guidance names rotation and scope of blast radius", () => {
    expect(REVOCATION_GUIDANCE).toMatch(/revoke/i);
    expect(REVOCATION_GUIDANCE).toMatch(/rotate/i);
  });

  it("serves the guidance live on the setup surface", async () => {
    const env = makeEnv();
    const body = (await (
      await callApp(env, "/api/setup/token-guidance")
    ).json()) as Record<string, unknown>;
    expect(body.scopes).toEqual(REQUIRED_SCOPES);
    expect(String(body.guidance)).toMatch(/revoke/i);
  });
});

describe("full journey", () => {
  it("provision → setup → corpus → submission → angle → research → publish → pack → teardown, receipts at every stage", async () => {
    // 1. Provision with scope-checked token.
    const scopes = checkScopes(REQUIRED_SCOPES);
    expect(scopes.missing).toEqual([]);
    const receipt = await provisionStack(fakeCloudflare(), {
      name: "journey",
      subdomain: "neutral",
      secrets: [
        { slot: "SERVER_SECRET", generate: true },
        { slot: "ENCRYPTION_KEY", generate: true },
        { slot: "OPERATOR_TOKEN", generate: true },
      ],
      grantedScopes: REQUIRED_SCOPES,
    });
    expect(receipt.worker.id).toBe("wrk-1");
    expect(receipt.secrets.every((s) => s.set)).toBe(true);

    const env = makeEnv();

    // 2. First-run wizard to ready.
    await callApp(env, "/api/setup", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ kind: "providers", providers: [] }),
    });
    const ready = (await (
      await callApp(env, "/api/setup", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          kind: "instrument",
          title: "Journey",
          blurb: "End to end",
          consent: "You are anonymous.",
        }),
      })
    ).json()) as Record<string, string>;
    expect(ready.phase).toBe("ready");
    const status = (await (
      await callApp(env, "/api/status")
    ).json()) as Record<string, unknown>;
    expect(status.degraded).toBe(true);
    expect(String(status.warning)).toMatch(/static fallback/i);

    // 3. Corpus → gated mirror.
    const up = (await (
      await callApp(env, "/api/corpus", {
        method: "POST",
        headers: corpusHeaders("notes.txt", "text/plain"),
        body: "Rosters run late on Tuesdays",
      })
    ).json()) as Record<string, string>;
    expect(up.status).toBe("parsed");
    const held = (await (
      await callApp(env, "/api/corpus", {
        method: "POST",
        headers: corpusHeaders("scan.png", "image/png"),
        body: "fakepng",
      })
    ).json()) as Record<string, string>;
    expect(held.status).toBe("held");
    expect(held.verdict).toBe("pending");

    // 4. Submission with PoW.
    const ch = (await (
      await callApp(env, "/api/intake/challenge")
    ).json()) as { challenge: string; difficulty: number };
    const nonce = await solveChallenge(ch.challenge, ch.difficulty);
    const sub = (await (
      await callApp(env, "/api/intake", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          pow: { challenge: ch.challenge, nonce: String(nonce) },
        }),
      })
    ).json()) as { id: string; access_code: string };
    expect(sub.access_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    // 5. Angle → approve → line → cited complete.
    const proposed = (await (
      await callApp(env, "/api/engine/angles/propose", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ topics: ["roster"] }),
      })
    ).json()) as { angles: Array<{ id: string }> };
    expect(proposed.angles.length).toBeGreaterThan(0);
    await callApp(env, `/api/engine/angles/${proposed.angles[0].id}/approve`, {
      method: "POST",
      headers: auth,
    });
    const line = (await (
      await callApp(env, "/api/engine/lines", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          angle_id: proposed.angles[0].id,
          spend_cap: 100,
        }),
      })
    ).json()) as { id: string };
    const docs = (await (
      await callApp(env, "/api/corpus", { headers: auth })
    ).json()) as { docs: Array<{ id: string; filename: string }> };
    // Cite the mirrored text document by name: the held scan is not in the
    // mirror and cannot carry a citation (B3).
    const notes = docs.docs.find((d) => d.filename === "notes.txt");
    if (!notes) throw new Error("notes.txt missing from corpus");
    const done = (await (
      await callApp(env, `/api/engine/lines/${line.id}/complete`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          citations: [{ doc_id: notes.id, snippet: "late" }],
          findings: "Rosters run late",
        }),
      })
    ).json()) as Record<string, string>;
    expect(done.status).toBe("complete");

    // 6. Approve, record the legal release, publish a report; pack generates.
    await callApp(env, "/api/reports/briefing/approve", {
      method: "POST",
      headers: auth,
    });
    await callApp(env, "/api/reports/briefing/legal", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        reviewer: "A. Lawyer",
        notes: "Defamation and public-interest check complete",
      }),
    });
    await callApp(env, "/api/reports/briefing/reply", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        subject: "Example Pty Ltd",
        channel: "email",
        outcome: "no_response",
      }),
    });
    const pub = (await (
      await callApp(env, "/api/reports/briefing/publish", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({}),
      })
    ).json()) as Record<string, number>;
    expect(pub.version).toBe(1);
    const pack = (await (
      await callApp(env, "/api/launch-pack", { headers: auth })
    ).json()) as Record<string, string>;
    expect(pack.submissions_url).not.toMatch(/[?#]/);

    // 7. Teardown: local reset + stack receipts, nothing identifying kept.
    const down = (await (
      await callApp(env, "/api/teardown", {
        method: "POST",
        headers: auth,
      })
    ).json()) as Record<string, unknown>;
    expect(down.wiped).toBeTruthy();
    const torn = await teardownStack(fakeCloudflare(), receipt);
    for (const k of [
      "worker",
      "d1",
      "r2",
      "queue",
      "workflow",
      "cron",
      "secret:SERVER_SECRET",
      "secret:ENCRYPTION_KEY",
      "secret:OPERATOR_TOKEN",
    ]) {
      expect(torn.wiped[k], k).toBe("deleted");
    }
    expect(torn.not_wiped.join(" ")).toMatch(/logs/i);
  }, 30000);
});
