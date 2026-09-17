import { describe, it, expect, vi, afterEach } from "vitest";
import { extractPdfText } from "../src/lib/pdf";
import { extractDocxText } from "../src/lib/ooxml";
import { extractNativeText } from "../src/lib/native";
import { buildDrainHandlers, runDrain, type HeldDoc } from "../src/lib/drain";
import { openZip } from "../src/lib/zip";
import {
  b64,
  buildDocx,
  buildEncryptedPdfWithText,
  buildPdf,
  buildPdfWithCmap,
  buildZip,
} from "./helpers/docs";

const utf8 = new TextEncoder();

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("native PDF extraction", () => {
  it("extracts page text in page order", async () => {
    const text = await extractPdfText(buildPdf(["First page body", "Second page body"]));
    expect(text).toContain("First page body");
    expect(text).toContain("Second page body");
    expect(text.indexOf("First")).toBeLessThan(text.indexOf("Second"));
  });

  it("decodes Type0 codes through the ToUnicode CMap", async () => {
    const pdf = buildPdfWithCmap(
      [
        [0x0041, "Z"],
        [0x0042, "a"],
        [0x0043, "r"],
        [0x0044, "a"],
        [0x0020, " "],
        [0x004b, "K"],
      ],
      [0x41, 0x42, 0x43, 0x44, 0x20, 0x4b],
    );
    expect(await extractPdfText(pdf)).toBe("Zara K");
  });

  it("returns no text for scans, encrypted files and malformed bytes", async () => {
    expect(await extractPdfText(buildPdf([""]))).toBe("");
    expect(await extractPdfText(buildEncryptedPdfWithText("Hidden body"))).toBe("");
    expect(await extractPdfText(utf8.encode("not a pdf at all"))).toBe("");
    expect(await extractPdfText(new Uint8Array())).toBe("");
  });
});

describe("native DOCX extraction", () => {
  it("extracts paragraphs and table rows from a deflated container", async () => {
    const docx = buildDocx(["Rosters with Zara Kline", "Second paragraph"], {
      table: [
        ["Row cells", "second"],
        ["top", "floor"],
      ],
    });
    const text = await extractDocxText(docx);
    expect(text).toContain("Rosters with Zara Kline");
    expect(text).toContain("Second paragraph");
    expect(text).toContain("Row cells | second");
    expect(text).toContain("top | floor");
  });

  it("keeps tabs and line breaks inside a run", async () => {
    const xml =
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      "<w:body><w:p><w:r><w:t>A</w:t><w:tab/><w:t>B</w:t><w:br/><w:t>C</w:t></w:r></w:p>" +
      "</w:body></w:document>";
    const docx = buildZip([{ name: "word/document.xml", data: xml, deflate: true }]);
    expect(await extractDocxText(docx)).toBe("A\tB\nC");
  });

  it("refuses a container without the body part", async () => {
    await expect(extractDocxText(buildDocx([], { omitBody: true }))).rejects.toThrow(
      /document\.xml/,
    );
  });

  it("refuses a ZIP entry that exceeds the uncompressed cap", async () => {
    const zip = await openZip(buildDocx(["Body"]));
    expect(zip.names()).toContain("word/document.xml");
    await expect(zip.read("word/document.xml")).resolves.toBeInstanceOf(Uint8Array);
    await expect(zip.read("no/such-part.xml")).resolves.toBeNull();
  });
});

describe("native lane dispatch", () => {
  it("routes PDF and DOCX lanes to their native tiers", async () => {
    const pdf = await extractNativeText("held-pdf", buildPdf(["Body"]));
    expect(pdf?.tier).toBe("native-pdf");
    const docx = await extractNativeText("held-docx", buildDocx(["Body"]));
    expect(docx?.tier).toBe("native-docx");
  });

  it("returns null for unsupported lanes and unreadable bytes", async () => {
    expect(await extractNativeText("held-ocr", utf8.encode("x"))).toBeNull();
    expect(await extractNativeText("held-pdf", utf8.encode("junk"))).toBeNull();
    expect(await extractNativeText("held-docx", utf8.encode("junk"))).toBeNull();
  });
});

const noModel = { ai: undefined, visionClient: null };

function heldPdf(bytes: Uint8Array, id = "p1"): HeldDoc {
  return { id, lane: "held-pdf", status: "held", bytes_b64: b64(bytes) };
}

function heldDocx(bytes: Uint8Array, id = "d1"): HeldDoc {
  return { id, lane: "held-docx", status: "held", bytes_b64: b64(bytes) };
}

