// Live serving passes: model-proposed angles and the bounded significance
// judge through an injected ModelClient (the registry chain at runtime).
// Every model output is validated and grounded before it touches storage:
// ungrounded angles are dropped (counted), the judge may only narrow the
// deterministic floor set (intersected, never widened), and any model
// failure degrades to the floors with a fallback telemetry row. Nothing
// ungrounded or fenceless persists (constitution III, IX).

import { z } from "zod";
import { generateText, APICallError } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  proposeAngles,
  rankAngles,
  judgeSignificance,
  type CandidateAngle,
  type CorpusDoc,
} from "./engine";
import { isAllowedProviderBaseUrl } from "./net";
import { entriesForCapability } from "./registry";

export interface ModelClient {
  tier: string;
  complete(prompt: string): Promise<string>;
  /** Send an image through a vision-capable entry (tagged in the registry). */
  completeVision?(prompt: string, imageBase64: string, mediaType: string): Promise<string>;
}

export interface Turn {
  tier: string;
  toolCalls: number;
  label: string;
}

export type RecordTurn = (t: Turn) => Promise<void>;

const LiveAngleSchema = z.object({
  title: z.string().min(1).max(200),
  rationale: z.string().min(1).max(2000),
  exhibits: z
    .array(
      z.object({
        doc_id: z.string().min(1).max(128),
        snippet: z.string().min(1).max(2000),
      }),
    )
    .max(8),
});

const LiveAnglesSchema = z.object({
  angles: z.array(LiveAngleSchema).max(16),
});

const JudgeSchema = z.object({
  keep: z.array(z.string().min(1).max(64)).max(64),
});

export interface LiveAngles {
  angles: CandidateAngle[];
  dropped: number;
  tier: string;
}

/**
 * Model-proposed angles against the gated mirror. Grounding is enforced:
 * an exhibit counts only when its doc exists AND its snippet occurs in
 * the doc text. Angles left exhibit-free are dropped, never stored.
 */
export async function proposeAnglesLive(
  client: ModelClient,
  docs: CorpusDoc[],
  topics: string[],
  recordTurn: RecordTurn,
): Promise<LiveAngles> {
  const byId = new Map(docs.map((d) => [d.doc_id, d.text]));
  let raw: string;
  try {
    const mirror = docs
      .map((d) => `[${d.doc_id}] ${d.text.slice(0, 500)}`)
      .join("\n");
    raw = await client.complete(
      `Propose investigative angles for topics: ${topics.join(", ")}. ` +
        `Reply JSON {"angles":[{"title":...,"rationale":...,"exhibits":[{"doc_id":...,"snippet":...}]}]} ` +
        `citing only these exhibits:\n${mirror}`,
    );
  } catch {
    await recordTurn({ tier: "extractive-fallback", toolCalls: 0, label: "angles-live" });
    return {
      angles: rankAngles(proposeAngles(docs, topics)),
      dropped: 0,
      tier: "extractive-fallback",
    };
  }
  await recordTurn({ tier: client.tier, toolCalls: 0, label: "angles-live" });
  let parsed: z.infer<typeof LiveAnglesSchema>;
  try {
    parsed = LiveAnglesSchema.parse(JSON.parse(raw));
  } catch {
    await recordTurn({ tier: "extractive-fallback", toolCalls: 0, label: "angles-live" });
    return {
      angles: rankAngles(proposeAngles(docs, topics)),
      dropped: 0,
      tier: "extractive-fallback",
    };
  }
  let dropped = 0;
  const grounded: CandidateAngle[] = [];
  for (const a of parsed.angles) {
    const kept = a.exhibits.filter((e) => {
      const text = byId.get(e.doc_id);
      return text !== undefined && text.includes(e.snippet);
    });
    dropped += a.exhibits.length - kept.length;
    if (kept.length === 0) {
      dropped += 1;
      continue;
    }
    grounded.push({ title: a.title, rationale: a.rationale, exhibits: kept });
  }
  if (grounded.length === 0) {
    await recordTurn({ tier: "extractive-fallback", toolCalls: 0, label: "angles-live" });
    return {
      angles: rankAngles(proposeAngles(docs, topics)),
      dropped,
      tier: "extractive-fallback",
    };
  }
  return { angles: rankAngles(grounded), dropped, tier: client.tier };
}

export interface LiveJudge {
  topics: string[];
  tier: string;
}

/**
 * Bounded significance judge: the deterministic floor decides the
 * candidate set; the model may only narrow it. Intersection makes ledger
 * widening impossible by construction; failure returns the floor.
 */
