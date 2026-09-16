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
): string {
  // No inline script: consent/blurb travel as data attributes (escaped)
  // so the page honours script-src 'self'. JSON inside <script> would
  // allow </script> breakout — data attributes cannot execute.
  return `<!DOCTYPE html>
<html lang="en-AU"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${SURVEY_CSS}</style></head>
<body><main class="svy" id="app" data-title="${esc(title)}" data-blurb="${esc(blurb)}" data-consent="${esc(consent)}"></main>
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
const S = { id: null, code: null, fresh: false, sitekey: null, tsPromise: null };
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
    body: JSON.stringify({ pow: { challenge: ch.challenge, nonce }, turnstile_token: turnstile }),
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
async function roundLoop() {
  for (;;) {
    const r = await api("/api/intake/" + S.id + "/rounds", { method: "POST" });
    if (r.done || r.questions.length === 0) return showDone();
    const answers = [];
    const box = el("div", {});
    for (const q of r.questions) {
      box.append(el("div", { class: "q" }, el("label", { text: q.question }), el("textarea", { id: "a-" + q.topic })));
    }
    const btn = el("button", { text: "Continue" });
    app.replaceChildren(box, btn);
    await new Promise((resolve) => { btn.onclick = resolve; });
    for (const q of r.questions) {
      const ta = document.getElementById("a-" + q.topic);
      answers.push({ q: q.topic, value: ta.value, topic: q.topic });
    }
    await api("/api/intake/" + S.id + "/steps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers }),
    });
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
  const res = await fetch(
    "/api/intake/" + id + "/attachments?filename=" + encodeURIComponent(name) +
      "&media_type=" + encodeURIComponent(type),
    { method: "POST", body: blob },
  );
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
  const statusInfo = await api("/api/status").catch(() => null);
  if (statusInfo && statusInfo.turnstile_sitekey) {
    S.sitekey = statusInfo.turnstile_sitekey;
  }
  const consent = el("div", { class: "consent", text: consentCopy });
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
    try { await resumeFlow(code.value.trim(), status); await roundLoop(); }
    catch (e) { status.textContent = "Resume failed — check the code."; }
  };
}
start();
`;
