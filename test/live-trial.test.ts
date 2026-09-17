import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const WIZARD = join(ROOT, "scripts", "live-trial-wizard.sh");

// F5 (#65): the live-trial wizard is a committed repeatable path linked
// from the README — syntax-checked, free of trial-specific values and dead
// stages, matching the trial end to end.
describe("live-trial wizard (F5)", () => {
  it("is committed and executable", () => {
    expect(existsSync(WIZARD)).toBe(true);
    expect(statSync(WIZARD).mode & 0o111).toBeTruthy();
    const tracked = execSync("git ls-files scripts/live-trial-wizard.sh", {
      cwd: ROOT,
      encoding: "utf8",
    }).trim();
    expect(tracked).toBe("scripts/live-trial-wizard.sh");
  });

  it("is syntax-checked", () => {
    expect(() =>
      execSync("bash -n scripts/live-trial-wizard.sh", { cwd: ROOT }),
    ).not.toThrow();
  });

  it("is linked from the README", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    expect(readme).toContain("scripts/live-trial-wizard.sh");
  });

  it("carries no trial-specific values", () => {
    const sh = readFileSync(WIZARD, "utf8");
    // Session values live in the gitignored file, never in the script.
    expect(sh).toContain('ENV_FILE=".env.live-trial"');
    const gitignore = readFileSync(join(ROOT, ".gitignore"), "utf8");
    expect(gitignore).toContain(".env.live-trial");
    // No hardcoded 32-hex account id, no concrete workers.dev host —
    // only the <you> placeholder and the public deploy-button URL.
    expect(sh).not.toMatch(/CF_ACCOUNT_ID="[0-9a-f]{32}"/);
    expect(sh).not.toMatch(/https:\/\/[a-z0-9-]+\.workers\.dev/);
    expect(sh).toContain("https://surveyor.<you>.workers.dev");
    // The real D1 id is restored to the placeholder, never committed.
    expect(sh).toContain("REPLACE_VIA_PROVISIONING");
  });

  it("walks the trial end to end with no dead stages", () => {
    const sh = readFileSync(WIZARD, "utf8");
    const totals = [...sh.matchAll(/TOTAL_STAGES=(\d+)/g)].map((m) => Number(m[1]));
    const total = totals[totals.length - 1];
    const stages = sh.match(/^stage "/gm) ?? [];
    expect(total).toBe(10);
    expect(stages).toHaveLength(10);
    for (const needle of [
      "Prerequisites",
      "Cloudflare credentials",
      "Deploy",
      "Boot the installation",
      "OAuth consent round trip",
      "Provisioner and scope mapping",
      "Deployed smoke",
      "Findings",
      "Teardown",
      "Scrub and close",
    ]) {
      expect(sh, needle).toContain(needle);
    }
  });
});
