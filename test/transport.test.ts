import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import app from "../src/index";
import { FakeD1 } from "./helpers/d1";

// A11: access codes, filenames and media types travel in headers or bodies,
// never query strings, so edge request logs cannot see identifiers. These
// checks guard the transport at the source and in the served clients; the
// route-level behaviour is asserted in test/attachments.test.ts.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function makeEnv() {
  return {
    DB: new FakeD1() as never,
    OPERATOR_TOKEN: "op-token",
    SERVER_SECRET: "server-secret-for-tests",
    ENCRYPTION_KEY: "e".padEnd(64, "0"),
  };
}

describe("identifier transport audit (A11)", () => {
  function routeSources(): Array<[string, string]> {
    const routesDir = path.join(root, "src/routes");
    const files = [
      ...readdirSync(routesDir).map((f) => path.join(routesDir, f)),
      path.join(root, "src/index.ts"),
    ];
    return files.map((f) => [f, readFileSync(f, "utf8")]);
  }

  it("no route reads an identifier from a query string", () => {
    const identifiers = /req\.(query|queries)\(\s*["'](access_code|filename|media_type|doc_id|attachment_id|submission_id)["']/;
    for (const [file, src] of routeSources()) {
      expect(src, path.relative(root, file)).not.toMatch(identifiers);
    }
  });

  it("every query-string read is sanctioned, not an identifier transport", () => {
    const reads: string[] = [];
    for (const [file, src] of routeSources()) {
      for (const match of src.matchAll(/req\.(query|queries)\((.*?)\)/g)) {
        reads.push(`${path.relative(root, file)}: req.${match[1]}(${match[2]})`);
      }
    }
    // Two sanctioned call sites, both non-identifiers:
    //  - the OAuth consent callback's protocol parameters `code`/`state`,
    //    which the provider's redirect defines and ADR-0013 pins (src/index.ts);
    //  - the launch pack's operator-supplied `forbidden` audit terms
    //    (src/routes/launch.ts), which are public-copy exclusions, not a
    //    source's access code, filename or record id.
    expect(reads.sort()).toEqual([
      'src/index.ts: req.query("code")',
      'src/index.ts: req.query("state")',
      'src/routes/launch.ts: req.queries("forbidden")',
      "src/routes/launch.ts: req.queries()",
    ]);
  });

  it("no client builds an attachment URL with query-string identifiers", () => {
    const frontendDir = path.join(root, "src/frontend");
    for (const file of readdirSync(frontendDir)) {
      const src = readFileSync(path.join(frontendDir, file), "utf8");
      expect(src, file).not.toMatch(/\/attachments\?/);
    }
  });

  it("the served survey driver sends attachment metadata in headers", async () => {
    const res = await app.fetch(
      new Request("https://survey.example/survey.js"),
      makeEnv() as never,
    );
    const js = await res.text();
    expect(js).toContain('"x-access-code": S.code');
    expect(js).toContain('"x-filename"');
    expect(js).toContain('"/api/intake/" + id + "/attachments"');
    expect(js).not.toMatch(/\/attachments\?/);
  });
});
