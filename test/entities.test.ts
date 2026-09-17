import { describe, it, expect } from "vitest";
import app from "../src/index";
import { FakeD1 } from "./helpers/d1";
import { FakeR2 } from "./helpers/r2";
import { solveChallenge } from "../src/lib/pow";
import { boot } from "../src/state";
import { unwrap } from "../src/lib/evidence";
import { nameHmac } from "../src/lib/vault";
import {
  entityIndexRows,
  entityMarkers,
  writeEntityIndex,
} from "../src/lib/entities";

const TOKEN = "op-token";
const SERVER_SECRET = "server-secret-for-tests";
const ENCRYPTION_KEY = "e".padEnd(64, "0");
const auth = {
  "content-type": "application/json",
  authorization: `Bearer ${TOKEN}`,
};

function makeEnv(extra: Record<string, unknown> = {}) {
  return {
    DB: new FakeD1() as never,
    CORPUS: new FakeR2() as never,
    OPERATOR_TOKEN: TOKEN,
    SERVER_SECRET,
    ENCRYPTION_KEY,
    POW_DIFFICULTY: "8",
    ...extra,
  };
}

async function callApp(
  env: Record<string, unknown>,
  path: string,
  init?: RequestInit,
) {
  return app.fetch(
    new Request(`https://surveyor.example${path}`, init),
    env as never,
  );
}

async function rowsOf<T>(
  db: FakeD1,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const stmt = db.prepare(sql);
  const res = await (params.length ? stmt.bind(...params) : stmt).all<T>();
  return unwrap(res as never);
}

async function createSubmission(env: Record<string, unknown>) {
  const ch = (await (
    await callApp(env, "/api/intake/challenge")
  ).json()) as { challenge: string; difficulty: number };
  const nonce = await solveChallenge(ch.challenge, ch.difficulty);
  const created = (await (
    await callApp(env, "/api/intake", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        pow: { challenge: ch.challenge, nonce: String(nonce) },
      }),
    })
  ).json()) as { id: string; access_code: string };
  return { id: created.id, code: created.access_code };
}

async function uploadText(
  env: Record<string, unknown>,
  text: string,
  filename = "notes.txt",
  contentType = "text/plain",
) {
  const res = await callApp(env, "/api/corpus", {
    method: "POST",
    headers: {
      ...auth,
      "x-filename": encodeURIComponent(filename),
      "content-type": contentType,
    },
    body: text,
  });
  return (await res.json()) as Record<string, string>;
}

