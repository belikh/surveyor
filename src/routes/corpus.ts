// Corpus routes: operator-gated upload with lane classification, gate
// verdicts, and per-file status. Uploads stream (A15): held lanes go into R2
// through a counting, capping transform; the native text lane decodes from
// the counted stream the same request. Model lanes (OCR/rescue) record
// honest held status.

import { Hono } from "hono";
import type { Bindings } from "../env";
import { getState } from "../state";
import { sealText, openText, nameHmac } from "../lib/vault";
import { unwrap } from "../lib/evidence";
import { entityIndexRows, entityIndexStatements } from "../lib/entities";
import { recordTurn } from "../lib/telemetry";
import {
  MAX_DOC_BYTES,
  classifyLane,
  gateCorpusText,
  statusFor,
} from "../lib/ingest";
import { RAW_RETRY_WINDOW_MS } from "../lib/retention";
import type { QuarantineHit } from "../lib/intake";
import { delimitedToText } from "../lib/tables";
import { storeBody } from "../lib/upload";
import { isSettledStatus } from "../lib/mirror";
import {
  captureRecordingProvenance,
  isRecordingLane,
  listRecordingProvenance,
  parseRecordingProvenanceHeader,
} from "../lib/recordings";

export const corpus = new Hono<{ Bindings: Bindings }>();

/** The filename travels percent-encoded in `x-filename`, never the request
 *  line (A11); a malformed escape falls back to the raw value. Mirrors the
 *  submitter-attachment transport (A14). */
function decodeFilename(raw: string | undefined): string {
  if (!raw) return "attachment";
  try {
    return decodeURIComponent(raw).slice(0, 256);
  } catch {
    return raw.slice(0, 256);
  }
}

