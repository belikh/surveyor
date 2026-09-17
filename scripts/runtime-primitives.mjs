#!/usr/bin/env node
// Workerd primitives smoke — the second phase of `npm run smoke:runtime`.
//
// Boots the built Worker in workerd (via miniflare, the engine under
// `wrangler dev`) and exercises the runtime primitives the app depends on:
//
//   queue:delivery     a held upload is delivered to the queue consumer and acked
//   queue:retry        a failing message is retried and then dropped after maxRetries
//   r2:range-read      R2 byte ranges return exactly the requested slice
//   r2:delete          R2 delete removes the object and leaves no tombstone
//   workflow:create-run  ENGINE.create runs EngineWorkflow to `complete`
//   workflow:resume    a completed instance survives a workerd restart with no replay
//
// Every receipt names the primitive it exercised; exits non-zero on any
// failure. No Cloudflare account is needed and no secret value is printed.
//
//   node scripts/runtime-primitives.mjs <path-to-miniflare/index.js>

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  fail,
  formatReceipt,
  pass,
  summarise,
} from "../dist/smoke-lib.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const miniflareEntry = process.argv[2] ?? process.env.MINIFLARE_ENTRY;
if (!miniflareEntry || !existsSync(miniflareEntry)) {
  console.error(
    "usage: node scripts/runtime-primitives.mjs <path-to-miniflare/index.js>\n" +
      `miniflare entry not found at ${miniflareEntry ?? "(unset)"}`,
  );
  process.exit(2);
}

const { Miniflare, convertV4MiniflareOptions, Log } = await import(
  pathToFileURL(miniflareEntry).href
);

const receipts = [];
const add = (receipt) => {
  receipts.push(receipt);
  console.log(formatReceipt(receipt));
};

/** Captures runtime logs so queue retry and ack behaviour can be asserted. */
class CaptureLog extends Log {
  lines = [];
  log(message) {
    this.lines.push(message.replace(/\x1b\[[0-9;]*m/g, ""));
  }
}

const TOKEN = "test-op-token";
const AUTH = {
  "content-type": "application/json",
  authorization: `Bearer ${TOKEN}`,
};
const persistDir = mkdtempSync(path.join(tmpdir(), "surveyor-smoke-"));

function boot(log) {
  return new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: path.join(root, "dist/worker.js"),
      compatibilityDate: "2026-09-01",
      bindings: {
        OPERATOR_TOKEN: TOKEN,
        SERVER_SECRET: "smoke-server-secret",
        ENCRYPTION_KEY: "ab".repeat(32),
        POW_DIFFICULTY: "8",
      },
      d1Databases: { DB: "surveyor-db" },
      r2Buckets: { CORPUS: "surveyor-corpus" },
      queueProducers: { INGEST: { queueName: "surveyor-ingest" } },
      // Mirrors wrangler.toml's consumer.
      queueConsumers: {
        "surveyor-ingest": { maxBatchSize: 5, maxRetries: 3 },
      },
      workflows: {
        ENGINE: { name: "surveyor-engine", className: "EngineWorkflow" },
      },
      unsafeLocalExplorer: true,
      resourcePersistencePath: persistDir,
      isolatedResourcePersistencePath: persistDir,
      log,
    }),
  );
}

