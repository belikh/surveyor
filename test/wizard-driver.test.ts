// The wizard driver (src/frontend/chrome.ts) must render on a fresh
// install: /api/setup answers 503 (not_provisioned) before any key
// material exists, and the boot panel is the whole point of the screen.
// A16 live trial: the deployed root showed an empty window frame because
// render() awaited /api/setup with no fallback.

import { describe, it, expect } from "vitest";
import { renderWizard } from "./helpers/wizard-dom";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("wizard driver initial render", () => {  it("renders the boot panel on a fresh install (setup 503)", async () => {
    const text = await renderWizard(async (path) => {
      if (path === "/api/setup") {
        return json(503, { error: "not_provisioned" });
      }
      if (path === "/api/status") {
        return json(200, {
          degraded: true,
          warning: "Not provisioned",
          provisioned: false,
          operator_token_set: false,
        });
      }
      throw new Error(`unexpected fetch ${path}`);
    });
    expect(text).toContain("Boot the installation");
  });

  it("shows an honest error when setup is unreadable on a provisioned install", async () => {
    const text = await renderWizard(async (path) => {
      if (path === "/api/setup") {
        return json(500, { error: "boom" });
      }
      if (path === "/api/status") {
        return json(200, { provisioned: true, operator_token_set: true });
      }
      throw new Error(`unexpected fetch ${path}`);
    });
    expect(text).toContain("Setup state unreadable");
    expect(text).toContain("boom");
    expect(text).not.toContain("Boot the installation");
  });

  it("renders the token panel once provisioned", async () => {
    const text = await renderWizard(async (path) => {
      if (path === "/api/setup") {
        return json(200, {
          phase: "providers",
          instrument: null,
          installed_at: null,
        });
      }
      if (path === "/api/status") {
        return json(200, { provisioned: true, operator_token_set: true });
      }
      throw new Error(`unexpected fetch ${path}`);
    });
    expect(text).toContain("Worker token");
  });
});

describe("wizard shell", () => {
  it("carries no inline script, so the page honours script-src 'self'", async () => {
    const { wizardShell } = await import("../src/frontend/chrome");
    const html = wizardShell("Surveyor — test", "off");
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).toContain('data-title="Surveyor — test"');
  });
});
