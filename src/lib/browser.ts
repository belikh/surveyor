// Headless-browser seam and the served-PDF check (A6, #7).
//
// The check proves the browser path end to end against a running
// installation: the survey shell is served, the self-hosted PDF.js tools
// extract a fixture PDF's text layer inside the page, and rasterisation
// returns a page image. Everything a browser does sits behind
// `BrowserDriver`, so tests drive the check through the in-process PDF.js
// seam (`test/helpers/pdf-browser.ts`) when no browser binary is installed,
// and a real headless driver can be dropped in for the live/CI run without
// touching the check. Nothing here reports a browser run that did not happen.

import { fail, pass, type Receipt } from "./smoke";

export interface RasterisedPage {
  mediaType: string;
  bytes: number;
  /** Leading bytes: a real encoded image, checked against the PNG magic. */
  signature: number[];
}

/** User-action primitives the console job drives real flows with (#67).
 *  Selectors are driver-defined CSS selectors; the served console keeps
 *  stable `data-action` / `data-field` hooks for them. Optional on
 *  BrowserSession so the A6 PDF check's in-process seam stays valid: a
 *  check that needs actions fails honestly when the driver has none. */
export interface BrowserActions {
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  /** Resolve when the element appears; reject on timeout. */
  waitFor(selector: string, timeoutMs?: number): Promise<void>;
  readText(selector: string): Promise<string>;
  isDisabled(selector: string): Promise<boolean>;
  setInputFiles(
    selector: string,
    files: Array<{ name: string; mimeType: string; bytes: Uint8Array }>,
  ): Promise<void>;
  /** Accept or dismiss the next native dialogs (confirm/alert). */
  onDialog(handler: (kind: "confirm" | "alert", message: string) => boolean): void;
  /** Optional failure artefact: a driver with a viewport returns a PNG. */
  screenshot?(): Promise<Uint8Array>;
  /** Drag an element by `dx`,`dy` — window title bars in the console shell. */
  drag?(selector: string, dx: number, dy: number): Promise<void>;
  /** Read an attribute value ("" when absent). */
  attribute?(selector: string, name: string): Promise<string>;
}

export interface BrowserSession {
  /** Load a same-origin path; `body` is the response body text. */
  goto(path: string): Promise<{ status: number; body: string }>;
  /** Run the served PDF tools over the bytes, inside the page. */
  extractText(pdf: Uint8Array): Promise<string>;
  rasterise(pdf: Uint8Array, maxPages?: number): Promise<RasterisedPage[]>;
  close(): Promise<void>;
  /** Action primitives for console flows; absent on PDF-only drivers. */
  actions?: BrowserActions;
}

export interface BrowserDriver {
  name: string;
  launch(baseUrl: string): Promise<BrowserSession>;
}

export interface PdfCheckFixture {
  pdf: Uint8Array;
  /** The fixture's digital text layer, as extraction should return it. */
  expectedText: string;
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** A one-page PDF with a digital text layer, built here so the check
 *  carries its own evidence rather than a binary fixture. */
export function fixturePdf(): PdfCheckFixture {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R " +
      "/Resources << /Font << /F1 5 0 R >> >> >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = "BT /F1 18 Tf 20 100 Td (Hello Surveyor) Tj ET";
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xref}\n%%EOF\n`;
  return { pdf: new TextEncoder().encode(pdf), expectedText: "Hello Surveyor" };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run the browser check against `baseUrl` through `driver` and return one
 * receipt per step. A driver that cannot launch yields a single failure;
 * otherwise every step reports independently, so one failure never hides
 * the others. The session is always closed.
 */
export async function runPdfBrowserCheck(
  driver: BrowserDriver,
  baseUrl: string,
  fixture: PdfCheckFixture = fixturePdf(),
): Promise<Receipt[]> {
  let session: BrowserSession;
  try {
    session = await driver.launch(baseUrl);
  } catch (err) {
    return [
      fail("browser:driver", `${driver.name}: ${message(err)}`),
    ];
  }

  const receipts: Receipt[] = [];
  try {
    try {
      const shell = await session.goto("/survey");
      receipts.push(
        shell.status === 200 && shell.body.includes("/survey.js")
          ? pass("browser:survey-shell", `HTTP ${shell.status}`)
          : fail(
              "browser:survey-shell",
              `HTTP ${shell.status} — expected the served survey shell`,
            ),
      );
    } catch (err) {
      receipts.push(fail("browser:survey-shell", message(err)));
    }

    try {
      const text = await session.extractText(fixture.pdf);
      receipts.push(
        text.includes(fixture.expectedText)
          ? pass("browser:pdf-text", `extracted "${fixture.expectedText}"`)
          : fail(
              "browser:pdf-text",
              `expected "${fixture.expectedText}" in the extracted text`,
            ),
      );
    } catch (err) {
      receipts.push(fail("browser:pdf-text", message(err)));
    }

    try {
      const pages = await session.rasterise(fixture.pdf, 1);
      const page = pages[0];
      const isPng =
        page !== undefined &&
        page.mediaType === "image/png" &&
        page.bytes > 0 &&
        PNG_SIGNATURE.every((b, i) => page.signature[i] === b);
      receipts.push(
        isPng
          ? pass(
              "browser:pdf-rasterise",
              `${pages.length} page image(s), ${page.bytes} bytes`,
            )
          : fail(
              "browser:pdf-rasterise",
              `no PNG page image returned (${pages.length} page(s))`,
            ),
      );
    } catch (err) {
      receipts.push(fail("browser:pdf-rasterise", message(err)));
    }
  } finally {
    try {
      await session.close();
    } catch {
      // A failed close must not mask the receipts already collected.
    }
  }
  return receipts;
}
