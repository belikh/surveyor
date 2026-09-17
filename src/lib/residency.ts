// Data-flow and residency receipts (D6, #49). The map is derived at read
// time from the installation's actual configuration — the Cloudflare
// services it runs and each BYOK provider whose key is present — so it
// moves when providers change and never asserts a residency fact the
// platform cannot keep. Cloudflare offers no Australian storage
// jurisdiction for D1 or R2 (EU, US and FedRAMP only); the map says so
// plainly (ADR-0019, docs/research/australian-legal-compliance.md §6).
//
// The operator is the data controller. This module ships the record, not a
// certification claim, and the region text names its source per recipient:
// a platform fact, the committed provider review, or "not recorded".

import type { Bindings } from "../env";
import { unwrap } from "./evidence";
import { hasSecretValue } from "./providers";
import { resolveChain } from "./registry";
import type { ProviderEntry, SetupState } from "./setup";

/** Cloudflare services a deployed installation runs unless configured off. */
export const CLOUDFLARE_CORE_SERVICES = [
  "Workers",
  "D1",
  "R2",
  "Queues",
  "Workflows",
];

export const CLOUDFLARE_REGIONS =
  "Cloudflare's global network, with no guaranteed processing jurisdiction. " +
  "The storage jurisdictions available to D1 are the European Union and " +
  "FedRAMP; to R2 the European Union, United States and FedRAMP. No " +
  "Australian jurisdiction is available, so information may be stored and " +
  "processed outside Australia.";

export type RegionSource = "platform" | "provider-review" | "not-recorded";

export interface DataFlowRecipient {
  name: string;
  role: string;
  services: string[];
  /** Where the recipient may process information, as far as this
   *  installation can verify — with the source named on the entry. */
  regions: string;
  region_source: RegionSource;
  /** APP 8 notice boundary: this recipient may handle data overseas. */
  may_process_offshore: boolean;
}

export interface ProviderRegionFact {
  regions: string;
  source: RegionSource;
}

/**
 * Per-kind residency facts from the committed research. Where a provider's
 * region is not recorded by a primary source in this repository, the entry
 * says so rather than guessing: "no unverifiable residency claims" is the
 * point of the receipt.
 */
export const PROVIDER_REGIONS: Record<
  ProviderEntry["kind"],
  ProviderRegionFact
> = {
  groq: {
    regions:
      "not recorded by Surveyor — the operator's Groq account terms govern, " +
      "and processing may occur outside Australia",
    source: "not-recorded",
  },
  tokenrouter: {
    regions:
      "not recorded by Surveyor — the operator's TokenRouter account terms " +
      "govern, and processing may occur outside Australia",
    source: "not-recorded",
  },
  "openai-compatible": {
    regions:
      "not recorded by Surveyor — the operator-supplied endpoint's terms " +
      "govern, and processing may occur outside Australia",
    source: "not-recorded",
  },
  tavily: {
    regions:
      "not recorded — the provider review leaves Tavily's subprocessors and " +
      "residency unresolved (docs/research/provider-terms-review.md §7); " +
      "processing may occur outside Australia",
    source: "not-recorded",
  },
  parallel: {
    regions:
      "United States — the provider FAQ states API data is stored in " +
      "US-based data centres, and EU residency is available for the Search " +
      "API only; this installation configures no EU endpoint " +
      "(docs/research/parallel-ai-api.md §4.4, retrieved 17 September 2026)",
    source: "provider-review",
  },
};

export interface StorageLocation {
  data: string;
  where: string;
}

/** What this installation stores and where it lives. */
export const STORAGE_LOCATIONS: readonly StorageLocation[] = [
  {
    data: "Submission testimony, answers and answer categories",
    where:
      "D1, sealed with authenticated encryption; category tags are HMACs, " +
      "not names",
  },
  {
    data: "Quarantined names and consent decisions",
    where:
      "D1, sealed; a name is revealed only by an audited operator action",
  },
  {
    data: "Raw attachment and held corpus bytes",
    where:
      "R2 (private bucket), only until the configured retention window lapses",
  },
  {
    data: "The searchable corpus mirror (gated text)",
    where: "D1 full-text index, held in plaintext by design (THREAT-MODEL §4)",
  },
  {
    data: "Published reports and their version history",
    where: "D1, append-only",
  },
  {
    data: "Audit, telemetry, consent and provisioning receipts",
    where: "D1",
  },
];

/** Limits the installation cannot change, stated where they bite. */
export const RESIDENCY_BOUNDARIES: readonly string[] = [
  "Cloudflare offers no Australian storage jurisdiction for D1 or R2 " +
    "(European Union, United States and FedRAMP only), and no jurisdiction " +
    "restriction is configured for this installation, so information may be " +
    "stored and processed outside Australia.",
  "Workers execute on Cloudflare's global edge; there is no " +
    "processing-location guarantee for Worker execution.",
  "Cloudflare account logs, analytics and backups cannot be deleted by the " +
    "installation; teardown reports them as not wiped.",
  "There is no Tor service and no source-side end-to-end encryption " +
    "(ADR-0016): text is unsealed inside the operator's Worker while it is " +
    "processed.",
];

export interface DataFlowMap {
  generated_at: string;
  instrument_title: string | null;
  recipients: DataFlowRecipient[];
  storage: StorageLocation[];
  boundaries: string[];
}

