// Provision/teardown contract for one investigation stack in an operator's
// own Cloudflare account. Pure orchestration over an injected CloudflareApi
// — no fetch, no wrangler, no ambient credentials. Secrets are generated
// here and pushed straight into the secret store; their VALUES never leave
// this module's stack frames (constitution II: receipts are slot names).

import { checkScopes } from "./scopes";

export interface CloudflareApi {
  createWorker(name: string): Promise<string>;
  getWorkerId(name: string): Promise<string>;
  createD1(name: string): Promise<string>;
  getD1Id(name: string): Promise<string>;
  createR2Bucket(name: string): Promise<string>;
  getR2BucketId(name: string): Promise<string>;
  createQueue(name: string): Promise<string>;
  getQueueId(name: string): Promise<string>;
  createWorkflow(name: string): Promise<string>;
  getWorkflowId(name: string): Promise<string>;
  putCronTrigger(name: string): Promise<boolean>;
  /**
   * Ensure a slot: a generated slot is minted and written only when absent,
   * an operator-supplied slot is presence-checked. Never rotates a set slot
   * (A2). `set` is presence, `written` says whether this call wrote a value.
   */
  putSecret(
    slot: string,
    set: boolean,
  ): Promise<{ set: boolean; written: boolean }>;
  listR2Objects(bucket: string): Promise<string[]>;
  deleteR2Objects(bucket: string, keys: string[]): Promise<boolean>;
  deleteWorker(name: string): Promise<boolean>;
  deleteD1(name: string): Promise<boolean>;
  deleteR2Bucket(name: string): Promise<boolean>;
  deleteQueue(name: string): Promise<boolean>;
  deleteWorkflow(name: string): Promise<boolean>;
  deleteCronTrigger(name: string): Promise<boolean>;
  deleteSecret(slot: string): Promise<boolean>;
}

export interface SecretSlot {
  slot: string;
  /** true = generated in-flight (never shown); false = operator-supplied. */
  generate: boolean;
}

export interface ProvisionPlan {
  name: string;
  subdomain: string;
  secrets: SecretSlot[];
  /**
   * Token-paste fallback path: the scopes the pasted token actually grants.
   * When present, required scopes are checked up front and fail loud as
   * step "scopes". Absent (OAuth button path), no check — the button flow
   * carries its own permissions.
   */
  grantedScopes?: string[];
}

export interface ProvisionReceipt {
  worker: { id: string };
  d1: { id: string };
  r2: { id: string };
  queue: { id: string };
  workflow: { id: string };
  cron: boolean;
  /**
   * Slot names and booleans only, never values (constitution II):
   * `set` = the slot exists after provisioning, `generated` = this run
   * minted it, `written` = this run wrote it (A2 keeps re-runs from
   * rotating anything already set).
   */
  secrets: Array<{
    slot: string;
    set: boolean;
    generated: boolean;
    written: boolean;
  }>;
}

export interface TeardownReceipt {
  wiped: Record<string, "deleted" | "already-gone" | "failed">;
  not_wiped: string[];
}

export class ProvisionError extends Error {
  constructor(
    public readonly step: string,
    public readonly message: string,
  ) {
    super(`provision failed at ${step}: ${message}`);
    this.name = "ProvisionError";
  }
}

