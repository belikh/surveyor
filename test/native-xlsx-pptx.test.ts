import { describe, it, expect } from "vitest";
import {
  extractPptxText,
  extractXlsxText,
  MAX_SHEET_ROWS,
} from "../src/lib/ooxml";
import { extractNativeText } from "../src/lib/native";
import { buildDrainHandlers, runDrain, type HeldDoc } from "../src/lib/drain";
import { b64, buildPptx, buildXlsx, buildZip } from "./helpers/docs";

const utf8 = new TextEncoder();

describe("native XLSX extraction", () => {
  it("extracts sheets with names, rows and pipe-joined cells", async () => {
    const xlsx = buildXlsx([
      {
        name: "Roster",
        rows: [
          ["Rosters", "Late", "Approved"],
          ["Zara Kline", 12, "no"],
        ],
      },
      {
        name: "Hours",
        rows: [
          ["Week", "Hours"],
          [1, 38],
        ],
      },
    ]);
    const text = await extractXlsxText(xlsx);
    expect(text).toContain("# Sheet: Roster");
    expect(text).toContain("Rosters | Late | Approved");
    expect(text).toContain("Zara Kline | 12 | no");
    expect(text).toContain("# Sheet: Hours");
    expect(text).toContain("Week | Hours");
    expect(text).toContain("1 | 38");
    expect(text.indexOf("# Sheet: Roster")).toBeLessThan(
      text.indexOf("# Sheet: Hours"),
    );
  });

  it("reads shared and inline strings alike", async () => {
    const xlsx = buildXlsx([
      { name: "Mixed", rows: [["shared one", "inline two", "shared three"]] },
    ]);
    const text = await extractXlsxText(xlsx);
    expect(text).toContain("shared one | inline two | shared three");
  });

  it("bounds large sheets with a truncation marker", async () => {
    const rows = Array.from({ length: MAX_SHEET_ROWS + 10 }, (_, i) => [i + 1]);
    const text = await extractXlsxText(buildXlsx([{ name: "Big", rows }]));
    expect(text).toContain(`[sheet truncated after ${MAX_SHEET_ROWS} rows]`);
    expect(text.split("\n").length).toBeLessThanOrEqual(MAX_SHEET_ROWS + 3);
  });

  it("refuses containers without worksheet parts", async () => {
    const zip = buildZip([{ name: "xl/workbook.xml", data: "<workbook/>" }]);
    await expect(extractXlsxText(zip)).rejects.toThrow(/worksheet/);
  });
});

describe("native PPTX extraction", () => {
  it("extracts slides with headings, shape text and table rows", async () => {
    const pptx = buildPptx([
      {
        title: "Roster review",
        bullets: ["Zara Kline approved", "Night shift penalties"],
      },
      {
        title: "Actions",
        table: [
          ["Owner", "Due"],
          ["Zara Kline", "Friday"],
        ],
      },
    ]);
    const text = await extractPptxText(pptx);
    expect(text).toContain("# Slide 1");
    expect(text).toContain("Roster review");
    expect(text).toContain("Zara Kline approved");
    expect(text).toContain("Night shift penalties");
    expect(text).toContain("# Slide 2");
    expect(text).toContain("Owner | Due");
    expect(text).toContain("Zara Kline | Friday");
    expect(text.indexOf("# Slide 1")).toBeLessThan(text.indexOf("# Slide 2"));
  });

  it("refuses containers without slide parts", async () => {
    const zip = buildZip([{ name: "ppt/presentation.xml", data: "<p/>" }]);
    await expect(extractPptxText(zip)).rejects.toThrow(/slide/);
  });
});

describe("native lane dispatch (C2)", () => {
  it("routes XLSX and PPTX lanes to their native tiers", async () => {
    const xlsx = await extractNativeText(
      "held-xlsx",
      buildXlsx([{ name: "S", rows: [["body"]] }]),
    );
    expect(xlsx?.tier).toBe("native-xlsx");
    const pptx = await extractNativeText(
      "held-pptx",
      buildPptx([{ title: "body" }]),
    );
    expect(pptx?.tier).toBe("native-pptx");
  });

  it("returns null for unreadable bytes", async () => {
    expect(await extractNativeText("held-xlsx", utf8.encode("junk"))).toBeNull();
    expect(await extractNativeText("held-pptx", utf8.encode("junk"))).toBeNull();
  });
});

const noModel = { ai: undefined, visionClient: null };

function held(lane: string, bytes: Uint8Array, id = "x1"): HeldDoc {
  return { id, lane, status: "held", bytes_b64: b64(bytes) };
}

