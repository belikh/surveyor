// Operator console: one Mac OS 9-styled browser shell for every day-2
// capability the API already has, plus the small set of read routes the
// console needed (submissions, report index, research lines, snapshot
// inspection). Zero dependencies, textContent-only rendering (constitution
// III), no inline script (CSP script-src 'self'), no framework and no build
// step: the shell and its vanilla-JS driver are served as static strings,
// in the same style as the wizard.
//
// The operator token lives in module memory only — never localStorage,
// cookies or the URL. Controls are inert until it is set and no request
// leaves the page before then (F3, #66). Irreversible acts (publish,
// reveal, teardown, reseal, rotation, key deletion) demand explicit
// confirmation, and where the API records a reason, a typed reason.

import { WIZARD_CSS, CONSOLE_CSS } from "./chrome";

export function consoleShell(): string {
  return `<!DOCTYPE html>
<html lang="en-AU"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Surveyor Console</title><style>${WIZARD_CSS}${CONSOLE_CSS}</style></head>
<body class="console"><main id="app"></main>
<script src="/console.js"></script></body></html>`;
}

export const CONSOLE_JS = `
// Console driver: token -> sections (hash-routed) -> operator actions.
// textContent-only rendering. The operator token and the transient
// Cloudflare OAuth token are held in module memory only; no storage APIs,
// no cookies, and no secret ever rides a query string or renders into the
// page.
const app = document.getElementById("app");
let TOKEN = "";
let CF_TOKEN = "";
let STATUS = null;
let statusNode = null;
const STATE = { openSubmission: null, openLine: null };
// Sections in navigation order; #home is the default.
const SECTIONS = [
  ["home", "Home"],
  ["providers", "Providers"],
  ["corpus", "Corpus"],
  ["submissions", "Submissions"],
  ["engine", "Engine"],
  ["reports", "Reports"],
  ["compliance", "Compliance"],
  ["case", "Case file"],
  ["launch", "Launch"],
];
// The OAuth callback returns the transient Cloudflare token in the URL
// fragment; read it once and strip it, so a screen share or transcript
// never carries it and it never reaches the server.
function readFragment() {
  const m = (location.hash || "").match(/cf_token=([^&]+)/);
  if (m) {
    CF_TOKEN = decodeURIComponent(m[1]);
    try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {}
  }
}
readFragment();
function currentSection() {
  const h = String(location.hash || "").replace(/^#/, "").split("?")[0];
  for (const s of SECTIONS) if (s[0] === h) return h;
  return "home";
}
function errorText(e) {
  if (!e) return "unknown error";
  if (e.token) {
    const extra = e.detail || (e.refusals
      ? e.refusals.map(function (r) { return r.category + ": " + r.reason; }).join("; ")
      : "");
    return e.token + (extra ? " \\u2014 " + extra : "");
  }
  return String(e.message || e);
}
// One error shape for every operator request: the API's error token plus
// whatever detail it carries (unmet gates, refused retention categories).
async function responseError(res) {
  let body = {};
  try { body = await res.json(); } catch (e) {}
  const err = new Error(body.error || String(res.status));
  err.token = body.error || String(res.status);
  err.detail = body.detail || (body.unmet ? body.unmet.join(", ") : "");
  err.refusals = Array.isArray(body.refusals) ? body.refusals : null;
  err.status = res.status;
  return err;
}
async function api(path, opts) {
  const o = opts || {};
  o.headers = Object.assign({}, o.headers || {});
  if (TOKEN) o.headers["authorization"] = "Bearer " + TOKEN;
  const res = await fetch(path, o);
  if (!res.ok) throw await responseError(res);
  return res.json();
}
// A download through the operator gate: browsers cannot carry an
// Authorization header on a plain navigation, so the export response is
// fetched, read and offered as a blob. Identifiers never ride the query
// string (A11).
async function download(path, fallbackName) {
  const res = await fetch(path, { headers: TOKEN ? { authorization: "Bearer " + TOKEN } : {} });
  if (!res.ok) throw await responseError(res);
  const blob = await res.blob();
  const disposition = res.headers.get("content-disposition") || "";
  const m = disposition.match(/filename="([^"]+)"/);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.setAttribute("href", url);
  a.setAttribute("download", m ? m[1] : fallbackName);
  a.click();
  URL.revokeObjectURL(url);
}
function el(tag, attrs, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "onclick") n.onclick = v;
    else if (k === "text") n.textContent = v;
    else if (k === "disabled") n.disabled = !!v;
    else if (k === "checked") { n.checked = !!v; n.setAttribute("checked", ""); }
    else if (k === "value") n.value = v;
    else n.setAttribute(k, v);
  }
  for (const c of children) {
    if (c !== null && c !== undefined) n.append(c);
  }
  return n;
}
function btn(label, onclick) { return el("button", { class: "os9-btn", text: label, onclick: onclick }); }
function warn(text) { return el("p", { class: "warn", text: text }); }
function panel(...children) { return el("div", { class: "os9-panel" }, ...children); }
function strong(text) { return el("strong", { text: text }); }
function input(placeholder, type) { return el("input", { type: type || "text", placeholder: placeholder }); }
function field(label, node) { return el("label", { class: "os9-field" }, el("span", { text: label }), node); }
function select(options, selected) {
  const s = el("select", {});
  for (const o of options) {
    const opt = el("option", { value: o, text: o });
    if (o === selected) opt.setAttribute("selected", "");
    s.append(opt);
  }
  if (selected) s.value = selected;
  return s;
}
function cellNode(c) {
  if (typeof c === "object" && c !== null) return c;
  return el("span", { text: String(c) });
}
function table(headers, rows) {
  const thead = el("thead", {}, el("tr", {}, ...headers.map((h) => el("th", { text: h }))));
  const tbody = el("tbody", {}, ...rows.map((r) => el("tr", {}, ...r.map((c) => el("td", {}, cellNode(c))))));
  return el("table", { class: "os9-table" }, thead, tbody);
}
function loading(parent, label) {
  const node = warn("Loading " + label + "\\u2026");
  parent.append(node);
  return {
    done: () => { node.remove(); },
    fail: (e) => { node.textContent = "Could not load " + label + ": " + errorText(e); },
  };
}
function heading(body, title, refresh) {
  const row = el("div", { class: "os9-row" }, el("h1", { text: title }));
  if (refresh) row.append(btn("Refresh", refresh));
  body.append(row);
}
// gated() is the single gate: until the operator token is set, controls
// are disabled, the hint says why, and loaders fire no request at all —
// a missing token must never read as a system failure (F3, #66).
function gated() { return TOKEN.length === 0; }
function gateHint() {
  return "Set the operator token above to enable this section \\u2014 no request leaves this page until then.";
}
function gatePanel() {
  const p = panel(strong("Operator token required"), warn(gateHint()));
  if (STATUS && STATUS.operator_token_set === false) {
    p.append(warn("This installation has no operator token yet. Boot it at /setup first."));
  }
  return p;
}
function statusStrip() {
  const s = STATUS || {};
  const bits = [];
  if (!STATUS) {
    // An unanswered status call is unknown, never a green light.
    bits.push("Status unknown \\u2014 /api/status did not answer");
  } else {
    bits.push(s.provisioned === false ? "Not provisioned" : "Provisioned");
    bits.push(s.operator_token_set ? "Operator token set" : "Operator token not set");
    if (s.build && s.build.commit) {
      bits.push("Build " + s.build.commit + (s.build.local ? " (local)" : ""));
    }
  }
  const node = el("div", { class: "os9-panel", role: "status" },
    el("span", { class: "os9-lamp " + (!STATUS || s.degraded ? "off" : "on") }),
    el("span", { text: " " + bits.join(" \\u00b7 ") }));
  if (s.warning) node.append(warn(s.warning));
  if (s.provisioned === false) {
    node.append(el("a", { href: "/setup", text: "Open first-run setup" }));
  }
  statusNode = node;
  return node;
}
function tokenPanel() {
  const t = input("Operator token (chosen at boot)", "password");
  t.setAttribute("data-field", "operator-token");
  const set = btn("Set token", () => { TOKEN = t.value.trim(); t.value = ""; render(); });
  set.setAttribute("data-action", "token-set");
  const clear = btn("Clear token", () => { TOKEN = ""; render(); });
  return panel(strong("Operator token"),
    warn(TOKEN
      ? "Token set (memory only \\u2014 this tab leaves nothing behind)."
      : "Token not set. Controls are inert until it is."),
    el("div", { class: "os9-row" }, t, set, clear));
}
function nav() {
  const bar = el("nav", { class: "os9-nav", "aria-label": "Console sections" });
  const here = currentSection();
  for (const s of SECTIONS) {
    bar.append(el("a", {
      class: "os9-tab" + (here === s[0] ? " current" : ""),
      href: "#" + s[0],
      text: s[1],
      "aria-current": here === s[0] ? "page" : "false",
    }));
  }
  return bar;
}
// ---------------------------------------------------------------- home
async function paintHome(body) {
  heading(body, "Home", () => render());
  if (gated()) { body.append(gatePanel()); return; }
  const l = loading(body, "counts");
  try {
    const subs = await api("/api/submissions");
    const corpus = await api("/api/corpus");
    const angles = await api("/api/engine/angles");
    const lines = await api("/api/engine/lines");
    const reports = await api("/api/reports");
    const providers = await api("/api/providers");
    l.done();
    const awaiting = angles.angles.filter((a) => a.status === "queued").length;
    const heldAngles = angles.angles.filter((a) => a.status === "held").length;
    const heldLines = lines.lines.filter((x) => x.status === "held").length;
    const heldDocs = corpus.docs.filter((d) => d.status === "held").length;
    const published = reports.types.filter((t) => t.current_version > 0).length;
    body.append(panel(strong("Outstanding work"),
      table(
        ["Submissions", "Corpus documents", "Angles awaiting review", "Held items", "Reports published"],
        [[subs.submissions.length, corpus.docs.length, awaiting, heldAngles + heldLines + heldDocs, published]],
      )));
    const links = el("ul", {});
    links.append(el("li", {}, el("a", { href: "/", text: "Open the public survey" })));
    links.append(el("li", {}, el("a", { href: "#launch", text: "Launch pack and telemetry" })));
    if (awaiting + heldAngles > 0) links.append(el("li", {}, el("a", { href: "#engine", text: "Engine \\u2014 angles awaiting a decision" })));
    if (heldDocs > 0) links.append(el("li", {}, el("a", { href: "#corpus", text: "Corpus \\u2014 documents held in a lane" })));
    if (subs.submissions.length > 0) links.append(el("li", {}, el("a", { href: "#submissions", text: "Submissions \\u2014 source traffic" })));
    if (published > 0 || reports.types.some((t) => t.gates && !t.gates.ok)) {
      links.append(el("li", {}, el("a", { href: "#reports", text: "Reports \\u2014 gate status" })));
    }
    body.append(panel(strong("Go to"), links));
    body.append(panel(strong("Provider configuration"),
      warn(providers.degraded ? (providers.warning || "The provider chain is degraded.") : "The chain is not degraded."),
      providers.entries.length === 0 ? warn("No provider keys configured.")
        : table(["Label", "Kind", "Model"],
            providers.entries.map((p) => [p.label, p.kind, p.model]))));
  } catch (e) { l.fail(e); }
}
// ----------------------------------------------------------- providers
async function paintProviders(body) {
  heading(body, "Providers and keys", () => render());
  if (gated()) { body.append(gatePanel()); return; }
  const l = loading(body, "providers");
  try {
    const chain = await api("/api/providers");
    l.done();
    body.append(panel(strong("Configured chain"),
      warn(chain.degraded ? (chain.warning || "The provider chain is degraded.") : "The chain is not degraded."),
      table(
        ["Label", "Kind", "Model", "Capabilities", "Base URL", "Order"],
        chain.entries.map((e, i) => [
          e.label, e.kind, e.model, (e.capabilities || []).join(", "), e.base_url || "\\u2014",
          el("span", {},
            btn("\\u2191", async () => {
              // Reorder speaks stored order: the entry's order survives the
              // filter that hides secretless entries, so the arrow moves the
              // entry the operator can actually see.
              const to = i > 0 ? chain.entries[i - 1].order : e.order - 1;
              try { await api("/api/providers/reorder", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: e.order, to: to }) }); render(); }
              catch (err) { alert("Reorder failed: " + errorText(err)); }
            }),
            btn("\\u2193", async () => {
              const to = i < chain.entries.length - 1 ? chain.entries[i + 1].order : e.order + 1;
              try { await api("/api/providers/reorder", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: e.order, to: to }) }); render(); }
              catch (err) { alert("Reorder failed: " + errorText(err)); }
            })),
        ]),
      )));
  } catch (e) { l.fail(e); }

  const cf = input("Cloudflare API token (Workers Scripts: Edit)", "password");
  const account = input("Cloudflare account id");
  const script = input("Worker script name (e.g. surveyor)");
  const connect = btn("Connect Cloudflare", () => { location.href = "/api/oauth/start?next=/console"; });
  body.append(panel(strong("Cloudflare"),
    warn(CF_TOKEN
      ? "Cloudflare connected (transient token held in this tab, never stored)."
      : "Connect Cloudflare for key writes, provisioning and teardown \\u2014 or paste a token here."),
    field("Cloudflare API token", cf), field("Account id", account), field("Script name", script),
    connect));

  const kind = select(["openai-compatible", "groq", "tokenrouter", "tavily", "parallel"], "openai-compatible");
  const label = input("Label");
  const model = input("Model id");
  const baseUrl = input("Base URL (openai-compatible only)");
  const slot = input("Secret slot (e.g. GROQ_API_KEY, TAVILY_API_KEY)");
  const caps = input("Capabilities (comma-separated: chat, vision, search, extract, audio)");
  const key = input("Provider API key", "password");
  const addNote = warn("");
  const bodyFor = () => ({
    cf_token: CF_TOKEN || cf.value,
    account_id: account.value,
    script_name: script.value,
    kind: kind.value || "openai-compatible",
    label: label.value,
    model: model.value,
    base_url: baseUrl.value || undefined,
    secret_slot: slot.value,
    capabilities: caps.value.split(",").map((c) => c.trim()).filter(Boolean),
    api_key: key.value,
  });
  const validate = btn("Validate draft", async () => {
    addNote.textContent = "Testing the provider draft\\u2026";
    try {
      await api("/api/providers/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: label.value, baseUrl: baseUrl.value, model: model.value, apiKey: key.value }),
      });
      addNote.textContent = "Draft validated.";
    } catch (e) { addNote.textContent = "Validation failed: " + errorText(e); }
  });
  const save = btn("Add provider key", async () => {
    addNote.textContent = "Validating and writing\\u2026";
    try {
      await api("/api/providers/key", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bodyFor()),
      });
      key.value = "";
      addNote.textContent = "Key written to the secret store.";
      render();
    } catch (e) { addNote.textContent = "Failed: " + errorText(e); }
  });
  body.append(panel(strong("Add a provider"),
    field("Kind", kind), field("Label", label), field("Model", model), field("Base URL", baseUrl),
    field("Secret slot", slot), field("Capabilities", caps), field("API key", key),
    el("div", { class: "os9-row" }, validate, save), addNote));

  const delSlot = input("Secret slot to delete");
  const delNote = warn("");
  const del = btn("Delete key", async () => {
    if (!confirm("Delete the key in " + delSlot.value + "? This cannot be undone.")) return;
    try {
      await api("/api/providers/key/" + encodeURIComponent(delSlot.value), {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cf_token: CF_TOKEN || cf.value, account_id: account.value, script_name: script.value }),
      });
      delNote.textContent = "Key deleted.";
      render();
    } catch (e) { delNote.textContent = "Failed: " + errorText(e); }
  });
  body.append(panel(strong("Remove a key"), field("Secret slot", delSlot), el("div", { class: "os9-row" }, del), delNote));
}
// -------------------------------------------------------------- corpus
function loadPdfTools() {
  if (window.SurveyorPdf) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "/pdf-tools.js";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("could not load the PDF reader"));
    document.head.append(s);
  });
}
async function uploadOne(filename, mediaType, blob) {
  await api("/api/corpus", {
    method: "POST",
    headers: { "content-type": mediaType, "x-filename": encodeURIComponent(filename) },
    body: blob,
  });
}
// Per-page hybrid routing (F2, #62): text pages upload as text,
// image-bearing pages rasterise to PNGs, so a mixed PDF never silently
// drops its raster portions. The receipt says what was sent.
async function handleCorpusFile(file, note) {
  const isPdf = file.type === "application/pdf" || /\\.pdf$/i.test(file.name);
  if (!isPdf) {
    note.textContent = "Uploading " + file.name + "\\u2026";
    await uploadOne(file.name, file.type || "application/octet-stream", file);
    return;
  }
  note.textContent = "Reading the PDF in this browser\\u2026";
  await loadPdfTools();
  const tools = window.SurveyorPdf;
  const base = file.name.replace(/\\.pdf$/i, "");
  if (tools.analysePages && tools.rasterisePages) {
    const analysis = await tools.analysePages(file);
    const textPages = analysis.filter((p) => p.hasText);
    const imagePages = analysis.filter((p) => p.hasImage);
    if (imagePages.length === 0 && textPages.length > 0) {
      const text = textPages.map((p) => p.text).join("\\n\\n").trim();
      await uploadOne(base + ".txt", "text/plain", new Blob([text], { type: "text/plain" }));
      note.textContent = "Digital PDF: sent extracted text (" + textPages.length + " pages).";
      return;
    }
    if (textPages.length === 0) {
      const targets = (imagePages.length > 0 ? imagePages : analysis).map((p) => p.page);
      note.textContent = "Scanned PDF: rasterising " + targets.length + " pages\\u2026";
      const rendered = await tools.rasterisePages(file, targets);
      for (const item of rendered) {
        await uploadOne(base + "-page-" + item.page + ".png", "image/png", item.blob);
      }
      note.textContent = "Sent " + rendered.length + " scanned pages (no text layer found).";
      return;
    }
    const text = textPages.map((p) => p.text).join("\\n\\n").trim();
    note.textContent = "Mixed PDF: sending text plus " + imagePages.length + " scanned pages\\u2026";
    await uploadOne(base + ".txt", "text/plain", new Blob([text], { type: "text/plain" }));
    const rendered = await tools.rasterisePages(file, imagePages.map((p) => p.page));
    for (const item of rendered) {
      await uploadOne(base + "-page-" + item.page + ".png", "image/png", item.blob);
    }
    note.textContent = "Sent text (" + textPages.length + " pages) plus " + rendered.length + " scanned pages.";
    return;
  }
  const text = await tools.extractText(file);
  if (text && text.length > 40) {
    await uploadOne(base + ".txt", "text/plain", new Blob([text], { type: "text/plain" }));
    return;
  }
  const pages = await tools.rasterise(file);
  for (let i = 0; i < pages.length; i++) {
    await uploadOne(base + "-page-" + (i + 1) + ".png", "image/png", pages[i]);
  }
  note.textContent = "Sent " + pages.length + " scanned pages.";
}
async function paintCorpus(body) {
  heading(body, "Corpus", () => render());
  if (gated()) { body.append(gatePanel()); return; }
  const picker = el("input", { type: "file", multiple: "true", "data-field": "corpus-files" });
  const note = warn("");
  const go = btn("Upload files", async () => {
    if (gated()) { note.textContent = gateHint(); return; }
    go.disabled = true;
    try {
      for (const file of picker.files || []) {
        try { await handleCorpusFile(file, note); }
        catch (e) { note.textContent = "Failed on " + file.name + ": " + errorText(e); }
      }
      note.textContent += "\\nTriggering the drain\\u2026";
      const r = await api("/api/corpus/drain", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const held = (r.outcomes || []).filter((o) => o.status === "held" && o.reason);
      note.textContent = "Drained " + r.drained + " of " + (r.outcomes || []).length + "." +
        (held.length > 0 ? " Held: " + held.map((o) => o.reason).join("; ") : "");
      render();
    } catch (e) { note.textContent = "Upload failed: " + errorText(e); }
    go.disabled = false;
  });
  go.setAttribute("data-action", "corpus-upload");
  const drain = btn("Drain held documents", async () => {
    try {
      const r = await api("/api/corpus/drain", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      note.textContent = "Drained " + r.drained + " of " + (r.outcomes || []).length + ".";
      render();
    } catch (e) { note.textContent = "Drain failed: " + errorText(e); }
  });
  drain.setAttribute("data-action", "corpus-drain");
  body.append(panel(strong("Upload"),
    warn("Digital PDFs are read in your browser; scanned pages are rasterised here and OCR'd server-side. Nothing is uploaded that is not needed."),
    picker, el("div", { class: "os9-row" }, go, drain), note));
  const l = loading(body, "documents");
  try {
    const data = await api("/api/corpus");
    l.done();
    const mirror = data.docs.filter((d) => d.status !== "held");
    const held = data.docs.filter((d) => d.status === "held");
    body.append(panel(strong("Mirror \\u2014 searchable corpus (" + mirror.length + ")"),
      mirror.length === 0 ? warn("No documents in the mirror yet.")
        : table(["Filename", "Lane", "Status", "Verdict", "Reason"],
            mirror.map((d) => [d.filename, d.lane, d.status, d.verdict, d.reason || "\\u2014"]))));
    body.append(panel(strong("Held lanes \\u2014 not searchable (" + held.length + ")"),
      held.length === 0 ? warn("Nothing held.")
        : table(["Filename", "Lane", "Status", "Reason"],
            held.map((d) => [d.filename, d.lane, d.status, d.reason || "\\u2014"]))));
  } catch (e) { l.fail(e); }
}
// --------------------------------------------------------- submissions
async function paintSubmissions(body) {
  heading(body, "Submissions", () => render());
  if (gated()) { body.append(gatePanel()); return; }
  if (STATE.openSubmission) { await paintSubmissionDetail(body, STATE.openSubmission); return; }
  const l = loading(body, "submissions");
  try {
    const data = await api("/api/submissions");
    l.done();
    if (data.submissions.length === 0) {
      body.append(panel(strong("Submissions"), warn("No submissions yet.")));
    } else {
      body.append(panel(strong("Source traffic"),
        table(
          ["Status", "Round", "Created", "Consent", "Attachments", "Last activity", ""],
          data.submissions.map((s) => [
            s.status, s.round, s.created_at,
            s.consent_captures > 0 ? s.consent_captures + " capture(s)" : "none",
            s.attachments.total + " (" + s.attachments.held + " held)",
            s.last_activity,
            btn("Open", () => { STATE.openSubmission = s.id; render(); }),
          ]),
        )));
    }
  } catch (e) { l.fail(e); }
  await paintConsentCoverage(body);
  await paintEntityPanels(body);
}
async function paintConsentCoverage(body) {
  const l = loading(body, "consent coverage");
  try {
    const cov = await api("/api/intake/consent/coverage");
    l.done();
    body.append(panel(strong("Consent coverage"),
      table(["Category", "Granted", "Refused", "Undecided", "Stored"],
        cov.categories.map((c) => [c.category, c.granted, c.refused, c.undecided, c.stored])),
      warn("Wording versions: " + (cov.by_version.map((v) => "v" + v.wording_version + " \\u00d7 " + v.captures).join(", ") || "none")),
      cov.gaps.length > 0
        ? warn(cov.gaps.length + " stored answer(s) without a grant \\u2014 see the console's compliance review.")
        : warn("No gaps: every stored sensitive answer has a grant behind it.")));
  } catch (e) { l.fail(e); }
}
async function paintEntityPanels(body, submissionId) {
  const l = loading(body, "entity groups");
  try {
    let groups = null;
    let rows = null;
    let reveals = null;
    if (submissionId) {
      const detail = await api("/api/submissions/" + submissionId);
      rows = detail.entities.map((x) => [submissionId, x.label, x.hmac, x.sealed]);
    } else {
      groups = await api("/api/intake/entities/groups");
      const links = (await api("/api/intake/entities/links")).links.slice(0, 50);
      rows = links.map((x) => [x.submission_id, x.label, x.name_hmac, x.sealed]);
    }
    reveals = await api("/api/intake/entities/reveals");
    l.done();
    if (groups) {
      body.append(panel(strong("Entity groups (pseudonyms by HMAC)"),
        groups.groups.length === 0 ? warn("No entities indexed yet.")
          : table(["HMAC", "Occurrences", "Submissions"], groups.groups.map((g) => [g.name_hmac, g.n, g.subs]))));
    }
    body.append(panel(strong("Entity pseudonyms"),
      rows.length === 0 ? warn("No entity pseudonyms for this view.")
        : table(["Submission", "Pseudonym", "HMAC", "Sealed mentions"], rows)));
    body.append(panel(strong("Break-glass reveals"),
      reveals.reveals.length === 0 ? warn("No reveals recorded.")
        : table(["When", "By", "Reason", "Pseudonym links"],
            reveals.reveals.map((r) => [r.revealed_at, r.revealed_by, r.reason,
              r.links.map((l) => l.label + " in " + l.submission_id.slice(0, 8)).join(", ")]))));
    const hmac = input("Entity HMAC (64 hex)");
    const who = input("Revealed by (who is asking)");
    const why = input("Reason (why this name must be opened)");
    const note = warn("");
    const reveal = btn("Reveal name", async () => {
      if (!hmac.value || !who.value || !why.value) { note.textContent = "All three fields are required."; return; }
      if (!confirm("Open this quarantined name? The reveal is audited and cannot be undone.")) return;
      try {
        const r = await api("/api/intake/entities/reveal", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ hmac: hmac.value.trim(), revealed_by: who.value, reason: why.value }),
        });
        revealNote.textContent = "Revealed: " + r.name + " (audited).";
        render();
      } catch (e) { note.textContent = "Reveal failed: " + errorText(e); }
    });
    const revealNote = warn("");
    body.append(panel(strong("Reveal a quarantined name"),
      warn("Break-glass: the reveal is audited with who, when and why."),
      field("Entity HMAC", hmac), field("Revealed by", who), field("Reason", why),
      el("div", { class: "os9-row" }, reveal), note, revealNote));
  } catch (e) { l.fail(e); }
}
async function paintSubmissionDetail(body, id) {
  const back = btn("\\u2190 All submissions", () => { STATE.openSubmission = null; render(); });
  body.append(el("div", { class: "os9-row" }, back));
  const l = loading(body, "submission");
  try {
    const data = await api("/api/submissions/" + id);
    l.done();
    const s = data.submission;
    body.append(panel(strong("Submission " + s.id.slice(0, 8)),
      table(["Status", "Kind", "Round", "Created", "Last activity", "Write count"],
        [[s.status, s.kind, s.round, s.created_at, s.last_activity, s.write_count]])));

    body.append(panel(strong("Testimony and thread"),
      data.messages.length === 0 ? warn("No messages yet.")
        : el("div", {}, ...data.messages.map((m) =>
            el("div", { class: "os9-msg" },
              el("strong", { text: m.role + " / " + m.kind + " #" + m.seq }),
              el("div", { text: m.body }))))));
    const reply = el("textarea", { rows: 4, placeholder: "Write an operator reply" });
    const replyNote = warn("");
    const send = btn("Send reply", async () => {
      if (!reply.value.trim()) { replyNote.textContent = "Write something first."; return; }
      try {
        await api("/api/intake/" + id + "/reply", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: reply.value }),
        });
        reply.value = "";
        replyNote.textContent = "Reply sent.";
        render();
      } catch (e) { replyNote.textContent = "Failed: " + errorText(e); }
    });
    body.append(panel(strong("Reply"), reply, el("div", { class: "os9-row" }, send), replyNote));

    body.append(panel(strong("Attachments"),
      data.attachments.length === 0 ? warn("No attachments.")
        : table(["Media type", "Bytes", "Status", "Lane", "Reason", "Raw held", "Retry after", "Created"],
            data.attachments.map((a) => [a.media_type, a.size_bytes, a.status, a.lane || "\\u2014",
              a.reason || "\\u2014", a.raw_retained ? "yes" : "no", a.retry_after || "\\u2014", a.created_at]))));
    const drainNote = warn("");
    const drain = btn("Drain attachments now", async () => {
      try {
        const r = await api("/api/intake/" + id + "/attachments/drain", { method: "POST" });
        drainNote.textContent = "Drained " + r.drained + " of " + (r.outcomes || []).length + ".";
        render();
      } catch (e) { drainNote.textContent = "Drain failed: " + errorText(e); }
    });
    body.append(panel(strong("Attachment lanes"), el("div", { class: "os9-row" }, drain), drainNote));

    body.append(panel(strong("Consent"),
      data.consent.captures.length === 0 ? warn("No consent captured.")
        : table(["Category", "Decision"],
            data.consent.effective.map((d) => [d.category, d.granted ? "granted" : "refused"]))));

    body.append(panel(strong("Topics"), data.topics.length === 0 ? warn("No topics.")
      : table(["Topic", "Source"], data.topics.map((t) => [t.topic, t.source]))));

    await paintEntityPanels(body, id);
  } catch (e) { l.fail(e); }
}
// -------------------------------------------------------------- engine
async function paintEngine(body) {
  heading(body, "Engine", () => render());
  if (gated()) { body.append(gatePanel()); return; }
  if (STATE.openLine) { await paintLineDetail(body, STATE.openLine); return; }
  const topics = input("Topics (comma-separated)");
  topics.setAttribute("data-field", "angle-topics");
  const mode = select(["floor", "live"], "floor");
  const proposeNote = warn("");
  const propose = btn("Propose angles", async () => {
    proposeNote.textContent = "Proposing against the mirror\\u2026";
    try {
      const r = await api("/api/engine/angles/propose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topics: topics.value.split(",").map((t) => t.trim()).filter(Boolean), mode: mode.value }),
      });
      proposeNote.textContent = "Queued " + r.angles.length + " angle(s); tier " + r.tier +
        (r.dropped > 0 ? "; " + r.dropped + " settled topic(s) dropped" : "") + ".";
      render();
    } catch (e) { proposeNote.textContent = "Proposal failed: " + errorText(e); }
  });
  propose.setAttribute("data-action", "angle-propose");
  body.append(panel(strong("Propose angles"), field("Topics", topics), field("Mode", mode),
    el("div", { class: "os9-row" }, propose), proposeNote));

  const la = loading(body, "angle queue");
  try {
    const queue = await api("/api/engine/angles");
    la.done();
    const rows = [];
    for (const a of queue.angles) {
      const actions = [];
      if (a.status === "held") {
        const reviewApprove = btn("Review \\u2014 approve", async () => {
          if (!confirm("Approve this flagged angle after review? The flags will be cleared.")) return;
          try { await api("/api/engine/angles/" + a.id + "/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "approve" }) }); render(); }
          catch (e) { alert("Failed: " + errorText(e)); }
        });
        reviewApprove.setAttribute("data-action", "angle-review-approve");
        reviewApprove.setAttribute("data-id", a.id);
        actions.push(reviewApprove);
        const reviewReject = btn("Review \\u2014 reject", async () => {
          if (!confirm("Reject this flagged angle? It leaves the queue.")) return;
          try { await api("/api/engine/angles/" + a.id + "/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "reject" }) }); render(); }
          catch (e) { alert("Failed: " + errorText(e)); }
        });
        reviewReject.setAttribute("data-action", "angle-review-reject");
        actions.push(reviewReject);
      } else if (a.status === "queued") {
        const approve = btn("Approve", async () => {
          try { await api("/api/engine/angles/" + a.id + "/approve", { method: "POST" }); render(); }
          catch (e) { alert("Approval refused: " + errorText(e)); }
        });
        approve.setAttribute("data-action", "angle-approve");
        approve.setAttribute("data-id", a.id);
        actions.push(approve);
      } else if (a.status === "approved") {
        const cap = input("Spend cap", "number");
        cap.value = "100";
        actions.push(el("span", {}, cap));
        actions.push(btn("Open research line", async () => {
          try {
            await api("/api/engine/lines", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ angle_id: a.id, spend_cap: Number(cap.value) || 100 }) });
            render();
          } catch (e) { alert("Could not open the line: " + errorText(e)); }
        }));
      }
      rows.push([
        a.rank,
        a.title + (a.flags && a.flags.length > 0 ? " \\u2014 flags: " + a.flags.join(", ") : ""),
        a.status,
        String((a.exhibits || []).length),
        a.created_at,
        el("span", { class: "os9-row" }, ...actions),
      ]);
    }
    body.append(panel(strong("Angle queue"),
      queue.angles.length === 0 ? warn("No angles proposed yet.")
        : table(["Rank", "Angle", "Status", "Exhibits", "Created", "Actions"], rows)));
  } catch (e) { la.fail(e); }

  const ll = loading(body, "research lines");
  try {
    const data = await api("/api/engine/lines");
    ll.done();
    body.append(panel(strong("Research lines"),
      data.lines.length === 0 ? warn("No research lines yet.")
        : table(["Status", "Angle", "Spend", "Citations", "Flags", "Created", ""],
            data.lines.map((x) => [x.status, x.angle_title || x.angle_id, x.spend_used + " / " + x.spend_cap,
              x.citation_count, (x.flags || []).join(", ") || "\\u2014", x.created_at,
              btn("Open", () => { STATE.openLine = x.id; render(); })]))));
  } catch (e) { ll.fail(e); }

  const retrig = input("Topics (comma-separated)");
  const retrigNote = warn("");
  const retrigger = btn("Retrigger", async () => {
    try {
      const r = await api("/api/engine/retrigger", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topics: retrig.value.split(",").map((t) => t.trim()).filter(Boolean), mode: "floor" }),
      });
      retrigNote.textContent = "New topics: " + (r.new_topics.join(", ") || "none") + " (tier " + r.tier + ").";
    } catch (e) { retrigNote.textContent = "Failed: " + errorText(e); }
  });
  body.append(panel(strong("Retrigger"), field("Topics", retrig), el("div", { class: "os9-row" }, retrigger), retrigNote));
}
async function paintLineDetail(body, id) {
  body.append(el("div", { class: "os9-row" }, btn("\\u2190 All lines", () => { STATE.openLine = null; render(); })));
  const l = loading(body, "line");
  try {
    const line = await api("/api/engine/lines/" + id);
    const dossier = await api("/api/dossier").catch(() => null);
    const found = dossier ? dossier.lines.find((x) => x.id === id) : null;
    l.done();
    body.append(panel(strong("Research line"),
      table(["Status", "Spend", "Created", "Flags"],
        [[line.status, line.spend_used + " / " + line.spend_cap, line.created_at,
          (function () {
            try { return JSON.parse(line.flags_json || "[]").join(", ") || "\\u2014"; }
            catch (e) { return "\\u2014"; }
          })()]])));
    body.append(panel(strong("Finding"),
      found && found.finding ? el("div", { class: "os9-msg", text: found.finding }) : warn("Finding is sealed or not yet available; the dossier holds completed findings.")));
    const citations = line.citations || [];
    body.append(panel(strong("Citations"),
      citations.length === 0 ? warn("No citations.")
        : table(["Document", "Snippet", "Snapshot"],
            citations.map((c) => [c.doc_id || "\\u2014", c.snippet,
              c.snapshot_id ? btn("Inspect snapshot", async () => {
                try {
                  const snap = await api("/api/engine/snapshots/" + c.snapshot_id);
                  alert("Snapshot " + snap.snapshot.final_url + "\\nverified: " + snap.verified + "\\n\\n" + snap.text.slice(0, 2000));
                } catch (e) { alert("Snapshot failed: " + errorText(e)); }
              }) : "\\u2014"]))));
    if (line.status === "held") {
      body.append(panel(strong("Review the held line"),
        el("div", { class: "os9-row" },
          btn("Approve", async () => {
            if (!confirm("Approve this held line? Its flags stay recorded.")) return;
            try { await api("/api/engine/lines/" + id + "/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "approve" }) }); render(); }
            catch (e) { alert("Failed: " + errorText(e)); }
          }),
          btn("Reject", async () => {
            if (!confirm("Reject this held line?")) return;
            try { await api("/api/engine/lines/" + id + "/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "reject" }) }); render(); }
            catch (e) { alert("Failed: " + errorText(e)); }
          }))));
    }
    if (line.status === "running") {
      const amount = input("Amount", "number");
      const spendNote = warn("");
      body.append(panel(strong("Record spend"),
        field("Amount", amount),
        el("div", { class: "os9-row" }, btn("Add spend", async () => {
          try { await api("/api/engine/lines/" + id + "/spend", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ amount: Number(amount.value) || 1 }) }); render(); }
          catch (e) { spendNote.textContent = "Failed: " + errorText(e); }
        })), spendNote));
      const findings = el("textarea", { rows: 4, placeholder: "Findings" });
      const cites = el("textarea", { rows: 4, placeholder: "One citation per line: doc_id :: snippet (or snapshot_id :: snippet)" });
      const completeNote = warn("");
      body.append(panel(strong("Complete manually"),
        warn("Citations are the price of completion \\u2014 every cited document must exist in the mirror or snapshot store."),
        field("Findings", findings), field("Citations", cites),
        el("div", { class: "os9-row" }, btn("Complete", async () => {
          const citations = cites.value.split("\\n").map((row) => {
            const idx = row.indexOf("::");
            if (idx < 0) return null;
            const ref = row.slice(0, idx).trim();
            const snippet = row.slice(idx + 2).trim();
            if (!ref || !snippet) return null;
            return ref.indexOf("snap_") === 0 ? { snapshot_id: ref, snippet } : { doc_id: ref, snippet };
          }).filter(Boolean);
          try {
            await api("/api/engine/lines/" + id + "/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ citations, findings: findings.value }) });
            render();
          } catch (e) { completeNote.textContent = "Failed: " + errorText(e); }
        })), completeNote));
    }
  } catch (e) { l.fail(e); }
}
// ------------------------------------------------------------- reports
async function paintReports(body) {
  heading(body, "Reports", () => render());
  if (gated()) { body.append(gatePanel()); return; }
  const l = loading(body, "reports");
  try {
    const index = await api("/api/reports");
    l.done();
    body.append(panel(strong("The five report types"),
      table(["Type", "Enabled", "Status", "Version", "Cadence", "Gates"],
        index.types.map((t) => [t.type, t.enabled ? "yes" : "no", t.status,
          "current " + t.current_version + ", pending " + t.pending_version,
          t.frequency === "scheduled" ? "every " + Math.round(t.cadence_ms / 3600000) + "h"
            : t.frequency + (t.frequency === "per-n" ? " (n=" + t.threshold_n + ")" : ""),
          t.gates.ok ? "open" : t.gates.unmet.join(", ")]))));
    for (const t of index.types) {
      body.append(reportPanel(t));
    }
  } catch (e) { l.fail(e); }
}
function reportPanel(t) {
  const details = el("details", {}, el("summary", { text: t.type + " \\u2014 v" + t.current_version + (t.enabled ? "" : " (disabled)") }));
  const enabled = el("input", { type: "checkbox" });
  enabled.checked = !!t.enabled;
  const frequency = select(["manual", "scheduled", "per-n", "full-dynamic"], t.frequency);
  const cadence = input("Cadence (whole hours)", "number");
  cadence.value = String(Math.max(1, Math.round(t.cadence_ms / 3600000)));
  const threshold = input("Threshold n (for per-n)", "number");
  threshold.value = String(t.threshold_n);
  const manual = el("input", { type: "checkbox" });
  manual.checked = !!t.manual_required;
  const uncited = el("input", { type: "checkbox" });
  uncited.checked = !!t.allow_uncited;
  const cfgNote = warn("");
  const saveCfg = btn("Save configuration", async () => {
    try {
      await api("/api/reports/" + t.type + "/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: !!enabled.checked,
          config: {
            frequency: frequency.value,
            cadence_ms: Math.max(1, Number(cadence.value) || 24) * 3600000,
            threshold_n: Math.max(1, Number(threshold.value) || 5),
            manual_required: !!manual.checked,
            allow_uncited: !!uncited.checked,
          },
        }),
      });
      cfgNote.textContent = "Configuration saved.";
    } catch (e) { cfgNote.textContent = "Failed: " + errorText(e); }
  });
  details.append(panel(strong("Configuration"),
    el("label", {}, enabled, " enabled"),
    field("Frequency", frequency), field("Cadence (hours)", cadence),
    field("Threshold n", threshold),
    el("label", {}, manual, " manual approval required"),
    el("label", {}, uncited, " allow uncited claims"),
    el("div", { class: "os9-row" }, saveCfg), cfgNote));

  const approve = btn("Record approval", async () => {
    if (!confirm("Record the operator approval for " + t.type + "?")) return;
    try { await api("/api/reports/" + t.type + "/approve", { method: "POST" }); render(); }
    catch (e) { alert("Failed: " + errorText(e)); }
  });
  approve.setAttribute("data-action", "report-approve");
  approve.setAttribute("data-type", t.type);
  const draftNote = warn("");
  const draft = btn("Read draft", async () => {
    try {
      const d = await api("/api/reports/" + t.type + "/draft");
      draftBody.textContent = d.body;
    } catch (e) { draftNote.textContent = "Failed: " + errorText(e); }
  });
  const draftBody = el("pre", { class: "os9-pre", text: "" });
  const publish = btn("Publish v" + t.pending_version, async () => {
    if (!confirm("Publish " + t.type + " version " + t.pending_version + "? Publication is a public, permanent act.")) return;
    try { await api("/api/reports/" + t.type + "/publish", { method: "POST" }); render(); }
    catch (e) { alert("Publish refused: " + errorText(e)); }
  });
  publish.setAttribute("data-action", "report-publish");
  publish.setAttribute("data-type", t.type);
  details.append(panel(strong("Draft and publish"),
    warn("Publication is a human act. The gate must pass first: " + (t.gates.ok ? "gates are open." : t.gates.unmet.join(", ") + " unmet.")),
    el("div", { class: "os9-row" }, approve, draft, publish), draftNote, draftBody));

  const reviewer = input("Reviewer (who reviewed)");
  reviewer.setAttribute("data-field", "legal-reviewer");
  reviewer.setAttribute("data-type", t.type);
  const replyRequired = el("input", { type: "checkbox" });
  replyRequired.checked = true;
  const legalNotes = input("Notes");
  const legalNote = warn("");
  const recordLegal = btn("Record legal gate", async () => {
    if (!reviewer.value) { legalNote.textContent = "Name the reviewer."; return; }
    try {
      const r = await api("/api/reports/" + t.type + "/legal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reviewer: reviewer.value, reply_required: !!replyRequired.checked, notes: legalNotes.value }),
      });
      legalNote.textContent = "Recorded for pending version " + r.version + ".";
    } catch (e) { legalNote.textContent = "Failed: " + errorText(e); }
  });
  recordLegal.setAttribute("data-action", "report-legal");
  recordLegal.setAttribute("data-type", t.type);
  const legalBody = el("div", {});
  const loadLegal = btn("Read legal surface", async () => {
    try {
      const surface = await api("/api/reports/" + t.type + "/legal");
      legalBody.replaceChildren(
        table(["Version", "Reviewer", "Reply required", "Recorded"],
          surface.records.map((r) => [r.version, r.reviewer, r.reply_required ? "yes" : "no", r.created_at])),
        table(["Outcome", "Subject", "Attempted"],
          surface.replies.map((r) => [r.outcome, r.subject, r.attempted_at])));
    } catch (e) { legalNote.textContent = "Failed: " + errorText(e); }
  });
  details.append(panel(strong("Legal gate (right of reply)"),
    field("Reviewer", reviewer), el("label", {}, replyRequired, " right of reply required"),
    field("Notes", legalNotes), el("div", { class: "os9-row" }, recordLegal, loadLegal), legalNote, legalBody));

  const docId = input("Recording doc id (audio/video)");
  const recReviewer = input("Recording reviewer");
  const recNotes = input("Recording notes");
  const recNote = warn("");
  details.append(panel(strong("Recording gate"),
    field("Document", docId), field("Reviewer", recReviewer), field("Notes", recNotes),
    el("div", { class: "os9-row" }, btn("Record recording review", async () => {
      try {
        const r = await api("/api/reports/" + t.type + "/recording", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ doc_id: docId.value, reviewer: recReviewer.value, notes: recNotes.value }),
        });
        recNote.textContent = "Recorded for pending version " + r.version + ".";
      } catch (e) { recNote.textContent = "Failed: " + errorText(e); }
    })), recNote));

  const subject = input("Reply subject");
  subject.setAttribute("data-field", "reply-subject");
  subject.setAttribute("data-type", t.type);
  const channel = input("Channel");
  channel.setAttribute("data-field", "reply-channel");
  channel.setAttribute("data-type", t.type);
  const outcome = select(["awaiting", "responded", "declined", "no_response"], "awaiting");
  outcome.setAttribute("data-field", "reply-outcome");
  outcome.setAttribute("data-type", t.type);
  const response = input("Response");
  const replyNote = warn("");
  const recordReply = btn("Record attempt", async () => {
    try {
      const r = await api("/api/reports/" + t.type + "/reply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subject: subject.value, channel: channel.value, outcome: outcome.value, response: response.value }),
      });
      replyNote.textContent = "Recorded against pending version " + r.version + ".";
    } catch (e) { replyNote.textContent = "Failed: " + errorText(e); }
  });
  recordReply.setAttribute("data-action", "report-reply");
  recordReply.setAttribute("data-type", t.type);
  details.append(panel(strong("Right-of-reply attempt"),
    field("Subject", subject), field("Channel", channel), field("Outcome", outcome), field("Response", response),
    el("div", { class: "os9-row" }, recordReply), replyNote));

  const versionsBody = el("div", {});
  details.append(panel(strong("Version history"),
    el("div", { class: "os9-row" }, btn("Load versions", async () => {
      try {
        const v = await api("/api/reports/" + t.type + "/versions");
        versionsBody.replaceChildren(table(
          ["Version", "Created", "State"],
          v.versions.map((x) => [
            x.version,
            x.created_at,
            x.version === t.current_version ? "current"
              : x.version === t.pending_version ? "pending" : "",
          ]),
        ));
      } catch (e) { versionsBody.replaceChildren(warn("Failed: " + errorText(e))); }
    })), versionsBody));
  return details;
}
// ---------------------------------------------------------- compliance
async function paintCompliance(body) {
  heading(body, "Compliance", () => render());
  if (gated()) { body.append(gatePanel()); return; }
  await paintRetention(body);
  await paintBreach(body);
  await paintNotices(body);
  await paintResidency(body);
  await paintAudit(body);
}
async function paintRetention(body) {
  const l = loading(body, "retention");
  try {
    const view = await api("/api/retention");
    l.done();
    const inputs = {};
    const fields = view.categories.map((c) => {
      const i = input("hours", "number");
      i.value = String(view.windows_hours[c.id]);
      inputs[c.id] = i;
      return field(c.label + " (" + c.min_hours + "\\u2013" + c.max_hours + " hours) \\u2014 " + c.what, i);
    });
    const refusals = warn("");
    body.append(panel(strong("Retention windows"),
      ...fields,
      el("div", { class: "os9-row" }, btn("Save windows", async () => {
        const windows = {};
        for (const c of view.categories) windows[c.id] = Number(inputs[c.id].value);
        try {
          await api("/api/retention", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ windows }) });
          refusals.textContent = "Windows saved.";
        } catch (e) { refusals.textContent = "Refused: " + errorText(e); }
      })), refusals,
      warn("Retained: " + view.retained.map((r) => r.label + " (" + r.why + ")").join("; "))));
    const sweeps = await api("/api/retention/sweeps");
    body.append(panel(strong("Sweeps"),
      sweeps.overdue.length > 0
        ? warn("Overdue raw bytes: " + sweeps.overdue.map((o) => o.label + " \\u00d7 " + o.overdue).join(", "))
        : warn("Nothing overdue."),
      el("div", { class: "os9-row" }, btn("Sweep now", async () => {
        try { await api("/api/retention/sweep", { method: "POST" }); render(); }
        catch (e) { alert("Sweep failed: " + errorText(e)); }
      })),
      sweeps.sweeps.length === 0 ? warn("No sweep receipts yet.")
        : table(["Swept", "Deleted", "Verified", "Failed"],
            sweeps.sweeps.map((s) => [s.swept_at, s.totals.deleted, s.totals.verified, s.totals.failed]))));
  } catch (e) { l.fail(e); }
}
async function paintBreach(body) {
  const l = loading(body, "breach assessments");
  try {
    const data = await api("/api/breach");
    l.done();
    body.append(panel(strong("Breach assessments"),
      data.assessments.length === 0 ? warn("No assessments.")
        : table(["Decision", "Aware", "Deadline", "Days left", "Overdue"],
            data.assessments.map((a) => [a.decision, a.aware_at, a.deadline_at, a.days_remaining,
              a.overdue ? "yes (" + a.days_overdue + " days)" : "no"]))));
    const opName = input("Operator name");
    const opContact = input("Operator contact");
    const desc = el("textarea", { rows: 3, placeholder: "What happened" });
    const kinds = input("Kinds of information (comma-separated)");
    const affected = input("Individuals affected", "number");
    const harm = el("textarea", { rows: 3, placeholder: "Harm assessment" });
    const containment = el("textarea", { rows: 2, placeholder: "Containment steps" });
    const recommended = el("textarea", { rows: 2, placeholder: "Recommended steps" });
    const breachNote = warn("");
    body.append(panel(strong("Assess a breach"),
      field("Operator name", opName), field("Operator contact", opContact),
      field("Description", desc), field("Kinds of information", kinds),
      field("Individuals affected", affected), field("Harm assessment", harm),
      field("Containment steps", containment), field("Recommended steps", recommended),
      el("div", { class: "os9-row" }, btn("Record assessment", async () => {
        try {
          const r = await api("/api/breach", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              operator_name: opName.value, operator_contact: opContact.value,
              description: desc.value,
              kinds_of_information: kinds.value.split(",").map((k) => k.trim()).filter(Boolean),
              individuals_affected: Number(affected.value) || 0,
              harm_assessment: harm.value,
              containment_steps: containment.value,
              recommended_steps: recommended.value,
            }),
          });
          breachNote.textContent = "Recorded; " + r.days_remaining + " day(s) remaining before the OAIC deadline.";
          render();
        } catch (e) { breachNote.textContent = "Failed: " + errorText(e); }
      })), breachNote));
    const id = input("Assessment id");
    const outcome = select(["eligible", "not_eligible"], "eligible");
    const reasoning = el("textarea", { rows: 2, placeholder: "Reasoning" });
    const decisionNote = warn("");
    body.append(panel(strong("Record the notification decision"),
      field("Assessment id", id), field("Outcome", outcome), field("Reasoning", reasoning),
      el("div", { class: "os9-row" },
        btn("Record decision", async () => {
          try {
            await api("/api/breach/" + id.value + "/decision", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ outcome: outcome.value, reasoning: reasoning.value }) });
            decisionNote.textContent = "Decision recorded.";
          } catch (e) { decisionNote.textContent = "Failed: " + errorText(e); }
        }),
        btn("Export OAIC statement", async () => {
          try { await download("/api/breach/" + id.value + "/statement", "oaic-statement.md"); }
          catch (e) { decisionNote.textContent = "Export failed: " + errorText(e); }
        })), decisionNote));
  } catch (e) { l.fail(e); }
}
async function paintNotices(body) {
  const l = loading(body, "notices");
  try {
    const list = await api("/api/notices");
    l.done();
    body.append(panel(strong("Notices"),
      list.versions.length === 0 ? warn("No notices generated yet.")
        : table(["Type", "Version", "Created"],
            list.versions.map((v) => [v.type, v.version, v.created_at]))));
    const opName = input("Operator name");
    const opContact = input("Operator contact");
    const genNote = warn("");
    const type = select(["privacy", "collection"], "privacy");
    body.append(panel(strong("Generate notices"),
      field("Operator name", opName), field("Operator contact", opContact),
      el("div", { class: "os9-row" }, btn("Generate privacy and collection notices", async () => {
        try {
          const r = await api("/api/notices/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operator_name: opName.value, operator_contact: opContact.value }) });
          genNote.textContent = "Generated: " + r.notices.map((n) => n.type + " v" + n.version).join(", ") + ".";
          render();
        } catch (e) { genNote.textContent = "Failed: " + errorText(e); }
      })), genNote));
    const version = input("Version (default latest)", "number");
    body.append(panel(strong("Export a notice"),
      field("Type", type), field("Version", version),
      el("div", { class: "os9-row" }, btn("Export", async () => {
        const wanted = Number(version.value);
        const candidates = list.versions.filter((v) => v.type === type.value);
        const latest = candidates.length > 0
          ? candidates.reduce((a, b) => (b.version > a.version ? b : a)).version
          : null;
        const chosen = wanted > 0 ? wanted : latest;
        if (!chosen) { alert("No " + type.value + " notice exists yet."); return; }
        try { await download("/api/notices/" + type.value + "/versions/" + chosen + "/export", type.value + "-notice.md"); }
        catch (e) { alert("Export failed: " + errorText(e)); }
      }))));
  } catch (e) { l.fail(e); }
}
async function paintResidency(body) {
  const l = loading(body, "residency map");
  try {
    const map = await api("/api/residency");
    l.done();
    body.append(panel(strong("Residency map"),
      table(["Recipient", "Role", "Services", "Regions", "Offshore"],
        map.recipients.map((r) => [r.name, r.role, (r.services || []).join(", "), r.regions + " (" + r.region_source + ")", r.may_process_offshore ? "yes" : "no"])),
      table(["Data", "Where"], map.storage.map((s) => [s.data, s.where])),
      el("ul", {}, ...map.boundaries.map((b) => el("li", { text: b })))));
    const receipts = await api("/api/residency/receipts");
    const receiptNote = warn("");
    body.append(panel(strong("Residency receipts"),
      el("div", { class: "os9-row" }, btn("Record receipt", async () => {
        try { await api("/api/residency/receipts", { method: "POST" }); render(); }
        catch (e) { receiptNote.textContent = "Failed: " + errorText(e); }
      })),
      receipts.receipts.length === 0 ? warn("No receipts yet.")
        : table(["Recorded", "Export"],
            receipts.receipts.map((r) => [r.created_at,
              btn("Export", async () => {
                try { await download("/api/residency/receipts/" + r.id + "/export", "data-flow-receipt.md"); }
                catch (e) { alert("Export failed: " + errorText(e)); }
              })])), receiptNote));
  } catch (e) { l.fail(e); }
}
async function paintAudit(body) {
  const l = loading(body, "at-rest audit");
  try {
    const audit = await api("/api/audit/ciphertext");
    l.done();
    body.append(panel(strong("At-rest ciphertext audit"),
      table(["Result", "Sealed values", "Malformed", "Uncovered columns"],
        [[audit.ok ? "ok" : "FAIL", audit.total, audit.malformed, audit.missing.length]]),
      audit.missing.length > 0
        ? warn("Uncovered sealed columns: " + audit.missing.join(", "))
        : warn("Every sealed column is covered and the envelopes are intact.")));
  } catch (e) { l.fail(e); }
}
// ------------------------------------------------------------ case file
async function paintCase(body) {
  heading(body, "Case file", () => render());
  if (gated()) { body.append(gatePanel()); return; }
  const l = loading(body, "dossier");
  try {
    const d = await api("/api/dossier");
    l.done();
    body.append(panel(strong("Angles"),
      d.angles.length === 0 ? warn("No angles.")
        : table(["Title", "Status", "Flags"],
            d.angles.map((a) => [a.title, a.status, (a.flags || []).join(", ") || "\\u2014"]))));
    body.append(panel(strong("Lines and findings"),
      d.lines.length === 0 ? warn("No lines.")
        : el("div", {}, ...d.lines.map((x) =>
            el("div", { class: "os9-msg" },
              el("strong", { text: x.status + " \\u2014 spend " + x.spend_used + "/" + x.spend_cap }),
              el("div", { text: x.finding || "(no finding)" }),
              el("div", { class: "os9-muted", text: (x.citations || []).length + " citation(s)" }))))));
    body.append(panel(strong("Report versions"),
      d.versions.length === 0 ? warn("No versions published.")
        : table(["Type", "Version", "Created"],
            d.versions.map((v) => [v.type, v.version, v.created_at]))));
    body.append(panel(strong("Operator notes"),
      d.notes.length === 0 ? warn("No notes.")
        : el("div", {}, ...d.notes.map((n) => el("div", { class: "os9-msg", text: n.body })))));
    const note = el("textarea", { rows: 3, placeholder: "Add an operator note" });
    const noteMsg = warn("");
    body.append(panel(strong("Note editor"), note,
      el("div", { class: "os9-row" },
        btn("Add note", async () => {
          if (!note.value.trim()) { noteMsg.textContent = "Write something first."; return; }
          try { await api("/api/dossier/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ note: note.value }) }); render(); }
          catch (e) { noteMsg.textContent = "Failed: " + errorText(e); }
        }),
        btn("Export dossier (markdown)", async () => {
          try { await download("/api/dossier/export", "case-dossier.md"); }
          catch (e) { noteMsg.textContent = "Export failed: " + errorText(e); }
        })), noteMsg));
  } catch (e) { l.fail(e); }
}
// -------------------------------------------------------------- launch
async function paintLaunch(body) {
  heading(body, "Launch", () => render());
  if (gated()) { body.append(gatePanel()); return; }
  const packBody = el("div", {});
  const l = loading(body, "launch pack");
  try {
    const pack = await api("/api/launch-pack");
    l.done();
    const forbidden = input("Forbidden terms (comma-separated, optional)");
    packBody.replaceChildren(
      table(["Asset", "Value"],
        [["Survey URL", pack.submissions_url],
          ["Short copy", pack.copy_short],
          ["Long copy", pack.copy_long],
          ["DM copy", pack.copy_dm],
          ["Alt text", pack.alt_text]]),
      el("details", {}, el("summary", { text: "QR square (SVG source)" }), el("pre", { class: "os9-pre", text: pack.qr_square_svg })),
      el("details", {}, el("summary", { text: "QR story (SVG source)" }), el("pre", { class: "os9-pre", text: pack.qr_story_svg })));
    body.append(panel(strong("Launch pack"),
      field("Forbidden terms", forbidden),
      el("div", { class: "os9-row" },
        btn("Reload with terms", async () => {
          const terms = forbidden.value.split(",").map((t) => t.trim()).filter(Boolean);
          const query = terms.map((t) => "forbidden=" + encodeURIComponent(t)).join("&");
          try {
            const next = await api("/api/launch-pack" + (query ? "?" + query : ""));
            packBody.replaceChildren(el("pre", { class: "os9-pre", text: JSON.stringify(next, null, 2) }));
          } catch (e) { alert("Failed: " + errorText(e)); }
        }),
        btn("Rotate launch pack", async () => {
          if (!confirm("Rotate the launch pack? The current slug and QR codes stop working; existing packs must be reissued.")) return;
          try { await api("/api/launch-pack/rotate", { method: "POST" }); render(); }
          catch (e) { alert("Rotation failed: " + errorText(e)); }
        })), packBody));
  } catch (e) { l.fail(e); }

  const tl = loading(body, "telemetry");
  try {
    const rows = await api("/api/telemetry");
    tl.done();
    body.append(panel(strong("Telemetry"),
      rows.length === 0 ? warn("No turns recorded.")
        : table(["When", "Tier", "Tool calls", "Label", "Outcome"],
            rows.map((r) => [r.ts, r.tier, r.toolCalls, r.label || "\\u2014", r.outcome || "\\u2014"]))));
  } catch (e) { tl.fail(e); }

  const schedNote = warn("");
  body.append(panel(strong("Scheduler"),
    warn("Evaluate the stored frequencies now \\u2014 a missed cron is recoverable here."),
    el("div", { class: "os9-row" }, btn("Evaluate now", async () => {
      try {
        const r = await api("/api/scheduler/evaluate", { method: "POST" });
        schedNote.textContent = r.receipts.length === 0 ? "Nothing due."
          : r.receipts.map((x) => x.type + ": " + x.action + " (" + x.reason + ")").join("; ");
      } catch (e) { schedNote.textContent = "Failed: " + errorText(e); }
    })), schedNote));

  const account = input("Cloudflare account id");
  const script = input("Worker script name");
  const cf = input("Cloudflare API token", "password");
  const name = input("Installation name (default surveyor)");
  const provNote = warn("");
  body.append(panel(strong("Provision / re-provision"),
    warn("Runs the runtime provisioner and shows the receipt (slot names and set/not-set only). An existing secret is never rewritten."),
    field("Account id", account), field("Script name", script), field("Cloudflare token", cf),
    field("Name", name),
    el("div", { class: "os9-row" }, btn("Provision", async () => {
      provNote.textContent = "Provisioning\\u2026";
      try {
        const r = await api("/api/provision", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cf_token: CF_TOKEN || cf.value, account_id: account.value, script_name: script.value, name: name.value || "surveyor" }),
        });
        provNote.textContent = "Provisioned. Secrets: " + r.receipt.secrets.map((s) => s.slot + (s.set ? "=set" : "=not-set")).join(", ");
      } catch (e) { provNote.textContent = "Failed: " + errorText(e); }
    })), provNote));

  const oldSecret = input("Old SERVER_SECRET", "password");
  const oldKey = input("Old ENCRYPTION_KEY", "password");
  const resealNote = warn("");
  body.append(panel(strong("Re-seal after key rotation"),
    warn("Deliberate rotation act: rows sealed under the old key pair are opened and rewritten with the current kit. Wrong old keys fail per row; nothing is written unverified."),
    field("Old server secret", oldSecret), field("Old encryption key", oldKey),
    el("div", { class: "os9-row" }, btn("Re-seal", async () => {
      if (!confirm("Re-seal every sealed row with the current key pair? This is a deliberate rotation act.")) return;
      try {
        const r = await api("/api/audit/reseal", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ old_server_secret: oldSecret.value, old_encryption_key: oldKey.value }),
        });
        resealNote.textContent = "Re-sealed " + Object.keys(r.resealed).length + " column(s); skipped " + r.skipped + "; failed " + r.failed + ".";
      } catch (e) { resealNote.textContent = "Failed: " + errorText(e); }
    })), resealNote));

  const tdNote = warn("");
  body.append(panel(strong("Teardown"),
    warn("Uninstall. The receipt reports exactly what was wiped and what was not; audit history is retained by design."),
    el("div", { class: "os9-row" }, btn("Uninstall the installation", async () => {
      if (!confirm("Tear down the entire installation? This cannot be undone.")) return;
      try {
        const r = await api("/api/teardown", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cf_token: CF_TOKEN || cf.value, account_id: account.value, script_name: script.value }),
        });
        tdNote.textContent = "Wiped: " + JSON.stringify(r.wiped) + ". Not wiped: " + r.not_wiped.join(", ");
      } catch (e) { tdNote.textContent = "Failed: " + errorText(e); }
    })), tdNote));
}
// -------------------------------------------------------------- render
const PAINTERS = {
  home: paintHome,
  providers: paintProviders,
  corpus: paintCorpus,
  submissions: paintSubmissions,
  engine: paintEngine,
  reports: paintReports,
  compliance: paintCompliance,
  case: paintCase,
  launch: paintLaunch,
};
function render() {
  const section = currentSection();
  const body = el("div", {});
  app.replaceChildren(
    el("div", { class: "os9-titlebar" },
      el("span", { class: "os9-lamp " + (STATUS && STATUS.degraded ? "off" : "on") }),
      "Surveyor Console"),
    el("div", { class: "os9-body" },
      statusStrip(), tokenPanel(), nav(), body));
  Promise.resolve()
    .then(() => PAINTERS[section](body))
    .catch((e) => { body.append(warn("Section failed: " + errorText(e))); });
}
async function boot() {
  try { STATUS = await api("/api/status"); } catch (e) { STATUS = null; }
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("hashchange", render);
  }
  render();
  // A light status poll: state changes (provisioning, degradation) appear
  // without reloading the whole console. Section data refreshes explicitly.
  if (typeof setInterval === "function") {
    setInterval(() => {
      api("/api/status").then((s) => {
        STATUS = s;
        const node = statusNode;
        if (node) {
          const fresh = statusStrip();
          node.replaceChildren(...fresh.children);
        }
      }).catch(() => {});
    }, 30000);
  }
}
boot();
`;
