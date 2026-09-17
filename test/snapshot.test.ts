import { describe, it, expect, vi, afterEach } from "vitest";
import app from "../src/index";
import { getState } from "../src/state";
import { openText, sealText } from "../src/lib/vault";
import { buildSearchClient, type SearchEntry } from "../src/lib/search";
import { sha256Hex } from "../src/lib/snapshot";
import { FakeD1 } from "./helpers/d1";
import { FakeR2 } from "./helpers/r2";

// B7: each fetched page becomes an immutable snapshot with complete
// provenance, and a web citation validates by exact occurrence in that
// snapshot's text — never against the live URL and never against a search
// provider's fragment. Search results are pointers: they may be shown, but
// only a snapshot enters the evidence chain (ADR-0017, ADR-0018).

const TOKEN = "op-token";
const auth = {
  "content-type": "application/json",
  authorization: `Bearer ${TOKEN}`,
};
const PAGE_TEXT = "The council posted minutes late on Tuesday.";
const PAGE_HTML =
  "<html><body><p>The council posted minutes late on Tuesday.</p></body></html>";

function makeEnv() {
  return {
    DB: new FakeD1() as never,
    CORPUS: new FakeR2() as never,
    OPERATOR_TOKEN: TOKEN,
    SERVER_SECRET: "server-secret-for-tests",
    ENCRYPTION_KEY: "e".padEnd(64, "0"),
    AI: { toMarkdown: async () => ({ format: "markdown", data: PAGE_TEXT }) },
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

function htmlResponse(
  body: string,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html", ...headers },
  });
}

/** Stub outbound fetches and record every URL called, in order. */
function stubFetch(
  handler?: (url: string, call: number) => Response | Promise<Response>,
) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      return handler ? handler(url, calls.length) : htmlResponse(PAGE_HTML);
    },
  );
  return calls;
}

interface SnapshotBody {
  ok: boolean;
  snapshot: {
    id: string;
    requested_url: string;
    final_url: string;
    fetched_at: string;
    http_status: number;
    content_type: string;
    content_sha256: string;
    byte_length: number;
    extractor: string;
    extractor_version: string;
    r2_key: string;
    flags: string[];
    provenance: string;
  };
}

async function snapshot(
  env: Record<string, unknown>,
  url: string,
): Promise<SnapshotBody> {
  const res = await callApp(env, "/api/engine/snapshots", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ url }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as SnapshotBody;
}

async function seedAngleLine(env: Record<string, unknown>, topic: string) {
  await callApp(env, "/api/corpus", {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "x-filename": encodeURIComponent("minutes.txt"),
      "content-type": "text/plain",
    },
    body: "Rosters are posted late on Tuesdays and wreck sleep",
  });
  const proposed = (await (
    await callApp(env, "/api/engine/angles/propose", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ topics: [topic] }),
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
  return { lineId: line.id };
}

async function complete(
  env: Record<string, unknown>,
  lineId: string,
  body: unknown,
) {
  return callApp(env, `/api/engine/lines/${lineId}/complete`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify(body),
  });
}

