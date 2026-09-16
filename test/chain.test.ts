import { describe, it, expect } from "vitest";
import { buildChainClient, type ChainEntry } from "../src/lib/serve";

const entries: ChainEntry[] = [
  { kind: "openai-compatible", label: "first", secret_slot: "A_KEY", model: "m", base_url: "https://a.example/v1" },
  { kind: "openai-compatible", label: "second", secret_slot: "B_KEY", model: "m", base_url: "https://b.example/v1" },
];

function completion(text: string): Response {
  return new Response(
    JSON.stringify({
      id: "1",
      object: "chat.completion",
      created: 0,
      model: "m",
      choices: [
        { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const secrets = { A_KEY: "ka", B_KEY: "kb" };
const read = (slot: string) => (secrets as Record<string, string>)[slot];

describe("AI SDK provider chain", () => {
  it("serves the first entry when it succeeds", async () => {
    const client = buildChainClient(entries, read, async () => completion("first!")) as {
      tier: string;
      complete: (p: string) => Promise<string>;
    };
    expect(await client.complete("hi")).toBe("first!");
    expect(client.tier).toBe("first+second");
  });

  it("skips entries whose secret is absent", async () => {
    const calls: string[] = [];
    const client = buildChainClient(entries, (slot) => (slot === "B_KEY" ? "kb" : undefined), async (url) => {
      calls.push(String(url));
      return completion("second!");
    });
    expect(await client.complete("hi")).toBe("second!");
    expect(calls.every((u) => u.includes("b.example"))).toBe(true);
  });

  it("falls through 429 and 5xx to the next entry", async () => {
    let n = 0;
    const client = buildChainClient(entries, read, async () => {
      n++;
      return n === 1
        ? new Response("slow down", { status: 429 })
        : completion("recovered");
    });
    expect(await client.complete("hi")).toBe("recovered");
  });

  it("surfaces a 4xx instead of masking it", async () => {
    const client = buildChainClient(entries, read, async () =>
      new Response("bad key", { status: 401 }),
    );
    await expect(client.complete("hi")).rejects.toThrow(/HTTP 401/);
  });

  it("falls through an empty completion", async () => {
    let n = 0;
    const client = buildChainClient(entries, read, async () => {
      n++;
      return n === 1 ? completion("") : completion("filled in");
    });
    expect(await client.complete("hi")).toBe("filled in");
  });

  it("reports chain exhaustion when every entry fails", async () => {
    const client = buildChainClient(entries, read, async () =>
      new Response("nope", { status: 503 }),
    );
    await expect(client.complete("hi")).rejects.toThrow(/chain exhausted/);
  });
});

describe("vision capability routing", () => {
  it("only sends images to vision-tagged entries", async () => {
    const plain = buildChainClient(entries, read, async () => completion("img"));
    // No entry is tagged, so the vision chain is empty and fails loudly.
    await expect(
      plain.completeVision!("prompt", "aGk=", "image/png"),
    ).rejects.toThrow(/chain exhausted/);

    const tagged = buildChainClient(
      [{ ...entries[0], capabilities: ["vision"] }],
      read,
      async () => completion("registry-ocr"),
    );
    expect(await tagged.completeVision!("prompt", "aGk=", "image/png")).toBe(
      "registry-ocr",
    );
  });
});
