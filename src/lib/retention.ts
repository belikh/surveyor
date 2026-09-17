// Retention engine (A3, D1). Raw submitter attachment bytes and held corpus
// bytes live in the object store only for their configured window.
// Successful drains delete immediately; the scheduled sweep enforces the same
// windows when a drain never comes, so held bytes cannot outlive their
// promised deletion and wait on an operator or a later drain.
//
// Windows are per data category, configured by the operator and bounded by
// safe minimums and maximums (loadRetentionWindows / saveRetentionWindows).
// A category that is the investigation's record — sealed evidence, published
// versions, audit receipts — is retained and refuses a deletion window with
// a reason. Unreadable stored configuration falls back to the safe defaults:
// the retention promise fails towards deletion, never towards holding
// forever.
//
// Expiry for a row is `retry_after` when a failed drain set one (the window
// restarts), otherwise `created_at` plus the category's window. A row whose
// timestamps are unreadable is treated as expired.
//
// Every sweep writes an audit receipt with counts only — never keys,
// filenames, or content (constitution II).

import type { Bindings } from "../env";
import { ATTACH_RETRY_MS } from "./attachments";
import { unwrap } from "./evidence";

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

/** The bounded raw-bytes window the sweep falls back to. Attachments and
 *  held corpus bytes share the default; each category is configured
 *  independently once D1's config is written. */
export const RAW_RETRY_WINDOW_MS = ATTACH_RETRY_MS;

export const MIN_RETENTION_MS = HOUR_MS;
export const MAX_RETENTION_MS = 30 * DAY_MS;

export type SweepCategoryId = "attachment_raw" | "corpus_raw";

export interface SweepableCategory {
  id: SweepCategoryId;
  label: string;
  what: string;
  /** Applied when the operator has not configured one. */
  default_ms: number;
  min_ms: number;
  max_ms: number;
  /** The table whose rows point at raw objects, and the statuses whose rows
   *  still hold a raw key. The sweep reads the catalogue, so a category
   *  added here is swept without touching the sweep loop. */
  table: "attachments" | "corpus_docs";
  statuses: readonly string[];
}

/** Categories the sweep deletes from. Each maps to raw bytes in the object
 *  store; the mirror and sealed rows are never touched by a time window. */
export const SWEEPABLE_CATEGORIES: readonly SweepableCategory[] = [
  {
    id: "attachment_raw",
    label: "Raw attachment bytes",
    what:
      "Source-uploaded files held in the object store until their lane " +
      "drains; the extracted text becomes sealed testimony.",
    default_ms: RAW_RETRY_WINDOW_MS,
    min_ms: MIN_RETENTION_MS,
    max_ms: MAX_RETENTION_MS,
    table: "attachments",
    statuses: ["uploaded", "held"],
  },
  {
    id: "corpus_raw",
    label: "Raw corpus bytes",
    what:
      "Operator-ingested documents held in the object store until parsed or " +
      "OCRed; the gated text enters the searchable mirror.",
    default_ms: RAW_RETRY_WINDOW_MS,
    min_ms: MIN_RETENTION_MS,
    max_ms: MAX_RETENTION_MS,
    table: "corpus_docs",
    statuses: ["held"],
  },
];

export interface RetainedCategory {
  id: string;
  label: string;
  why: string;
}

/** Categories with no time-based deletion window: they are the
 *  investigation's evidence or the proof that its controls ran. Asking for
 *  a window is refused, with the reason, rather than silently ignored. */
export const RETAINED_CATEGORIES: readonly RetainedCategory[] = [
  {
    id: "sealed_evidence",
    label: "Sealed testimony and quarantined names",
    why:
      "testimony is the investigation's evidence and stays sealed until the " +
      "operator closes or deletes the record; a time window could destroy " +
      "the evidence chain",
  },
  {
    id: "published_versions",
    label: "Published reports and versions",
    why:
      "published versions are the record of what was published, kept for " +
      "correction, retraction and the defamation limitation horizon",
  },
  {
    id: "audit_receipts",
    label: "Audit receipts",
    why:
      "receipts are the evidence that the controls ran; deleting them would " +
      "make deletion itself unprovable",
  },
];

export type RetentionWindows = Record<SweepCategoryId, number>;

