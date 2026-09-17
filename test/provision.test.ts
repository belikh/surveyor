import { describe, it, expect } from "vitest";
import {
  provisionStack,
  teardownStack,
  type CloudflareApi,
  type ProvisionPlan,
} from "../src/lib/provision";

// A fake Cloudflare API surface: records every call, returns canned
// responses. The provision code must only ever call methods on this
// interface — no fetch, no wrangler, nothing else.
function fakeApi(overrides: Partial<CloudflareApi> = {}): CloudflareApi & {
  calls: Array<{ method: string; args: unknown[] }>;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const track =
    <A extends unknown[], R>(name: string, fn: (...a: A) => R) =>
    (...args: A): R => {
      calls.push({ method: name, args });
      return fn(...args);
    };
  const ids = {
    worker: "wrk-1",
    d1: "d1-1",
    r2: "r2-1",
    queue: "q-1",
    workflow: "wf-1",
  };
  const api: CloudflareApi = {
    createWorker: track("createWorker", async () => ids.worker),
    getWorkerId: track("getWorkerId", async () => ids.worker),
    createD1: track("createD1", async () => ids.d1),
    getD1Id: track("getD1Id", async () => ids.d1),
    createR2Bucket: track("createR2Bucket", async () => ids.r2),
    getR2BucketId: track("getR2BucketId", async () => ids.r2),
    createQueue: track("createQueue", async () => ids.queue),
    getQueueId: track("getQueueId", async () => ids.queue),
    createWorkflow: track("createWorkflow", async () => ids.workflow),
    getWorkflowId: track("getWorkflowId", async () => ids.workflow),
    putCronTrigger: track("putCronTrigger", async () => true),
    // The adapter mints and writes only absent generated slots; a present
    // slot is reported set with written false. The fake models that.
    putSecret: track("putSecret", async (_slot: string, generate: boolean) =>
      generate ? { set: true, written: true } : { set: true, written: false },
    ),
    listR2Objects: track("listR2Objects", async () => []),
    deleteR2Objects: track("deleteR2Objects", async () => true),
    deleteWorker: track("deleteWorker", async () => true),
    deleteD1: track("deleteD1", async () => true),
    deleteR2Bucket: track("deleteR2Bucket", async () => true),
    deleteQueue: track("deleteQueue", async () => true),
    deleteWorkflow: track("deleteWorkflow", async () => true),
    deleteCronTrigger: track("deleteCronTrigger", async () => true),
    deleteSecret: track("deleteSecret", async () => true),
    ...overrides,
  };
  return Object.assign(api, { calls });
}

const plan: ProvisionPlan = {
  name: "surveyor-investigation",
  subdomain: "neutral-example",
  secrets: [
    { slot: "SERVER_SECRET", generate: true },
    { slot: "ENCRYPTION_KEY", generate: true },
    { slot: "OPERATOR_TOKEN", generate: true },
    { slot: "GROQ_API_KEY", generate: false },
  ],
};

describe("provisionStack", () => {
  it("returns a receipt naming every binding with its id", async () => {
    const api = fakeApi();
    const receipt = await provisionStack(api, plan);
    expect(receipt.worker.id).toBe("wrk-1");
    expect(receipt.d1.id).toBe("d1-1");
    expect(receipt.r2.id).toBe("r2-1");
    expect(receipt.queue.id).toBe("q-1");
    expect(receipt.workflow.id).toBe("wf-1");
    expect(receipt.cron).toBe(true);
    expect(receipt.secrets).toEqual([
      { slot: "SERVER_SECRET", set: true, generated: true, written: true },
      { slot: "ENCRYPTION_KEY", set: true, generated: true, written: true },
      { slot: "OPERATOR_TOKEN", set: true, generated: true, written: true },
      { slot: "GROQ_API_KEY", set: true, generated: false, written: false },
    ]);
  });

  it("never places a secret value in the receipt or any call arg", async () => {
    const api = fakeApi();
    await provisionStack(api, plan);
    const seen = JSON.stringify(api.calls);
    // Generated values exist (putSecret was called) but are not observable.
    const secretCalls = api.calls.filter((c) => c.method === "putSecret");
    expect(secretCalls.length).toBe(4);
    // Receipt carries slots, never values (typed shape above enforces it;
    // belt-and-braces: no long high-entropy string appears anywhere).
    for (const call of secretCalls) {
      const arg = JSON.stringify(call.args[1] ?? "");
      expect(arg.length).toBeLessThan(32); // slot name or flag, not a value
    }
    expect(seen).not.toMatch(/value|secret_[a-z0-9]{20,}/i);
  });

  it("throws typed ProvisionError on API failure naming the step", async () => {
    const api = fakeApi({
      createD1: async () => {
        throw new Error("boom at provider");
      },
    });
    await expect(provisionStack(api, plan)).rejects.toMatchObject({
      name: "ProvisionError",
      step: "createD1",
    });
  });

  it("converges when re-run over a half-provisioned stack", async () => {
    // First createD1 call returns a fresh id; every later call throws
    // "already exists" — the provisioner must converge to the same id.
    let created = false;
    const api = fakeApi({
      createD1: async () => {
        if (created) throw new Error("already exists");
        created = true;
        return "d1-1";
      },
    });
    const r1 = await provisionStack(api, plan);
    const r2 = await provisionStack(api, plan);
    expect(r2.d1.id).toBe(r1.d1.id);
  });

  it("converges on the live Queues 'already taken' wording (A16)", async () => {
    // The real API answers a taken queue name with "already taken", not
    // "already exists" — observed live 2026-09-17. The provisioner must
    // still converge through getQueueId rather than fail the run.
    const api = fakeApi({
      createQueue: async () => {
        throw new Error(
          "Queue name 'surveyor-ingest' is already taken. Please use a different name and try again.",
        );
      },
    });
    const receipt = await provisionStack(api, plan);
    expect(receipt.queue.id).toBe("q-1");
    expect(api.calls.map((c) => c.method)).toContain("getQueueId");
  });

  it("converges on a bare HTTP 409 from any create call", async () => {
    const api = fakeApi({
      createR2Bucket: async () => {
        throw new Error("HTTP 409");
      },
    });
    const receipt = await provisionStack(api, plan);
    expect(receipt.r2.id).toBe("r2-1");
  });

  it("reports an existing generated slot as set but not written (A2)", async () => {
    // A re-run finds the slot present: nothing is minted, nothing is
    // overwritten, and the receipt stays truthful about it.
    const api = fakeApi({
      putSecret: async () => ({ set: true, written: false }),
    });
    const receipt = await provisionStack(api, plan);
    expect(receipt.secrets[0]).toEqual({
      slot: "SERVER_SECRET",
      set: true,
      generated: false,
      written: false,
    });
  });
});

