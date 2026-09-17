#!/usr/bin/env node
// Headless-browser check (#67): boot the built Worker locally (the
// runtime-smoke pattern) and drive the real console and browser PDF path
// with Playwright/Chromium, emitting one receipt per step.
//
//   node scripts/console-check.mjs [base-url]
//
// With no argument it boots `wrangler dev` itself on PORT (default 8787)
// with throwaway key material and a known operator token; pass a base URL
// to check an already-running installation (the operator token then comes
// from CONSOLE_OPERATOR_TOKEN). Exits non-zero on any failure.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatReceipt, summarise } from "../dist/smoke-lib.js";
import {
  fixturePdf,
  playwrightDriver,
  runConsoleBrowserCheck,
  runPdfBrowserCheck,
} from "../dist/console-check-lib.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const [baseArg] = process.argv.slice(2);
const PORT = process.env.PORT ?? "8790";
const OPERATOR_TOKEN = process.env.CONSOLE_OPERATOR_TOKEN ?? "console-check-token";
const receipts = [];
const add = (r) => {
  receipts.push(r);
  console.log(formatReceipt(r));
};

let child;
let logDir;
function stopServer() {
  if (!child) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  }
  child = undefined;
}
function cleanup() {
  stopServer();
  if (logDir) rmSync(logDir, { recursive: true, force: true });
}
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));

async function bootServer() {
  logDir = mkdtempSync(join(tmpdir(), "surveyor-console-check-"));
  const logPath = join(logDir, "dev.log");
  // A fresh local state each run: the console check publishes a report, so
  // it must start from a clean installation to be repeatable.
  const persistDir = join(logDir, "state");
  const out = (await import("node:fs")).openSync(logPath, "a");
  const key = "ab".repeat(32);
  child = spawn(
    "npx",
    [
      "wrangler",
      "dev",
      "--local",
      "--persist-to",
      persistDir,
      "--port",
      PORT,
      "--ip",
      "127.0.0.1",
      "--var",
      `OPERATOR_TOKEN:${OPERATOR_TOKEN}`,
      "--var",
      "SERVER_SECRET:console-check-server-secret",
      "--var",
      `ENCRYPTION_KEY:${key}`,
    ],
    {
      cwd: root,
      detached: true,
      stdio: ["ignore", out, out],
    },
  );
  const base = `http://127.0.0.1:${PORT}`;
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const res = await fetch(`${base}/api/status`);
      if (res.ok) return { base, build: await res.json() };
    } catch {
      // Not listening yet.
    }
    if (exited || Date.now() > deadline) {
      const log = readFileSync(logPath, "utf8").split("\n").slice(-20).join("\n");
      throw new Error(
        exited
          ? `wrangler dev exited before answering on ${base}:\n${log}`
          : `wrangler dev did not answer within 120s:\n${log}`,
      );
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

async function main() {
  let base = baseArg?.replace(/\/+$/, "");
  let status = null;
  if (!base) {
    const booted = await bootServer();
    base = booted.base;
    status = booted.build;
  } else {
    status = await (await fetch(`${base}/api/status`)).json().catch(() => null);
  }
  add({
    name: "console:boot",
    status: status ? "pass" : "fail",
    detail: status
      ? `build ${status.build?.commit ?? "?"}${status.build?.local ? " (local)" : ""}`
      : "no /api/status from the target",
  });
  if (!status) {
    report();
    return;
  }

  const driver = playwrightDriver();
  for (const receipt of await runPdfBrowserCheck(driver, base, fixturePdf())) {
    add(receipt);
  }
  for (const receipt of await runConsoleBrowserCheck(driver, base, {
    operatorToken: OPERATOR_TOKEN,
  })) {
    add(receipt);
  }
  report();
}

function report() {
  const s = summarise(receipts);
  console.log(`\n${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped`);
  process.exit(s.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
