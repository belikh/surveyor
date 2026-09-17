// Raw-byte retention sweep (A3). Raw submitter attachment bytes and held
// corpus bytes live in the object store only for their retry window.
// Successful drains delete immediately; this sweep enforces the same window
// when a drain never comes, so held bytes cannot outlive their promised
// deletion and wait on an operator or a later drain.
//
// Expiry for a row is `retry_after` when a failed drain set one (the window
// restarts), otherwise `created_at` plus the retry window. A row whose
// timestamps are unreadable is treated as expired: the retention promise
// fails towards deletion, never towards holding forever.
//
// Every sweep writes an audit receipt with counts only — never keys,
// filenames, or content (constitution II).

import type { Bindings } from "../env";
import { ATTACH_RETRY_MS } from "./attachments";
import { unwrap } from "./evidence";

/** The bounded raw-bytes retry window. Attachments and held corpus bytes
 *  share it; per-category windows arrive with the retention engine (D1). */
export const RAW_RETRY_WINDOW_MS = ATTACH_RETRY_MS;

export const RAW_SWEEP_ACTION = "retention:raw-sweep";

export interface CategorySweep {
  expired: number;
  deleted: number;
  failed: number;
}

export interface RawSweepReceipt {
  swept_at: string;
  attachments: CategorySweep;
  corpus: CategorySweep;
}

interface RawRow {
  id: string;
  raw_key: string;
  retry_after: string | null;
  created_at: string;
}

function expiryMs(row: RawRow): number {
  if (row.retry_after) {
    const at = Date.parse(row.retry_after);
    if (Number.isFinite(at)) return at;
  }
  const created = Date.parse(row.created_at);
  return Number.isFinite(created) ? created + RAW_RETRY_WINDOW_MS : 0;
}

async function sweepCategory(
  db: D1Database,
  bucket: R2Bucket,
  table: "attachments" | "corpus_docs",
  statuses: string[],
  nowMs: number,
): Promise<CategorySweep> {
  const placeholders = statuses.map(() => "?").join(", ");
  const rows = unwrap(
    await db
      .prepare(
        `SELECT id, raw_key, retry_after, created_at FROM ${table} ` +
          `WHERE raw_key IS NOT NULL AND status IN (${placeholders})`,
      )
      .bind(...statuses)
      .all<RawRow>(),
  );
  const receipt: CategorySweep = { expired: 0, deleted: 0, failed: 0 };
  for (const row of rows) {
    if (expiryMs(row) > nowMs) continue;
    receipt.expired++;
    try {
      await bucket.delete(row.raw_key);
    } catch {
      // The object stays; the row keeps its raw_key so the next sweep
      // retries rather than losing track of bytes that still exist.
      receipt.failed++;
      continue;
    }
    await db
      .prepare(
        `UPDATE ${table} SET status = 'expired', raw_key = NULL, ` +
          `reason = ?, retry_after = NULL WHERE id = ?`,
      )
      .bind("raw bytes deleted after the retry window lapsed", row.id)
      .run();
    receipt.deleted++;
  }
  return receipt;
}

/**
 * Delete expired raw objects and record the receipt. The caller boots the
 * schema first (scheduled(), or a route); this function only reads and
 * deletes.
 */
export async function sweepRawBytes(
  env: Pick<Bindings, "DB" | "CORPUS">,
  nowIso: string,
): Promise<RawSweepReceipt> {
  const nowMs = Date.parse(nowIso);
  const empty: CategorySweep = { expired: 0, deleted: 0, failed: 0 };
  const receipt: RawSweepReceipt = {
    swept_at: nowIso,
    attachments: { ...empty },
    corpus: { ...empty },
  };
  if (env.CORPUS) {
    // Never-drained uploads and failed drains both count: an upload whose
    // queue message is lost must still be deleted on schedule.
    receipt.attachments = await sweepCategory(
      env.DB,
      env.CORPUS,
      "attachments",
      ["uploaded", "held"],
      nowMs,
    );
    receipt.corpus = await sweepCategory(
      env.DB,
      env.CORPUS,
      "corpus_docs",
      ["held"],
      nowMs,
    );
  }
  // The receipt exists whether or not anything expired: a sweep that ran
  // must be visible to the audit.
  await env.DB.prepare("INSERT INTO audit (ts, action) VALUES (?, ?)")
    .bind(
      nowIso,
      `${RAW_SWEEP_ACTION} ${JSON.stringify({
        attachments: receipt.attachments,
        corpus: receipt.corpus,
      })}`,
    )
    .run();
  return receipt;
}
