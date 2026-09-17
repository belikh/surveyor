// Real headless-browser driver (#67, widening A6 #7): Playwright/Chromium
// implementing the BrowserDriver seam over the served installation. Tests and
// CI drive the console check through this; the DOM-stub seam stays the fast
// per-push suite. Nothing here reports a browser run that did not happen.

import {
  chromium,
  type Browser,
  type Page,
} from "playwright";
import type {
  BrowserActions,
  BrowserDriver,
  BrowserSession,
  RasterisedPage,
} from "../../src/lib/browser";

interface PdfTools {
  extractText(blob: Blob): Promise<string>;
  rasterise(blob: Blob, maxPages?: number): Promise<Blob[]>;
}

function toolsOf(page: Page): Promise<boolean> {
  return page.evaluate(
    () =>
      Boolean(
        (globalThis as unknown as { SurveyorPdf?: PdfTools }).SurveyorPdf,
      ),
  );
}

async function ensurePdfTools(page: Page, baseUrl: string): Promise<void> {
  if (await toolsOf(page)) return;
  await page.addScriptTag({
    url: new URL("/pdf-tools.js", baseUrl).toString(),
  });
  await page.waitForFunction(
    () =>
      Boolean(
        (globalThis as unknown as { SurveyorPdf?: PdfTools }).SurveyorPdf,
      ),
    undefined,
    { timeout: 30_000 },
  );
}

export interface PlaywrightDriverOptions {
  headless?: boolean;
  /** Per-action timeout; the check also exercises refusal paths. */
  timeoutMs?: number;
}

/** A BrowserDriver backed by Playwright's Chromium. */
export function playwrightDriver(
  options: PlaywrightDriverOptions = {},
): BrowserDriver {
  return {
    name: "playwright-chromium",
    async launch(baseUrl: string): Promise<BrowserSession> {
      const browser: Browser = await chromium.launch({
        headless: options.headless ?? true,
        // Containers and CI sandboxes need this to start Chromium.
        args: ["--no-sandbox"],
      });
      const context = await browser.newContext();
      const page = await context.newPage();
      page.setDefaultTimeout(options.timeoutMs ?? 5_000);

      let dialogHandler:
        | ((kind: "confirm" | "alert", message: string) => boolean)
        | undefined;
      page.on("dialog", async (dialog) => {
        const kind = dialog.type() === "confirm" ? "confirm" : "alert";
        const accept = dialogHandler ? dialogHandler(kind, dialog.message()) : true;
        if (accept) await dialog.accept();
        else await dialog.dismiss();
      });

      const actions: BrowserActions = {
        async click(selector) {
          await page.click(selector);
        },
        async fill(selector, value) {
          await page.fill(selector, value);
        },
        async waitFor(selector, timeoutMs) {
          await page.waitForSelector(selector, {
            state: "attached",
            timeout: timeoutMs ?? options.timeoutMs ?? 10_000,
          });
        },
        async readText(selector) {
          return (await page.textContent(selector)) ?? "";
        },
        async isDisabled(selector) {
          return page.isDisabled(selector);
        },
        async setInputFiles(selector, files) {
          await page.setInputFiles(
            selector,
            files.map((f) => ({
              name: f.name,
              mimeType: f.mimeType,
              buffer: Buffer.from(f.bytes),
            })),
          );
        },
        onDialog(handler) {
          dialogHandler = handler;
        },
        async screenshot() {
          return new Uint8Array(await page.screenshot());
        },
        async drag(selector, dx, dy) {
          const box = await page.locator(selector).boundingBox();
          if (!box) throw new Error(`no box for ${selector}`);
          const x = box.x + box.width / 2;
          const y = box.y + box.height / 2;
          await page.mouse.move(x, y);
          await page.mouse.down();
          await page.mouse.move(x + dx, y + dy, { steps: 5 });
          await page.mouse.up();
        },
        async attribute(selector, name) {
          return (
            (await page.locator(selector).first().getAttribute(name)) ?? ""
          );
        },
      };

      return {
        async goto(path) {
          const res = await page.goto(new URL(path, baseUrl).toString(), {
            waitUntil: "domcontentloaded",
          });
          return { status: res?.status() ?? 0, body: await page.content() };
        },
        async extractText(pdf) {
          await ensurePdfTools(page, baseUrl);
          return page.evaluate(async (bytes) => {
            const tools = (globalThis as unknown as { SurveyorPdf: PdfTools })
              .SurveyorPdf;
            return tools.extractText(
              new Blob([new Uint8Array(bytes)], { type: "application/pdf" }),
            );
          }, Array.from(pdf));
        },
        async rasterise(pdf, maxPages): Promise<RasterisedPage[]> {
          await ensurePdfTools(page, baseUrl);
          const blobs = await page.evaluate(
            async ({ bytes, pages }) => {
              const tools = (globalThis as unknown as { SurveyorPdf: PdfTools })
                .SurveyorPdf;
              const rendered = await tools.rasterise(
                new Blob([new Uint8Array(bytes)], {
                  type: "application/pdf",
                }),
                pages,
              );
              const out: Array<{ type: string; bytes: number[] }> = [];
              for (const blob of rendered) {
                out.push({
                  type: blob.type,
                  bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
                });
              }
              return out;
            },
            { bytes: Array.from(pdf), pages: maxPages },
          );
          return blobs.map((b) => ({
            mediaType: b.type,
            bytes: b.bytes.length,
            signature: b.bytes.slice(0, 8),
          }));
        },
        async close() {
          await browser.close();
        },
        actions,
      };
    },
  };
}
