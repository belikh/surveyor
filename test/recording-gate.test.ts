// C8 — recording provenance and publication gate: audio/video evidence
// carries recorder, date, place, jurisdiction and consent status, captured
// with the recording at ingest. A jurisdiction-sensitive recording (one
// without all-parties consent, or with no provenance at all) cannot reach a
// published report until a legal review is recorded against the version
// that would release it. A stale review never carries to the next version.

import { describe, it, expect } from "vitest";
import { createVaultKit, openText } from "../src/lib/vault";

const TOKEN = "op-token";
const auth = {
  "content-type": "application/json",
  authorization: `Bearer ${TOKEN}`,
};

type CallApp = (
  path: string,
  init?: RequestInit,
) => Response | Promise<Response>;

function makeEnv() {
  return {
    DB: undefined as unknown as never,
    OPERATOR_TOKEN: TOKEN,
    SERVER_SECRET: "server-secret-for-tests",
    ENCRYPTION_KEY: "e".padEnd(64, "0"),
  };
}

async function setup(transcript = "Rosters run late on Tuesdays") {
  const { default: app } = await import("../src/index");
  const { FakeD1 } = await import("./helpers/d1");
  const { FakeR2 } = await import("./helpers/r2");
  const db = new FakeD1();
  const corpus = new FakeR2();
  const env: Record<string, unknown> = {
    ...makeEnv(),
    DB: db as never,
    CORPUS: corpus as never,
    AI: { run: async () => ({ text: transcript }) },
  };
  const callApp: CallApp = (path, init) =>
    app.fetch(new Request(`https://survey.example${path}`, init), env as never);
  return { db, corpus, callApp };
}

function mediaHeaders(
  filename: string,
  mediaType: string,
): Record<string, string> {
  return {
    authorization: `Bearer ${TOKEN}`,
    "x-filename": encodeURIComponent(filename),
    "content-type": mediaType,
  };
}

function provenanceHeader(value: Record<string, string>): string {
  return encodeURIComponent(JSON.stringify(value));
}

const PROVENANCE = {
  recorder: "M. Recorder",
  recorded_at: "2026-09-01",
  place: "Sydney office",
  jurisdiction: "AU-NSW",
  consent_status: "one_party",
};

/** Upload a recording, optionally with provenance, and return its doc id. */
async function uploadRecording(
  callApp: CallApp,
  over: Record<string, string> | null = PROVENANCE,
): Promise<string> {
  const headers = mediaHeaders("interview.mp3", "audio/mpeg");
  if (over) headers["x-recording-provenance"] = provenanceHeader(over);
  const res = await callApp("/api/corpus", {
    method: "POST",
    headers,
    body: "fake-mp3-bytes",
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

/** Drain, cite through an approved angle and complete line, approve the
 *  report and record the defamation-side legal review so the recording gate
 *  is the only unmet condition. A parsed text document grounds the floor
 *  angle pass; the line itself cites the recording, which is what the gate
 *  polices. */
async function seedCitedRecording(
  callApp: CallApp,
  docId: string,
  type = "dossier",
): Promise<void> {
  const drain = await callApp("/api/corpus/drain", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({}),
  });
  expect(((await drain.json()) as { drained: number }).drained).toBe(1);
  await callApp("/api/corpus", {
    method: "POST",
    headers: mediaHeaders("notes.txt", "text/plain"),
    body: "Rosters run late on Tuesdays",
  });

  const proposed = (await (
    await callApp("/api/engine/angles/propose", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ topics: ["roster"] }),
    })
  ).json()) as { angles: Array<{ id: string }> };
  await callApp(`/api/engine/angles/${proposed.angles[0].id}/approve`, {
    method: "POST",
    headers: auth,
  });
  const line = (await (
    await callApp("/api/engine/lines", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        angle_id: proposed.angles[0].id,
        spend_cap: 100,
      }),
    })
  ).json()) as { id: string };
  await callApp(`/api/engine/lines/${line.id}/complete`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      citations: [{ doc_id: docId, snippet: "Rosters run late" }],
      findings: "Rosters run late",
    }),
  });
  await callApp(`/api/reports/${type}/approve`, {
    method: "POST",
    headers: auth,
  });
  // The defamation-side gate is met; the recording gate is not.
  await callApp(`/api/reports/${type}/legal`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      reviewer: "A. Lawyer",
      reply_required: false,
      notes: "No person is a subject of this report",
    }),
  });
}

