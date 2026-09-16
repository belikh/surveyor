// Corpus routes: operator-gated upload with lane classification, gate
// verdicts, and per-file status. Text lands sealed in the mirror the same
// request; model lanes (OCR/rescue) record honest held status.

import { Hono } from "hono";
import type { Bindings } from "../env";
import { getState } from "../state";
import { sealText, openText, nameHmac } from "../lib/vault";
import { unwrap } from "../lib/evidence";
import { recordTurn } from "../lib/telemetry";
import {
  UploadBodySchema,
  MAX_DOC_BYTES,
  classifyLane,
  gateCorpusText,
  statusFor,
} from "../lib/ingest";

export const corpus = new Hono<{ Bindings: Bindings }>();

function decodeB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

corpus.post("/", async (c) => {
  const app = await getState(c.env);
  const parsed = UploadBodySchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_body" }, 422);
  const { filename, content_type, content_b64 } = parsed.data;

  // Size gate BEFORE decode: base64 inflates ~4/3, so compare against the
  // cap scaled up. Fails closed before any large allocation.
  if (content_b64.length > (MAX_DOC_BYTES * 4) / 3 + 64) {
    return c.json({ error: "rejected", detail: "size exceeds cap" }, 422);
  }
  let bytes: Uint8Array;
  try {
    bytes = decodeB64(content_b64);
  } catch {
    return c.json({ error: "invalid_body", detail: "bad base64" }, 422);
  }
  const decision = classifyLane(filename, content_type, bytes.length);
  if (decision.lane === "rejected") {
    return c.json({ error: "rejected", detail: decision.reason }, 422);
  }

  // Text extraction per lane. Only the native text lane decodes in-request;
  // every other lane records held status — the model pass (T5) drains them.
  let raw = "";
  const status = statusFor(decision.lane);
  if (decision.lane === "native") {
    try {
      raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    } catch {
      return c.json({ error: "rejected", detail: "not decodable text" }, 422);
    }
  }

  // Verdict honesty: unexamined (held) content is pending, never clean.
  // Filenames are operator-supplied but may carry names — seal them.
  const gated = status === "held" ? { text: "", verdict: "pending" as const, names: [] as string[] } : gateCorpusText(raw);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const sealedNames = await Promise.all(
    gated.names.map(async (name, i) => ({
      label: `[corpus-name ${i + 1}]`,
      envelope: await sealText(app.kit, name),
      hmac: await nameHmac(app.kit, name),
    })),
  );
  if (status === "held" && c.env.CORPUS) {
    await c.env.CORPUS.put(`corpus/${id}`, bytes);
    // Enqueue for the drain; absent binding (tests, local) is fine — the
    // file is already durable and the operator can POST /drain.
    if (c.env.INGEST) {
      await c.env.INGEST.send({ doc_id: id, lane: decision.lane });
    }
  }
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO corpus_docs (id, filename, lane, status, verdict, text_envelope, raw_key, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      id,
      await sealText(app.kit, filename),
      decision.lane,
      status,
      gated.verdict,
      await sealText(app.kit, gated.text),
      // Held lanes keep their raw bytes in the corpus object store (R2)
      // so the model pass has input; parsed docs keep none.
      status === "held" && c.env.CORPUS ? `corpus/${id}` : null,
      decision.reason ?? null,
      now,
    ),
    // Gated mirror: scrubbed text only, inserted for parsed docs.
    ...(status === "parsed"
      ? [
          c.env.DB.prepare(
            "INSERT INTO corpus_fts (doc_id, text) VALUES (?, ?)",
          ).bind(id, gated.text),
        ]
      : []),
    ...sealedNames.map((s) =>
      c.env.DB.prepare(
        "INSERT INTO entities (submission_id, label, name_envelope, name_hmac) VALUES (?, ?, ?, ?)",
      ).bind(`corpus:${id}`, s.label, s.envelope, s.hmac),
    ),
  ]);
  return c.json({
    id,
    lane: decision.lane,
    status,
    verdict: gated.verdict,
    reason: decision.reason ?? null,
  });
});