async function step<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new ProvisionError(
      name,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Idempotent resource creation: on "already exists", fetch the real id.
 *  The live APIs share no single wording — Queues say "already taken", and
 *  a bare 409 carries no message at all — so match all three. Proven
 *  against a real account by the A16 trial, where a half-provisioned stack
 *  (queue created by wrangler, worker deployed by hand) had to converge. */
const ALREADY_EXISTS = /exists|already taken|duplicate|^http 409\b/i;

async function createOrReuse(
  api: CloudflareApi,
  create: (name: string) => Promise<string>,
  getId: (name: string) => Promise<string>,
  name: string,
): Promise<string> {
  try {
    return await create(name);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (ALREADY_EXISTS.test(msg)) {
      return await getId(name);
    }
    throw err;
  }
}

export async function provisionStack(
  api: CloudflareApi,
  plan: ProvisionPlan,
): Promise<ProvisionReceipt> {
  if (plan.grantedScopes !== undefined) {
    const { missing } = checkScopes(plan.grantedScopes);
    if (missing.length > 0) {
      throw new ProvisionError("scopes", `missing: ${missing.join(", ")}`);
    }
  }
  const worker = await step("createWorker", () =>
    createOrReuse(
      api,
      (n) => api.createWorker(n),
      (n) => api.getWorkerId(n),
      plan.name,
    ),
  );
  const d1 = await step("createD1", () =>
    createOrReuse(
      api,
      (n) => api.createD1(n),
      (n) => api.getD1Id(n),
      `${plan.name}-db`,
    ),
  );
  const r2 = await step("createR2Bucket", () =>
    createOrReuse(
      api,
      (n) => api.createR2Bucket(n),
      (n) => api.getR2BucketId(n),
      `${plan.name}-corpus`,
    ),
  );
  const queue = await step("createQueue", () =>
    createOrReuse(
      api,
      (n) => api.createQueue(n),
      (n) => api.getQueueId(n),
      `${plan.name}-ingest`,
    ),
  );
  const workflow = await step("createWorkflow", () =>
    createOrReuse(
      api,
      (n) => api.createWorkflow(n),
      (n) => api.getWorkflowId(n),
      `${plan.name}-engine`,
    ),
  );
  const cron = await step("putCronTrigger", () =>
    api.putCronTrigger(plan.name),
  );

  const secrets: ProvisionReceipt["secrets"] = [];
  for (const s of plan.secrets) {
    const result = await step(`putSecret:${s.slot}`, () =>
      api.putSecret(s.slot, s.generate),
    );
    secrets.push({
      slot: s.slot,
      set: result.set,
      generated: result.written && s.generate,
      written: result.written,
    });
  }

  return { worker: { id: worker }, d1: { id: d1 }, r2: { id: r2 }, queue: { id: queue }, workflow: { id: workflow }, cron, secrets };
}

export async function teardownStack(
  api: CloudflareApi,
  receipt: ProvisionReceipt,
): Promise<TeardownReceipt> {
  const wiped: TeardownReceipt["wiped"] = {};
  const notWiped: string[] = [];

  const attempt = async (key: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      wiped[key] = "deleted";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/404|not found|already/i.test(msg)) {
        wiped[key] = "already-gone";
      } else {
        wiped[key] = "failed";
        notWiped.push(key);
      }
    }
  };

  // R2 must be empty before the bucket can be deleted.
  const objects = await api.listR2Objects(receipt.r2.id);
  if (objects.length > 0) {
    await api.deleteR2Objects(receipt.r2.id, objects);
  }
  for (const s of receipt.secrets) {
    await attempt(`secret:${s.slot}`, () => api.deleteSecret(s.slot));
  }
  await attempt("cron", () => api.deleteCronTrigger(receipt.worker.id));
  await attempt("queue", () => api.deleteQueue(receipt.queue.id));
  await attempt("workflow", () => api.deleteWorkflow(receipt.workflow.id));
  await attempt("d1", () => api.deleteD1(receipt.d1.id));
  await attempt("r2", () => api.deleteR2Bucket(receipt.r2.id));
  // The Worker is deleted last: when the uninstaller runs inside the Worker
  // itself, deleting it earlier would terminate the request mid-receipt.
  await attempt("worker", () => api.deleteWorker(receipt.worker.id));

  // Honest wipe statement: Cloudflare retains account logs/analytics we
  // cannot delete; the receipt says so.
  return {
    wiped,
    not_wiped: [
      ...notWiped,
      "cloudflare-account-logs-and-analytics (outside our control)",
    ],
  };
}
