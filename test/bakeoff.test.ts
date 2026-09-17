import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GAPS,
  REPRODUCE_COMMAND,
  runBakeoff,
  textMetrics,
  type BakeoffResults,
} from "./helpers/bakeoff";

// D8 (#51): the OCR accuracy bake-off is a measured runbook, not a unit
// test. These guards keep it honest:
//   - a fresh run is deterministic, so its numbers reproduce;
//   - the committed evidence is exactly a fresh run of the committed corpus;
//   - the model lanes appear as explicit gaps, never as fabricated numbers.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = path.join(root, "evidence/ocr-accuracy/results.json");

function committed(): BakeoffResults & {
  run_at?: string;
  environment?: Record<string, string>;
} {
  return JSON.parse(readFileSync(EVIDENCE, "utf8"));
}

describe("OCR accuracy bake-off (D8, #51)", () => {
  it("scores exact, imperfect and empty extractions honestly", () => {
    expect(textMetrics("abc", "abc")).toMatchObject({
      exact: true,
      char_accuracy: 1,
      word_accuracy: 1,
    });
    // One wrong character in three: 1 - 1/3.
    expect(textMetrics("abc", "abd")).toMatchObject({
      exact: false,
      char_accuracy: 0.6667,
    });
    // One wrong word in three: 1 - 1/3.
    expect(textMetrics("a b c", "a b d")).toMatchObject({
      exact: false,
      word_accuracy: 0.6667,
    });
    // Whitespace differences normalise away; they are not accuracy.
    expect(textMetrics("a b c", "a  b\nc")).toMatchObject({ exact: true });
    // Nothing extracted from a text fixture is a zero, never a pass.
    expect(textMetrics("delegate brief", "")).toMatchObject({
      exact: false,
      char_accuracy: 0,
      word_accuracy: 0,
    });
    // A wildly longer output cannot score below zero.
    expect(textMetrics("ab", "z".repeat(50)).char_accuracy).toBe(0);
  });

  it("finds the LZW comparison the corpus is built to expose", async () => {
    const results = await runBakeoff();
    const native = results.measurements.find(
      (m) => m.fixture === "pdf-lzw" && m.path === "native-pdf",
    )!;
    const pdfjs = results.measurements.find(
      (m) => m.fixture === "pdf-lzw" && m.path === "pdfjs-text",
    )!;
    // The native parser's documented filter set excludes LZW, so it must
    // fall back; PDF.js reads the same bytes exactly. Both numbers are
    // measured from the fixture, not asserted as a target.
    expect(native.outcome).toBe("empty");
    expect(native.char_accuracy).toBe(0);
    expect(pdfjs).toMatchObject({ outcome: "text", exact: true });
  });

  it("is deterministic: a fresh run repeats exactly", async () => {
    const first = await runBakeoff();
    const second = await runBakeoff();
    expect(second).toEqual(first);
  });

  it("measures every applicable fixture and records every path", async () => {
    const results = await runBakeoff();
    const expected = results.corpus.reduce(
      (n, fixture) => n + fixture.applies.length,
      0,
    );
    expect(results.measurements).toHaveLength(expected);
    for (const fixture of results.corpus) {
      for (const pathId of fixture.applies) {
        const found = results.measurements.find(
          (m) => m.fixture === fixture.id && m.path === pathId,
        );
        expect(found, `${fixture.id} x ${pathId}`).toBeDefined();
      }
    }
    for (const summary of results.summary) {
      expect(summary.fixtures).toBeGreaterThan(0);
    }
    // Every deterministic path is exercised by at least one fixture.
    expect(new Set(results.measurements.map((m) => m.path)).size).toBe(
      results.summary.length,
    );
  });

  it("keeps every measurement numeric and free of model-lane claims", async () => {
    const results = await runBakeoff();
    for (const m of results.measurements) {
      expect(m.path).toMatch(/^native-|^pdfjs-/);
      expect(m.outcome).toMatch(/^(text|empty|error)$/);
      if (m.expected === "text") {
        expect(m.char_accuracy).toBeGreaterThanOrEqual(0);
        expect(m.char_accuracy).toBeLessThanOrEqual(1);
        expect(m.word_accuracy).toBeGreaterThanOrEqual(0);
        expect(m.word_accuracy).toBeLessThanOrEqual(1);
      } else {
        expect(m.char_accuracy).toBeNull();
        expect(m.word_accuracy).toBeNull();
      }
    }
  });

  it("publishes evidence that reproduces: committed results match a fresh run", async () => {
    const fresh = await runBakeoff();
    const stored = committed();
    expect(stored.reproduce).toBe(REPRODUCE_COMMAND);
    expect(stored.version).toBe(1);
    expect(stored.corpus).toEqual(fresh.corpus);
    expect(stored.measurements).toEqual(fresh.measurements);
    expect(stored.summary).toEqual(fresh.summary);
    expect(stored.gaps).toEqual(GAPS);
  });

  it("records the model lanes as explicit, unmeasured gaps", async () => {
    const stored = committed();
    expect(stored.gaps.length).toBeGreaterThan(0);
    for (const gap of stored.gaps) {
      expect(gap.reason).toMatch(/live/i);
      expect(gap.measured).toBe(false);
      expect(gap).not.toHaveProperty("char_accuracy");
    }
    // The scan fixture exists precisely to show what the vision lane would
    // have to read, and it produces no text on either deterministic path.
    const scan = stored.measurements.filter((m) => m.fixture === "pdf-scanlike");
    expect(scan.length).toBeGreaterThan(0);
    for (const m of scan) expect(m.outcome).toBe("empty");
  });
});
