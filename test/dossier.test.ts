import { describe, it, expect } from "vitest";
import {
  renderDossier,
  type Dossier,
} from "../src/lib/dossier";
import app from "../src/index";
import { FakeD1 } from "./helpers/d1";

const TOKEN = "op-token";

const auth = {
  "content-type": "application/json",
  authorization: `Bearer ${TOKEN}`,
};

function makeEnv() {
  return {
    DB: new FakeD1() as never,
    OPERATOR_TOKEN: TOKEN,
    SERVER_SECRET: "server-secret-for-tests",
    ENCRYPTION_KEY: "e".padEnd(64, "0"),
  };
}

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

/** Every internal Markdown link target in the document. */
function internalLinks(md: string): string[] {
  return [...md.matchAll(/\]\(#([A-Za-z0-9._-]+)\)/g)].map((m) => m[1]);
}

/** Every explicit anchor id in the document. */
function anchors(md: string): Set<string> {
  return new Set([...md.matchAll(/id="([A-Za-z0-9._-]+)"/g)].map((m) => m[1]));
}

function unresolved(md: string): string[] {
  const ids = anchors(md);
  return internalLinks(md).filter((l) => !ids.has(l));
}

async function seedCase(env: Record<string, unknown>) {
  await callApp(env, "/api/corpus", {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "x-filename": encodeURIComponent("notes.txt"),
      "content-type": "text/plain",
    },
    body: "Rosters run late on Tuesdays",
  });
  const proposed = (await (
    await callApp(env, "/api/engine/angles/propose", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ topics: ["roster"] }),
    })
  ).json()) as { angles: Array<{ id: string }> };
  const angleId = proposed.angles[0].id;
  await callApp(env, `/api/engine/angles/${angleId}/approve`, {
    method: "POST",
    headers: auth,
  });
  const line = (await (
    await callApp(env, "/api/engine/lines", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ angle_id: angleId, spend_cap: 100 }),
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
      findings: "Rosters run late on Tuesdays",
    }),
  });
  // A published report version through the real publish path.
  await callApp(env, "/api/reports/briefing/approve", {
    method: "POST",
    headers: auth,
  });
  await callApp(env, "/api/reports/briefing/legal", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ reviewer: "A. Lawyer", notes: "checked" }),
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
  await callApp(env, "/api/reports/briefing/publish", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({}),
  });
  return { angleId, lineId: line.id };
}

describe("dossier rendering (C12)", () => {
  function fixture(): Dossier {
    return {
      generated_at: "2026-09-17T00:00:00.000Z",
      angles: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          title: "Late rosters",
          status: "approved",
          rationale: "Repeated late rosters",
          exhibits: [{ doc_id: "doc-1", snippet: "late" }],
          flags: [],
        },
      ],
      lines: [
        {
          id: "22222222-2222-2222-2222-222222222222",
          angle_id: "11111111-1111-1111-1111-111111111111",
          status: "complete",
          spend_cap: 100,
          spend_used: 40,
          finding: "Rosters run late",
          citations: [{ doc_id: "doc-1", snippet: "late" }],
          flags: [],
        },
      ],
      versions: [
        {
          type: "briefing",
          version: 2,
          body: "# Briefing\n\nLate rosters.",
          created_at: "2026-09-17T00:00:00.000Z",
        },
      ],
      notes: [
        {
          id: "33333333-3333-3333-3333-333333333333",
          body: "Check the Tuesday roster",
          created_at: "2026-09-17T00:00:00.000Z",
        },
      ],
    };
  }

  it("renders angles, findings, versions and notes", () => {
    const md = renderDossier(fixture());
    expect(md).toContain("Late rosters");
    expect(md).toContain("Rosters run late");
    expect(md).toContain("briefing v2");
    expect(md).toContain("Check the Tuesday roster");
  });

  it("links every finding and version to a resolving anchor", () => {
    const md = renderDossier(fixture());
    expect(unresolved(md)).toEqual([]);
    expect(internalLinks(md)).toContain(
      "finding-22222222-2222-2222-2222-222222222222",
    );
    expect(internalLinks(md)).toContain("report-briefing-v2");
    // The links land on the finding and the version themselves.
    expect(md).toMatch(
      /id="finding-22222222-2222-2222-2222-222222222222"/,
    );
    expect(md).toMatch(/id="report-briefing-v2"/);
  });

  it("renders an empty investigation without dangling links", () => {
    const md = renderDossier({
      generated_at: "2026-09-17T00:00:00.000Z",
      angles: [],
      lines: [],
      versions: [],
      notes: [],
    });
    expect(unresolved(md)).toEqual([]);
    expect(md).toContain("Case dossier");
  });
});

describe("case dossier routes (C12)", () => {
  it("renders investigation state from the real engine and report tables", async () => {
    const env = makeEnv();
    const { lineId } = await seedCase(env);
    await callApp(env, "/api/dossier/notes", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ note: "Check the Tuesday roster against payroll" }),
    });

    const state = (await (
      await callApp(env, "/api/dossier", { headers: auth })
    ).json()) as Dossier;
    expect(state.angles.length).toBe(1);
    expect(state.lines.length).toBe(1);
    expect(state.lines[0].id).toBe(lineId);
    expect(state.lines[0].finding).toBe("Rosters run late on Tuesdays");
    expect(state.versions.some((v) => v.type === "briefing" && v.version === 1)).toBe(true);
    expect(state.notes.map((n) => n.body)).toEqual([
      "Check the Tuesday roster against payroll",
    ]);

    const res = await callApp(env, "/api/dossier/export", { headers: auth });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(res.headers.get("content-disposition")).toContain("case-dossier.md");
    const md = await res.text();
    expect(md).toContain("Rosters run late on Tuesdays");
    expect(md).toContain(`finding-${lineId}`);
    expect(md).toContain("report-briefing-v1");
    expect(md).toContain("Check the Tuesday roster against payroll");
    expect(unresolved(md)).toEqual([]);
  });

  it("seals operator notes at rest and opens them only for the operator", async () => {
    const env = makeEnv();
    await callApp(env, "/api/dossier/notes", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ note: "Sandra Bell may hold the payroll records" }),
    });
    const stored = JSON.stringify(
      await (env.DB as FakeD1).prepare("SELECT * FROM dossier_notes").all(),
    );
    expect(stored).not.toContain("Sandra");
    expect(stored).toContain("v1.");
    const state = (await (
      await callApp(env, "/api/dossier", { headers: auth })
    ).json()) as Dossier;
    expect(state.notes[0].body).toContain("Sandra Bell");
  });

  it("refuses an empty note", async () => {
    const env = makeEnv();
    const res = await callApp(env, "/api/dossier/notes", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ note: "" }),
    });
    expect(res.status).toBe(422);
    const count = await (env.DB as FakeD1)
      .prepare("SELECT COUNT(*) AS n FROM dossier_notes")
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("gates every dossier surface behind the operator token", async () => {
    const env = makeEnv();
    expect((await callApp(env, "/api/dossier")).status).toBe(401);
    expect((await callApp(env, "/api/dossier/export")).status).toBe(401);
    expect(
      (
        await callApp(env, "/api/dossier/notes", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ note: "x" }),
        })
      ).status,
    ).toBe(401);
  });
});
