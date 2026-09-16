import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const repoRoot = join(root, "..");

describe("open-source surface (R8)", () => {
  it("ships the AGPL-3.0 licence", () => {
    const licence = readFileSync(join(root, "LICENSE"), "utf8");
    expect(licence).toContain("GNU AFFERO GENERAL PUBLIC LICENSE");
    expect(licence).toContain("Version 3");
  });

  it("ships contributing and security docs", () => {
    expect(existsSync(join(root, "CONTRIBUTING.md"))).toBe(true);
    expect(existsSync(join(root, "SECURITY.md"))).toBe(true);
    const contributing = readFileSync(join(root, "CONTRIBUTING.md"), "utf8");
    expect(contributing).toContain("SECURITY.md");
    expect(contributing).toMatch(/AGPL-3\.0/);
  });

  it("CI runs the four gates against the platform", () => {
    const wf = readFileSync(
      join(repoRoot, ".github/workflows/surveyor.yml"),
      "utf8",
    );
    for (const needle of [
      "npm ci",
      "npm run typecheck",
      "npm test",
      "npm run build",
      "working-directory: surveyor",
      "npm run smoke:runtime",
    ]) {
      expect(wf, needle).toContain(needle);
    }
  });

  it("ships issue/PR templates and the squashed-history split script", () => {
    expect(existsSync(join(repoRoot, ".github/ISSUE_TEMPLATE/bug_report.md"))).toBe(true);
    expect(existsSync(join(repoRoot, ".github/pull_request_template.md"))).toBe(true);
    const script = readFileSync(join(root, "scripts/split-repo.sh"), "utf8");
    expect(script).toContain("squashed history");
    expect(script).toContain("--exclude");
    expect(script).toContain("gh repo create");
  });
});