export interface CollectResidencyInput {
  setup: SetupState;
  /** Presence test for a provider key slot; values are never read here. */
  hasSecret: (slot: string) => boolean;
  /** Cloudflare services this installation actually uses. */
  services?: string[];
  workersAi: boolean;
  turnstile: boolean;
  now?: string;
}

export function collectDataFlowMap(input: CollectResidencyInput): DataFlowMap {
  const chain = resolveChain(input.setup, input.hasSecret);
  const services = [...(input.services ?? CLOUDFLARE_CORE_SERVICES)];
  if (input.workersAi) services.push("Workers AI");
  if (input.turnstile) services.push("Turnstile");

  const recipients: DataFlowRecipient[] = [
    {
      name: "Cloudflare",
      role:
        "hosting, storage, queueing and the keyless model tier for this " +
        "installation",
      services,
      regions: CLOUDFLARE_REGIONS,
      region_source: "platform",
      may_process_offshore: true,
    },
  ];
  for (const p of chain.entries) {
    const fact = PROVIDER_REGIONS[p.kind];
    const capabilities = p.capabilities ?? [];
    recipients.push({
      name: p.label,
      role:
        `operator-configured ${p.kind} provider for ` +
        (capabilities.length > 0 ? capabilities.join(", ") : "chat"),
      services: [p.model, ...capabilities],
      regions: fact.regions,
      region_source: fact.source,
      may_process_offshore: true,
    });
  }

  return {
    generated_at: input.now ?? new Date().toISOString(),
    instrument_title: input.setup.instrument?.title ?? null,
    recipients,
    storage: [...STORAGE_LOCATIONS],
    boundaries: [...RESIDENCY_BOUNDARIES],
  };
}

/** The map for the running installation: services and secrets come from the
 *  environment, providers from the stored setup state. */
export function collectEnvDataFlowMap(
  env: Bindings,
  setup: SetupState,
): DataFlowMap {
  return collectDataFlowMap({
    setup,
    hasSecret: (slot) => hasSecretValue(env, slot),
    workersAi: Boolean(env.AI),
    turnstile: Boolean(env.TURNSTILE_SECRET),
  });
}

export function renderDataFlowReceipt(map: DataFlowMap): string {
  const lines: string[] = [
    "# Data-flow and residency receipt",
    "",
    `Generated ${map.generated_at} from this installation's configured ` +
      "services and providers. It names every recipient that may handle " +
      "personal information, the services involved and where each may " +
      "process it. It is a record, not legal advice.",
    "",
    "## Recipients",
    "",
  ];
  for (const r of map.recipients) {
    lines.push(`### ${r.name}`, "");
    lines.push(`- Role: ${r.role}`);
    lines.push(`- Services: ${r.services.join(", ")}`);
    lines.push(`- Regions: ${r.regions}`);
    lines.push(
      `- Cross-border: ${
        r.may_process_offshore
          ? "information may be processed outside Australia"
          : "no overseas processing recorded"
      } (source: ${r.region_source})`,
    );
    lines.push("");
  }
  lines.push("## What is stored where", "");
  for (const s of map.storage) {
    lines.push(`- **${s.data}** — ${s.where}`);
  }
  lines.push("", "## Boundaries", "");
  for (const b of map.boundaries) {
    lines.push(`- ${b}`);
  }
  lines.push(
    "",
    "---",
    "Australian Privacy Principle 8 makes the operator accountable for how " +
      "these overseas recipients handle personal information. This receipt " +
      "documents the recipients; it does not transfer that duty.",
  );
  return lines.join("\n");
}

export interface DataFlowReceiptMeta {
  id: string;
  created_at: string;
}

export interface DataFlowReceipt extends DataFlowReceiptMeta {
  map: DataFlowMap;
}

interface ReceiptRow {
  id: string;
  map_json: string;
  created_at: string;
}

/** Append one receipt snapshot. Receipts are never rewritten or deleted by
 *  this module: an audit can see what was disclosed, and when. */
export async function recordDataFlowReceipt(
  db: D1Database,
  map: DataFlowMap,
): Promise<DataFlowReceipt> {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO data_flow_receipts (id, map_json, created_at) " +
        "VALUES (?, ?, ?)",
    )
    .bind(id, JSON.stringify(map), createdAt)
    .run();
  return { id, created_at: createdAt, map };
}

export async function listDataFlowReceipts(
  db: D1Database,
): Promise<DataFlowReceiptMeta[]> {
  const rows = unwrap(
    await db
      .prepare(
        "SELECT id, created_at FROM data_flow_receipts " +
          "ORDER BY created_at ASC, id ASC",
      )
      .bind()
      .all<DataFlowReceiptMeta>(),
  );
  return rows.map((r) => ({ id: r.id, created_at: r.created_at }));
}

export async function dataFlowReceiptAt(
  db: D1Database,
  id: string,
): Promise<DataFlowReceipt | null> {
  const row = await db
    .prepare(
      "SELECT id, map_json, created_at FROM data_flow_receipts WHERE id = ?",
    )
    .bind(id)
    .first<ReceiptRow>();
  if (!row) return null;
  return {
    id: row.id,
    created_at: row.created_at,
    map: JSON.parse(row.map_json) as DataFlowMap,
  };
}
