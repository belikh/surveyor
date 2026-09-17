// The console browser check (#67) over a DOM-stub action driver: proves the
// check's steps, receipts and honest failure modes without pretending a real
// browser ran. The stub implements the same BrowserActions contract a
// Playwright/CDP driver must, over the served console driver and the real
// worker routes.

import { describe, it, expect } from "vitest";
import app from "../src/index";
import { FakeD1 } from "./helpers/d1";
import { FakeR2 } from "./helpers/r2";
import {
  bootConsole,
  findAll,
  type ConsoleHarness,
  type ElementStub,
  type Responder,
} from "./helpers/console-dom";
import { runConsoleBrowserCheck } from "../src/lib/console-browser";
import type {
  BrowserActions,
  BrowserDriver,
  BrowserSession,
} from "../src/lib/browser";

function makeEnv() {
  return {
    DB: new FakeD1() as never,
    CORPUS: new FakeR2() as never,
    OPERATOR_TOKEN: "op-token",
    SERVER_SECRET: "server-secret-for-tests",
    ENCRYPTION_KEY: "e".padEnd(64, "0"),
    POW_DIFFICULTY: "8",
  };
}

/** Resolve the selector subset the check uses: #id, tag, [attr="value"]* */
function resolveSelector(root: ElementStub, selector: string): ElementStub {
  if (selector === "#app") return root;
  const tag = (/^([a-zA-Z]*)/.exec(selector) ?? [""])[1] ?? "";
  const attrs = [...selector.matchAll(/\[([a-zA-Z-]+)="([^"]*)"\]/g)].map(
    (m) => [m[1], m[2]] as const,
  );
  if (tag === "" && attrs.length === 0) {
    throw new Error(`unsupported selector: ${selector}`);
  }
  const found = findAll(
    root,
    (n) =>
      (tag === "" || n.tag === tag) &&
      attrs.every(([attr, value]) => n.attrs[attr] === value),
  )[0];
  if (!found) throw new Error(`selector not found: ${selector}`);
  return found;
}

function actionDriver(): BrowserDriver {
  return {
    name: "dom-stub-actions",
    async launch(baseUrl: string): Promise<BrowserSession> {
      const env = makeEnv();
      const responder: Responder = async (path, init) => {
        const res = await app.fetch(
          new Request(new URL(path, baseUrl).toString(), init),
          env as never,
        );
        let body: unknown = {};
        try {
          body = await res.json();
        } catch {
          body = {};
        }
        return { status: res.status, body };
      };
      const h: ConsoleHarness = await bootConsole(responder);
      let dialogHandler: (kind: "confirm" | "alert", message: string) => boolean =
        () => true;
      h.setDialogHandler((kind, message) => dialogHandler(kind, message));
      const resolve = (selector: string) => resolveSelector(h.app, selector);
      const actions: BrowserActions = {
        async click(selector) {
          const node = resolve(selector);
          if (node.disabled) throw new Error(`${selector} is disabled`);
          const href = node.attrs.href;
          if (node.tag === "a" && href && href.startsWith("#")) {
            await h.navigate(href);
            return;
          }
          if (!node.onclick) throw new Error(`${selector} has no click handler`);
          await node.onclick();
          await h.flush();
        },
        async fill(selector, value) {
          resolve(selector).value = value;
        },
        async waitFor(selector, timeoutMs = 5_000) {
          const deadline = Date.now() + timeoutMs;
          for (;;) {
            try {
              resolve(selector);
              return;
            } catch {
              // Not yet: give the driver's promises a tick and retry.
            }
            if (Date.now() >= deadline) {
              throw new Error(`timed out waiting for ${selector}`);
            }
            await new Promise((r) => setTimeout(r, 10));
            await h.flush();
          }
        },
        async readText(selector) {
          return resolve(selector).text();
        },
        async isDisabled(selector) {
          return resolve(selector).disabled;
        },
        async setInputFiles(selector, files) {
          const input = resolve(selector);
          input.files = files.map((f) => {
            const blob = new Blob([f.bytes], { type: f.mimeType }) as Blob & {
              name: string;
            };
            blob.name = f.name;
            return blob;
          });
        },
        onDialog(handler) {
          dialogHandler = handler;
        },
        async screenshot() {
          return new Uint8Array(32);
        },
      };
      return {
        async goto(path) {
          const res = await app.fetch(
            new Request(new URL(path, baseUrl).toString()),
            env as never,
          );
          return { status: res.status, body: await res.text() };
        },
        async extractText() {
          return "";
        },
        async rasterise() {
          return [];
        },
        async close() {},
        actions,
      };
    },
  };
}

describe("console browser check (#67)", () => {
  it("drives the whole console flow and reports one receipt per step", async () => {
    const receipts = await runConsoleBrowserCheck(
      actionDriver(),
      "https://surveyor.example",
      { operatorToken: "op-token" },
    );
    expect(receipts.map((r) => `${r.status}:${r.name}`)).toEqual([
      "pass:console:root-survey",
      "pass:console:setup-wizard",
      "pass:console:shell",
      "pass:console:unauthenticated-gate",
      "pass:console:token-and-home",
      "pass:console:corpus-upload-and-drain",
      "pass:console:angle-review",
      "pass:console:publish-refused-honestly",
      "pass:console:confirmed-publish",
    ]);
  }, 60_000);

  it("fails honestly when the driver has no action primitives", async () => {
    const driver: BrowserDriver = {
      name: "pdf-only",
      async launch() {
        return {
          async goto() {
            return { status: 200, body: "" };
          },
          async extractText() {
            return "";
          },
          async rasterise() {
            return [];
          },
          async close() {},
        };
      },
    };
    const receipts = await runConsoleBrowserCheck(
      driver,
      "https://surveyor.example",
      { operatorToken: "op-token" },
    );
    expect(receipts).toEqual([
      {
        name: "console:actions",
        status: "fail",
        detail: expect.stringContaining("no action primitives"),
      },
    ]);
  });

  it("fails visibly when the driver cannot launch", async () => {
    const driver: BrowserDriver = {
      name: "absent",
      async launch() {
        throw new Error("no browser binary installed");
      },
    };
    const receipts = await runConsoleBrowserCheck(
      driver,
      "https://surveyor.example",
      { operatorToken: "op-token" },
    );
    expect(receipts).toEqual([
      {
        name: "console:driver",
        status: "fail",
        detail: expect.stringContaining("no browser binary installed"),
      },
    ]);
  });

  it("keeps reporting later steps when an early one fails", async () => {
    const base = actionDriver();
    const driver: BrowserDriver = {
      name: base.name,
      async launch(url) {
        const session = await base.launch(url);
        return {
          ...session,
          goto: async () => ({ status: 404, body: "not found" }),
        };
      },
    };
    const receipts = await runConsoleBrowserCheck(
      driver,
      "https://surveyor.example",
      { operatorToken: "op-token" },
    );
    expect(receipts[0].status).toBe("fail");
    expect(receipts[0].name).toBe("console:root-survey");
    // The steps after a failure still report.
    expect(receipts.map((r) => r.name)).toContain("console:shell");
  }, 60_000);
});