describe("entity index over gated text (C9)", () => {
  it("reads pseudonym markers from gated text, never raw names", () => {
    const gated = "Ask [person A] about [person B] and [person AB]";
    expect(entityMarkers(gated)).toEqual([
      "[person A]",
      "[person B]",
      "[person AB]",
    ]);
    // Un-gated prose has no markers: extraction never scans raw names.
    expect(entityMarkers("Ask Sandra Bell about the roster")).toEqual([]);
  });

  it("indexes a gated corpus document with no real name in the index", async () => {
    const env = makeEnv();
    const up = await uploadText(env, "Sandra Bell approved the roster");
    expect(up.status).toBe("parsed");
    const db = env.DB as FakeD1;
    const rows = await rowsOf<{
      submission_id: string;
      label: string;
      name_hmac: string;
    }>(db, "SELECT submission_id, label, name_hmac FROM entity_index");
    expect(rows.length).toBe(1);
    expect(rows[0].submission_id).toBe(`corpus:${up.id}`);
    expect(rows[0].label).toBe("[person A]");
    // The index itself carries a pseudonym and an HMAC — no name, in any case.
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain("Sandra");
    expect(dump).not.toContain("Bell");
    expect(rows[0].name_hmac).toMatch(/^[0-9a-f]{64}$/);
  });

  it("indexes drained held corpus docs after the gate", async () => {
    const env = makeEnv({
      AI: {
        toMarkdown: async () => ({
          format: "markdown",
          data: "Priya Raman signed the memo",
        }),
      },
    });
    const up = await callApp(env, "/api/corpus", {
      method: "POST",
      headers: {
        ...auth,
        "x-filename": encodeURIComponent("scan.pdf"),
        "content-type": "application/pdf",
      },
      body: "%PDF-1.4 probe",
    });
    const docId = ((await up.json()) as { id: string }).id;
    const drained = await callApp(env, "/api/corpus/drain", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({}),
    });
    expect(((await drained.json()) as { drained: number }).drained).toBe(1);
    const rows = await rowsOf<{ submission_id: string; label: string }>(
      env.DB as FakeD1,
      "SELECT submission_id, label FROM entity_index WHERE submission_id = ?",
      [`corpus:${docId}`],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].label).toBe("[person A]");
    expect(JSON.stringify(rows)).not.toContain("Priya");
  });

  it("indexes attachment testimony once the drain gates it", async () => {
    const env = makeEnv({
      AI: { run: async () => ({ answer: "Zara Kline approved the roster" }) },
    });
    const { id, code } = await createSubmission(env);
    await callApp(env, `/api/intake/${id}/attachments`, {
      method: "POST",
      headers: {
        "content-type": "image/png",
        "x-filename": encodeURIComponent("scan.png"),
        "x-access-code": code,
      },
      body: "fake-scan",
    });
    const drained = await callApp(env, `/api/intake/${id}/attachments/drain`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({}),
    });
    expect(((await drained.json()) as { drained: number }).drained).toBe(1);
    const rows = await rowsOf<{ label: string }>(
      env.DB as FakeD1,
      "SELECT label FROM entity_index WHERE submission_id = ?",
      [id],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].label).toBe("[person A]");
    expect(JSON.stringify(rows)).not.toContain("Zara");
  });

  it("resolves links by HMAC against sealed entities, without names", async () => {
    const env = makeEnv();
    const up = await uploadText(env, "Sandra Bell approved the roster");
    const { kit } = await boot(env as never);
    const hmac = await nameHmac(kit, "Sandra Bell");
    const res = await callApp(env, "/api/intake/entities/links", {
      headers: { ...auth, "x-entity-hmac": hmac },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      links: Array<{
        submission_id: string;
        label: string;
        name_hmac: string;
        sealed: number;
      }>;
    };
    expect(body.links.length).toBe(1);
    expect(body.links[0].submission_id).toBe(`corpus:${up.id}`);
    expect(body.links[0].label).toBe("[person A]");
    expect(body.links[0].name_hmac).toBe(hmac);
    // The link resolves to the sealed entity row(s) it was joined from.
    expect(body.links[0].sealed).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toContain("Sandra");
  });

  it("gates the links surface behind the operator token", async () => {
    const res = await callApp(makeEnv(), "/api/intake/entities/links");
    expect(res.status).toBe(401);
  });

  it("is idempotent: re-indexing the same gated text adds no rows", async () => {
    const env = makeEnv();
    const { kit } = await boot(env as never);
    const sealed = [
      { label: "[person A]", hmac: await nameHmac(kit, "Sandra Bell") },
      { label: "[person B]", hmac: await nameHmac(kit, "Tom Nguyen") },
    ];
    const rows = entityIndexRows(
      "subject-1",
      "Met [person A] and [person B] about the roster.",
      sealed,
    );
    expect(rows.length).toBe(2);
    await writeEntityIndex(env.DB as never, rows);
    await writeEntityIndex(env.DB as never, rows);
    const count = await (env.DB as FakeD1)
      .prepare("SELECT COUNT(*) AS n FROM entity_index")
      .first<{ n: number }>();
    expect(count?.n).toBe(2);
  });

  it("is idempotent across a rerun of the same intake answers", async () => {
    const env = makeEnv();
    const { id, code } = await createSubmission(env);
    const answers = [
      {
        q: "story",
        value: "I told Sandra Bell about the roster",
        topic: "roster",
      },
    ];
    for (let i = 0; i < 2; i++) {
      const res = await callApp(env, `/api/intake/${id}/steps`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ answers, access_code: code }),
      });
      expect(res.status).toBe(200);
    }
    const db = env.DB as FakeD1;
    const rows = await rowsOf<{ submission_id: string; label: string }>(
      db,
      "SELECT submission_id, label FROM entity_index WHERE submission_id = ?",
      [id],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].label).toBe("[person A]");
    const dump = JSON.stringify(
      await db.prepare("SELECT * FROM entity_index").all(),
    );
    expect(dump).not.toContain("Sandra");
  });
});

