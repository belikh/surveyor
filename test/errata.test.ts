import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const read = (name: string) => readFileSync(join(root, name), "utf8");

// A7 (#8): the three documents describe the code as it is. These assertions
// lock the specific errata so a future edit cannot silently restore a claim
// the code contradicts.
describe("documentation errata (A7, #8)", () => {
  it("SECURITY.md no longer makes the contradicted claims", () => {
    // The Errata section quotes the old claims by design; check the body.
    const security = read("SECURITY.md").split("## Errata")[0];
    for (const stale of [
      "Flags never auto-action",
      "never used to author question text the operator did not write",
      "A grep gate asserts this in review",
      "Raw submitter-identifying originals never persisted |",
    ]) {
      expect(security, stale).not.toContain(stale);
    }
    // The replacements name code behaviour.
    expect(security).toContain("Flags gate, and never act unattended");
    expect(security).toContain("model-authored");
    expect(security).toContain("There is no\n  automated grep gate");
  });

  it("README.md carries the attachment exception to never-stored", () => {
    const readme = read("README.md");
    expect(readme).toContain("documented exception");
    expect(readme).toContain("ADR-0012");
  });

  it("RUNBOOK.md scopes Workers AI and never implies a returned token", () => {
    const runbook = read("RUNBOOK.md");
    expect(runbook).toContain("Workers AI is not used for chat");
    expect(runbook).toContain("the installation never returns it");
  });

  it("each corrected document names what changed in an Errata section", () => {
    for (const name of ["README.md", "SECURITY.md", "RUNBOOK.md"]) {
      const text = read(name);
      expect(text, name).toContain("## Errata");
      expect(text, name).toContain("each names the claim that changed");
    }
  });

  it("the audit claim table carries a resolution for every row", () => {
    const audit = read("docs/research/architecture-audit.md");
    const start = audit.indexOf("### 4.1 Statements the code does not bear out");
    const end = audit.indexOf("### 4.2", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const table = audit.slice(start, end);
    const rows = table
      .split("\n")
      .filter((line) => line.startsWith("| ") && !line.includes("---"));
    // Header row plus every claim row; each claim row has its resolution.
    expect(rows.length).toBeGreaterThan(2);
    for (const row of rows.slice(1)) {
      expect(row, row).toMatch(/\*\*(Resolved|Partially resolved|Open)/);
    }
  });
});
