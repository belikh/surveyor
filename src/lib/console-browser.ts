// Console browser check (#67): drives the served console end to end through
// the A6 BrowserDriver's action primitives and returns one receipt per step.
// The checks assert external behaviour only — rendered text, which controls
// are present or inert, and which flows complete — never driver internals.
//
// The real driver is test/helpers/playwright-driver.ts (Playwright/Chromium)
// and the CI job boots the built worker locally and runs this check via
// scripts/console-check.mjs. The DOM-stub action seam keeps the per-push
// suite fast; the driver-absent and actions-absent cases still fail
// honestly: nothing here reports a browser run that did not happen.

import { fail, pass, type Receipt } from "./smoke";
import type { BrowserActions, BrowserDriver, BrowserSession } from "./browser";

export interface ConsoleCheckOptions {
  /** The operator token the booted worker accepts. */
  operatorToken: string;
  /** The document the corpus step uploads; its text grounds the angle. */
  corpusFile?: { name: string; mimeType: string; bytes: Uint8Array };
}

const DEFAULT_CORPUS = {
  name: "console-check.txt",
  mimeType: "text/plain",
  bytes: new TextEncoder().encode(
    "Roster notes: the roster is posted late on Tuesdays and wrecks sleep.",
  ),
};

const TOPICS = "roster";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read a selector's text until it contains `needle`, or time out honestly. */
async function waitForText(
  actions: BrowserActions,
  selector: string,
  needle: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = await actions.readText(selector);
    if (text.includes(needle)) return text;
    if (Date.now() >= deadline) {
      throw new Error(`"${needle}" not found in ${selector} within ${timeoutMs}ms`);
    }
    await sleep(100);
  }
}

/** Wait for a native dialog the handler recorded, never a fixed sleep: a
 *  publish does real work (evidence, sealing) before it answers. */
async function waitForDialog(
  dialogs: string[],
  prefix: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = dialogs.find((d) => d.startsWith(prefix));
    if (found) return found;
    if (Date.now() >= deadline) {
      throw new Error(`no ${prefix} dialog within ${timeoutMs}ms`);
    }
    await sleep(100);
  }
}

/**
 * Drive the console through `driver` against `baseUrl`. One receipt per
 * step, each reported independently so a failure never hides the others.
 */
