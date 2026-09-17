#!/usr/bin/env node
// Report-quality evaluation runbook (D9, #52).
//
// Runs the published fixture investigation (`test/helpers/report-quality.ts`)
// through every deterministic and scripted report path and writes the
// measured evidence to `evidence/report-quality/results.json`. Nothing here
// talks to a provider: a live model's prose quality cannot be measured
// without a live BYOK provider or Workers AI run, and is recorded as
// explicit gaps in the results, never as numbers.
//
// Reproduce:  npm run quality:report
// Verify a checkout without writing:  node scripts/report-quality.mjs --check

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { runEvaluation } from "../dist/report-quality-lib.js";

const OUT = new URL("../evidence/report-quality/results.json", import.meta.url);

function withoutRunContext(raw) {
  const { run_at, environment, ...rest } = JSON.parse(raw);
  void run_at;
  void environment;
  return JSON.stringify(rest);
}

const results = await runEvaluation();
const rendered =
  JSON.stringify(
    {
      evaluation: "report-quality",
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
    console.error(`no evidence at ${OUT.pathname} — run: npm run quality:report`);
    process.exit(1);
  }
  if (withoutRunContext(committed) !== withoutRunContext(rendered)) {
    console.error(
      "results drift: the committed evidence is not a run of the current " +
        "fixtures and report paths — run: npm run quality:report",
    );
    process.exit(1);
  }
  console.log(`reproduces: ${OUT.pathname}`);
  process.exit(0);
}

mkdirSync(new URL("../evidence/report-quality/", import.meta.url), {
  recursive: true,
});
writeFileSync(OUT, rendered);

console.log(
  "report_type   path                     outcome              claims  cover  quotes  fid  uncited  leaks  marker",
);
for (const m of results.measurements) {
  console.log(
    [
      m.report_type.padEnd(13),
      m.path.padEnd(24),
      m.outcome.padEnd(21),
      `${m.claims_delivered}/${m.claims_proposed}`.padEnd(7),
      String(m.claim_coverage ?? "-").padEnd(6),
      String(m.citations_delivered).padEnd(7),
      String(m.quote_fidelity).padEnd(4),
      String(m.uncited_markers).padEnd(8),
      String(m.held_content_leaked).padEnd(6),
      String(m.marker_in_body),
    ].join(" "),
  );
}
console.log(
  "\npath                     n   cit acc  quote fid  claim cov  fabricated  unsupported  uncited  leaks  fallbacks",
);
for (const s of results.summary) {
  console.log(
    [
      s.path.padEnd(24),
      String(s.measurements).padEnd(3),
      String(s.mean_citation_accuracy ?? "-").padEnd(8),
      String(s.mean_quote_fidelity ?? "-").padEnd(10),
      String(s.mean_claim_coverage ?? "-").padEnd(10),
      String(s.fabricated_quotes_delivered).padEnd(11),
      String(s.unsupported_claims_delivered).padEnd(12),
      String(s.uncited_markers).padEnd(8),
      String(s.held_content_leaks).padEnd(6),
      String(s.deterministic_fallbacks),
    ].join(" "),
  );
}
console.log(`\nlive-model lanes not measured (gaps recorded, never estimated):`);
for (const gap of results.gaps) {
  console.log(`- ${gap.path}: ${gap.reason}`);
}
console.log(`\nwrote ${OUT.pathname}`);
