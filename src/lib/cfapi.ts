// Real Cloudflare API adapter for the runtime provisioner (R3). Implements
// the CloudflareApi interface using a transient, operator-consented token.
// Generated secret values are minted here and pushed straight to the secret
// store — they never appear in a receipt, log, or return value
// (constitution II). The Cloudflare API is injectable for tests.
//
// Endpoint shapes are from the primary sources cited in
// `.scratch/cloudflare-native/research/installer-mechanism.md`. Resources
// Cloudflare ships with the Worker bundle (the Workflow class) have no
// separate API and are treated as identity operations; the live
// deploy-destroy trial (T16 #23) must confirm the rest.

import type { CloudflareApi } from "./provision";

export interface CfApiContext {
  accountId: string;
  scriptName: string;
  /** Transient, operator-consented token. Never persisted. */
  token: string;
  fetchImpl?: typeof fetch;
}

interface CfEnvelope<T> {
  success?: boolean;
  result?: T;
  errors?: Array<{ message?: string }>;
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Generate a secret value in-flight, per slot convention. Shared with the
 *  first-run bootstrap, which mints the same master slots. */
export function generateSecret(slot: string): string {
  if (slot === "ENCRYPTION_KEY") return hex(randomBytes(32));
  return b64url(randomBytes(32));
}

export function createCloudflareApi(ctx: CfApiContext): CloudflareApi {
  const fetchImpl = ctx.fetchImpl ?? fetch;
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(ctx.accountId)}`;
  const script = encodeURIComponent(ctx.scriptName);

  async function call<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(base + path, {
        method,
        headers: {
          authorization: `Bearer ${ctx.token}`,
          "content-type": "application/json",
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new Error(
        `cloudflare api unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const data = (await res.json().catch(() => ({}))) as CfEnvelope<T>;
    if (!res.ok || data.success === false) {
      // Surface the API's own message so "already exists" stays detectable.
      const detail = data.errors?.[0]?.message ?? `HTTP ${res.status}`;
      throw new Error(detail);
    }
    return data.result as T;
  }

  return {
    // The Worker is already running (this code). Identity.
    async createWorker(name) {
      return name;
    },
    async getWorkerId(name) {
      return name;
    },
    async createD1(name) {
      const r = await call<{ uuid: string }>("POST", "/d1/database", { name });
      return r.uuid;
    },
    async getD1Id(name) {
      const r = await call<Array<{ uuid: string; name: string }>>(
        "GET",
        "/d1/database",
      );
      const hit = r.find((d) => d.name === name);
      if (!hit) throw new Error("404 not found");
      return hit.uuid;
    },
    async createR2Bucket(name) {
      await call<unknown>("POST", "/r2/buckets", { name });
      return name;
    },
    async getR2BucketId(name) {
      await call<unknown>("GET", `/r2/buckets/${encodeURIComponent(name)}`);
      return name;
    },
    async createQueue(name) {
      const r = await call<{ queue_id: string }>("POST", "/queues", {
        queue_name: name,
      });
      return r.queue_id;
    },
    async getQueueId(name) {
      const r = await call<Array<{ queue_id: string; queue_name: string }>>(
        "GET",
        "/queues",
      );
      const hit = r.find((q) => q.queue_name === name);
      if (!hit) throw new Error("404 not found");
      return hit.queue_id;
    },
    // Workflows ship inside the Worker bundle; no standalone create API.
    async createWorkflow(name) {
      return name;
    },
    async getWorkflowId(name) {
      return name;
    },
    async putCronTrigger(name) {
      await call<unknown>(
        "PUT",
        `/workers/scripts/${encodeURIComponent(name)}/schedules`,
        { crons: ["0 6 * * *"] },
      );
      return true;
    },
    async putSecret(slot, set) {
      // Presence first: re-provisioning must never rotate a slot that is
      // already set (A2). Generated values are minted in-flight and pushed
      // straight to the store; operator-supplied slots are presence-checked
      // only — the provisioner has no value to write.
      const list = await call<Array<{ name: string }>>(
        "GET",
        `/workers/scripts/${script}/secrets`,
      );
      const present = list.some((s) => s.name === slot);
      if (present || !set) return { set: present, written: false };
      const value = generateSecret(slot);
      await call<unknown>("PUT", `/workers/scripts/${script}/secrets`, {
        name: slot,
        text: value,
        type: "secret_text",
      });
      return { set: true, written: true };
    },
    async listR2Objects(bucket) {
      const r = await call<Array<{ key: string }>>(
        "GET",
        `/r2/buckets/${encodeURIComponent(bucket)}/objects`,
      );
      return r.map((o) => o.key);
    },
    async deleteR2Objects(bucket, keys) {
      for (const key of keys) {
        await call<unknown>(
          "DELETE",
          `/r2/buckets/${encodeURIComponent(bucket)}/objects/${encodeURIComponent(key)}`,
        );
      }
      return true;
    },
    async deleteWorker(name) {
      await call<unknown>(
        "DELETE",
        `/workers/scripts/${encodeURIComponent(name)}?force=true`,
      );
      return true;
    },
    async deleteD1(id) {
      await call<unknown>("DELETE", `/d1/database/${encodeURIComponent(id)}`);
      return true;
    },
    async deleteR2Bucket(id) {
      await call<unknown>("DELETE", `/r2/buckets/${encodeURIComponent(id)}`);
      return true;
    },
    async deleteQueue(id) {
      await call<unknown>("DELETE", `/queues/${encodeURIComponent(id)}`);
      return true;
    },
    async deleteWorkflow() {
      // No standalone Workflow resource: it leaves with the Worker bundle.
      return true;
    },
    async deleteCronTrigger(name) {
      await call<unknown>(
        "DELETE",
        `/workers/scripts/${encodeURIComponent(name)}/schedules`,
      );
      return true;
    },
    async deleteSecret(slot) {
      await call<unknown>(
        "DELETE",
        `/workers/scripts/${script}/secrets/${encodeURIComponent(slot)}`,
      );
      return true;
    },
  };
}