export async function runConsoleBrowserCheck(
  driver: BrowserDriver,
  baseUrl: string,
  opts: ConsoleCheckOptions,
): Promise<Receipt[]> {
  let session: BrowserSession;
  try {
    session = await driver.launch(baseUrl);
  } catch (err) {
    return [fail("console:driver", `${driver.name}: ${message(err)}`)];
  }
  const actions = session.actions;
  if (!actions) {
    try {
      await session.close();
    } catch {
      // Nothing to clean up beyond the launch.
    }
    return [
      fail(
        "console:actions",
        `${driver.name}: the driver has no action primitives — the console job needs click/fill/waitFor/readText/setInputFiles`,
      ),
    ];
  }

  const file = opts.corpusFile ?? DEFAULT_CORPUS;
  const dialogs: string[] = [];
  actions.onDialog((kind, text) => {
    dialogs.push(`${kind}: ${text}`);
    return true;
  });

  const receipts: Receipt[] = [];
  const step = async (
    name: string,
    run: () => Promise<string>,
  ): Promise<void> => {
    try {
      receipts.push(pass(name, await run()));
    } catch (err) {
      let detail = message(err);
      // The same receipts story as the smoke scripts: a failed step carries
      // a screenshot artefact where the driver can take one.
      if (actions.screenshot) {
        try {
          const shot = await actions.screenshot();
          detail += ` (screenshot: ${shot.length} bytes)`;
        } catch {
          detail += " (screenshot failed)";
        }
      }
      receipts.push(fail(name, detail));
    }
  };

  try {
    await step("console:root-survey", async () => {
      const res = await session.goto("/");
      if (res.status !== 200 || !res.body.includes("/survey.js")) {
        throw new Error(`HTTP ${res.status} — expected the served survey shell`);
      }
      return `HTTP ${res.status}`;
    });

    await step("console:setup-wizard", async () => {
      const res = await session.goto("/setup");
      if (res.status !== 200 || !res.body.includes("/wizard.js")) {
        throw new Error(`HTTP ${res.status} — expected the first-run wizard`);
      }
      return `HTTP ${res.status}`;
    });

    await step("console:shell", async () => {
      const res = await session.goto("/console");
      if (res.status !== 200 || !res.body.includes("/console.js")) {
        throw new Error(`HTTP ${res.status} — expected the console shell`);
      }
      await actions.waitFor("#app");
      return `HTTP ${res.status}`;
    });

    await step("console:unauthenticated-gate", async () => {
      await actions.waitFor('[data-field="operator-token"]');
      const text = await actions.readText("#app");
      if (!text.includes("Set the operator token above")) {
        throw new Error("the gated hint is not on screen");
      }
      // The corpus controls must not be reachable before the token: a
      // driver click either cannot resolve or hits a disabled control.
      await actions.click('a[href="#corpus"]');
      try {
        await actions.click('[data-action="corpus-upload"]');
      } catch {
        return "upload control absent/inert before the token";
      }
      const disabled = await actions.isDisabled('[data-action="corpus-upload"]');
      if (!disabled) throw new Error("upload control was live before the token");
      return "upload control disabled before the token";
    });

    await step("console:token-and-home", async () => {
      await actions.fill('[data-field="operator-token"]', opts.operatorToken);
      await actions.click('[data-action="token-set"]');
      await actions.click('a[href="#home"]');
      await waitForText(actions, "#app", "Outstanding work", 10_000);
      const text = await actions.readText("#app");
      if (!text.includes("Build ")) throw new Error("the build identity is missing");
      return "home painted with the token set";
    });

    await step("console:corpus-upload-and-drain", async () => {
      await actions.click('a[href="#corpus"]');
      await actions.waitFor('[data-field="corpus-files"]');
      await actions.setInputFiles('[data-field="corpus-files"]', [file]);
      await actions.click('[data-action="corpus-upload"]');
      await waitForText(actions, "#app", "Mirror", 30_000);
      const text = await actions.readText("#app");
      if (!text.includes(file.name)) {
        throw new Error(`${file.name} not listed after upload`);
      }
      await actions.click('[data-action="corpus-drain"]');
      return `${file.name} uploaded and drained`;
    });

    await step("console:angle-review", async () => {
      await actions.click('a[href="#engine"]');
      await actions.fill('[data-field="angle-topics"]', TOPICS);
      // Local D1 can serve a stale read just after a write; an operator
      // would press Propose again. Retry rather than assert on one read.
      let clicked = false;
      const deadline = Date.now() + 20_000;
      while (!clicked && Date.now() < deadline) {
        await actions.click('[data-action="angle-propose"]');
        await sleep(1_000);
        for (const selector of [
          '[data-action="angle-review-approve"]',
          '[data-action="angle-approve"]',
        ]) {
          try {
            await actions.waitFor(selector, 1_000);
            clicked = true;
            await actions.click(selector);
            break;
          } catch {
            // Not queued yet; retry.
          }
        }
      }
      if (!clicked) throw new Error("no angle appeared in the queue to approve");
      await waitForText(actions, "#app", "approved", 15_000);
      return "an angle was proposed, reviewed if held, and approved";
    });

    await step("console:publish-refused-honestly", async () => {
      await actions.click('a[href="#reports"]');
      // The report panels are collapsible; open the briefing one before
      // touching its controls. The console keeps it open across re-renders.
      await actions.click('summary[data-report="briefing"]');
      await actions.waitFor('[data-action="report-publish"]');
      dialogs.length = 0;
      await actions.click('[data-action="report-publish"][data-type="briefing"]');
      const confirmation = await waitForDialog(dialogs, "confirm:", 5_000);
      if (!/version \d+/.test(confirmation)) {
        throw new Error(`the confirmation did not name the pending version: ${confirmation}`);
      }
      // The gates are unmet on a fresh fixture report: the refusal must
      // surface as an alert carrying the API's error token, never a silent
      // pass.
      const refusal = await waitForDialog(dialogs, "alert:", 30_000);
      if (!/Publish refused/.test(refusal)) {
        throw new Error("the publish refusal was not surfaced");
      }
      return "confirmation fired, refusal surfaced";
    });

    await step("console:confirmed-publish", async () => {
      // Satisfy the report's gates through the console — approval, legal
      // review, one right-of-reply attempt — then publish for real.
      dialogs.length = 0;
      await actions.click('[data-action="report-approve"][data-type="briefing"]');
      // Wait for the in-place acknowledgement before touching the gates
      // below: the approval must be recorded, not just clicked.
      await waitForText(actions, "#app", "Approval recorded", 15_000);
      await actions.fill(
        '[data-field="legal-reviewer"][data-type="briefing"]',
        "Console check",
      );
      await actions.click('[data-action="report-legal"][data-type="briefing"]');
      await actions.fill(
        '[data-field="reply-subject"][data-type="briefing"]',
        "Draft report",
      );
      await actions.fill(
        '[data-field="reply-channel"][data-type="briefing"]',
        "Email",
      );
      await actions.click('[data-action="report-reply"][data-type="briefing"]');
      // Confirm the recorded attempt through the legal surface (what an
      // operator would read) before publishing: re-read until it surfaces,
      // because a stale first read must not cause a spurious gate refusal.
      let surfaced = false;
      const legalDeadline = Date.now() + 20_000;
      while (!surfaced && Date.now() < legalDeadline) {
        await actions.click('[data-action="report-legal-read"][data-type="briefing"]');
        await sleep(500);
        const surface = await actions.readText(
          '[data-field="legal-surface"][data-type="briefing"]',
        );
        surfaced = surface.includes("awaiting");
      }
      if (!surfaced) {
        throw new Error("the legal surface never showed the recorded reply attempt");
      }
      await actions.click('[data-action="report-publish"][data-type="briefing"]');
      const deadline = Date.now() + 20_000;
      for (;;) {
        const text = await actions.readText("#app");
        if (text.includes("briefing \u2014 v1")) {
          return "gates satisfied through the console; version 1 published";
        }
        const alert = dialogs.find((d) => d.startsWith("alert:"));
        if (alert) throw new Error(`publish failed: ${alert}`);
        if (Date.now() >= deadline) {
          throw new Error('"briefing — v1" not found within 20s');
        }
        await sleep(200);
      }
    });
  } finally {
    try {
      await session.close();
    } catch {
      // A failed close must not mask the receipts already collected.
    }
  }
  return receipts;
}
