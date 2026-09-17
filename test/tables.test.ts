// C5 table ingest: CSV and TSV become the same column-aware row text the
// XLSX lane produces, gated before the mirror and bounded like sheets.

import { describe, it, expect } from "vitest";
import {
  parseDelimited,
  delimitedToText,
  MAX_TABLE_ROWS,
} from "../src/lib/tables";
import { MAX_TABLE_CHARS } from "../src/lib/ooxml";
import { classifyLane } from "../src/lib/ingest";

describe("parseDelimited", () => {
  it("parses quoted cells with escaped quotes and embedded delimiters", () => {
    const rows = parseDelimited(
      'Name,Note\r\n"Kline, Zara","said ""hello"" to all"\r\n',
      ",",
    );
    expect(rows).toEqual([
      ["Name", "Note"],
      ["Kline, Zara", 'said "hello" to all'],
    ]);
  });

  it("keeps embedded newlines inside a quoted cell", () => {
    const rows = parseDelimited('a,b\r\n"line one\nline two",c\r\n', ",");
    expect(rows[1]).toEqual(["line one\nline two", "c"]);
  });

  it("parses tab-separated text and strips a BOM", () => {
    const rows = parseDelimited("\ufeffWeek\tHours\r\n1\t38\r\n", "\t");
    expect(rows).toEqual([
      ["Week", "Hours"],
      ["1", "38"],
    ]);
  });

  it("does not invent a row from a trailing newline or an empty file", () => {
    expect(parseDelimited("a,b\n", ",")).toEqual([["a", "b"]]);
    expect(parseDelimited("", ",")).toEqual([]);
  });
});

describe("delimitedToText", () => {
  it("renders rows as pipe-joined cells and skips blank rows", () => {
    const text = delimitedToText(
      "Name,Hours,Approved\nZara Kline,12,no\n\n,,\nSam Doyle,38,yes\n",
      ",",
    );
    expect(text).toBe(
      "Name | Hours | Approved\nZara Kline | 12 | no\nSam Doyle | 38 | yes",
    );
  });

  it("bounds a large table with an explicit row marker", () => {
    const rows = Array.from(
      { length: MAX_TABLE_ROWS + 10 },
      (_, i) => `${i + 1},row ${i + 1}`,
    );
    const text = delimitedToText(rows.join("\n"), ",");
    expect(text).toContain(`[table truncated after ${MAX_TABLE_ROWS} rows]`);
    expect(text.split("\n").length).toBeLessThanOrEqual(MAX_TABLE_ROWS + 2);
  });

  it("bounds a table with an explicit character marker", () => {
    const text = delimitedToText(`huge\n${"x".repeat(MAX_TABLE_CHARS + 10)}`, ",");
    expect(text).toContain(`[table truncated at ${MAX_TABLE_CHARS} characters]`);
  });
});

describe("table lane classification", () => {
  it("labels CSV and TSV as native table text", () => {
    expect(classifyLane("roster.csv", "text/csv", 100)).toMatchObject({
      lane: "native",
      table: "csv",
    });
    expect(classifyLane("hours.tsv", "text/tab-separated-values", 100)).toMatchObject({
      lane: "native",
      table: "tsv",
    });
    expect(classifyLane("notes.txt", "text/plain", 100).table).toBeUndefined();
  });
});

describe("table lanes at the corpus route", () => {
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

  it("mirrors a CSV as gated, column-aware rows", async () => {
    const { db, upload } = await setup();
    const up = (await (
      await upload(
        "roster.csv",
        "text/csv",
        'Name,Hours,Approved\nZara Kline,12,no\nSam Doyle,38,yes\n',
      )
    ).json()) as Record<string, string>;
    expect(up.lane).toBe("native");
    expect(up.status).toBe("parsed");
    expect(up.verdict).toBe("gated");

    const fts = JSON.stringify(await db.prepare("SELECT * FROM corpus_fts").all());
    // Rows are searchable with column boundaries preserved; capitalised
    // header cells are gate candidates like any other text.
    expect(fts).toContain("Name | Hours |");
    expect(fts).toContain("| 12 | no");
    expect(fts).toContain("| 38 | yes");
    // The gate applies to cell text: no raw name reaches the mirror.
    expect(fts).not.toContain("Zara Kline");
    expect(fts).not.toContain("Sam Doyle");
    const entities = JSON.stringify(await db.prepare("SELECT * FROM entities").all());
    expect(entities).not.toContain("Zara Kline");
    expect(entities).not.toContain("Sam Doyle");
  });

  it("mirrors a TSV through the same column-aware path", async () => {
    const { db, upload } = await setup();
    await upload("hours.tsv", "text/tab-separated-values", "Week\tHours\n1\t38\n");
    const fts = JSON.stringify(await db.prepare("SELECT * FROM corpus_fts").all());
    expect(fts).toContain("Week | Hours");
    expect(fts).toContain("1 | 38");
  });

  it("bounds a large CSV in the mirror", async () => {
    const { db, upload } = await setup();
    const rows = Array.from(
      { length: MAX_TABLE_ROWS + 10 },
      (_, i) => `shift ${i + 1},${i + 1}`,
    );
    await upload("huge.csv", "text/csv", rows.join("\n"));
    const fts = JSON.stringify(await db.prepare("SELECT * FROM corpus_fts").all());
    expect(fts).toContain(`[table truncated after ${MAX_TABLE_ROWS} rows]`);
  });
});