async function publish(callApp: CallApp, type = "dossier") {
  const res = await callApp(`/api/reports/${type}/publish`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, never> };
}

async function reviewRecording(
  callApp: CallApp,
  docId: string,
  type = "dossier",
) {
  const res = await callApp(`/api/reports/${type}/recording`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      doc_id: docId,
      reviewer: "A. Lawyer",
      notes: "Reviewed NSW recording law and consent",
    }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, never> };
}

async function corpusDocs(callApp: CallApp) {
  const out = (await (
    await callApp("/api/corpus", { headers: auth })
  ).json()) as {
    docs: Array<Record<string, unknown> & { recording?: Record<string, string> }>;
  };
  return out.docs;
}

function unwrap<T>(rows: T[] | { results: T[] }): T[] {
  return Array.isArray(rows) ? rows : rows.results;
}

describe("recording provenance capture (C8)", () => {
  it("captures provenance at ingest and seals the free-text detail", async () => {
    const { db, callApp } = await setup();
    await uploadRecording(callApp);

    const docs = await corpusDocs(callApp);
    expect(docs[0].recording).toEqual({
      recorder: "M. Recorder",
      recorded_at: "2026-09-01",
      place: "Sydney office",
      jurisdiction: "AU-NSW",
      consent_status: "one_party",
    });

    // At rest: recorder and place are sealed; jurisdiction and consent are
    // plaintext so the gate can decide without opening a record.
    const rows = unwrap(
      (await db.prepare("SELECT * FROM recording_provenance").all()) as Array<
        Record<string, string>
      > | { results: Array<Record<string, string>> },
    );
    expect(rows.length).toBe(1);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain("M. Recorder");
    expect(dump).not.toContain("Sydney office");
    expect(dump).toContain("AU-NSW");
    expect(dump).toContain("one_party");
    const kit = await createVaultKit(
      "server-secret-for-tests",
      "e".padEnd(64, "0"),
    );
    const detail = await openText(kit, rows[0].detail_envelope);
    expect(detail).toContain("M. Recorder");
    expect(detail).toContain("Sydney office");
  });

  it("rejects a malformed provenance header before the body lands", async () => {
    const { corpus, callApp } = await setup();
    const res = await callApp("/api/corpus", {
      method: "POST",
      headers: {
        ...mediaHeaders("interview.mp3", "audio/mpeg"),
        "x-recording-provenance": "%7Bnot-json",
      },
      body: "fake-mp3-bytes",
    });
    expect(res.status).toBe(422);
    expect(corpus.keys()).toEqual([]);
  });

  it("rejects provenance attached to a non-recording lane", async () => {
    const { corpus, callApp } = await setup();
    const res = await callApp("/api/corpus", {
      method: "POST",
      headers: {
        ...mediaHeaders("notes.txt", "text/plain"),
        "x-recording-provenance": provenanceHeader(PROVENANCE),
      },
      body: "Rosters run late",
    });
    expect(res.status).toBe(422);
    expect(corpus.keys()).toEqual([]);
  });
});

