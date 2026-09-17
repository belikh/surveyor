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