export function defaultRetentionWindows(): RetentionWindows {
  const out = {} as RetentionWindows;
  for (const category of SWEEPABLE_CATEGORIES) {
    out[category.id] = category.default_ms;
  }
  return out;
}

export const DEFAULT_RETENTION_WINDOWS: RetentionWindows =
  defaultRetentionWindows();

export interface RetentionRefusal {
  category: string;
  reason: string;
}

export type RetentionUpdate =
  | { ok: true; windows: Partial<RetentionWindows> }
  | { ok: false; refusals: RetentionRefusal[] };

function categoryOf(id: string): SweepableCategory | undefined {
  return SWEEPABLE_CATEGORIES.find((c) => c.id === id);
}

function retainedOf(id: string): RetainedCategory | undefined {
  return RETAINED_CATEGORIES.find((c) => c.id === id);
}

/**
 * Validate an operator-supplied window map. Values are whole hours at this
 * boundary and return as milliseconds. All refusals are collected, so an
 * operator sees every problem in one response.
 */
export function validateRetentionWindows(input: unknown): RetentionUpdate {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {
      ok: false,
      refusals: [
        {
          category: "*",
          reason:
            "windows must be an object mapping a retention category to a " +
            "whole number of hours",
        },
      ],
    };
  }
  const refusals: RetentionRefusal[] = [];
  const windows: Partial<RetentionWindows> = {};
  for (const [id, value] of Object.entries(input as Record<string, unknown>)) {
    const sweepable = categoryOf(id);
    if (!sweepable) {
      const retained = retainedOf(id);
      refusals.push({
        category: id,
        reason: retained
          ? `"${retained.label}" is retained: ${retained.why}; no deletion ` +
            `window is supported`
          : `unknown retention category "${id}"`,
      });
      continue;
    }
    if (typeof value !== "number" || !Number.isInteger(value)) {
      refusals.push({
        category: id,
        reason: `"${sweepable.label}" window must be a whole number of hours`,
      });
      continue;
    }
    const ms = value * HOUR_MS;
    if (ms < sweepable.min_ms) {
      refusals.push({
        category: id,
        reason:
          `"${sweepable.label}" window is below the minimum of ` +
          `${sweepable.min_ms / HOUR_MS} hours`,
      });
      continue;
    }
    if (ms > sweepable.max_ms) {
      refusals.push({
        category: id,
        reason:
          `"${sweepable.label}" window is above the maximum of ` +
          `${sweepable.max_ms / DAY_MS} days`,
      });
      continue;
    }
    windows[id as SweepCategoryId] = ms;
  }
  if (refusals.length > 0) return { ok: false, refusals };
  return { ok: true, windows };
}

interface RetentionConfigRow {
  config_json: string;
}

/**
 * The effective windows. Missing, malformed or out-of-range stored entries
 * fall back to the category's safe default, so a bad configuration can
 * neither hold raw bytes forever nor delete them before a lane can drain.
 */
export async function loadRetentionWindows(
  db: D1Database,
): Promise<RetentionWindows> {
  const defaults = defaultRetentionWindows();
  let row: RetentionConfigRow | null = null;
  try {
    row = await db
      .prepare("SELECT config_json FROM retention_config WHERE id = 1")
      .first<RetentionConfigRow>();
  } catch {
    // Table absent (pre-migration boot) or store unreachable: defaults.
    return defaults;
  }
  if (!row) return defaults;
  let stored: unknown;
  try {
    stored = JSON.parse(row.config_json);
  } catch {
    return defaults;
  }
  const raw =
    typeof stored === "object" && stored !== null
      ? (stored as { windows?: Record<string, unknown> }).windows
      : undefined;
  if (typeof raw !== "object" || raw === null) return defaults;
  const out = { ...defaults };
  for (const category of SWEEPABLE_CATEGORIES) {
    const value = (raw as Record<string, unknown>)[category.id];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      out[category.id] = value;
    }
  }
  return out;
}

/**
 * Validate, merge over the current windows and persist. Refusals change
 * nothing and are returned to the caller.
 */