corpus.post("/", async (c) => {
  const app = await getState(c.env);
  const filename = decodeFilename(c.req.header("x-filename"));
  const mediaType = (
    c.req.header("content-type") ?? "application/octet-stream"
  ).slice(0, 128);

  // Lane by type before the body is touched: an unsupported type costs no
  // transfer. The size checks re-run against the counted stream length below.
  const typed = classifyLane(filename, mediaType, MAX_DOC_BYTES);
  if (typed.lane === "rejected") {
    return c.json({ error: "rejected", detail: typed.reason }, 422);
  }

  // Recording provenance (C8) travels in a header, never the request line:
  // a malformed value, or one attached to a non-recording, fails the ingest
  // before any bytes land. Absent provenance is allowed — the recording is
  // stored unknown and the publication gate holds it for legal review.
  const provenance = parseRecordingProvenanceHeader(
    c.req.header("x-recording-provenance"),
  );
  if (!provenance.ok) {
    return c.json(
      { error: "invalid_recording_provenance", detail: provenance.error },
      422,
    );
  }
  if (provenance.value && !isRecordingLane(typed.lane)) {
    return c.json(
      {
        error: "invalid_recording_provenance",
        detail: "provenance only applies to audio and video recordings",
      },
      422,
    );
  }

  const body = c.req.raw.body;
  if (!body) return c.json({ error: "invalid_body", detail: "empty body" }, 422);

  const id = crypto.randomUUID();
  const key = `corpus/${id}`;
  const status = statusFor(typed.lane);
  // Count and cap while forwarding (A14/A15): a declared content-length
  // streams straight into R2 (the FixedLengthStream path), a chunked body is
  // stored as bounded multipart parts. Native text is collected for the
  // in-request decode; held bytes are never retained raw.
  const forwarded = await storeBody(body, {
    cap: MAX_DOC_BYTES,
    collect: status === "parsed",
    declaredLengthHeader: c.req.header("content-length") ?? null,
    bucket: status === "held" && c.env.CORPUS ? c.env.CORPUS : null,
    key,
  });
  const size = forwarded.size;
  const stored = forwarded.stored;
  if (forwarded.overCap) {
    return c.json({ error: "rejected", detail: "size exceeds cap" }, 422);
  }

  // Authoritative classification on the counted length: empty and over-cap
  // documents fail closed, and a cap breach never leaves bytes behind.
  const decision = classifyLane(filename, mediaType, size);
  if (decision.lane === "rejected") {
    if (stored) await c.env.CORPUS!.delete(key);
    return c.json({ error: "rejected", detail: decision.reason }, 422);
  }

  // Text extraction per lane. Only the native text lane decodes in-request;
  // every other lane records held status — the model pass (T5) drains them.
  let raw = "";
  if (status === "parsed" && forwarded.bytes) {
    try {
      raw = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: false,
      }).decode(forwarded.bytes);
    } catch {
      return c.json({ error: "rejected", detail: "not decodable text" }, 422);
    }
    // CSV/TSV are structured tables: keep column boundaries in the mirror.
    if (decision.table) {
      raw = delimitedToText(raw, decision.table === "tsv" ? "\t" : ",");
    }
  }

  // Verdict honesty: unexamined (held) content is pending, never clean.
  // Filenames are operator-supplied but may carry names — seal them.
  const gated =
    status === "held"
      ? {
          text: "",
          verdict: "pending" as const,
          names: [] as string[],
          hits: [] as QuarantineHit[],
        }
      : gateCorpusText(raw);
  const now = new Date().toISOString();
  const sealedNames = await Promise.all(
    gated.hits.map(async (h, i) => ({
      label: `[corpus-name ${i + 1}]`,
      envelope: await sealText(app.kit, h.name),
      hmac: await nameHmac(app.kit, h.name),
      // The index node is the pseudonym the gated text actually shows.
      marker: h.label,
    })),
  );
  // Enqueue for the drain; absent binding (tests, local) is fine — the
  // file is already durable and the operator can POST /drain.
  if (stored && c.env.INGEST) {
    await c.env.INGEST.send({ doc_id: id, lane: decision.lane });
  }
  // Entity index rows over the gated text, joined by HMAC — never names.
  const indexRows = entityIndexRows(
    `corpus:${id}`,
    gated.text,
    sealedNames.map((s) => ({ label: s.marker, hmac: s.hmac })),
  );
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
      stored ? key : null,
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
    ...entityIndexStatements(c.env.DB, indexRows),
  ]);
  if (provenance.value) {
    await captureRecordingProvenance(
      c.env.DB,
      app.kit,
      id,
      provenance.value,
      now,
    );
  }
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
  // Recording provenance, opened for the operator beside the media it
  // describes (the at-rest record is sealed).
  const provenance = await listRecordingProvenance(c.env.DB, app.kit);
  // Filenames are sealed at rest: decrypt for the operator listing.
  const docs = await Promise.all(
    sealed.map(async (d) => {
      const recording = provenance.get(String(d.id));
      return {
        ...d,
        filename: await openText(app.kit, String(d.filename)),
        ...(recording
          ? {
              recording: {
                recorder: recording.recorder,
                recorded_at: recording.recorded_at,
                place: recording.place,
                jurisdiction: recording.jurisdiction,
                consent_status: recording.consent_status,
              },
            }
          : {}),
      };
    }),
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

  if (isSettledStatus(r.outcome.status)) {
    const sealedNames = await Promise.all(
      r.outcome.hits.map(async (h, i) => ({
        label: `[corpus-name ${i + 1}]`,
        envelope: await sealText(app.kit, h.name),
        hmac: await nameHmac(app.kit, h.name),
        marker: h.label,
      })),
    );
    const indexRows = entityIndexRows(
      `corpus:${row.id}`,
      r.outcome.text,
      sealedNames.map((s) => ({ label: s.marker, hmac: s.hmac })),
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
      ...entityIndexStatements(env.DB, indexRows),
    ]);
    if (env.CORPUS) await env.CORPUS.delete(row.raw_key);
  } else {
    // A failed drain restarts the bounded raw-bytes window; the retention
    // sweep deletes the bytes if no later drain ever comes.
    await env.DB.prepare(
      "UPDATE corpus_docs SET reason = ?, retry_after = ? WHERE id = ?",
    )
      .bind(
        r.outcome.reason,
        new Date(Date.now() + RAW_RETRY_WINDOW_MS).toISOString(),
        row.id,
      )
      .run();
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
    drained: outcomes.filter((o) => isSettledStatus(o.status)).length,
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
