import { describe, it, expect } from "vitest";
import {
  classifyLane,
  gateCorpusText,
  statusFor,
  MAX_DOC_BYTES,
} from "../src/lib/ingest";

describe("classifyLane", () => {
  it("routes text formats to the native lane", () => {
    for (const f of ["notes.txt", "readme.md", "data.csv"]) {
      expect(classifyLane(f, "text/plain", 100).lane).toBe("native");
    }
  });

  it("routes office formats to held lanes with reasons", () => {
    for (const [f, ct] of [
      ["report.pdf", "application/pdf"],
      ["doc.docx", "application/vnd.openxmlformats"],
      ["sheet.xlsx", "application/vnd.openxmlformats"],
      ["deck.pptx", "application/vnd.openxmlformats"],
      ["scan.png", "image/png"],
    ] as Array<[string, string]>) {
      const r = classifyLane(f, ct, 100);
      expect(r.lane.startsWith("held-")).toBe(true);
      expect(r.reason).toBeTruthy();
      expect(statusFor(r.lane)).toBe("held");
    }
    expect(statusFor("native")).toBe("parsed");
  });

  it("rejects oversized and empty documents loudly", () => {
    const big = classifyLane("big.pdf", "application/pdf", MAX_DOC_BYTES + 1);
    expect(big.lane).toBe("rejected");
    expect(big.reason).toMatch(/size/i);
    const empty = classifyLane("empty.txt", "text/plain", 0);
    expect(empty.lane).toBe("rejected");
    expect(empty.reason).toMatch(/empty/i);
  });

  it("rejects unknown types instead of guessing", () => {
    const r = classifyLane("blob.xyz", "application/octet-stream", 100);
    expect(r.lane).toBe("rejected");
  });
});

describe("gateCorpusText", () => {
  it("quarantines names and reports a gated verdict", () => {
    const r = gateCorpusText("Meeting with Zara Kline about rosters");
    expect(r.verdict).toBe("gated");
    expect(r.text).not.toContain("Zara Kline");
    expect(r.names.length).toBeGreaterThan(0);
  });

  it("passes clean text straight through", () => {
    const r = gateCorpusText("Rosters are posted on Tuesdays");
    expect(r.verdict).toBe("clean");
    expect(r.text).toContain("Rosters");
  });
});
