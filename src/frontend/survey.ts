// Source-facing survey shell: neutral, high-contrast, zero dependencies.
// Consent copy comes from the installation instrument (HTML-escaped server
// side); all dynamic rendering is textContent-only (constitution III).
// The driver walks consent → create/resume → rounds → done over /api/intake.

export const SURVEY_CSS = `
:root { color-scheme: light dark; --bg: #fafafa; --ink: #161616; --muted: #555; --accent: #1a56db; --line: #d8d8d8; }
body { background: var(--bg); color: var(--ink); font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; line-height: 1.5; }
.svy { max-width: 620px; margin: 0 auto; padding: 32px 20px 64px; }
.svy h1 { font-size: 22px; margin: 0 0 8px; }
.svy .consent { border: 1px solid var(--line); padding: 14px 16px; margin: 16px 0; background: #fff; }
.svy textarea { width: 100%; min-height: 110px; font: inherit; padding: 8px; margin: 6px 0 12px; }
.svy input[type=text] { width: 100%; font: inherit; padding: 8px; margin: 6px 0 12px; }
.svy button { font: inherit; font-weight: 700; padding: 8px 20px; background: var(--accent); color: #fff; border: 0; cursor: pointer; }
.svy button:disabled { opacity: .55; cursor: default; }
.svy .code { font-family: monospace; font-size: 22px; letter-spacing: 2px; }
.svy .warn { color: var(--muted); font-size: 13px; }
.svy .q { margin: 14px 0; }
.svy .thread { margin: 14px 0; }
.svy .msg { border-left: 3px solid var(--line); margin: 8px 0; padding: 4px 10px; white-space: pre-wrap; }
@media (prefers-color-scheme: dark) { :root { --bg: #141414; --ink: #efefef; --muted: #aaa; --line: #333; } .svy .consent { background: #1c1c1c; } }
`;

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function surveyShell(
  title: string,
  blurb: string,
  consent: string,
  sensitive: string,
): string {
  // No inline script: consent/blurb travel as data attributes (escaped)
  // so the page honours script-src 'self'. JSON inside <script> would
  // allow </script> breakout — data attributes cannot execute.
  return `<!DOCTYPE html>
<html lang="en-AU"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${SURVEY_CSS}</style></head>
<body><main class="svy" id="app" data-title="${esc(title)}" data-blurb="${esc(blurb)}" data-consent="${esc(consent)}" data-sensitive="${esc(sensitive)}"></main>
<script src="/survey.js"></script></body></html>`;
}

