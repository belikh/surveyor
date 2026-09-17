#!/usr/bin/env node
// OCR accuracy bake-off runbook (D8, #51).
//
// Runs the published fixture corpus (`test/helpers/bakeoff.ts`) through every
// deterministic extraction path and writes the measured evidence to
// `evidence/ocr-accuracy/results.json`. Nothing here talks to a provider:
// the model lanes cannot be measured without a live Workers AI account and
// are recorded as explicit gaps in the results, never as numbers.
//
// Reproduce:  npm run bakeoff:ocr
// Verify a checkout without writing:  node scripts/ocr-bakeoff.mjs --check

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { runBakeoff } from "../dist/bakeoff-lib.js";

const OUT = new URL("../evidence/ocr-accuracy/results.json", import.meta.url);

function withoutRunContext(raw) {
  const { run_at, environment, ...rest } = JSON.parse(raw);
  void run_at;
  void environment;
  return JSON.stringify(rest);
}

const results = await runBakeoff();
const rendered =
  JSON.stringify(
    {
      bakeoff: "ocr-accuracy",
      ...results,
      run_at: new Date().toISOString(),
      environment: {
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
      },
    },
    null,
    2,
  ) + "\n";

if (process.argv.includes("--check")) {
  let committed;
  try {
    committed = readFileSync(OUT, "utf8");
  } catch {
    console.error(`no evidence at ${OUT.pathname} — run: npm run bakeoff:ocr`);
    process.exit(1);
  }
  if (withoutRunContext(committed) !== withoutRunContext(rendered)) {
    console.error(
      "results drift: the committed evidence is not a run of the current " +
        "corpus and parsers — run: npm run bakeoff:ocr",
    );
    process.exit(1);
  }
  console.log(`reproduces: ${OUT.pathname}`);
  process.exit(0);
}

mkdirSync(new URL("../evidence/ocr-accuracy/", import.meta.url), {
  recursive: true,
});
writeFileSync(OUT, rendered);

console.log("fixture             path          outcome  exact  char   word");
for (const m of results.measurements) {
  console.log(
    [
      m.fixture.padEnd(19),
      m.path.padEnd(13),
      m.outcome.padEnd(8),
      String(m.exact).padEnd(6),
      String(m.char_accuracy ?? "-").padEnd(6),
      String(m.word_accuracy ?? "-"),
    ].join(" "),
  );
}
console.log("\npath          fixtures  exact  mean char  mean word");
for (const s of results.summary) {
  console.log(
    [
      s.path.padEnd(13),
      String(s.fixtures).padEnd(8),
      String(s.exact).padEnd(6),
      String(s.mean_char_accuracy).padEnd(10),
      String(s.mean_word_accuracy),
    ].join(" "),
  );
}
console.log(`\nmodel lanes not measured (gaps recorded, never estimated):`);
for (const gap of results.gaps) {
  console.log(`- ${gap.path}: ${gap.reason}`);
}
console.log(`\nwrote ${OUT.pathname}`);
