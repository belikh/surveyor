// Operator corpus uploader shell. Runs the self-hosted PDF.js tools in the
// operator's browser: digital-text PDFs are extracted to text; scanned PDFs
// are rasterised page-at-a-time to PNGs; everything else uploads as-is.
// The file never needs a server-side rasteriser, and image pages then drain
// through the vision lane. Operator-token-gated client-side (the API is
// operator-gated server-side).

export const UPLOADER_CSS = `
:root { color-scheme: light dark; --bg:#f4f4f4; --ink:#1a1a1a; --muted:#555; --accent:#3366cc; --line:#c9c9c9; }
body { background:var(--bg); color:var(--ink); font-family:system-ui,sans-serif; margin:0; line-height:1.5; }
.up { max-width:720px; margin:0 auto; padding:32px 20px 64px; }
.up h1 { font-size:20px; margin:0 0 6px; }
.up .panel { border:1px solid var(--line); background:#fff; padding:14px 16px; margin:12px 0; }
.up input[type=text], .up input[type=password] { width:100%; font:inherit; padding:8px; margin:6px 0 10px; }
.up button { font:inherit; font-weight:700; padding:8px 18px; background:var(--accent); color:#fff; border:0; cursor:pointer; }
.up button:disabled { opacity:.55; cursor:default; }
.up .warn { color:var(--muted); font-size:13px; white-space:pre-wrap; }
.up ul { margin:8px 0; padding-left:18px; font-size:13px; }
@media (prefers-color-scheme: dark) { :root { --bg:#141414; --ink:#efefef; --muted:#aaa; --line:#333; } .up .panel { background:#1c1c1c; } }
`;

export function uploaderShell(): string {
  return `<!DOCTYPE html>
<html lang="en-AU"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Corpus upload</title><style>${UPLOADER_CSS}</style></head>
<body><main class="up" id="app"></main>
<script src="/pdf-tools.js"></script>
<script src="/corpus.js"></script></body></html>`;
}

export const UPLOADER_JS = `
// Operator corpus uploader: token -> pick files -> extract/rasterise -> upload.
const app = document.getElementById("app");
let TOKEN = "";
async function api(path, opts) {
  const o = opts || {};
  o.headers = Object.assign({}, o.headers || {});
  if (TOKEN) o.headers["authorization"] = "Bearer " + TOKEN;
  const res = await fetch(path, o);
  if (!res.ok) throw new Error(String(res.status));
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
// The file itself is the request body: it streams to the Worker and on to
// R2, never a base64 JSON field (A15). The filename rides in a header (A11).
async function uploadOne(filename, mediaType, blob) {
  await api(
    "/api/corpus",
    {
      method: "POST",
      headers: { "content-type": mediaType, "x-filename": encodeURIComponent(filename) },
      body: blob,
    },
  );
}
async function handleFile(file, note) {
  const isPdf = file.type === "application/pdf" || /\\.pdf$/i.test(file.name);
  if (isPdf) {
    note.textContent = "Reading PDF\\u2026";
    const text = await window.SurveyorPdf.extractText(file);
    if (text && text.length > 40) {
      note.textContent = "Digital PDF: uploading extracted text\\u2026";
      await uploadOne(
        file.name.replace(/\\.pdf$/i, "") + ".txt",
        "text/plain",
        new Blob([text], { type: "text/plain" }),
      );
      return;
    }
    note.textContent = "Scanned PDF: rasterising pages in your browser\\u2026";
    const pages = await window.SurveyorPdf.rasterise(file);
    for (let i = 0; i < pages.length; i++) {
      note.textContent = "Uploading page " + (i + 1) + " of " + pages.length + "\\u2026";
      await uploadOne(file.name.replace(/\\.pdf$/i, "") + "-page-" + (i + 1) + ".png", "image/png", pages[i]);
    }
    return;
  }
  note.textContent = "Uploading " + file.name + "\\u2026";
  await uploadOne(file.name, file.type || "application/octet-stream", file);
}
async function render() {
  const tokenInput = el("input", { type: "password", placeholder: "Operator token" });
  const setToken = el("button", {}, "Set token");
  setToken.onclick = () => { TOKEN = tokenInput.value.trim(); render(); };
  const tokenNote = el("p", { class: "warn" }, TOKEN ? "Token set (memory only)." : "Token not set.");
  const picker = el("input", { type: "file", multiple: "true" });
  const go = el("button", {}, "Upload files");
  const note = el("p", { class: "warn" }, "");
  const docs = el("ul", {});
  go.onclick = async () => {
    go.disabled = true;
    try {
      for (const file of picker.files || []) {
        try { await handleFile(file, note); }
        catch (e) { note.textContent = "Failed on " + file.name + ": " + e.message; }
      }
      note.textContent += "\\nTriggering the drain\\u2026";
      const r = await api("/api/corpus/drain", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      note.textContent = "Drained " + r.drained + " of " + r.outcomes.length + ".";
      await list();
    } catch (e) {
      note.textContent = "Error: " + e.message;
    }
    go.disabled = false;
  };
  async function list() {
    try {
      const data = await api("/api/corpus");
      docs.replaceChildren();
      for (const d of data.docs) {
        docs.append(el("li", { text: d.status + " \\u2014 " + d.filename + (d.reason ? " (" + d.reason + ")" : "") }));
      }
    } catch (e) {
      docs.replaceChildren(el("li", { text: "Could not list: " + e.message }));
    }
  }
  app.replaceChildren(
    el("h1", {}, "Corpus upload"),
    el("p", { class: "warn" }, "Digital PDFs are read in your browser; scanned PDFs are rasterised here and OCR'd server-side. Nothing is uploaded that is not needed."),
    el("div", { class: "panel" }, tokenInput, setToken, tokenNote),
    el("div", { class: "panel" }, picker, go, note),
    el("div", { class: "panel" }, el("strong", {}, "Documents"), docs),
  );
  if (TOKEN) await list();
}
render();
`;
