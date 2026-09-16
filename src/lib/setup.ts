// First-run setup wizard state machine. The installation boots unconfigured
// (phase "welcome"); the operator walks providers → corpus → instrument;
// "ready" is terminal and requires an instrument. Secrets are never part
// of this state — they live in the Cloudflare secret store only.

import { z } from "zod";
import { isAllowedProviderBaseUrl } from "./net";

export const SetupPhase = z.enum([
  "welcome",
  "providers",
  "corpus",
  "instrument",
  "ready",
]);
export type SetupPhase = z.infer<typeof SetupPhase>;

/** The only environment bindings a provider entry may read a key from.
 *  Anything else (OPERATOR_TOKEN, ENCRYPTION_KEY, SERVER_SECRET, …) must
 *  never be resolvable as a provider credential. */
export const PROVIDER_SLOTS: ReadonlySet<string> = new Set([
  "GROQ_API_KEY",
  "TOKENROUTER_API_KEY",
]);

export function isProviderSlot(slot: string): boolean {
  return PROVIDER_SLOTS.has(slot);
}

export const ProviderEntrySchema = z
  .object({
    /** Registry name (e.g. "groq") or "custom" for OpenAI-compatible. */
    kind: z.enum(["groq", "tokenrouter", "openai-compatible"]),
    label: z.string().min(1).max(64),
    /** Never a key value — the secret slot name it was written to. */
    secret_slot: z.string().min(1).max(64),
    model: z.string().min(1).max(128),
    base_url: z.string().url().optional(),
    /** Declared abilities, e.g. ["vision"], so lanes route correctly. */
    capabilities: z.array(z.string().min(1).max(32)).max(8).optional(),
  })
  .superRefine((p, ctx) => {
    if (!isProviderSlot(p.secret_slot)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["secret_slot"],
        message: "not a provider key slot",
      });
    }
    if (
      p.kind === "openai-compatible" &&
      p.base_url !== undefined &&
      !isAllowedProviderBaseUrl(p.base_url)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["base_url"],
        message: "provider base URL must be https to a public host",
      });
    }
  });
export type ProviderEntry = z.infer<typeof ProviderEntrySchema>;

export const InstrumentSchema = z.object({
  title: z.string().min(1).max(120),
  blurb: z.string().min(1).max(500),
  consent: z.string().min(1).max(2000),
});
export type Instrument = z.infer<typeof InstrumentSchema>;

export const SetupStateSchema = z
  .object({
    phase: SetupPhase,
    providers: z.array(ProviderEntrySchema),
    instrument: InstrumentSchema.nullable(),
    installed_at: z.string().datetime().nullable(),
  })
  .superRefine((s, ctx) => {
    if (s.phase === "ready" && s.instrument === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ready requires an instrument",
      });
    }
  });
export type SetupState = z.infer<typeof SetupStateSchema>;

export type SetupStep = z.infer<typeof SetupStepSchema>;

export const SetupStepSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("providers"),
    providers: z.array(ProviderEntrySchema),
  }),
  InstrumentSchema.extend({
    kind: z.literal("instrument"),
  }),
]);

export const PHASE_ORDER: SetupPhase[] = [
  "welcome",
  "providers",
  "corpus",
  "instrument",
  "ready",
];

export function validateSetupStep(
  state: SetupState,
  step: SetupStep,
): SetupState {
  const stepPhase: SetupPhase =
    step.kind === "providers" ? "providers" : "instrument";
  const at = PHASE_ORDER.indexOf(state.phase);
  const want = PHASE_ORDER.indexOf(stepPhase);
  // Past steps are rejected (the wizard never walks backwards). Earlier
  // phases may be skipped: providers and corpus are optional in
  // principle, so an instrument step may legally arrive from welcome.
  if (want < at) {
    throw new Error(
      `setup step ${step.kind} submitted in phase ${state.phase}`,
    );
  }
  if (step.kind === "providers") {
    return SetupStateSchema.parse({
      ...state,
      providers: step.providers,
      phase: "corpus",
    });
  }
  return SetupStateSchema.parse({
    ...state,
    instrument: InstrumentSchema.parse({
      title: step.title,
      blurb: step.blurb,
      consent: step.consent,
    }),
    phase: "ready",
    installed_at: new Date().toISOString(),
  });
}
