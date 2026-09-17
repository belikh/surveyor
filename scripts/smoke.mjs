#!/usr/bin/env node
// Installation smoke: run against a live deployment URL.
//
//   node scripts/smoke.mjs https://your-install.workers.dev [--token <operator-token>]
//
// Prints a per-check receipt and exits non-zero on any failure. The token
// is optional: checks that need it skip with a clear note, never silently
// pass. Secret values are never printed.

import { solvePow, auditHeaders, formatReceipt, summarise } from "../dist/smoke-lib.js";

const [urlArg, ...rest] = process.argv.slice(2);
if (!urlArg) {
  console.error("usage: node scripts/smoke.mjs <base-url> [--token <token>]");
  process.exit(2);
}
const base = urlArg.replace(/\/+$/, "");
const tokenIdx = rest.indexOf("--token");
const token = tokenIdx >= 0 ? rest[tokenIdx + 1] : undefined;

const receipts = [];
const add = (r) => {
  receipts.push(r);
  console.log(formatReceipt(r));
};

async function get(path, headers = {}) {
  return fetch(`${base}${path}`, { headers });
}

async function main() {
  // 1. Security headers on the root.
  try {
    const res = await get("/");
    const headers = {};
    for (const [k, v] of res.headers) headers[k.toLowerCase()] = v;
    for (const r of auditHeaders(headers)) add(r);
  } catch (err) {
    add({ name: "reachability", status: "fail", detail: String(err) });
    return finish();
  }

  // 2. Degraded status is public and honest.
  try {
    const res = await get("/api/status");
    const body = await res.json();
    add({
      name: "status:degraded",
      status: typeof body.degraded === "boolean" ? "pass" : "fail",
      detail: `degraded=${body.degraded} warning=${body.warning ? "present" : "none"}`,
    });
  } catch (err) {
    add({ name: "status:degraded", status: "fail", detail: String(err) });
  }

  // 3. Public survey shell serves.
  try {
    const res = await get("/survey");
    const html = await res.text();
    add({
      name: "survey:shell",
      status: res.ok && html.includes("/survey.js") ? "pass" : "fail",
      detail: `HTTP ${res.status}`,
    });
  } catch (err) {
    add({ name: "survey:shell", status: "fail", detail: String(err) });
  }

  // 3b. Placement (#67): the root is the survey, /setup is the wizard, the
  // console is served, and /corpus permanently redirects into it.
  try {
    const placements = [
      { name: "placement:root-survey", path: "/", needle: "/survey.js" },
      { name: "placement:setup-wizard", path: "/setup", needle: "/wizard.js" },
      { name: "placement:console", path: "/console", needle: "/console.js" },
    ];
    for (const p of placements) {
      const res = await get(p.path);
      const html = await res.text();
      add({
        name: p.name,
        status: res.ok && html.includes(p.needle) ? "pass" : "fail",
        detail: `HTTP ${res.status}`,
      });
    }
    const redirect = await get("/corpus");
    add({
      name: "placement:corpus-redirect",
      status:
        redirect.status === 301 &&
        redirect.headers.get("location") === "/console#corpus"
          ? "pass"
          : "fail",
      detail: `HTTP ${redirect.status} -> ${redirect.headers.get("location")}`,
    });
  } catch (err) {
    add({ name: "placement:root-survey", status: "fail", detail: String(err) });
  }

  // 4. Intake challenge + proof-of-work round trip.
  try {
    const ch = await (await get("/api/intake/challenge")).json();
    const nonce = await solvePow(ch.challenge, ch.difficulty);
    const res = await fetch(`${base}/api/intake`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pow: { challenge: ch.challenge, nonce } }),
    });
    const created = await res.json();
    add({
      name: "intake:pow-create",
      status: res.ok && created.access_code ? "pass" : "fail",
      detail: `HTTP ${res.status}`,
    });
  } catch (err) {
    add({ name: "intake:pow-create", status: "fail", detail: String(err) });
  }

  // 5. Operator-gated checks.
  if (!token) {
    add({
      name: "operator:ciphertext-audit",
      status: "skip",
      detail: "no --token supplied; run again with the operator token to audit at-rest storage",
    });
  } else {
    try {
      const auth = { authorization: `Bearer ${token}` };
      const corpus = await get("/api/corpus", auth);
      add({
        name: "operator:corpus-list",
        status: corpus.ok ? "pass" : "fail",
        detail: `HTTP ${corpus.status}`,
      });
      const tele = await get("/api/telemetry", auth);
      const rows = await tele.json();
      add({
        name: "operator:telemetry",
        status: tele.ok && Array.isArray(rows) ? "pass" : "fail",
        detail: `${Array.isArray(rows) ? rows.length : 0} turn(s) recorded`,
      });
      const reports = await get("/api/reports", auth);
      const index = await reports.json();
      add({
        name: "operator:report-index",
        status: reports.ok && Array.isArray(index.types) ? "pass" : "fail",
        detail: `${Array.isArray(index.types) ? index.types.length : 0} report type(s)`,
      });
      const subs = await get("/api/submissions", auth);
      const listed = await subs.json();
      add({
        name: "operator:submissions-list",
        status: subs.ok && Array.isArray(listed.submissions) ? "pass" : "fail",
        detail: `${Array.isArray(listed.submissions) ? listed.submissions.length : 0} submission(s)`,
      });
      const audit = await get("/api/audit/ciphertext", auth);
      const shape = await audit.json();
      add({
        name: "operator:ciphertext-only",
        status: audit.ok && shape.ok ? "pass" : "fail",
        detail: `messages=${shape.messages?.total ?? "?"} corpus=${shape.corpus?.total ?? "?"} entities=${shape.entities?.total ?? "?"}`,
      });
    } catch (err) {
      add({ name: "operator:ciphertext-audit", status: "fail", detail: String(err) });
    }
  }

  finish();
}

function finish() {
  const s = summarise(receipts);
  console.log(
    `\n${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped`,
  );
  process.exit(s.ok ? 0 : 1);
}

main();