export async function saveRetentionWindows(
  db: D1Database,
  input: unknown,
  nowIso: string,
): Promise<RetentionUpdate> {
  const validated = validateRetentionWindows(input);
  if (!validated.ok) return validated;
  const current = await loadRetentionWindows(db);
  const windows: RetentionWindows = { ...current, ...validated.windows };
  await db
    .prepare(
      "INSERT INTO retention_config (id, config_json, updated_at) " +
        "VALUES (1, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json, " +
        "updated_at = excluded.updated_at",
    )
    .bind(JSON.stringify({ windows }), nowIso)
    .run();
  return { ok: true, windows };
}

export const RAW_SWEEP_ACTION = "retention:raw-sweep";

export interface CategorySweep {
  category: SweepCategoryId;
  /** Rows whose window had lapsed when the sweep ran. */
  expired: number;
  /** Objects whose delete call returned success. */
  deleted: number;
  /** Deletions confirmed gone by a follow-up read of the object. */
  verified: number;
  /** Deletions the follow-up read could not confirm as gone. */
  unverified: number;
  /** Rows still holding their raw key after the sweep (a delete that threw
   *  or could not be verified). The next sweep retries them. */
  failed: number;
}

export interface SweepTotals {
  expired: number;
  deleted: number;
  verified: number;
  unverified: number;
  failed: number;
}

export interface RawSweepReceipt {
  swept_at: string;
  /** The windows this sweep enforced, per category. */
  windows_ms: RetentionWindows;
  /** One entry per sweepable category, in catalogue order. A sweep that ran
   *  reports every category, whether or not anything expired. */
  categories: CategorySweep[];
  totals: SweepTotals;
}

export interface OverdueCategory {
  category: SweepCategoryId;
  label: string;
  /** Rows past their window that still hold raw bytes — a failed delete, an
   *  unreached sweep, or an unconfirmed object. Visible between sweeps. */
  overdue: number;
}

interface RawRow {
  id: string;
  raw_key: string;
  retry_after: string | null;
  created_at: string;
}

function expiryMs(row: RawRow, windowMs: number): number {
  if (row.retry_after) {
    const at = Date.parse(row.retry_after);
    if (Number.isFinite(at)) return at;
  }
  const created = Date.parse(row.created_at);
  return Number.isFinite(created) ? created + windowMs : 0;
}

/**
 * Delete one category's expired objects and report counts plus the
 * verification result. A row is marked `expired` only once its object is
 * confirmed gone; a delete that throws or cannot be verified keeps the raw
 * key so the next sweep retries rather than losing track of existing bytes.
 */
async function sweepCategory(
  db: D1Database,
  bucket: R2Bucket,
  category: SweepableCategory,
  nowMs: number,
  windowMs: number,
): Promise<CategorySweep> {
  const placeholders = category.statuses.map(() => "?").join(", ");
  const rows = unwrap(
    await db
      .prepare(
        `SELECT id, raw_key, retry_after, created_at FROM ${category.table} ` +
          `WHERE raw_key IS NOT NULL AND status IN (${placeholders})`,
      )
      .bind(...category.statuses)
      .all<RawRow>(),
  );
  const receipt: CategorySweep = {
    category: category.id,
    expired: 0,
    deleted: 0,
    verified: 0,
    unverified: 0,
    failed: 0,
  };
  for (const row of rows) {
    if (expiryMs(row, windowMs) > nowMs) continue;
    receipt.expired++;
    try {
      await bucket.delete(row.raw_key);
    } catch {
      receipt.failed++;
      continue;
    }
    receipt.deleted++;
    // Verification: the delete call is not proof. Read the object back; a
    // surviving (or unreadable) object keeps the row for the next sweep.
    let stillThere = false;
    try {
      stillThere = (await bucket.head(row.raw_key)) !== null;
    } catch {
      stillThere = true;
    }
    if (stillThere) {
      receipt.unverified++;
      receipt.failed++;
      continue;
    }
    receipt.verified++;
    await db
      .prepare(
        `UPDATE ${category.table} SET status = 'expired', raw_key = NULL, ` +
          `reason = ?, retry_after = NULL WHERE id = ?`,
      )
      .bind(
        "raw bytes deleted after the configured retention window lapsed " +
          "(deletion verified)",
        row.id,
      )
      .run();
  }
  return receipt;
}

/**
 * Delete expired raw objects across every sweepable category and record the
 * receipt. The caller boots the schema first (scheduled(), or a route); this
 * function only reads and deletes. The windows come from the operator's
 * configuration unless the caller supplies them.
 */