corpus.get("/", async (c) => {
  const app = await getState(c.env);
  const rows = await c.env.DB.prepare(
    "SELECT id, filename, lane, status, verdict, reason, created_at FROM corpus_docs ORDER BY created_at DESC",
  ).all<Record<string, string | null>>();
  const sealed = unwrap(rows);
  // Filenames are sealed at rest: decrypt for the operator listing.
  const docs = await Promise.all(
    sealed.map(async (d) => ({
      ...d,
      filename: await openText(app.kit, String(d.filename)),
    })),
  );
  return c.json({ docs });
});

// Model-pass drain: held docs through their lane handlers, gated before
// the mirror, quarantined names preserved, telemetry with outcomes.

/** Drain one held doc by id: R2 bytes → lane handler → gate → mirror.
 *  Shared by the HTTP route and the queue consumer. Returns the outcome. */
export async function drainDocById(
  env: Bindings,
  docId: string,
): Promise<{ status: string; reason: string | null }> {
  const app = await getState(env);
  const row = await env.DB.prepare(
    "SELECT id, lane, status, raw_key FROM corpus_docs WHERE id = ?",
  ).bind(docId).first<{
    id: string;
    lane: string;
    status: string;
    raw_key: string | null;
  }>();
  if (!row || row.status !== "held" || !row.raw_key || !env.CORPUS) {
    return { status: "ignored", reason: "doc not held or already drained" };
  }
  const obj = await env.CORPUS.get(row.raw_key);
  const buf = obj ? new Uint8Array(await obj.arrayBuffer()) : new Uint8Array();
  let b64 = "";
  for (const byte of buf) b64 += String.fromCharCode(byte);
  const doc = {
    id: row.id,
    lane: row.lane,
    status: row.status,
    raw_key: row.raw_key,
    bytes_b64: btoa(b64),
  };

  const handlers = await liveHandlers(env);
  const { runDrain } = await import("../lib/drain");
  const { results } = await runDrain([doc], handlers);
  const r = results[0];
  if (!r) return { status: "ignored", reason: "no handler for lane" };

  if (["parsed", "OCRed", "rescued"].includes(r.outcome.status)) {
    const sealedNames = await Promise.all(
      r.outcome.names.map(async (name, i) => ({
        label: `[corpus-name ${i + 1}]`,
        envelope: await sealText(app.kit, name),
        hmac: await nameHmac(app.kit, name),
      })),
    );
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE corpus_docs SET status = ?, verdict = ?, text_envelope = ?, raw_key = NULL, reason = NULL WHERE id = ?",
      ).bind(
        r.outcome.status,
        r.outcome.verdict,
        await sealText(app.kit, r.outcome.text),
        row.id,
      ),
      env.DB.prepare(
        "INSERT INTO corpus_fts (doc_id, text) VALUES (?, ?)",
      ).bind(row.id, r.outcome.text),
      ...sealedNames.map((sn) =>
        env.DB.prepare(
          "INSERT INTO entities (submission_id, label, name_envelope, name_hmac) VALUES (?, ?, ?, ?)",
        ).bind(`corpus:${row.id}`, sn.label, sn.envelope, sn.hmac),
      ),
    ]);
    if (env.CORPUS) await env.CORPUS.delete(row.raw_key);
  } else {
    await env.DB.prepare(
      "UPDATE corpus_docs SET reason = ? WHERE id = ?",
    ).bind(r.outcome.reason, row.id).run();
  }
  await recordTurn(env.DB, {
    tier: r.tier,
    toolCalls: 0,
    label: `drain:${row.lane}`,
    outcome: r.outcome.status,
  });
  return { status: r.outcome.status, reason: r.outcome.reason };
}

corpus.post("/drain", async (c) => {
  const rows = unwrap(
    await c.env.DB.prepare(
      "SELECT id FROM corpus_docs WHERE status = 'held' AND raw_key IS NOT NULL",
    ).all<{ id: string }>(),
  );
  const outcomes = [];
  for (const r of rows) {
    const out = await drainDocById(c.env, r.id);
    outcomes.push({ id: r.id, ...out });
  }
  return c.json({
    drained: outcomes.filter((o) =>
      ["parsed", "OCRed", "rescued"].includes(o.status),
    ).length,
    outcomes,
  });
});

/** Lane providers: the Workers AI binding for keyless conversion/OCR, plus
 *  the operator's vision-tagged registry entries when configured. */
async function liveHandlers(env: Bindings) {
  const { buildLaneHandlers } = await import("../lib/lanes");
  return buildLaneHandlers(env);
}

export default corpus;
