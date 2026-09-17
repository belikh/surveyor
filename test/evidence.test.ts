import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** The same suite runs in the monorepo (surveyor/ subdir) and in the
 *  standalone public repository (platform at the root). */
const root = join(__dirname, "..");
const evidence = join(root, "evidence", "niro");
const recordPath = join(evidence, "2026-09-16-penetration-test.md");
const reportPath = join(evidence, "2026-09-16-penetration-test-report.pdf");

describe("published Niro penetration-test evidence (D10)", () => {
  it("publishes the run report with date and scope", () => {
    expect(existsSync(recordPath)).toBe(true);
    const record = readFileSync(recordPath, "utf8");
    expect(record).toContain("**Date**: 2026-09-16");
    expect(record).toMatch(/\*\*Scope\*\*/);
    expect(record).toMatch(/commit under test.*2b029a8/i);
    // The record names the real run the report was promoted from.
    expect(record).toContain("actions/runs/35145113911");
    expect(record).toContain("gh run download 35145113911");
  });

  it("commits the report unchanged, with a matching checksum", () => {
    expect(existsSync(reportPath)).toBe(true);
    expect(statSync(reportPath).size).toBeGreaterThan(10_000);
    expect(readFileSync(reportPath, "latin1").startsWith("%PDF-")).toBe(true);
    const record = readFileSync(recordPath, "utf8");
    const claimed = record.match(/`([0-9a-f]{64})`/)?.[1];
    expect(claimed).toBeTruthy();
    expect(createHash("sha256").update(readFileSync(reportPath)).digest("hex")).toBe(claimed);
  });

  it("documents the promotion process for repeat runs", () => {
    const process = readFileSync(join(evidence, "README.md"), "utf8");
    expect(process).toContain("gh run download");
    expect(process).toContain("niro-penetration-test-report");
    expect(process).toContain("30-day");
    expect(process).toContain("sha256sum");
  });

  it("links the report from the README security claim", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    expect(readme).toContain("evidence/niro/2026-09-16-penetration-test.md");
  });
});
