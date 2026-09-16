// Per-isolate boot: schema migration + setup-state cache.

import type { Bindings } from "./env";
import { SetupStateSchema, type SetupState } from "./lib/setup";
import { createVaultKit, type VaultKit } from "./lib/vault";
import SCHEMA_SQL from "./db/schema.sql";

const DEV_SERVER_SECRET = "surveyor-dev-secret-not-for-production";
const DEV_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
// Dev fallbacks for local/wrangler dev and offline tests only — production
// deploy MUST set the real secrets. A production caught on dev keys fails
// deploy verification: the dev ENCRYPTION_KEY is public, so every envelope
// would be readable on leak (constitution I + II).

const FRESH: SetupState = {
  phase: "welcome",
  providers: [],
  instrument: null,
  installed_at: null,
};

export interface AppState {
  kit: VaultKit;
  loadSetup(): Promise<SetupState>;
  putSetup(next: SetupState): Promise<void>;
  audit(action: string): Promise<void>;
}

// Per-bindings boot cache: idempotent schema migration runs once per
// (isolate, env) pair. Keyed lookup (not middleware context vars — those
// do not propagate across app.route() sub-app boundaries).
const bootCache = new WeakMap<Bindings, Promise<AppState>>();

export function getState(env: Bindings): Promise<AppState> {
  let p = bootCache.get(env);
  if (!p) {
    p = boot(env);
    bootCache.set(env, p);
  }
  return p;
}

export async function boot(env: Bindings): Promise<AppState> {
  const kit = await createVaultKit(
    env.SERVER_SECRET ?? DEV_SERVER_SECRET,
    env.ENCRYPTION_KEY ?? DEV_KEY,
  );
  const statements = SCHEMA_SQL.replace(/^\s*--.*$/gm, "")
    .split(";")
    .map((s: string) => s.trim())
    .filter(Boolean);
  await env.DB.batch(statements.map((s) => env.DB.prepare(s)));

  // Additive migrations: CREATE TABLE IF NOT EXISTS never widens an
  // existing table, so column additions ship as guarded ALTERs. Each is
  // attempted and ignored when the column already exists.
  const additive = [
    "ALTER TABLE corpus_docs ADD COLUMN raw_key TEXT",
    "ALTER TABLE corpus_docs ADD COLUMN reason TEXT",
    "ALTER TABLE telemetry ADD COLUMN outcome TEXT",
    "ALTER TABLE reports ADD COLUMN sched_total INTEGER NOT NULL DEFAULT 0",
  ];
  for (const stmt of additive) {
    try {
      await env.DB.prepare(stmt).run();
    } catch {
      // Column already present: fine.
    }
  }

  let cached: SetupState | null = null;
  const loadSetup = async () => {
    if (cached) return cached;
    const row = await env.DB.prepare(
      "SELECT state_json FROM setup_state WHERE id = 1",
    ).first<{ state_json: string }>();
    cached = row ? SetupStateSchema.parse(JSON.parse(row.state_json)) : FRESH;
    return cached;
  };
  const putSetup = async (next: SetupState) => {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO setup_state (id, state_json) VALUES (1, ?) " +
          "ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json",
      ).bind(JSON.stringify(next)),
      env.DB.prepare(
        "INSERT INTO audit (ts, action) VALUES (?, ?)",
      ).bind(new Date().toISOString(), `setup:${next.phase}`),
    ]);
    cached = next;
  };
  const audit = async (action: string) => {
    await env.DB.prepare(
      "INSERT INTO audit (ts, action) VALUES (?, ?)",
    ).bind(new Date().toISOString(), action).run();
  };

  return { kit, loadSetup, putSetup, audit };
}
