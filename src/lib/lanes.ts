// Shared lane providers: the Workers AI binding (keyless document conversion
// and vision OCR) plus the operator's vision-tagged registry entries. One
// place decides what can service a lane, so corpus drains and submitter
// attachments behave identically.

import type { Bindings } from "../env";
import { buildChainClient } from "./serve";
import { entriesForCapability, resolveChain } from "./registry";
import { buildDrainHandlers, type AiBinding, type DrainHandler } from "./drain";
import { currentProviders, hasSecretValue, secretValue } from "./providers";

export async function buildLaneProviders(
  env: Bindings,
): Promise<{ ai?: AiBinding; visionClient: ReturnType<typeof buildChainClient> | null }> {
  const chain = resolveChain(
    {
      phase: "ready",
      providers: await currentProviders(env.DB),
      instrument: null,
      installed_at: null,
    },
    (slot) => hasSecretValue(env, slot),
  );
  const visionEntries = entriesForCapability(chain.entries, "vision");
  return {
    ai: env.AI as unknown as AiBinding,
    visionClient:
      visionEntries.length > 0
        ? buildChainClient(visionEntries, (slot) => secretValue(env, slot))
        : null,
  };
}

export async function buildLaneHandlers(
  env: Bindings,
): Promise<DrainHandler[]> {
  return buildDrainHandlers(await buildLaneProviders(env));
}
