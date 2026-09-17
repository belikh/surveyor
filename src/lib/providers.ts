// Provider availability helpers shared by the engine, corpus drain, and
// intake rounds. Secret values are read only to build the client and never
// leave these stack frames (constitution II).

import type { Bindings } from "../env";
import { entriesForCapability, resolveChain, sanitiseStoredSetup } from "./registry";
import { buildChainClient, type ModelClient } from "./serve";
import { buildSearchClient, type SearchClient } from "./search";
import { SetupStateSchema, isProviderSlot } from "./setup";

export async function currentProviders(db: D1Database) {
  const row = await db
    .prepare("SELECT state_json FROM setup_state WHERE id = 1")
    .first<{ state_json: string }>();
  if (!row) return [];
  try {
    const raw = sanitiseStoredSetup(JSON.parse(row.state_json));
    return SetupStateSchema.parse(raw).providers;
  } catch {
    return [];
  }
}

/** Read a provider key from the environment. This is the single choke
 *  point between configured entries and installation secrets: only the
 *  provider key slots ever resolve, so naming OPERATOR_TOKEN (or any other
 *  binding) as a secret_slot cannot turn config-write into a secret read. */
export function secretValue(env: Bindings, slot: string): string | undefined {
  if (!isProviderSlot(slot)) return undefined;
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

/** Resolve this installation's search chain (operator order, search-capable
 *  entries only) or null when none is configured: callers degrade to the
 *  deterministic floor rather than failing. */
export async function liveSearchClient(
  db: D1Database,
  env: Bindings,
): Promise<SearchClient | null> {
  const chain = resolveChain(
    {
      phase: "ready",
      providers: await currentProviders(db),
      instrument: null,
      installed_at: null,
    },
    (slot) => hasSecretValue(env, slot),
  );
  const entries = entriesForCapability(chain.entries, "search");
  if (entries.length === 0) return null;
  return buildSearchClient(entries, (slot) => secretValue(env, slot));
}
