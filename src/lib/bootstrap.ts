// Fresh-install bootstrap (A1). A fresh deployment has no key material and
// no operator token, so every write surface is disabled and the wizard
// cannot complete setup. This module is the one pre-provisioned write: using
// a transient, operator-supplied Cloudflare token it installs the three
// master slots straight into the installation's own Worker secret store.
//
// Rules:
//  - a slot that is already set is never rotated here (A2 owns rotation);
//  - the operator token is chosen by the operator and required — a token
//    minted server-side and never shown would be a lockout;
//  - SERVER_SECRET / ENCRYPTION_KEY are generated in-flight when absent and
//    need never be known by a human;
//  - the receipt names slots and booleans only (constitution II).

import type { Bindings } from "../env";
import { putWorkerSecret } from "./secrets";
import { generateSecret } from "./cfapi";

export const MASTER_SLOTS = [
  "SERVER_SECRET",
  "ENCRYPTION_KEY",
  "OPERATOR_TOKEN",
] as const;
export type MasterSlot = (typeof MASTER_SLOTS)[number];

export interface BootstrapInput {
  /** Transient, operator-supplied Cloudflare token. Never stored. */
  cf_token: string;
  account_id: string;
  script_name: string;
  /** Required while OPERATOR_TOKEN is unset: the operator's own choice. */
  operator_token?: string;
}

export interface BootstrapReceipt {
  slots: Array<{
    slot: MasterSlot;
    set: boolean;
    generated: boolean;
    written: boolean;
  }>;
}

export type BootstrapErrorCode =
  | "already_provisioned"
  | "operator_token_required";

export class BootstrapError extends Error {
  constructor(
    public readonly code: BootstrapErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BootstrapError";
  }
}

type MasterEnv = {
  [K in "SERVER_SECRET" | "ENCRYPTION_KEY" | "OPERATOR_TOKEN"]?: Bindings[K];
};

/** Presence only: truthiness of the bindings, never their values. */
export function masterSlotPresence(
  env: MasterEnv,
): Record<MasterSlot, boolean> {
  return {
    SERVER_SECRET: Boolean(env.SERVER_SECRET),
    ENCRYPTION_KEY: Boolean(env.ENCRYPTION_KEY),
    OPERATOR_TOKEN: Boolean(env.OPERATOR_TOKEN),
  };
}

export async function bootstrapInstallation(
  env: MasterEnv,
  input: BootstrapInput,
  fetchImpl: typeof fetch = fetch,
): Promise<BootstrapReceipt> {
  const present = masterSlotPresence(env);
  if (MASTER_SLOTS.every((slot) => present[slot])) {
    throw new BootstrapError(
      "already_provisioned",
      "all master slots are set; bootstrap never rotates them",
    );
  }
  if (!present.OPERATOR_TOKEN && !input.operator_token) {
    throw new BootstrapError(
      "operator_token_required",
      "choose the operator token; it is never minted and hidden",
    );
  }

  const values: Partial<Record<MasterSlot, string>> = {};
  const generated: Record<MasterSlot, boolean> = {
    SERVER_SECRET: false,
    ENCRYPTION_KEY: false,
    OPERATOR_TOKEN: false,
  };
  for (const slot of MASTER_SLOTS) {
    if (present[slot]) continue;
    if (slot === "OPERATOR_TOKEN") {
      values.OPERATOR_TOKEN = input.operator_token as string;
    } else {
      values[slot] = generateSecret(slot);
      generated[slot] = true;
    }
  }

  const ctx = {
    accountId: input.account_id,
    scriptName: input.script_name,
    token: input.cf_token,
  };
  const slots: BootstrapReceipt["slots"] = [];
  for (const slot of MASTER_SLOTS) {
    if (present[slot]) {
      slots.push({ slot, set: true, generated: false, written: false });
      continue;
    }
    await putWorkerSecret(ctx, slot, values[slot] as string, fetchImpl);
    slots.push({ slot, set: true, generated: generated[slot], written: true });
  }
  return { slots };
}
