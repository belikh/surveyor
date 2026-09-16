// Provider availability helpers shared by the engine, corpus drain, and
// intake rounds. Secret values are read only to build the client and never
// leave these stack frames (constitution II).

import type { Bindings } from "../env";
import { resolveChain } from "./registry";
import { buildChainClient, type ModelClient } from "./serve";
import { SetupStateSchema } from "./setup";

export async function currentProviders(db: D1Database) {
  const row = await db
    .prepare("SELECT state_json FROM setup_state WHERE id = 1")
    .first<{ state_json: string }>();
  if (!row) return [];
  try {
    return SetupStateSchema.parse(JSON.parse(row.state_json)).providers;
  } catch {
    return [];
  }
}

export function secretValue(env: Bindings, slot: string): string | undefined {
  const v = (env as unknown as Record<string, unknown>)[slot];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function hasSecretValue(env: Bindings, slot: string): boolean {
  return secretValue(env, slot) !== undefined;
}

/** Resolve the operator-ordered chain and build its client, or null when no
 *  usable entries exist (callers degrade to the deterministic floor). */
export async function liveClient(
  db: D1Database,
  env: Bindings,
): Promise<ModelClient | null> {
  const chain = resolveChain(
    {
      phase: "ready",
      providers: await currentProviders(db),
      instrument: null,
      installed_at: null,
    },
    (slot) => hasSecretValue(env, slot),
  );
  if (chain.entries.length === 0) return null;
  return buildChainClient(chain.entries, (slot) => secretValue(env, slot));
}
