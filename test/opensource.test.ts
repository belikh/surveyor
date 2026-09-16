import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const repoRoot = join(root, "..");

/** The same suite runs in the monorepo (surveyor/ subdir) and in the
 *  standalone public repository (platform at the root), so locate shared
 *  files in either layout. */
function firstExisting(...candidates: string[]): string | null {
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

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
    const workflow = firstExisting(
      join(repoRoot, ".github/workflows/surveyor.yml"),
      join(root, ".github/workflows/ci.yml"),
      join(root, ".github/workflows/surveyor.yml"),
    );
    expect(workflow).toBeTruthy();
    const wf = readFileSync(workflow as string, "utf8");
    for (const needle of [
      "npm ci",
      "npm run typecheck",
      "npm test",
      "npm run build",
      "npm run smoke:runtime",
    ]) {
      expect(wf, needle).toContain(needle);
    }
    // Monorepo layout targets the subdirectory; standalone it is the root.
    if (String(workflow).endsWith("surveyor.yml")) {
      expect(wf).toContain("working-directory: surveyor");
    }
  });

  it("ships issue/PR templates and the split record", () => {
    expect(
      firstExisting(
        join(repoRoot, ".github/ISSUE_TEMPLATE/bug_report.md"),
        join(root, ".github/ISSUE_TEMPLATE/bug_report.md"),
      ),
    ).toBeTruthy();
    expect(
      firstExisting(
        join(repoRoot, ".github/pull_request_template.md"),
        join(root, ".github/pull_request_template.md"),
      ),
    ).toBeTruthy();
    const script = firstExisting(join(root, "scripts/split-repo.sh"));
    if (script) {
      // Private-repo tool: assert it does what the ADR says.
      const s = readFileSync(script, "utf8");
      expect(s).toContain("squashed history");
      expect(s).toContain("--exclude");
      expect(s).toContain("gh repo create");
    } else {
      // Standalone repository: the decision record travels instead.
      expect(
        existsSync(join(root, "docs/adr/0014-licence-and-repository-split.md")),
      ).toBe(true);
    }
  });
});
