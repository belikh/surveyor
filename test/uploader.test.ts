import { describe, it, expect } from "vitest";
import { Script } from "node:vm";
import app from "../src/index";
import { FakeD1 } from "./helpers/d1";

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

describe("browser PDF tools (R6, T923)", () => {
  it("serves self-hosted PDF.js with the SurveyorPdf helpers", async () => {
    const res = await callApp("/pdf-tools.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    const js = await res.text();
    expect(js.length).toBeGreaterThan(500_000);
    expect(js).toContain("SurveyorPdf");
    // Self-hosted: no CDN import.
    expect(js).not.toContain("cdnjs.cloudflare.com");
  });

  it("serves the operator uploader shell wired to the tools", async () => {
    const res = await callApp("/corpus");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("/pdf-tools.js");
    expect(html).toContain("/corpus.js");
    expect(res.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
  });

  it("survey driver lazily loads the PDF tools for attachments", async () => {
    const js = await (await callApp("/survey.js")).text();
    expect(() => new Script(js)).not.toThrow();
    for (const needle of [
      "/pdf-tools.js",
      "extractText",
      "rasterise",
      "sendAttachment",
    ]) {
      expect(js, needle).toContain(needle);
    }
  });

  it("uploader driver parses and uses the corpus API and PDF tools", async () => {
    const res = await callApp("/corpus.js");
    const js = await res.text();
    expect(() => new Script(js)).not.toThrow();
    expect(js).not.toContain("innerHTML");
    for (const needle of [
      "window.SurveyorPdf",
      "extractText",
      "rasterise",
      "/api/corpus/drain",
      "authorization",
    ]) {
      expect(js, needle).toContain(needle);
    }
  });
});