export async function sweepRawBytes(
  env: Pick<Bindings, "DB" | "CORPUS">,
  nowIso: string,
  configured?: RetentionWindows,
): Promise<RawSweepReceipt> {
  const nowMs = Date.parse(nowIso);
  const windows = configured ?? (await loadRetentionWindows(env.DB));
  const receipt: RawSweepReceipt = {
    swept_at: nowIso,
    windows_ms: windows,
    categories: [],
    totals: { expired: 0, deleted: 0, verified: 0, unverified: 0, failed: 0 },
  };
  if (env.CORPUS) {
    for (const category of SWEEPABLE_CATEGORIES) {
      const swept = await sweepCategory(
        env.DB,
        env.CORPUS,
        category,
        nowMs,
        windows[category.id],
      );
      receipt.categories.push(swept);
      receipt.totals.expired += swept.expired;
      receipt.totals.deleted += swept.deleted;
      receipt.totals.verified += swept.verified;
      receipt.totals.unverified += swept.unverified;
      receipt.totals.failed += swept.failed;
    }
  } else {
    // No object store bound: report every category with zero counts rather
    // than a shorter receipt, so "swept" and "swept nothing" stay distinct.
    for (const category of SWEEPABLE_CATEGORIES) {
      receipt.categories.push({
        category: category.id,
        expired: 0,
        deleted: 0,
        verified: 0,
        unverified: 0,
        failed: 0,
      });
    }
  }
  // The receipt exists whether or not anything expired: a sweep that ran
  // must be visible to the audit, with the windows it enforced and the
  // verification result. Counts only — never keys, filenames or content.
  await recordSweepReceipt(env.DB, receipt);
  await env.DB.prepare("INSERT INTO audit (ts, action) VALUES (?, ?)")
    .bind(nowIso, `${RAW_SWEEP_ACTION} ${JSON.stringify(receipt)}`)
    .run();
  return receipt;
}

/** Append-only persistence for the readable receipts surface. The sweep
 *  itself still writes the audit line; this row is the queryable copy. */
export async function recordSweepReceipt(
  db: D1Database,
  receipt: RawSweepReceipt,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO retention_sweeps (id, swept_at, receipt_json) VALUES (?, ?, ?)",
    )
    .bind(crypto.randomUUID(), receipt.swept_at, JSON.stringify(receipt))
    .run();
}

/** The most recent receipts, newest first. An unreadable row is skipped
 *  rather than failing the read: the audit line remains the fallback. */
export async function loadRecentSweeps(
  db: D1Database,
  limit = 20,
): Promise<RawSweepReceipt[]> {
  const rows = unwrap(
    await db
      .prepare(
        "SELECT receipt_json FROM retention_sweeps " +
          "ORDER BY swept_at DESC, rowid DESC LIMIT ?",
      )
      .bind(limit)
      .all<{ receipt_json: string }>(),
  );
  const out: RawSweepReceipt[] = [];
  for (const row of rows) {
    try {
      out.push(JSON.parse(row.receipt_json) as RawSweepReceipt);
    } catch {
      // Skip an unreadable row; the next one still reads.
    }
  }
  return out;
}

/**
 * Count raw rows past their window that still hold bytes, per category:
 * the live view of a failed or unconfirmed deletion between sweeps. Reads
 * only; never names a row.
 */
export async function countOverdueRawBytes(
  env: Pick<Bindings, "DB">,
  nowIso: string,
  configured?: RetentionWindows,
): Promise<OverdueCategory[]> {
  const nowMs = Date.parse(nowIso);
  const windows = configured ?? (await loadRetentionWindows(env.DB));
  const out: OverdueCategory[] = [];
  for (const category of SWEEPABLE_CATEGORIES) {
    const placeholders = category.statuses.map(() => "?").join(", ");
    const rows = unwrap(
      await env.DB.prepare(
        `SELECT id, raw_key, retry_after, created_at FROM ${category.table} ` +
          `WHERE raw_key IS NOT NULL AND status IN (${placeholders})`,
      )
        .bind(...category.statuses)
        .all<RawRow>(),
    );
    out.push({
      category: category.id,
      label: category.label,
      overdue: rows.filter((row) => expiryMs(row, windows[category.id]) <= nowMs)
        .length,
    });
  }
  return out;
}