export async function judgeSignificanceLive(
  client: ModelClient,
  candidates: string[],
  ledger: Set<string>,
  recordTurn: RecordTurn,
): Promise<LiveJudge> {
  const floor = judgeSignificance(candidates, ledger);
  let raw: string;
  try {
    raw = await client.complete(
      `Which of these topics are significant enough to warrant more research: ${floor.join(", ")}. ` +
        `Reply JSON {"keep":[...]} with a subset only.`,
    );
  } catch {
    await recordTurn({ tier: "ledger-floor", toolCalls: 0, label: "judge-live" });
    return { topics: floor, tier: "ledger-floor" };
  }
  await recordTurn({ tier: client.tier, toolCalls: 0, label: "judge-live" });
  try {
    const parsed = JudgeSchema.parse(JSON.parse(raw));
    const allowed = new Set(floor);
    return {
      topics: parsed.keep.filter((t) => allowed.has(t)),
      tier: client.tier,
    };
  } catch {
    await recordTurn({ tier: "ledger-floor", toolCalls: 0, label: "judge-live" });
    return { topics: floor, tier: "ledger-floor" };
  }
}

const CHAIN_BASE_URLS: Record<string, string> = {
  groq: "https://api.groq.com/openai/v1",
  tokenrouter: "https://api.tokenrouter.com/v1",
};

export interface ChainEntry {
  kind: string;
  label: string;
  secret_slot: string;
  model: string;
  base_url?: string;
  capabilities?: string[];
}

function baseFor(e: ChainEntry): string {
  if (e.kind === "openai-compatible") return (e.base_url ?? "").replace(/\/+$/, "");
  return CHAIN_BASE_URLS[e.kind] ?? "";
}

/**
 * Registry-backed model client (Vercel AI SDK, constitution IV). Tries the
 * operator-ordered chain entries with their secret values (in-flight only,
 * never logged or persisted). Falls through on transport errors, 429, and
 * 5xx; 4xx surfaces. `fetchImpl` is injectable so the chain can be tested
 * without network.
 */
export function buildChainClient(
  entries: ChainEntry[],
  secrets: (slot: string) => string | undefined,
  fetchImpl: typeof fetch = fetch,
): ModelClient {
  const chatEntries = entriesForCapability(entries, "chat");
  const visionEntries = entriesForCapability(entries, "vision");

  async function run(
    pool: ChainEntry[],
    invoke: (
      provider: ReturnType<typeof createOpenAICompatible>,
      entry: ChainEntry,
    ) => Promise<string>,
  ): Promise<string> {
    let lastError = "no chain entries";
    for (const e of pool) {
      const key = secrets(e.secret_slot);
      if (!key) {
        lastError = `missing secret for ${e.label}`;
        continue;
      }
      const baseURL = baseFor(e);
      if (!baseURL) {
        lastError = `no base URL for ${e.label}`;
        continue;
      }
      if (!isAllowedProviderBaseUrl(baseURL)) {
        lastError = `disallowed base URL for ${e.label}`;
        continue;
      }
      const provider = createOpenAICompatible({
        name: e.label,
        baseURL,
        apiKey: key,
        fetch: fetchImpl,
      });
      try {
        const text = await invoke(provider, e);
        if (!text || text.length === 0) {
          lastError = `empty completion from ${e.label}`;
          continue;
        }
        return text;
      } catch (err) {
        if (APICallError.isInstance(err)) {
          const status = err.statusCode;
          if (status === 429 || (status ?? 0) >= 500) {
            lastError = `HTTP ${status} from ${e.label}`;
            continue;
          }
          throw new Error(`provider ${e.label}: HTTP ${status ?? "error"}`);
        }
        lastError = err instanceof Error ? err.message : String(err);
        continue;
      }
    }
    throw new Error(`chain exhausted: ${lastError}`);
  }

  return {
    tier: chatEntries.map((e) => e.label).join("+") || "chain",
    complete: (prompt: string): Promise<string> =>
      run(chatEntries, async (provider, e) => {
        const { text } = await generateText({
          model: provider.chatModel(e.model),
          prompt,
          maxRetries: 0,
        });
        return text;
      }),
    completeVision: (
      prompt: string,
      imageBase64: string,
      mediaType: string,
    ): Promise<string> =>
      run(visionEntries, async (provider, e) => {
        const { text } = await generateText({
          model: provider.chatModel(e.model),
          maxRetries: 0,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                { type: "file", mediaType, data: imageBase64 },
              ],
            },
          ],
        });
        return text;
      }),
  };
}