async function waitFor(label, fn, timeoutMs = 30_000) {
  const start = Date.now();
  for (;;) {
    const out = await fn();
    if (out) return out;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

let runtimeLog = new CaptureLog(4 /* DEBUG: retry logs are debug-level */);
let mf = boot(runtimeLog);
try {
  const base = "http://localhost";
  const post = (p, body) =>
    mf.dispatchFetch(`${base}${p}`, {
      method: "POST",
      headers: AUTH,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  // Corpus uploads stream (A15): the bytes are the body, the filename rides
  // in `x-filename` (A11), never a base64 JSON field. The declared length
  // exercises the workerd FixedLengthStream path (R2 `put` rejects streams
  // of unknown length).
  const upload = (filename, mediaType, body) =>
    mf.dispatchFetch(`${base}/api/corpus`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "x-filename": encodeURIComponent(filename),
        "content-type": mediaType,
        "content-length": String(new TextEncoder().encode(body).byteLength),
      },
      body,
    });
  const db = await mf.getD1Database("DB");
  const bucket = await mf.getR2Bucket("CORPUS");

  // --- queue:delivery -------------------------------------------------
  try {
    await post("/api/setup", { kind: "providers", providers: [] });
    await post("/api/setup", {
      kind: "instrument",
      title: "Smoke",
      blurb: "runtime primitives",
      consent: "smoke",
    });
    const up = await upload("scan.png", "image/png", "fake-scan-bytes");
    if (up.status !== 200) {
      const detail = (await up.text()).slice(0, 200);
      throw new Error(`held upload answered HTTP ${up.status}: ${detail}`);
    }
    const turn = await waitFor("the queue consumer to drain the held doc", async () => {
      const row = await db
        .prepare("SELECT label, outcome FROM telemetry WHERE label LIKE 'drain:%'")
        .first();
      return row ?? null;
    });
    add(
      pass(
        "queue:delivery",
        `consumer drained and acked (${turn.label} -> ${turn.outcome})`,
      ),
    );
  } catch (err) {
    add(fail("queue:delivery", String(err)));
  }

  // --- queue:retry ----------------------------------------------------
  try {
    const producer = await mf.getQueueProducer("INGEST");
    // A body the consumer cannot drain: missing doc_id makes the D1 bind
    // throw, so the consumer's retry path is exercised on every delivery.
    await producer.send({ kind: "attachment" });
    const dropped = await waitFor("the failed message to exhaust its retries", () =>
      runtimeLog.lines.find((l) =>
        /Dropped message .* on queue "surveyor-ingest"/.test(l),
      ),
    );
    const retried = runtimeLog.lines.filter((l) =>
      /Retrying message .* on queue "surveyor-ingest"/.test(l),
    );
    if (retried.length === 0) {
      throw new Error("message was dropped without any retry");
    }
    add(
      pass(
        "queue:retry",
        `${retried.length} retr${retried.length === 1 ? "y" : "ies"} then dropped ` +
          `(${dropped.replace(/^\[mf:warn\] /, "")})`,
      ),
    );
  } catch (err) {
    add(fail("queue:retry", String(err)));
  }

  // --- r2:range-read --------------------------------------------------
  try {
    await bucket.put("smoke/range", new Uint8Array([1, 2, 3, 4, 5]));
    const ranged = await bucket.get("smoke/range", {
      range: { offset: 1, length: 2 },
    });
    const bytes = ranged ? [...new Uint8Array(await ranged.arrayBuffer())] : null;
    if (!bytes || bytes.length !== 2 || bytes[0] !== 2 || bytes[1] !== 3) {
      throw new Error(`range offset 1 length 2 returned ${JSON.stringify(bytes)}`);
    }
    add(pass("r2:range-read", "offset 1 length 2 returned [2,3]"));
  } catch (err) {
    add(fail("r2:range-read", String(err)));
  }

  // --- r2:delete ------------------------------------------------------
  try {
    await bucket.delete("smoke/range");
    const gone = await bucket.get("smoke/range");
    if (gone !== null) {
      throw new Error("object still readable after delete");
    }
    // A second delete is a no-op, not an error.
    await bucket.delete("smoke/range");
    add(pass("r2:delete", "object unreadable after delete; repeat delete is a no-op"));
  } catch (err) {
    add(fail("r2:delete", String(err)));
  }

  // --- workflow:create-run --------------------------------------------
  const runWorkflow = async () => {
    await upload("notes.txt", "text/plain", "Rosters run late on Tuesdays");
    const proposed = await (
      await post("/api/engine/angles/propose", { topics: ["roster"] })
    ).json();
    await post(`/api/engine/angles/${proposed.angles[0].id}/approve`);
    const line = await (
      await post("/api/engine/lines", {
        angle_id: proposed.angles[0].id,
        spend_cap: 100,
      })
    ).json();
    if (!line.workflow_id) {
      throw new Error("ENGINE.create returned no instance id");
    }
    await waitFor("the workflow's steps to run", async () => {
      const row = await db
        .prepare("SELECT tier FROM telemetry WHERE tier = 'workflow'")
        .first();
      return row ?? null;
    });
    const instance = await waitFor("the workflow instance to complete", async () => {
      const res = await mf.dispatchFetch(
        `${base}/cdn-cgi/local/explorer/api/workflows/surveyor-engine/instances/${line.workflow_id}`,
      );
      const body = await res.json();
      return body?.result?.status === "complete" ? line.workflow_id : null;
    });
    return instance;
  };

  let instanceId = null;
  try {
    instanceId = await runWorkflow();
    add(
      pass(
        "workflow:create-run",
        `EngineWorkflow instance ${instanceId} ran its steps to complete`,
      ),
    );
  } catch (err) {
    add(fail("workflow:create-run", String(err)));
  }

  // --- workflow:resume ------------------------------------------------
  try {
    if (!instanceId) throw new Error("no completed instance to resume");
    const before = await db
      .prepare("SELECT COUNT(*) AS n FROM telemetry WHERE tier = 'workflow'")
      .first();
    await mf.dispose();
    runtimeLog = new CaptureLog(4);
    mf = boot(runtimeLog);
    const dbAfter = await mf.getD1Database("DB");
    const listed = await (
      await mf.dispatchFetch(
        `${base}/cdn-cgi/local/explorer/api/workflows/surveyor-engine/instances`,
      )
    ).json();
    const still = (listed.result ?? []).find((i) => i.id === instanceId);
    if (!still || still.status !== "complete") {
      throw new Error(
        `instance ${instanceId} after restart: ${JSON.stringify(still ?? null)}`,
      );
    }
    const after = await dbAfter
      .prepare("SELECT COUNT(*) AS n FROM telemetry WHERE tier = 'workflow'")
      .first();
    if (after.n !== before.n) {
      throw new Error(
        `steps replayed across restart: ${before.n} telemetry turn(s) before, ${after.n} after`,
      );
    }
    add(
      pass(
        "workflow:resume",
        `instance ${instanceId} still complete after workerd restart; no step replayed`,
      ),
    );
  } catch (err) {
    add(fail("workflow:resume", String(err)));
  }
} finally {
  await mf.dispose().catch(() => {});
  rmSync(persistDir, { recursive: true, force: true });
}

const summary = summarise(receipts);
console.log(`\n${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped`);
process.exit(summary.ok ? 0 : 1);
