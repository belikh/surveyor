// Provider registry: ordered chain resolution, custom-provider validation,
// and degraded keyless mode. The wizard stores the operator's ORDER in
// SetupState.providers; this module decides what is usable at runtime.
// Secret VALUES never appear here — availability is a boolean per slot.

import { z } from "zod";
import { isAllowedProviderBaseUrl } from "./net";
import {
  isProviderSlot,
  type ProviderEntry,
  type SetupState,
} from "./setup";

export type UsableEntry = ProviderEntry;

export interface ChainResolution {
  entries: UsableEntry[];
  degraded: boolean;
  /** Dashboard warning copy when degraded; null otherwise. */
  warning: string | null;
}

/** An entry is servable only when its slot is a provider key slot and, for
 *  openai-compatible kinds, its base URL passes the destination policy. */
function isServableEntry(p: ProviderEntry): boolean {
  if (!isProviderSlot(p.secret_slot)) return false;
  if (p.kind === "openai-compatible") {
    return (
      typeof p.base_url === "string" && isAllowedProviderBaseUrl(p.base_url)
    );
  }
  return true;
}

/**
 * Read-time migration for stored setup state: drop entries that can no
 * longer be served (hostile or stale slots, unsafe base URLs) so
 * pre-existing state cannot keep the config-write secret-read hole open.
 * Tolerates unknown shapes; the caller still runs the full schema parse.
 */
export function sanitiseStoredSetup(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const state = raw as Record<string, unknown>;
  if (!Array.isArray(state.providers)) return raw;
  const providers = state.providers.filter((p) => {
    if (typeof p !== "object" || p === null) return false;
    const e = p as Record<string, unknown>;
    if (typeof e.secret_slot !== "string" || !isProviderSlot(e.secret_slot)) {
      return false;
    }
    if (e.kind === "openai-compatible") {
      return (
        typeof e.base_url === "string" && isAllowedProviderBaseUrl(e.base_url)
      );
    }
    return true;
  });
  return { ...state, providers };
}

export function resolveChain(
  state: SetupState,
  hasSecret: (slot: string) => boolean,
): ChainResolution {
  const entries = state.providers.filter(
    (p) => isServableEntry(p) && hasSecret(p.secret_slot),
  );
  if (entries.length === 0) {
    return {
      entries: [],
      degraded: true,
      warning:
        "No provider keys configured — running on static fallbacks and " +
        "keyless tiers. Add a key to enable full interviews.",
    };
  }
  return { entries, degraded: false, warning: null };
}

/** Move the entry at `from` to index `to`, returning a new array. */
export function reorderProviders(
  providers: ProviderEntry[],
  from: number,
  to: number,
): ProviderEntry[] {
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to < 0 ||
    from >= providers.length ||
    to >= providers.length
  ) {
    throw new Error(
      `reorder out of range: from=${from} to=${to} len=${providers.length}`,
    );
  }
  const next = [...providers];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

const CustomDraftSchema = z.object({
  label: z.string().min(1).max(64),
  baseUrl: z.string().url().max(2048),
  model: z.string().min(1).max(128),
  apiKey: z.string().min(1).max(512),
});

export type CustomDraft = z.infer<typeof CustomDraftSchema>;
export type ValidationResult = { ok: true } | { ok: false; error: string };

/**
 * Save-time validation for a custom OpenAI-compatible provider: one cheap
 * test call (`GET {baseUrl}/models`). Loud typed failures; the key value
 * is never echoed into the error.
 */
export async function validateCustomProvider(
  draft: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<ValidationResult> {
  const parsed = CustomDraftSchema.safeParse(draft);
  if (!parsed.success) {
    return { ok: false, error: `invalid provider: ${parsed.error.message}` };
  }
  const { label, baseUrl, apiKey } = parsed.data;
  if (!isAllowedProviderBaseUrl(baseUrl)) {
    return {
      ok: false,
      error: `provider "${label}" base URL not allowed: https to a public host is required`,
    };
  }
  const url = baseUrl.replace(/\/+$/, "") + "/models";
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { authorization: `Bearer ${apiKey}` },
      // A redirect hop is not re-checked against the destination policy:
      // a public host can 302 to loopback or link-local and the internal
      // status would come back as a passing check. Refuse to follow.
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `provider "${label}" unreachable: ${msg}` };
  }
  if (!res.ok) {
    return {
      ok: false,
      error: `provider "${label}" test call failed: HTTP ${res.status}`,
    };
  }
  return { ok: true };
}
