import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const adrDir = join(root, "docs/adr");
const index = readFileSync(join(adrDir, "README.md"), "utf8");

const files = readdirSync(adrDir).filter((f) => /^\d{4}-.*\.md$/.test(f));

describe("ADR index and campaign ADRs (A8, #9)", () => {
  it("links every ADR file from the index", () => {
    for (const file of files) {
      expect(index, file).toContain(`](${file})`);
    }
  });

  it("carries the five campaign ADRs, numbered after 0014", () => {
    const campaign = [
      "0015-automation-stance.md",
      "0016-anonymity-deviation.md",
      "0017-web-research-and-snapshot-provenance.md",
      "0018-providers-are-leads-not-evidence.md",
      "0019-compliance-posture.md",
    ];
    for (const file of campaign) expect(files, file).toContain(file);
  });

  it("states a trade-off in every ADR", () => {
    for (const file of files) {
      const text = readFileSync(join(adrDir, file), "utf8");
      expect(text, file).toMatch(/trade-offs/);
      // Every negative section names at least one concrete cost.
      const negative = text.split("trade-offs")[1] ?? "";
      expect(negative.length, file).toBeGreaterThan(80);
    }
  });

  it("keeps repo-external paths out of the ADR corpus", () => {
    const dangling = [/\.scratch\//, /\.specify\//, /`specs\//, /`plan\.md/];
    for (const file of files) {
      const text = readFileSync(join(adrDir, file), "utf8");
      for (const pattern of dangling) {
        expect(text, `${file} matches ${pattern}`).not.toMatch(pattern);
      }
    }
    expect(index).not.toMatch(/\.scratch\/|\.specify\/|`specs\//);
  });

  it("names the code deviations with owning tickets", () => {
    const deviations = index.split("## Known deviations")[1] ?? "";
    expect(deviations).toContain("0002");
    expect(deviations).toContain("0015");
    expect(deviations).toMatch(/#\d+/);
  });
});