describe("recording publication gate (C8)", () => {
  it("blocks publication until the recording is legally reviewed", async () => {
    const { db, callApp } = await setup();
    const docId = await uploadRecording(callApp);
    await seedCitedRecording(callApp, docId);

    const blocked = await publish(callApp);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe("recording_gate_unmet");
    expect(blocked.body.unmet).toEqual(["recording-review"]);
    expect(blocked.body.doc_ids).toEqual([docId]);

    const reviewed = await reviewRecording(callApp, docId);
    expect(reviewed.status).toBe(201);
    expect(reviewed.body.version).toBe(1);

    // The review detail is sealed; the version linked to it is plaintext.
    const rows = unwrap(
      (await db.prepare("SELECT * FROM recording_reviews").all()) as Array<
        Record<string, string>
      > | { results: Array<Record<string, string>> },
    );
    expect(JSON.stringify(rows)).not.toContain("A. Lawyer");
    expect(JSON.stringify(rows)).not.toContain("NSW recording law");
    expect(Number(rows[0].version)).toBe(1);

    const ok = await publish(callApp);
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(1);
  });

  it("ties the approval to the version it releases", async () => {
    const { callApp } = await setup();
    const docId = await uploadRecording(callApp);
    await seedCitedRecording(callApp, docId);
    await reviewRecording(callApp, docId);
    expect((await publish(callApp)).status).toBe(200);

    // Version 1's review never releases version 2.
    const stale = await publish(callApp);
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("recording_gate_unmet");
    expect(stale.body.doc_ids).toEqual([docId]);

    const second = await reviewRecording(callApp, docId);
    expect(second.body.version).toBe(2);
    // Version 2 needs its own defamation-side review too.
    await callApp("/api/reports/dossier/legal", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        reviewer: "A. Lawyer",
        reply_required: false,
        notes: "Second release review",
      }),
    });
    const ok = await publish(callApp);
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(2);
  });

  it("does not gate an all-parties-consented recording", async () => {
    const { callApp } = await setup();
    const docId = await uploadRecording(callApp, {
      ...PROVENANCE,
      consent_status: "all_parties",
    });
    await seedCitedRecording(callApp, docId);
    const ok = await publish(callApp);
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(1);
  });

  it("treats a recording with no provenance as jurisdiction-sensitive", async () => {
    const { callApp } = await setup();
    const docId = await uploadRecording(callApp, null);
    await seedCitedRecording(callApp, docId);
    const blocked = await publish(callApp);
    expect(blocked.status).toBe(409);
    expect(blocked.body.unmet).toEqual(["recording-review"]);
    expect(blocked.body.doc_ids).toEqual([docId]);
  });

  it("only gates recordings that would reach the report", async () => {
    // The transcript shares no vocabulary with the topic, so no approved
    // angle exhibits it and nothing cites it: the recording is in the
    // corpus but cannot reach the report.
    const { callApp } = await setup("Parking permits were discussed");
    await uploadRecording(callApp);
    await callApp("/api/corpus/drain", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({}),
    });
    await callApp("/api/corpus", {
      method: "POST",
      headers: mediaHeaders("notes.txt", "text/plain"),
      body: "Rosters run late on Tuesdays",
    });
    const docs = (await (
      await callApp("/api/corpus", { headers: auth })
    ).json()) as { docs: Array<{ id: string; lane: string }> };
    const textDoc = docs.docs.find((d) => d.lane === "native");
    if (!textDoc) throw new Error("text doc not classified");
    const proposed = (await (
      await callApp("/api/engine/angles/propose", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ topics: ["roster"] }),
      })
    ).json()) as { angles: Array<{ id: string }> };
    await callApp(`/api/engine/angles/${proposed.angles[0].id}/approve`, {
      method: "POST",
      headers: auth,
    });
    const line = (await (
      await callApp("/api/engine/lines", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          angle_id: proposed.angles[0].id,
          spend_cap: 100,
        }),
      })
    ).json()) as { id: string };
    await callApp(`/api/engine/lines/${line.id}/complete`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        citations: [{ doc_id: textDoc.id, snippet: "Rosters run late" }],
        findings: "Rosters run late",
      }),
    });
    await callApp("/api/reports/dossier/approve", {
      method: "POST",
      headers: auth,
    });
    await callApp("/api/reports/dossier/legal", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        reviewer: "A. Lawyer",
        reply_required: false,
        notes: "No person is a subject of this report",
      }),
    });
    const ok = await publish(callApp);
    expect(ok.status).toBe(200);
  });

  it("refuses a review for a document that is not a recording", async () => {
    const { callApp } = await setup();
    await callApp("/api/corpus", {
      method: "POST",
      headers: mediaHeaders("notes.txt", "text/plain"),
      body: "Rosters run late",
    });
    const docs = await corpusDocs(callApp);
    const reviewed = await reviewRecording(callApp, String(docs[0].id));
    expect(reviewed.status).toBe(404);
  });

  it("401s the recording review route without the operator token", async () => {
    const { callApp } = await setup();
    const res = await callApp("/api/reports/dossier/recording", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ doc_id: "x", reviewer: "A. Lawyer" }),
    });
    expect(res.status).toBe(401);
  });
});
