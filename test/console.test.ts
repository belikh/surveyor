import { describe, it, expect } from "vitest";
import { Script } from "node:vm";
import app from "../src/index";
import { FakeD1 } from "./helpers/d1";
import { consoleShell, CONSOLE_JS } from "../src/frontend/console";

// #67: the public root and the launch-pack short link serve the survey, the
// first-run wizard lives at /setup, and the operator console at /console
// absorbs the retired /corpus page (which permanently redirects).

function makeEnv() {
  return {
    DB: new FakeD1() as never,
    OPERATOR_TOKEN: "op-token",
    SERVER_SECRET: "server-secret-for-tests",
    ENCRYPTION_KEY: "e".padEnd(64, "0"),
  };
}

async function callApp(path: string, init?: RequestInit) {
  return app.fetch(
    new Request(`https://surveyor.example${path}`, init),
    makeEnv() as never,
  );
}

describe("public placement (#67)", () => {
  it("serves the survey shell at the root", async () => {
    const res = await callApp("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("/survey.js");
  });

  it("keeps /survey as an alias of the root survey", async () => {
    const res = await callApp("/survey");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("/survey.js");
  });

  it("serves the first-run wizard at /setup", async () => {
    const res = await callApp("/setup");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("/wizard.js");
    expect(html).not.toContain("/survey.js");
  });

  it("permanently redirects /corpus into the console's corpus section", async () => {
    const res = await callApp("/corpus");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/console#corpus");
  });
});

describe("console shell (R6, #67)", () => {
  it("serves the shell wired to its own driver, with security headers", async () => {
    const res = await callApp("/console");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("/console.js");
    expect(res.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    // No inline script: the page honours script-src 'self'.
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
  });

  it("serves console.js as javascript", async () => {
    const res = await callApp("/console.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
  });

  it("serves the console shell with no eager PDF bundle", () => {
    // The 1 MB reader loads lazily on the first PDF attachment, so the
    // initial console page stays light.
    expect(consoleShell()).not.toContain("/pdf-tools.js");
  });

  it("still serves the self-hosted PDF tools and worker", async () => {
    const res = await callApp("/pdf-tools.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    const js = await res.text();
    expect(js.length).toBeGreaterThan(500_000);
    expect(js).toContain("SurveyorPdf");
    // Self-hosted: no CDN import.
    expect(js).not.toContain("cdnjs.cloudflare.com");

    const worker = await callApp("/pdf.worker.mjs");
    expect(worker.status).toBe(200);
    expect(worker.headers.get("content-type")).toContain("javascript");
  });
});

describe("console driver (#67)", () => {
  it("parses and carries the corpus API, PDF tools and operator gate", () => {
    expect(() => new Script(CONSOLE_JS)).not.toThrow();
    // textContent-only rendering; no framework and no build step.
    expect(CONSOLE_JS).not.toContain("innerHTML");
    for (const needle of [
      "window.SurveyorPdf",
      "extractText",
      "rasterise",
      "/api/corpus/drain",
      "authorization",
      "x-filename",
      "Set the operator token in the Session window",
    ]) {
      expect(CONSOLE_JS, needle).toContain(needle);
    }
  });

  it("holds no credential in storage, cookies or the URL", () => {
    for (const banned of [
      "localStorage",
      "sessionStorage",
      "document.cookie",
      "indexedDB",
    ]) {
      expect(CONSOLE_JS, banned).not.toContain(banned);
    }
    // The OAuth fragment is read once and stripped; no secret is written
    // back into the URL.
    expect(CONSOLE_JS).toContain("history.replaceState");
  });

  it("covers every console section", () => {
    for (const section of [
      '"home"',
      '"providers"',
      '"corpus"',
      '"submissions"',
      '"engine"',
      '"reports"',
      '"compliance"',
      '"case"',
      '"launch"',
    ]) {
      expect(CONSOLE_JS, section).toContain(section);
    }
  });
});