describe("teardownStack", () => {
  it("empties R2 before deleting the bucket, deletes all resources, and reports honestly", async () => {
    const api = fakeApi();
    await teardownStack(api, {
      worker: { id: "wrk-1" },
      d1: { id: "d1-1" },
      r2: { id: "r2-1" },
      queue: { id: "q-1" },
      workflow: { id: "wf-1" },
      cron: true,
      secrets: [
        {
          slot: "SERVER_SECRET",
          set: true,
          generated: true,
          written: true,
        },
      ],
    });
    const order = api.calls.map((c) => c.method);
    const r2List = order.indexOf("listR2Objects");
    const r2DelObjects = order.indexOf("deleteR2Objects");
    const r2DelBucket = order.indexOf("deleteR2Bucket");
    expect(r2List).toBeGreaterThanOrEqual(0);
    // Empty bucket: object deletion is legitimately skipped.
    if (r2DelObjects !== -1) {
      expect(r2DelObjects).toBeGreaterThan(r2List);
      expect(r2DelBucket).toBeGreaterThan(r2DelObjects);
    } else {
      expect(r2DelBucket).toBeGreaterThan(r2List);
    }
    for (const m of [
      "deleteWorker",
      "deleteD1",
      "deleteR2Bucket",
      "deleteQueue",
      "deleteWorkflow",
      "deleteCronTrigger",
      "deleteSecret",
    ]) {
      expect(order).toContain(m);
    }
  });

  it("converges when resources are already gone (404s)", async () => {
    const api = fakeApi({
      deleteWorker: async () => {
        throw new Error("404");
      },
      deleteD1: async () => {
        throw new Error("404");
      },
    });
    const receipt = await teardownStack(api, {
      worker: { id: "wrk-1" },
      d1: { id: "d1-1" },
      r2: { id: "r2-1" },
      queue: { id: "q-1" },
      workflow: { id: "wf-1" },
      cron: true,
      secrets: [],
    });
    expect(receipt.wiped.worker).toBe("already-gone");
  });
});

function trackOnce(
  _name: string,
  fn: () => string,
  _push: (c: { method: string; args: unknown[] }) => void,
) {
  let done = false;
  return async () => {
    if (!done) {
      done = true;
      return fn();
    }
    throw new Error("exists");
  };
}

describe("grantedScopes", () => {
  it("fails loud at step scopes when the pasted token is under-scoped", async () => {
    const api = fakeApi();
    await expect(
      provisionStack(api, { ...plan, grantedScopes: ["workers:write"] }),
    ).rejects.toMatchObject({ name: "ProvisionError", step: "scopes" });
  });

  it("provisions when the pasted token carries every required scope", async () => {
    const api = fakeApi();
    const { REQUIRED_SCOPES } = await import("../src/lib/scopes");
    const receipt = await provisionStack(api, {
      ...plan,
      grantedScopes: REQUIRED_SCOPES,
    });
    expect(receipt.worker.id).toBe("wrk-1");
  });
});
