// D7 — publication legal gate: legal review and right of reply are
// recorded against the version they release; publish blocks until both are
// in place, attempts are logged, and a stale approval never carries to a
// new version.

import { describe, it, expect } from "vitest";
import app from "../src/index";
import { FakeD1 } from "./helpers/d1";
import { createVaultKit, openText } from "../src/lib/vault";

const TOKEN = "op-token";

function makeEnv() {
  return {
    DB: new FakeD1() as never,
    OPERATOR_TOKEN: TOKEN,
    SERVER_SECRET: "server-secret-for-tests",
    ENCRYPTION_KEY: "e".padEnd(64, "0"),
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

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

async function seedEvidence(env: Record<string, unknown>) {
  await callApp(env, "/api/corpus", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      filename: "notes.txt",
      content_type: "text/plain",
      content_b64: b64("Rosters run late on Tuesdays"),
    }),
  });
  const proposed = (await (
    await callApp(env, "/api/engine/angles/propose", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ topics: ["roster"] }),
    })
  ).json()) as { angles: Array<{ id: string }> };
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
  ).json()) as { docs: Array<{ id: string }> };
  await callApp(env, `/api/engine/lines/${line.id}/complete`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      citations: [{ doc_id: docs.docs[0].id, snippet: "late" }],
      findings: "Rosters run late",
    }),
  });
}

async function approve(env: Record<string, unknown>, type = "dossier") {
  return callApp(env, `/api/reports/${type}/approve`, {
    method: "POST",
    headers: auth,
  });
}

async function publish(env: Record<string, unknown>, type = "dossier") {
  const res = await callApp(env, `/api/reports/${type}/publish`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, never> };
}

async function recordLegal(
  env: Record<string, unknown>,
  type = "dossier",
  body: Record<string, unknown> = {
    reviewer: "A. Lawyer",
    notes: "Defamation check complete",
  },
) {
  const res = await callApp(env, `/api/reports/${type}/legal`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, never> };
}

async function recordReply(
  env: Record<string, unknown>,
  type = "dossier",
  body: Record<string, unknown> = {
    subject: "Maddie Subject",
    channel: "email",
    outcome: "no_response",
    response: "",
  },
) {
  const res = await callApp(env, `/api/reports/${type}/reply`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, never> };
}

async function legalView(env: Record<string, unknown>, type = "dossier") {
  const res = await callApp(env, `/api/reports/${type}/legal`, {
    headers: auth,
  });
  return { status: res.status, body: (await res.json()) as Record<string, never> };
}

describe("publication legal gate", () => {
  it("blocks publish until the legal review is recorded", async () => {
    const env = makeEnv();
    await seedEvidence(env);
    await approve(env);
    const blocked = await publish(env);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe("legal_gate_unmet");
    expect(blocked.body.unmet).toEqual(["legal-review"]);
  });

  it("blocks publish until the right-of-reply record exists", async () => {
    const env = makeEnv();
    await seedEvidence(env);
    await approve(env);
    const recorded = await recordLegal(env);
    expect(recorded.status).toBe(201);
    expect(recorded.body.version).toBe(1);

    const blocked = await publish(env);
    expect(blocked.status).toBe(409);
    expect(blocked.body.unmet).toEqual(["right-of-reply"]);

    const reply = await recordReply(env);
    expect(reply.status).toBe(201);
    expect(reply.body.version).toBe(1);

    const ok = await publish(env);
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(1);
  });

  it("allows no reply when the operator records that none is required", async () => {
    const env = makeEnv();
    await seedEvidence(env);
    await approve(env);
    await recordLegal(env, "dossier", {
      reviewer: "A. Lawyer",
      reply_required: false,
      notes: "No person is a subject of this report",
    });
    const ok = await publish(env);
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(1);
  });

  it("ties approval to the published version, never the next one", async () => {
    const env = makeEnv();
    await seedEvidence(env);
    await approve(env);
    await recordLegal(env);
    await recordReply(env);
    expect((await publish(env)).status).toBe(200);

    // The record released version 1; version 2 needs its own.
    const stale = await publish(env);
    expect(stale.status).toBe(409);
    expect(stale.body.unmet).toEqual(["legal-review"]);

    const second = await recordLegal(env);
    expect(second.body.version).toBe(2);
    expect((await recordReply(env)).body.version).toBe(2);
    const ok = await publish(env);
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(2);
  });

  it("logs right-of-reply attempts and keeps their content sealed", async () => {
    const env = makeEnv();
    await seedEvidence(env);
    await recordReply(env, "dossier", {
      subject: "Maddie Subject",
      channel: "email",
      outcome: "responded",
      response: "Subject denies the roster claim",
    });

    const view = await legalView(env);
    expect(view.status).toBe(200);
    expect(view.body.pending_version).toBe(1);
    const replies = view.body.replies as Array<Record<string, string>>;
    expect(replies.length).toBe(1);
    expect(replies[0].subject).toBe("Maddie Subject");
    expect(replies[0].response).toBe("Subject denies the roster claim");
    expect(replies[0].outcome).toBe("responded");

    // At rest the attempt is sealed: the subject never sits in plaintext.
    const db = env.DB as FakeD1;
    const rows = (await db
      .prepare("SELECT * FROM right_of_reply_attempts")
      .all()) as
      | Array<Record<string, string>>
      | { results: Array<Record<string, string>> };
    const list = Array.isArray(rows) ? rows : rows.results;
    const dump = JSON.stringify(list);
    expect(dump).not.toContain("Maddie Subject");
    expect(dump).not.toContain("denies the roster claim");
    const kit = await createVaultKit(
      env.SERVER_SECRET as string,
      env.ENCRYPTION_KEY as string,
    );
    expect(await openText(kit, list[0].record_envelope)).toContain(
      "Maddie Subject",
    );
  });

  it("shows the recorded legal review to the operator", async () => {
    const env = makeEnv();
    await seedEvidence(env);
    await recordLegal(env, "dossier", {
      reviewer: "A. Lawyer",
      notes: "Reviewed imputations and public interest",
    });
    const view = await legalView(env);
    const records = view.body.records as Array<Record<string, unknown>>;
    expect(records.length).toBe(1);
    expect(records[0].version).toBe(1);
    expect(records[0].reviewer).toBe("A. Lawyer");
    expect(records[0].notes).toBe("Reviewed imputations and public interest");
    expect(records[0].reply_required).toBe(true);
  });

  it("401s the legal surface without the operator token", async () => {
    const env = makeEnv();
    const get = await callApp(env, "/api/reports/dossier/legal");
    expect(get.status).toBe(401);
    const post = await callApp(env, "/api/reports/dossier/legal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reviewer: "X" }),
    });
    expect(post.status).toBe(401);
    const reply = await callApp(env, "/api/reports/dossier/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        subject: "X",
        channel: "email",
        outcome: "no_response",
      }),
    });
    expect(reply.status).toBe(401);
  });
});
