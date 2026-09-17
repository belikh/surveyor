// Bundled entry for scripts/console-check.mjs: the A6 PDF check and the
// console check over the Playwright driver, exported so the runner stays a
// thin boot-and-report shell (#67).

export { runPdfBrowserCheck, fixturePdf } from "../../src/lib/browser";
export { runConsoleBrowserCheck } from "../../src/lib/console-browser";
export { playwrightDriver } from "./playwright-driver";