describe("native-first drain", () => {
  it("drains a PDF with no model configured", async () => {
    const { results } = await runDrain(
      [heldPdf(buildPdf(["Rosters with Zara Kline"]))],
      buildDrainHandlers(noModel),
    );
    const r = results[0];
    expect(r.outcome.status).toBe("parsed");
    expect(r.tier).toBe("native-pdf");
    expect(r.outcome.verdict).toBe("gated");
    expect(r.outcome.text).toContain("[person");
    expect(r.outcome.text).not.toContain("Zara Kline");
  });

  it("drains a DOCX with no model configured", async () => {
    const { results } = await runDrain(
      [heldDocx(buildDocx(["Deck rosters"]))],
      buildDrainHandlers(noModel),
    );
    expect(results[0].outcome.status).toBe("parsed");
    expect(results[0].tier).toBe("native-docx");
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
    const { results } = await runDrain(
      [heldPdf(buildPdf(["native body text"]))],
      handlers,
    );
    expect(calls).toBe(0);
    expect(results[0].tier).toBe("native-pdf");
    expect(results[0].outcome.text).toContain("native body text");
  });

  it("falls back to the model only when the native parse fails", async () => {
    const calls: string[] = [];
    const handlers = buildDrainHandlers({
      ai: {
        toMarkdown: async () => {
          calls.push("model");
          return { format: "markdown", data: "model fallback body" };
        },
      },
      visionClient: null,
    });
    const { results } = await runDrain(
      [
        heldPdf(utf8.encode("junk that is not a pdf"), "p1"),
        heldPdf(buildPdf([""]), "p2"),
        heldDocx(buildDocx([], { omitBody: true }), "d1"),
      ],
      handlers,
    );
    expect(calls.length).toBe(3);
    expect(results.map((r) => r.outcome.status)).toEqual([
      "parsed",
      "parsed",
      "parsed",
    ]);
    expect(results[0].tier).toBe("workers-ai-toMarkdown");
    expect(results[0].outcome.text).toContain("model fallback body");
  });

  it("stays held with a reason when native fails and no model exists", async () => {
    const { results } = await runDrain(
      [heldPdf(utf8.encode("junk"), "p1")],
      buildDrainHandlers(noModel),
    );
    expect(results[0].outcome.status).toBe("held");
    expect(results[0].outcome.reason).toMatch(/no capable provider configured/);
    expect(results[0].outcome.reason).toMatch(/document text extraction/);
  });
});

describe("native lanes at the corpus route", () => {
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
    const auth = { authorization: "Bearer op-token" };
    const callApp = (path: string, init?: RequestInit) =>
      app.fetch(new Request(`https://survey.example${path}`, init), env as never);
    // A11/A15 corpus framing: identifiers in headers, raw bytes as the body.
    const upload = (filename: string, mediaType: string, body: BodyInit) =>
      callApp("/api/corpus", {
        method: "POST",
        headers: {
          ...auth,
          "x-filename": encodeURIComponent(filename),
          "content-type": mediaType,
        },
        body,
      });
    return { db, corpus, callApp, upload, auth };
  }

  it("parses a PDF natively and gates names before the mirror", async () => {
    const { db, corpus, callApp, upload, auth } = await setup();
    const uploaded = await upload(
      "roster.pdf",
      "application/pdf",
      buildPdf(["Rosters signed by Zara Kline"]),
    );
    expect(uploaded.status).toBe(200);
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
    ).json()) as {
      docs: Array<{ status: string; verdict: string; reason: string | null }>;
    };
    expect(list.docs[0].status).toBe("parsed");
    expect(list.docs[0].verdict).toBe("gated");
    expect(list.docs[0].reason).toBeNull();
    expect(corpus.keys()).toEqual([]);

    const fts = JSON.stringify(await db.prepare("SELECT * FROM corpus_fts").all());
    expect(fts).toContain("Rosters signed by");
    expect(fts).not.toContain("Zara Kline");
    const entities = JSON.stringify(await db.prepare("SELECT * FROM entities").all());
    expect(entities).not.toContain("Zara Kline");
    const tele = (await (
      await callApp("/api/telemetry", { headers: auth })
    ).json()) as Array<{ tier: string }>;
    expect(tele.some((t) => t.tier === "native-pdf")).toBe(true);
  });

  it("parses a DOCX natively and gates names before the mirror", async () => {
    const { db, corpus, callApp, upload, auth } = await setup();
    await upload(
      "roster.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buildDocx(["Rosters signed by Zara Kline"]),
    );
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
    ).json()) as {
      docs: Array<{ status: string; verdict: string }>;
    };
    expect(list.docs[0].status).toBe("parsed");
    expect(list.docs[0].verdict).toBe("gated");
    expect(corpus.keys()).toEqual([]);

    const fts = JSON.stringify(await db.prepare("SELECT * FROM corpus_fts").all());
    expect(fts).toContain("Rosters signed by");
    expect(fts).not.toContain("Zara Kline");
  });
});