describe("XLSX and PPTX native-first drain", () => {
  it("drains a workbook with no model configured", async () => {
    const { results } = await runDrain(
      [held("held-xlsx", buildXlsx([{ name: "Roster", rows: [["roster note"]] }]))],
      buildDrainHandlers(noModel),
    );
    expect(results[0].outcome.status).toBe("parsed");
    expect(results[0].tier).toBe("native-xlsx");
    expect(results[0].outcome.text).toContain("roster note");
  });

  it("drains a deck with no model configured", async () => {
    const { results } = await runDrain(
      [held("held-pptx", buildPptx([{ title: "roster note" }]))],
      buildDrainHandlers(noModel),
    );
    expect(results[0].outcome.status).toBe("parsed");
    expect(results[0].tier).toBe("native-pptx");
    expect(results[0].outcome.text).toContain("# Slide 1");
    expect(results[0].outcome.text).not.toContain("[person");
  });

  it("never calls the model when the native parse succeeds", async () => {
    let calls = 0;
    const handlers = buildDrainHandlers({
      ai: {
        toMarkdown: async () => {
          calls++;
          return { format: "markdown", data: "model body" };
        },
      },
      visionClient: null,
    });
    await runDrain(
      [
        held("held-xlsx", buildXlsx([{ name: "S", rows: [["native body"]] }]), "x"),
        held("held-pptx", buildPptx([{ title: "native body" }]), "p"),
      ],
      handlers,
    );
    expect(calls).toBe(0);
  });

  it("falls back to the model only when native parsing fails", async () => {
    const modelTiers: string[] = [];
    const handlers = buildDrainHandlers({
      ai: {
        toMarkdown: async () => {
          modelTiers.push("workers-ai-toMarkdown");
          return { format: "markdown", data: "model body" };
        },
      },
      visionClient: null,
    });
    const { results } = await runDrain(
      [
        held("held-xlsx", utf8.encode("junk"), "x"),
        held("held-pptx", utf8.encode("junk"), "p"),
      ],
      handlers,
    );
    expect(modelTiers.length).toBe(2);
    expect(results.map((r) => r.outcome.status)).toEqual(["parsed", "parsed"]);
    expect(results[0].tier).toBe("workers-ai-toMarkdown");
    expect(results[0].outcome.text).toContain("model body");
  });
});

describe("XLSX and PPTX lanes at the corpus route", () => {
  async function setup() {
    const { default: app } = await import("../src/index");
    const { FakeD1 } = await import("./helpers/d1");
    const { FakeR2 } = await import("./helpers/r2");
    const db = new FakeD1();
    const corpus = new FakeR2();
    const env = {
      DB: db as never,
      CORPUS: corpus as never,
      OPERATOR_TOKEN: "op-token",
      SERVER_SECRET: "s",
      ENCRYPTION_KEY: "e".padEnd(64, "0"),
    };
    const auth = {
      "content-type": "application/json",
      authorization: "Bearer op-token",
    };
    const callApp = (path: string, init?: RequestInit) =>
      app.fetch(new Request(`https://survey.example${path}`, init), env as never);
    return { db, corpus, callApp, auth };
  }

  it("parses an XLSX natively and gates cell text before the mirror", async () => {
    const { db, corpus, callApp, auth } = await setup();
    await callApp("/api/corpus", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        filename: "roster.xlsx",
        content_type:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        content_b64: b64(
          buildXlsx([
            { name: "Roster", rows: [["Rosters signed by Zara Kline", 12]] },
          ]),
        ),
      }),
    });
    const drained = (await (
      await callApp("/api/corpus/drain", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({}),
      })
    ).json()) as { drained: number };
    expect(drained.drained).toBe(1);

    const list = (await (
      await callApp("/api/corpus", { headers: auth })
    ).json()) as { docs: Array<{ status: string; verdict: string }> };
    expect(list.docs[0].status).toBe("parsed");
    expect(list.docs[0].verdict).toBe("gated");
    expect(corpus.keys()).toEqual([]);

    const fts = JSON.stringify(await db.prepare("SELECT * FROM corpus_fts").all());
    expect(fts).toContain("# Sheet: Roster");
    expect(fts).toContain("Rosters signed by");
    expect(fts).not.toContain("Zara Kline");
    const entities = JSON.stringify(await db.prepare("SELECT * FROM entities").all());
    expect(entities).not.toContain("Zara Kline");
  });

  it("parses a PPTX natively and gates slide text before the mirror", async () => {
    const { db, corpus, callApp, auth } = await setup();
    await callApp("/api/corpus", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        filename: "deck.pptx",
        content_type:
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        content_b64: b64(
          buildPptx([{ title: "Rosters signed by Zara Kline" }]),
        ),
      }),
    });
    const drained = (await (
      await callApp("/api/corpus/drain", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({}),
      })
    ).json()) as { drained: number };
    expect(drained.drained).toBe(1);

    const list = (await (
      await callApp("/api/corpus", { headers: auth })
    ).json()) as { docs: Array<{ status: string; verdict: string }> };
    expect(list.docs[0].status).toBe("parsed");
    expect(list.docs[0].verdict).toBe("gated");
    expect(corpus.keys()).toEqual([]);

    const fts = JSON.stringify(await db.prepare("SELECT * FROM corpus_fts").all());
    expect(fts).toContain("Rosters signed by");
    expect(fts).not.toContain("Zara Kline");
  });
});
