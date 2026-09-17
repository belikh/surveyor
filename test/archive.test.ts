// C4 archive ingest: ZIP members classify individually, unsafe paths are
// refused, nesting is bounded and reported, and whatever members parse
// natively flows through the same pre-mirror gate as every other lane.

import { describe, it, expect } from "vitest";
import {
  extractArchiveText,
  MAX_ARCHIVE_MEMBERS,
} from "../src/lib/archive";
import { classifyLane, statusFor, MAX_DOC_BYTES } from "../src/lib/ingest";
import { extractNativeText } from "../src/lib/native";
import { buildDrainHandlers, runDrain, type HeldDoc } from "../src/lib/drain";
import { b64, buildDocx, buildZip } from "./helpers/docs";

const utf8 = new TextEncoder();

describe("archive lane classification", () => {
  it("routes ZIP archives to the held-archive lane", () => {
    for (const [f, ct] of [
      ["bundle.zip", "application/zip"],
      ["bundle.zip", "application/octet-stream"],
      ["records.zip", "application/x-zip-compressed"],
      ["records", "application/zip"],
    ] as Array<[string, string]>) {
      const r = classifyLane(f, ct, 100);
      expect(r.lane, f).toBe("held-archive");
      expect(r.reason, f).toBeTruthy();
      expect(statusFor(r.lane)).toBe("held");
    }
  });
});

function bundle(): Uint8Array {
  const deeper = buildZip([{ name: "deep.txt", data: "Deep archive body" }]);
  const inner = buildZip([
    { name: "nested.txt", data: "Nested roster note" },
    { name: "deeper.zip", data: deeper },
  ]);
  return buildZip([
    { name: "notes.txt", data: "Rosters are late", deflate: true },
    {
      name: "report.docx",
      data: buildDocx(["Rosters signed by Zara Kline"]),
      deflate: true,
    },
    { name: "scan.png", data: "fakepng" },
    { name: "../escape.txt", data: "Escaped body" },
    { name: "a/../../evil.txt", data: "Traversal body" },
    { name: "/abs.txt", data: "Absolute body" },
    { name: "inner.zip", data: inner },
  ]);
}

describe("native archive extraction", () => {
  it("classifies members individually and reads the supported ones", async () => {
    const text = await extractArchiveText(bundle(), extractNativeText);
    expect(text).toContain("# Archive: 7 members");
    expect(text).toContain("## Member: notes.txt (native)");
    expect(text).toContain("Rosters are late");
    // A DOCX member parses through its own lane.
    expect(text).toContain("## Member: report.docx (held-docx, parsed)");
    expect(text).toContain("Rosters signed by Zara Kline");
    // A scan is classified and skipped, never silently dropped.
    expect(text).toContain("## Member: scan.png (held-ocr, skipped");
    // A nested archive is read, up to the nesting limit.
    expect(text).toContain("Nested roster note");
    expect(text).toContain("nesting limit");
    expect(text).not.toContain("Deep archive body");
  });

  it("refuses unsafe member paths", async () => {
    const text = await extractArchiveText(bundle(), extractNativeText);
    expect(text).toContain("## Member: ../escape.txt (refused: unsafe path)");
    expect(text).toContain("## Member: a/../../evil.txt (refused: unsafe path)");
    expect(text).toContain("## Member: /abs.txt (refused: unsafe path)");
    expect(text).not.toContain("Escaped body");
    expect(text).not.toContain("Traversal body");
    expect(text).not.toContain("Absolute body");
  });

  it("refuses a member that declares more bytes than the document cap", async () => {
    const zip = buildZip([
      {
        name: "huge.txt",
        data: "huge member body",
        declaredSize: MAX_DOC_BYTES + 1,
      },
      { name: "notes.txt", data: "Rosters are late" },
    ]);
    const text = await extractArchiveText(zip, extractNativeText);
    expect(text).toContain("## Member: huge.txt (refused: ");
    expect(text).toContain("exceeds cap");
    expect(text).not.toContain("huge member body");
    expect(text).toContain("Rosters are late");
  });

  it("caps the member count with a truncation marker", async () => {
    const entries = Array.from({ length: MAX_ARCHIVE_MEMBERS + 5 }, (_, i) => ({
      name: `note-${i}.txt`,
      data: `body ${i}`,
    }));
    const text = await extractArchiveText(buildZip(entries), extractNativeText);
    expect(text).toContain(`[archive truncated after ${MAX_ARCHIVE_MEMBERS} members]`);
  });

  it("reports a malformed nested archive instead of failing the bundle", async () => {
    const zip = buildZip([
      { name: "notes.txt", data: "Rosters are late" },
      { name: "broken.zip", data: "this is not a zip" },
    ]);
    const text = await extractArchiveText(zip, extractNativeText);
    expect(text).toContain("## Member: notes.txt (native)");
    expect(text).toContain("Rosters are late");
    expect(text).toContain("## Member: broken.zip (held-archive, skipped");
  });

  it("yields nothing for bytes that are not an archive", async () => {
    expect(
      await extractNativeText("held-archive", utf8.encode("not a zip")),
    ).toBeNull();
    await expect(
      extractArchiveText(utf8.encode("not a zip"), extractNativeText),
    ).rejects.toThrow();
  });
});

describe("archive lane dispatch and drain", () => {
  it("dispatches held-archive to the native tier", async () => {
    const native = await extractNativeText("held-archive", bundle());
    expect(native?.tier).toBe("native-archive");
    expect(native?.text).toContain("Rosters are late");
  });

  it("gates names before the mirror with no model configured", async () => {
    const doc: HeldDoc = {
      id: "z1",
      lane: "held-archive",
      status: "held",
      bytes_b64: b64(bundle()),
    };
    const { results } = await runDrain(
      [doc],
      buildDrainHandlers({ ai: undefined, visionClient: null }),
    );
    const r = results[0];
    expect(r.outcome.status).toBe("parsed");
    expect(r.tier).toBe("native-archive");
    expect(r.outcome.verdict).toBe("gated");
    expect(r.outcome.text).not.toContain("Zara Kline");
    expect(r.outcome.text).toContain("Rosters are late");
  });

  it("stays held with an actionable reason when nothing can parse it", async () => {
    const doc: HeldDoc = {
      id: "z2",
      lane: "held-archive",
      status: "held",
      bytes_b64: b64(utf8.encode("junk bytes")),
    };
    const { results } = await runDrain(
      [doc],
      buildDrainHandlers({ ai: undefined, visionClient: null }),
    );
    expect(results[0].outcome.status).toBe("held");
    expect(results[0].outcome.reason).toMatch(/held-archive/);
    expect(results[0].outcome.reason).toMatch(/document text extraction/);
  });
});

describe("archive lanes at the corpus route", () => {
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

  it("holds a ZIP, drains it natively and gates members before the mirror", async () => {
    const { db, corpus, callApp, upload, auth } = await setup();
    const up = (await (
      await upload("bundle.zip", "application/zip", bundle())
    ).json()) as Record<string, string>;
    expect(up.lane).toBe("held-archive");
    expect(up.status).toBe("held");

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
    expect(fts).toContain("Rosters are late");
    expect(fts).toContain("unsafe path");
    expect(fts).not.toContain("Zara Kline");
    expect(fts).not.toContain("Escaped body");
    const entities = JSON.stringify(await db.prepare("SELECT * FROM entities").all());
    expect(entities).not.toContain("Zara Kline");
  });
});