async function lineRow(env: Record<string, unknown>, lineId: string) {
  return (await (env.DB as FakeD1)
    .prepare("SELECT status, citations_json FROM research_lines WHERE id = ?")
    .bind(lineId)
    .first()) as { status: string; citations_json: string };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("snapshot store", () => {
  it("stores an immutable snapshot with complete provenance", async () => {
    const env = makeEnv();
    const calls = stubFetch();
    const body = await snapshot(env, "https://records.example/minutes");
    const snap = body.snapshot;
    expect(snap.id).toBeTruthy();
    expect(snap.requested_url).toBe("https://records.example/minutes");
    expect(snap.final_url).toBe("https://records.example/minutes");
    expect(Number.isNaN(Date.parse(snap.fetched_at))).toBe(false);
    expect(snap.http_status).toBe(200);
    expect(snap.content_type).toContain("text/html");
    expect(snap.content_sha256).toBe(await sha256Hex(PAGE_TEXT));
    expect(snap.byte_length).toBe(new TextEncoder().encode(PAGE_TEXT).length);
    expect(snap.extractor).toBe("workers-ai-toMarkdown");
    expect(snap.extractor_version).toBe("1");
    expect(snap.r2_key).toBe(`web/${snap.id}.html`);
    expect(snap.flags).toEqual([]);
    expect(snap.provenance).toBe("untrusted");
    expect(calls).toEqual(["https://records.example/minutes"]);

    // The raw capture is in private object storage and the evidence text is
    // sealed at rest: neither is plaintext somewhere the audit cannot see.
    const r2 = env.CORPUS as FakeR2;
    expect(r2.has(`web/${snap.id}.html`)).toBe(true);
    const row = (await (env.DB as FakeD1)
      .prepare("SELECT text_envelope FROM web_snapshots WHERE id = ?")
      .bind(snap.id)
      .first()) as { text_envelope: string };
    const { kit } = await getState(env as never);
    expect(row.text_envelope.startsWith("v1.")).toBe(true);
    expect(row.text_envelope).not.toContain("council");
    expect(await openText(kit, row.text_envelope)).toBe(PAGE_TEXT);
  });

  it("records the redirect chain and snapshots the final URL", async () => {
    const env = makeEnv();
    stubFetch((url) =>
      url === "https://records.example/start"
        ? htmlResponse("", 301, { location: "https://records.example/final" })
        : htmlResponse(PAGE_HTML),
    );
    const body = await snapshot(env, "https://records.example/start");
    expect(body.snapshot.requested_url).toBe("https://records.example/start");
    expect(body.snapshot.final_url).toBe("https://records.example/final");
  });

  it("re-checks every redirect hop against the destination policy", async () => {
    const env = makeEnv();
    const calls = stubFetch(() =>
      htmlResponse("", 302, { location: "http://127.0.0.1/admin" }),
    );
    const res = await callApp(env, "/api/engine/snapshots", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ url: "https://records.example/start" }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe(
      "url_not_allowed",
    );
    // The disallowed hop was refused, never fetched.
    expect(calls).toEqual(["https://records.example/start"]);
  });

  it("never stores a non-2xx capture", async () => {
    const env = makeEnv();
    stubFetch(() => htmlResponse("gone", 404));
    const res = await callApp(env, "/api/engine/snapshots", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ url: "https://records.example/missing" }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("http_status");
    const count = (await (env.DB as FakeD1)
      .prepare("SELECT COUNT(*) AS n FROM web_snapshots")
      .first()) as { n: number };
    expect(count.n).toBe(0);
    expect((env.CORPUS as FakeR2).keys()).toEqual([]);
  });

  it("is operator-gated", async () => {
    const env = makeEnv();
    const res = await callApp(env, "/api/engine/snapshots", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://records.example/minutes" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("web citation validation", () => {
  it("accepts a snippet that occurs verbatim in the snapshot", async () => {
    const env = makeEnv();
    stubFetch();
    const { snapshot: snap } = await snapshot(env, "https://records.example/minutes");
    const { lineId } = await seedAngleLine(env, "roster");
    const res = await complete(env, lineId, {
      citations: [
        {
          snapshot_id: snap.id,
          snippet: "council posted minutes late",
        },
      ],
      findings: "Minutes were posted late per the snapshot",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("complete");
    const row = await lineRow(env, lineId);
    expect(row.status).toBe("complete");
    expect(JSON.parse(row.citations_json)).toEqual([
      { snapshot_id: snap.id, snippet: "council posted minutes late" },
    ]);
  });

  it("rejects a snippet absent from the snapshot, never re-fetching the live URL", async () => {
    const env = makeEnv();
    const calls = stubFetch();
    const { snapshot: snap } = await snapshot(env, "https://records.example/minutes");
    const { lineId } = await seedAngleLine(env, "roster");
    const fetchesAfterCapture = calls.length;
    // The live page has drifted; validation must stay with the snapshot.
    vi.stubGlobal("fetch", async () =>
      htmlResponse(`<html><body>${PAGE_TEXT.toUpperCase()}</body></html>`),
    );
    const res = await complete(env, lineId, {
      citations: [{ snapshot_id: snap.id, snippet: "posted minutes early" }],
      findings: "A drifted quote",
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_citation",
    );
    expect(calls.length).toBe(fetchesAfterCapture);
    expect((await lineRow(env, lineId)).status).toBe("running");
  });

  it("rejects a provider fragment and an unknown snapshot id", async () => {
    const env = makeEnv();
    stubFetch();
    const { lineId } = await seedAngleLine(env, "roster");
    // A search result is a pointer: its URL is not a snapshot and its
    // snippet was never observed by this installation.
    const entries: SearchEntry[] = [
      {
        kind: "tavily",
        label: "tv",
        secret_slot: "TAVILY_API_KEY",
        model: "search",
        capabilities: ["search"],
      },
    ];
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              url: "https://news.example/a",
              title: "Council minutes",
              content: "Rosters are posted late",
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    const client = buildSearchClient(entries, () => "tvly-key");
    const [pointer] = await client.search("roster");
    const res = await complete(env, lineId, {
      citations: [{ snapshot_id: pointer.url, snippet: pointer.snippet }],
      findings: "Cited a search fragment",
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe(
      "unknown_citation",
    );

    const res2 = await complete(env, lineId, {
      citations: [{ snapshot_id: "hallucinated", snippet: "anything" }],
      findings: "Cited an invented snapshot",
    });
    expect(res2.status).toBe(422);
    expect(((await res2.json()) as { error: string }).error).toBe(
      "unknown_citation",
    );
  });

  it("rejects a snapshot whose stored text no longer matches its hash", async () => {
    const env = makeEnv();
    stubFetch();
    const { snapshot: snap } = await snapshot(env, "https://records.example/minutes");
    const { lineId } = await seedAngleLine(env, "roster");
    const { kit } = await getState(env as never);
    await (env.DB as FakeD1)
      .prepare("UPDATE web_snapshots SET text_envelope = ? WHERE id = ?")
      .bind(await sealText(kit, "Wholly different text."), snap.id)
      .run();
    const res = await complete(env, lineId, {
      citations: [{ snapshot_id: snap.id, snippet: "council posted minutes" }],
      findings: "Tampered snapshot",
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_citation",
    );
  });

  it("rejects a citation naming both evidence copies at once", async () => {
    const env = makeEnv();
    stubFetch();
    const { snapshot: snap } = await snapshot(env, "https://records.example/minutes");
    const { lineId } = await seedAngleLine(env, "roster");
    const res = await complete(env, lineId, {
      citations: [
        {
          doc_id: "d1",
          snapshot_id: snap.id,
          snippet: "council posted minutes late",
        },
      ],
      findings: "Ambiguous evidence reference",
    });
    expect(res.status).toBe(422);
  });
});
