import { describe, it, expect } from "vitest";
import { buildChainClient, type ChainEntry } from "../src/lib/serve";

const entries: ChainEntry[] = [
  { kind: "openai-compatible", label: "first", secret_slot: "GROQ_API_KEY", model: "m", base_url: "https://a.example/v1" },
  { kind: "openai-compatible", label: "second", secret_slot: "TOKENROUTER_API_KEY", model: "m", base_url: "https://b.example/v1" },
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

const secrets = { GROQ_API_KEY: "ka", TOKENROUTER_API_KEY: "kb" };
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
    const client = buildChainClient(entries, (slot) => (slot === "TOKENROUTER_API_KEY" ? "kb" : undefined), async (url) => {
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

describe("destination policy (A12, #13)", () => {
  it("refuses to follow a redirect with the provider key attached", async () => {
    let sawRedirect: string | undefined;
    let calls = 0;
    const redirecting = (async (_url: string, init?: RequestInit) => {
      calls++;
      sawRedirect = init?.redirect as string | undefined;
      return new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/v1/chat/completions" },
      });
    }) as typeof fetch;
    const client = buildChainClient(entries.slice(0, 1), read, redirecting);
    await expect(client.complete("hi")).rejects.toThrow(/302|chain exhausted/);
    expect(sawRedirect).toBe("manual");
    expect(calls).toBe(1);
  });

  it("refuses private and loopback hosts before any request", async () => {
    const hosts = [
      "http://127.0.0.1:8788/v1",
      "http://localhost:8788/v1",
      "https://10.1.2.3/v1",
      "https://192.168.0.10/v1",
    ];
    let calls = 0;
    for (const base_url of hosts) {
      const local: ChainEntry = {
        kind: "openai-compatible",
        label: "local",
        secret_slot: "GROQ_API_KEY",
        model: "m",
        base_url,
      };
      const client = buildChainClient([local], read, async () => {
        calls++;
        return completion("should never be reached");
      });
      await expect(client.complete("hi")).rejects.toThrow(/chain exhausted/);
    }
    expect(calls).toBe(0);
  });

  it("skips a disallowed host and serves the next public entry", async () => {
    const local: ChainEntry = {
      kind: "openai-compatible",
      label: "local",
      secret_slot: "GROQ_API_KEY",
      model: "m",
      base_url: "https://127.0.0.1/v1",
    };
    const calls: string[] = [];
    const client = buildChainClient([local, entries[1]], read, async (url) => {
      calls.push(String(url));
      return completion("public!");
    });
    expect(await client.complete("hi")).toBe("public!");
    expect(calls.every((u) => u.includes("b.example"))).toBe(true);
  });
});

describe("capability routing", () => {
  it("never spends a chat call on a search-tagged entry", async () => {
    const mixed: ChainEntry[] = [
      {
        kind: "tavily",
        label: "find",
        secret_slot: "TAVILY_API_KEY",
        model: "search",
        capabilities: ["search"],
      },
      {
        kind: "openai-compatible",
        label: "chat",
        secret_slot: "GROQ_API_KEY",
        model: "m",
        base_url: "https://a.example/v1",
      },
    ];
    let calls = 0;
    const client = buildChainClient(mixed, () => "k", async () => {
      calls++;
      return completion("chat!");
    });
    expect(await client.complete("hi")).toBe("chat!");
    expect(calls).toBe(1);
    expect(client.tier).toBe("chat");
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