describe("audited entity reveal (C10)", () => {
  function reveal(
    env: Record<string, unknown>,
    body: Record<string, unknown>,
    token = TOKEN,
  ) {
    return callApp(env, "/api/intake/entities/reveal", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  }

  async function sealedHmac(
    env: Record<string, unknown>,
  ): Promise<string> {
    const rows = await rowsOf<{ name_hmac: string }>(
      env.DB as FakeD1,
      "SELECT name_hmac FROM entities",
    );
    expect(rows.length).toBe(1);
    return rows[0].name_hmac;
  }

  it("reveals the sealed name and writes who, when and why to the audit", async () => {
    const env = makeEnv();
    await uploadText(env, "Sandra Bell approved the roster");
    const hmac = await sealedHmac(env);

    const res = await reveal(env, {
      hmac,
      revealed_by: "operator",
      reason: "verifying before publication",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      name: string;
      reveal: {
        id: string;
        name_hmac: string;
        links: Array<{ submission_id: string; label: string }>;
        revealed_by: string;
        reason: string;
        revealed_at: string;
      };
    };
    expect(body.name).toBe("Sandra Bell");
    expect(body.reveal.name_hmac).toBe(hmac);
    // Corpus rows keep the sealed lane label; the index holds the marker.
    expect(body.reveal.links[0].label).toBe("[corpus-name 1]");
    expect(body.reveal.links[0].submission_id).toMatch(/^corpus:/);
    expect(body.reveal.revealed_by).toBe("operator");
    expect(body.reveal.reason).toBe("verifying before publication");
    expect(Number.isNaN(Date.parse(body.reveal.revealed_at))).toBe(false);

    // The audit row is sealed at rest and readable through the audit route.
    const stored = JSON.stringify(
      await (env.DB as FakeD1).prepare("SELECT * FROM entity_reveals").all(),
    );
    expect(stored).not.toContain("Sandra Bell");
    const listed = (await (
      await callApp(env, "/api/intake/entities/reveals", { headers: auth })
    ).json()) as { reveals: Array<Record<string, unknown>> };
    expect(listed.reveals.length).toBe(1);
    expect(listed.reveals[0].revealed_by).toBe("operator");
    expect(listed.reveals[0].reason).toBe("verifying before publication");
    expect(listed.reveals[0].name_hmac).toBe(hmac);
  });

  it("records every reveal, including a repeated one", async () => {
    const env = makeEnv();
    await uploadText(env, "Sandra Bell approved the roster");
    const hmac = await sealedHmac(env);
    const first = await reveal(env, {
      hmac,
      revealed_by: "operator",
      reason: "first look",
    });
    const second = await reveal(env, {
      hmac,
      revealed_by: "operator",
      reason: "second look",
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const count = await (env.DB as FakeD1)
      .prepare("SELECT COUNT(*) AS n FROM entity_reveals")
      .first<{ n: number }>();
    expect(count?.n).toBe(2);
    const audit = await (env.DB as FakeD1)
      .prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'entities:revealed'")
      .first<{ n: number }>();
    expect(audit?.n).toBe(2);
  });

  it("refuses a reveal with no operator token and writes no audit", async () => {
    const env = makeEnv();
    await uploadText(env, "Sandra Bell approved the roster");
    const hmac = await sealedHmac(env);
    const res = await reveal(
      env,
      { hmac, revealed_by: "operator", reason: "peek" },
      "wrong-token",
    );
    expect(res.status).toBe(401);
    const count = await (env.DB as FakeD1)
      .prepare("SELECT COUNT(*) AS n FROM entity_reveals")
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("refuses an HMAC with no sealed entity and writes no audit", async () => {
    const env = makeEnv();
    const absent = "a".repeat(64);
    const res = await reveal(env, {
      hmac: absent,
      revealed_by: "operator",
      reason: "looking",
    });
    expect(res.status).toBe(404);
    const count = await (env.DB as FakeD1)
      .prepare("SELECT COUNT(*) AS n FROM entity_reveals")
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("refuses a reveal without a stated reason, writing no audit", async () => {
    const env = makeEnv();
    await uploadText(env, "Sandra Bell approved the roster");
    const hmac = await sealedHmac(env);
    const res = await reveal(env, { hmac, revealed_by: "operator", reason: "" });
    expect(res.status).toBe(422);
    const count = await (env.DB as FakeD1)
      .prepare("SELECT COUNT(*) AS n FROM entity_reveals")
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("never lists a name without a reveal, and source-facing text stays pseudonymous", async () => {
    const env = makeEnv();
    const { id, code } = await createSubmission(env);
    await callApp(env, `/api/intake/${id}/steps`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        answers: [
          { q: "story", value: "I told Sandra Bell about the roster", topic: "roster" },
        ],
        access_code: code,
      }),
    });
    const hmac = await sealedHmac(env);

    // Before the reveal: no surface lists the name.
    const linksBefore = await (
      await callApp(env, "/api/intake/entities/links", {
        headers: { ...auth, "x-entity-hmac": hmac },
      })
    ).text();
    expect(linksBefore).not.toContain("Sandra");

    await reveal(env, {
      hmac,
      revealed_by: "operator",
      reason: "publication check",
    });

    // After the reveal: the source's own thread still shows the pseudonym.
    const thread = await (
      await callApp(env, `/api/intake/${id}/thread`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ access_code: code }),
      })
    ).text();
    expect(thread).toContain("[person A]");
    expect(thread).not.toContain("Sandra");
    // The audit list names the pseudonym and HMAC, never the name.
    const listed = await (
      await callApp(env, "/api/intake/entities/reveals", { headers: auth })
    ).text();
    expect(listed).not.toContain("Sandra");
    const linksAfter = await (
      await callApp(env, "/api/intake/entities/links", {
        headers: { ...auth, "x-entity-hmac": hmac },
      })
    ).text();
    expect(linksAfter).not.toContain("Sandra");
  });
});
