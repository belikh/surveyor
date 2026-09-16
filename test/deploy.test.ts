import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Config-drift guard: every binding the worker reads must be declared in
// wrangler.toml, and the config must declare the full runtime surface.
// This is the test that stops "works locally, breaks on deploy".

const TOML = readFileSync(join(__dirname, "..", "wrangler.toml"), "utf8");

function srcFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    return statSync(p).isDirectory() ? srcFiles(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("wrangler config", () => {
  it("declares the full runtime surface", () => {
    for (const needle of [
      "[[d1_databases]]",
      'binding = "DB"',
      "[[r2_buckets]]",
      'binding = "CORPUS"',
      "[[queues.producers]]",
      "[[queues.consumers]]",
      "[[workflows]]",
      "[ai]",
      "[triggers]",
      "crons =",
    ]) {
      expect(TOML, needle).toContain(needle);
    }
  });

  it("never contains a secret value, only slot names in comments", () => {
    // Every known secret slot must appear only in the comment block.
    for (const slot of [
      "SERVER_SECRET",
      "ENCRYPTION_KEY",
      "OPERATOR_TOKEN",
      "GROQ_API_KEY",
      "TOKENROUTER_API_KEY",
      "TURNSTILE_SECRET",
      "CF_OAUTH_CLIENT_SECRET",
      "PUBLIC_BASE_URL",
    ]) {
      const re = new RegExp(`^\\s*${slot}\\s*[=:]\\s*"`, "m");
      expect(TOML).not.toMatch(re);
    }
    expect(TOML).toMatch(/Secrets \(set by the operator/);
  });

  it("every binding read in src/ is declared", () => {
    const envNames = new Set<string>();
    for (const file of srcFiles(join(__dirname, "..", "src"))) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g)) {
        envNames.add(m[1]);
      }
    }
    // Secrets are declared in the comment block, not as vars.
    const SECRETS = new Set([
      "SERVER_SECRET",
      "ENCRYPTION_KEY",
      "OPERATOR_TOKEN",
      "GROQ_API_KEY",
      "TOKENROUTER_API_KEY",
      "TURNSTILE_SECRET",
      "CF_OAUTH_CLIENT_SECRET",
      "PUBLIC_BASE_URL",
    ]);
    // Bindings come from wrangler sections; vars from [vars].
    const BINDINGS = new Set(["DB", "CORPUS", "AI", "INGEST", "ENGINE"]);
    for (const name of envNames) {
      if (SECRETS.has(name)) {
        expect(TOML, `${name} documented`).toContain(name);
        continue;
      }
      if (BINDINGS.has(name)) {
        expect(TOML, `${name} bound`).toContain(`binding = "${name}"`);
        continue;
      }
      // Plain vars (e.g. POW_DIFFICULTY) live under [vars].
      expect(TOML, `${name} var`).toMatch(
        new RegExp(`^${name}\\s*=`, "m"),
      );
    }
  });
});

describe("deploy surface docs", () => {
  it("runbook covers provision, setup, drain, teardown, secrets", () => {
    const runbook = readFileSync(join(__dirname, "..", "RUNBOOK.md"), "utf8");
    for (const needle of [
      "Provision",
      "First-run setup",
      "Corpus",
      "Teardown",
      "Secrets reference",
    ]) {
      expect(runbook, needle).toContain(needle);
    }
  });

  it("deploy button names every provisioned resource", () => {
    const button = readFileSync(join(__dirname, "..", "deploy-button.md"), "utf8");
    for (const needle of ["D1 database", "R2 bucket", "Queue", "Workflow", "Workers AI", "Cron trigger"]) {
      expect(button, needle).toContain(needle);
    }
  });
});

describe("binding shape", () => {
  it("producer and consumer name the same queue", () => {
    const producer = TOML.match(/\[\[queues\.producers\]\][\s\S]*?queue = "([^"]+)"/);
    const consumer = TOML.match(/\[\[queues\.consumers\]\][\s\S]*?queue = "([^"]+)"/);
    expect(producer?.[1]).toBeTruthy();
    expect(producer?.[1]).toBe(consumer?.[1]);
  });

  it("workflow class_name is exported by the entry module", () => {
    const cls = TOML.match(/class_name = "([^"]+)"/)?.[1];
    expect(cls).toBeTruthy();
    const index = readFileSync(join(__dirname, "..", "src", "index.ts"), "utf8");
    expect(index).toContain(`export class ${cls}`);
  });

  it("cron field is a valid cron expression", () => {
    const crons = TOML.match(/crons = \[([^\]]+)\]/)?.[1] ?? "";
    const entries = crons.split(",").map((c) => c.trim().replace(/"/g, ""));
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.split(/\s+/).length).toBe(5);
    }
  });

  it("upload enqueues held docs to the declared queue binding", () => {
    const corpus = readFileSync(join(__dirname, "..", "src", "routes", "corpus.ts"), "utf8");
    expect(corpus).toMatch(/env\.INGEST\.send\(/);
  });
});