export const SURVEY_JS = `
// Survey driver: consent -> create/resume -> rounds loop -> done.
// textContent-only rendering. PoW is solved in-page (yields to the loop).
const app = document.getElementById("app");
async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let detail = String(res.status);
    try {
      const data = await res.json();
      if (data && typeof data.error === "string") detail = data.error;
    } catch {
      // Non-JSON error body: keep the status, never throw a second error.
    }
    throw new Error(detail);
  }
  return res.json();
}
function el(tag, attrs, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "onclick") n.onclick = v;
    else if (k === "text") n.textContent = v;
    else n.setAttribute(k, v);
  }
  for (const c of children) n.append(c);
  return n;
}
async function sha256hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function lzBits(hex) {
  const bytes = hex.match(/../g).map((h) => parseInt(h, 16));
  let bits = 0;
  for (const b of bytes) {
    if (b === 0) { bits += 8; continue; }
    let m = 0x80;
    while (m && !(b & m)) { bits++; m >>= 1; }
    break;
  }
  return bits;
}
async function solvePow(challenge, difficulty, onTick) {
  let nonce = 0;
  for (;;) {
    const h = await sha256hex(challenge + ":" + nonce);
    if (lzBits(h) >= difficulty) return String(nonce);
    nonce++;
    if (nonce % 500 === 0) { onTick(nonce); await new Promise((r) => setTimeout(r, 0)); }
  }
}
const S = { id: null, code: null, fresh: false, sitekey: null, tsPromise: null, sensitive: { version: 1, categories: [] }, refusedNote: null };
// The sensitive-category decisions in force for this page: one entry per
// category in the panel, ticked or not. Sent with the create call.
function consentDecisions() {
  const out = [];
  for (const cat of S.sensitive.categories) {
    const box = document.getElementById("c-" + cat.key);
    out.push({ category: cat.key, granted: !!(box && box.checked) });
  }
  return out;
}
function refusedNoteNode() {
  return S.refusedNote ? el("p", { class: "warn", text: S.refusedNote }) : null;
}
// Invisible human-check: only wired when the installation exposes a
// sitekey. The widget script is the sole third-party origin (constitution
// VI) and the token is sent to our own /api/intake routes.
function loadTurnstile() {
  if (window.turnstile) return Promise.resolve();
  if (S.tsPromise) return S.tsPromise;
  S.tsPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("human-check failed to load"));
    document.head.append(s);
  });
  return S.tsPromise;
}
async function turnstileToken() {
  if (!S.sitekey) return undefined;
  await loadTurnstile();
  return await new Promise((resolve, reject) => {
    const holder = document.createElement("div");
    holder.style.display = "none";
    document.body.append(holder);
    let widgetId;
    try {
      widgetId = window.turnstile.render(holder, {
        sitekey: S.sitekey,
        size: "invisible",
        callback: (token) => {
          try { window.turnstile.remove(widgetId); } catch (e) {}
          holder.remove();
          resolve(token);
        },
        "error-callback": () => reject(new Error("human-check failed")),
      });
      window.turnstile.execute(widgetId);
    } catch (e) {
      reject(e);
    }
  });
}
async function newSubmission(status) {
  const ch = await api("/api/intake/challenge");
  status.textContent = "Proving you are human (one-time puzzle)…";
  const nonce = await solvePow(ch.challenge, ch.difficulty, (n) => {
    status.textContent = "Proving you are human… (" + n + " tries)";
  });
  const turnstile = await turnstileToken();
  const created = await api("/api/intake", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      pow: { challenge: ch.challenge, nonce },
      turnstile_token: turnstile,
      consent: consentDecisions(),
    }),
  });
  S.id = created.id;
  S.code = created.access_code;
  S.fresh = true;
  return created;
}
async function resumeFlow(code, status) {
  const r = await api("/api/intake/resume", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ access_code: code }),
  });
  S.id = r.id;
  S.code = code;
}
// Reply thread (C11): read the conversation and send follow-ups through the
// same access code — nothing new is stored on the device.
async function threadMessages() {
  const r = await api("/api/intake/" + S.id + "/thread", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ access_code: S.code }),
  });
  return r.messages || [];
}
async function threadScreen() {
  const msgs = await threadMessages();
  const box = el("div", { class: "thread" });
  for (const m of msgs) {
    box.append(el("p", { class: "msg", text: (m.role === "operator" ? "Investigator" : "You") + ": " + m.body }));
  }
  const input = el("textarea", { placeholder: "Write a follow-up" });
  const send = el("button", { text: "Send follow-up" });
  const next = el("button", { text: "Continue" });
  const note = el("p", { class: "warn", text: "" });
  app.replaceChildren(el("h1", { text: "Your conversation" }), box, input, send, next, note);
  await new Promise((resolve) => {
    next.onclick = resolve;
    send.onclick = async () => {
      const value = input.value.trim();
      if (!value) { note.textContent = "Write something first."; return; }
      send.disabled = true;
      try {
        await api("/api/intake/" + S.id + "/followup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ access_code: S.code, value }),
        });
        input.value = "";
        note.textContent = "Sent. The investigator will see it when they next open your file.";
      } catch (e) {
        note.textContent = "Could not send: " + e.message;
      }
      send.disabled = false;
    };
  });
}
async function roundLoop() {
  for (;;) {
    const r = await api("/api/intake/" + S.id + "/rounds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ access_code: S.code }),
    });
    if (r.done || r.questions.length === 0) return showDone();
    const answers = [];
    const box = el("div", {});
    for (const q of r.questions) {
      const item = el("div", { class: "q" }, el("label", { text: q.question }), el("textarea", { id: "a-" + q.topic }));
      if (S.sensitive.categories.length > 0) {
        const details = el("details", {}, el("summary", { text: "Sensitive information in this answer" }));
        for (const cat of S.sensitive.categories) {
          details.append(el("label", { class: "warn" },
            el("input", { type: "checkbox", id: "s-" + q.topic + "-" + cat.key }),
            " " + cat.label + ": " + cat.prompt));
        }
        item.append(details);
      }
      box.append(item);
    }
    const btn = el("button", { text: "Continue" });
    const warn = refusedNoteNode();
    app.replaceChildren(...(warn ? [warn] : []), box, btn);
    await new Promise((resolve) => { btn.onclick = resolve; });
    for (const q of r.questions) {
      const ta = document.getElementById("a-" + q.topic);
      const cats = [];
      for (const cat of S.sensitive.categories) {
        const cb = document.getElementById("s-" + q.topic + "-" + cat.key);
        if (cb && cb.checked) cats.push(cat.key);
      }
      answers.push({ q: q.topic, value: ta.value, topic: q.topic, sensitive_categories: cats });
    }
    const saved = await api("/api/intake/" + S.id + "/steps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers, access_code: S.code }),
    });
    if (saved && saved.refused && saved.refused.length > 0) {
      S.refusedNote = "Not saved — consent was not given for: " + saved.refused.map((x) => x.topic).join(", ") + ". You can answer again without that information, or begin a new submission.";
    } else {
      S.refusedNote = null;
    }
  }
}
// PDF tools are loaded lazily, only when a source attaches a PDF, so the
// 1 MB reader never slows the initial page.
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
async function sendAttachment(id, name, type, blob) {
  // Identifiers travel in headers, never the query string, so edge request
  // logs cannot see the access code or filename (A11).
  const res = await fetch("/api/intake/" + id + "/attachments", {
    method: "POST",
    headers: {
      "x-access-code": S.code,
      "x-filename": encodeURIComponent(name),
      "content-type": type || "application/octet-stream",
    },
    body: blob,
  });
  if (!res.ok) throw new Error(String(res.status));
}
async function attachFile(f, note) {
  const isPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name);
  if (isPdf) {
    note.textContent = "Reading the PDF in your browser…";
    await loadPdfTools();
    const text = await window.SurveyorPdf.extractText(f);
    if (text && text.length > 40) {
      await sendAttachment(
        S.id,
        f.name.replace(/\.pdf$/i, "") + ".txt",
        "text/plain",
        new Blob([text], { type: "text/plain" }),
      );
      return;
    }
    note.textContent = "Scanned PDF: preparing pages in your browser…";
    const pages = await window.SurveyorPdf.rasterise(f);
    for (let i = 0; i < pages.length; i++) {
      await sendAttachment(
        S.id,
        f.name.replace(/\.pdf$/i, "") + "-page-" + (i + 1) + ".png",
        "image/png",
        pages[i],
      );
    }
    return;
  }
  note.textContent = "Uploading " + f.name + "…";
  await sendAttachment(S.id, f.name, f.type || "application/octet-stream", f);
}
function showDone() {
  const body = [el("h1", { text: "Thank you — your testimony is recorded." })];
  const refused = refusedNoteNode();
  if (refused) body.push(refused);
  if (S.fresh && S.code) {
    body.push(el("p", { text: "Your access code (shown once — write it down):" }));
    body.push(el("p", { class: "code", text: S.code }));
  }
  body.push(el("p", { class: "warn", text: "Your access code stays in this page's memory while it is open — nothing is saved to the device. Close the page and clear site data to remove all trace." }));
  if (S.id) {
    const file = el("input", { type: "file" });
    const up = el("button", { text: "Attach a file" });
    const note = el("p", { class: "warn", text: "PDF, image, or office file. It is uploaded, processed to text, and deleted; identifying details are stripped." });
    up.onclick = async () => {
      if (!file.files || !file.files[0]) { note.textContent = "Choose a file first."; return; }
      const f = file.files[0];
      try {
        await attachFile(f, note);
        note.textContent = "Attached. The file is processed to text and then deleted.";
        file.value = "";
      } catch (e) {
        note.textContent = "Could not attach: " + e.message;
      }
    };
    body.push(el("p", { text: "You can also add a document:" }), file, up, note);
  }
  const more = el("button", { text: "Add more testimony" });
  more.onclick = async () => {
    try {
      const ch = await api("/api/intake/challenge");
      const nonce = await solvePow(ch.challenge, ch.difficulty, () => {});
      const turnstile = await turnstileToken();
      const child = await api("/api/intake/" + S.id + "/addendum", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pow: { challenge: ch.challenge, nonce },
          access_code: S.code,
          turnstile_token: turnstile,
        }),
      });
      S.id = child.id;
      S.fresh = false;
      await roundLoop();
    } catch (e) {
      app.append(el("p", { class: "warn", text: "Could not open a follow-up: " + e.message }));
    }
  };
  body.push(more);
  app.replaceChildren(...body);
}
async function start() {
  const root = document.getElementById("app");
  const title = root.dataset.title || "Survey";
  const blurb = root.dataset.blurb || "";
  const consentCopy = root.dataset.consent || "";
  try {
    const parsed = JSON.parse(root.dataset.sensitive || "");
    if (parsed && Array.isArray(parsed.categories)) S.sensitive = parsed;
  } catch (e) {
    S.sensitive = { version: 1, categories: [] };
  }
  const statusInfo = await api("/api/status").catch(() => null);
  if (statusInfo && statusInfo.turnstile_sitekey) {
    S.sitekey = statusInfo.turnstile_sitekey;
  }
  const consent = el("div", { class: "consent" }, el("p", { text: consentCopy }));
  if (S.sensitive.categories.length > 0) {
    consent.append(el("p", { class: "warn", text: "Sensitive information — consent wording version " + S.sensitive.version + ". Tick the kinds you agree to provide. Anything unticked is not collected: an answer telling us about it will not be saved." }));
    for (const cat of S.sensitive.categories) {
      consent.append(el("label", { class: "q" },
        el("input", { type: "checkbox", id: "c-" + cat.key }),
        " " + cat.label + ": I consent to my testimony including " + cat.prompt + "."));
    }
  }
  const status = el("p", { class: "warn", text: "" });
  const code = el("input", { type: "text", placeholder: "Access code (to resume)" });
  const goNew = el("button", { text: "Begin anonymously" });
  const goResume = el("button", { text: "Resume with code" });
  app.replaceChildren(el("h1", { text: title }), el("p", { text: blurb }), consent, status, goNew, code, goResume);
  goNew.onclick = async () => {
    goNew.disabled = true; goResume.disabled = true;
    try { await newSubmission(status); await roundLoop(); }
    catch (e) { status.textContent = "Something went wrong: " + e.message; goNew.disabled = false; goResume.disabled = false; }
  };
  goResume.onclick = async () => {
    try { await resumeFlow(code.value.trim(), status); await threadScreen(); await roundLoop(); }
    catch (e) { status.textContent = "Resume failed — check the code."; }
  };
}
start();
`;
