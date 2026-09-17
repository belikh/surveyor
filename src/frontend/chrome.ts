// Platinum Mac OS 9 chrome for the first-run wizard, the operator console
// and the desktop shell. Zero dependencies, textContent-only rendering
// (constitution III), served as static strings. The aesthetic follows the
// real Platinum controls: 1px black outlines with an inner highlight,
// pinstriped title bars, folder tabs, etched group boxes, monochrome
// widgets, and the public-domain ChicagoFLF face for titles and menus
// (assets/fonts/README.md).

export const MAC9_CSS = `
@font-face {
  font-family: 'ChicagoFLF';
  src: url('/fonts/ChicagoFLF.ttf') format('truetype');
  font-display: swap;
}
:root {
  --platinum: #dddddd; --platinum-hi: #f6f6f6; --platinum-lo: #888888;
  --ink: #000000; --paper: #ffffff; --accent: #737373;
  --finder-blue: #3366cc; --danger: #b34700;
  --lamp-green: #58be00; --lamp-red: #ff5f45;
  --desktop: #5c7796;
  --ui-font: Geneva, 'Helvetica Neue', Helvetica, Arial, 'Liberation Sans', sans-serif;
  --title-font: 'ChicagoFLF', Geneva, 'Helvetica Neue', Helvetica, Arial, sans-serif;
  font-family: var(--ui-font); font-size: 12px; color: var(--ink);
}
* { box-sizing: border-box; }
body { background: var(--desktop); margin: 0; }
body.mac9 {
  min-height: 100vh;
  background-color: var(--desktop);
  /* The OS 9 default desktop: a fine diagonal weave. */
  background-image:
    repeating-linear-gradient(45deg, rgba(255,255,255,.07) 0 1px, transparent 1px 3px),
    repeating-linear-gradient(-45deg, rgba(0,0,0,.09) 0 1px, transparent 1px 3px);
}

/* ------------------------------------------------------------- menubar */
.mac-menubar {
  position: sticky; top: 0; z-index: 5000;
  display: flex; align-items: center; height: 22px;
  background: var(--paper); border-bottom: 1px solid var(--ink);
  font-family: var(--title-font); font-size: 13px; padding: 0 4px;
  user-select: none;
}
.mac-menu-wrap { position: relative; }
.mac-menu-title { display: inline-block; padding: 2px 9px; cursor: default; }
.mac-menu-title:hover, .mac-menu-title[aria-expanded="true"] { background: var(--ink); color: var(--paper); }
.mac-menu {
  position: absolute; top: 22px; left: 0; min-width: 190px;
  background: var(--paper); border: 1px solid var(--ink);
  box-shadow: 2px 2px 0 rgba(0,0,0,.5); padding: 2px 0; z-index: 5001;
  font-family: var(--ui-font); font-size: 12px;
}
.mac-menu-item { padding: 3px 18px; cursor: default; white-space: nowrap; }
.mac-menu-item:hover, .mac-menu-item[data-active="true"] { background: var(--ink); color: var(--paper); }
.mac-menu-item[aria-disabled="true"] { color: #9a9a9a; }
.mac-menu-item[aria-disabled="true"]:hover { background: transparent; color: #9a9a9a; }
.mac-menu-sep { height: 1px; background: #9a9a9a; margin: 3px 1px; }
.mac-menubar .mac-spacer { flex: 1; }
.mac-menubar .mac-clock { font-family: var(--ui-font); font-size: 12px; font-weight: 700; padding-right: 6px; }
.mac-menubar .mac-lamp-slot { display: inline-flex; align-items: center; padding: 0 8px; cursor: default; }
.mac-lamp { width: 10px; height: 10px; border-radius: 50%; border: 1px solid var(--ink); display: inline-block; }
.mac-lamp.on { background: var(--lamp-green); } .mac-lamp.off { background: var(--lamp-red); }
.mac-lamp.idle { background: var(--platinum-lo); }

/* ------------------------------------------------------------ desktop */
.mac-desktop { position: relative; min-height: calc(100vh - 22px); }

/* ------------------------------------------------------------ windows */
.mac-window {
  position: absolute; display: flex; flex-direction: column;
  background: var(--platinum); border: 1px solid var(--ink);
  box-shadow: 2px 2px 0 rgba(0,0,0,.55); padding: 0;
}
.mac-window.inactive { box-shadow: 2px 2px 0 rgba(0,0,0,.35); }
.mac-titlebar {
  position: relative; flex: none; height: 20px; display: flex;
  align-items: center; justify-content: center;
  background: repeating-linear-gradient(180deg, #fbfbfb 0 1px, #d2d2d2 1px 2px, #bcbcbc 2px 3px);
  border-bottom: 1px solid var(--platinum-lo);
  font-family: var(--title-font); font-size: 12px; user-select: none;
  cursor: default;
}
.mac-window.inactive .mac-titlebar { background: repeating-linear-gradient(180deg, #fbfbfb 0 1px, #e4e4e4 1px 2px, #d5d5d5 2px 3px); }
.mac-title { background: #e9e9e9; padding: 0 8px; position: relative; z-index: 1; }
.mac-box {
  position: absolute; top: 3px; width: 13px; height: 13px; padding: 0;
  border: 1px solid var(--ink); border-radius: 2px;
  background: linear-gradient(#ffffff, #cfcfcf);
  box-shadow: inset 1px 1px 0 #fff, inset -1px -1px 0 #9a9a9a;
  cursor: default;
}
.mac-box:active { background: linear-gradient(#bdbdbd, #d9d9d9); box-shadow: inset 1px 1px 0 #808080; }
.mac-box.close { left: 5px; }
.mac-box.zoom { right: 5px; }
.mac-box.zoom::after { content: ""; position: absolute; inset: 2px; border: 1px solid var(--ink); }
.mac-box.close::after { content: ""; position: absolute; inset: 1px; border-top: 1px solid #b5b5b5; }
.mac-window-content {
  flex: 1; overflow: auto; background: var(--paper);
  border-top: 1px solid #b5b5b5; padding: 14px 16px 20px;
}
.mac-window-content > :first-child { margin-top: 0; }

/* Wizard window: one centred window, no desktop. */
.wizard-body { display: grid; place-items: center; min-height: 100vh; }
.wizard-body .mac-window { position: static; width: 560px; max-width: 94vw; }
.wizard-body .mac-window-content { max-height: none; }

/* ------------------------------------------------------------ controls */
.os9-btn {
  font-family: var(--ui-font); font-size: 12px; line-height: 1.1;
  padding: 4px 14px; margin: 1px 3px 1px 0;
  border: 1px solid var(--ink); border-radius: 4px;
  background: linear-gradient(#ffffff, #d9d9d9);
  box-shadow: 1px 1px 0 rgba(0,0,0,.45), inset 0 1px 0 #fff;
  cursor: default; color: var(--ink);
}
.os9-btn:hover { background: linear-gradient(#ffffff, #e4e4e4); }
.os9-btn:active { background: linear-gradient(#c9c9c9, #bdbdbd); box-shadow: inset 1px 1px 0 rgba(0,0,0,.25); }
.os9-btn:disabled { color: #9a9a9a; box-shadow: 1px 1px 0 rgba(0,0,0,.2); }
.os9-btn:focus-visible, .mac-box:focus-visible, .mac-menu-item:focus-visible, .mac-menu-title:focus-visible {
  outline: 2px solid var(--ink); outline-offset: 1px;
}
input[type=text], input[type=password], input[type=number], input[type=file], textarea, select {
  min-width: 180px;
  font-family: var(--ui-font); font-size: 12px; color: var(--ink);
  background: var(--paper); border: 1px solid var(--ink); border-radius: 3px;
  box-shadow: inset 1px 1px 0 #9a9a9a; padding: 2px 5px;
}
textarea { padding: 4px 5px; }
input:focus-visible, textarea:focus-visible, select:focus-visible { outline: 2px solid #555; outline-offset: 0; }
select {
  appearance: none; -webkit-appearance: none; padding-right: 20px;
  background-image:
    linear-gradient(45deg, transparent 50%, var(--ink) 50%),
    linear-gradient(135deg, var(--ink) 50%, transparent 50%);
  background-position: calc(100% - 12px) calc(50% + 1px), calc(100% - 8px) calc(50% + 1px);
  background-size: 4px 4px, 4px 4px; background-repeat: no-repeat;
}
input[type=checkbox], input[type=radio] {
  appearance: none; -webkit-appearance: none;
  width: 13px; height: 13px; margin: 0 5px 0 0; position: relative;
  border: 1px solid var(--ink); border-radius: 2px;
  background: linear-gradient(#ffffff, #ececec);
  box-shadow: inset 1px 1px 0 #b5b5b5; vertical-align: -2px;
}
input[type=radio] { border-radius: 50%; }
input[type=checkbox]:checked::after { content: "\\2713"; position: absolute; left: 1px; top: -3px; font-size: 13px; font-weight: 700; line-height: 1; }
input[type=radio]:checked::after { content: ""; position: absolute; inset: 3px; background: var(--ink); border-radius: 50%; }
input[type=file] { box-shadow: inset 1px 1px 0 #9a9a9a; }

/* --------------------------------------------------------- group boxes */
.os9-panel {
  position: relative; border: 1px solid #9a9a9a; background: transparent;
  padding: 14px 12px 10px; margin: 18px 0 12px;
}
.os9-panel > strong:first-child {
  position: absolute; top: -8px; left: 8px; background: var(--paper);
  padding: 0 4px; font-weight: 700;
}
.os9-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 7px 0 2px; }

/* -------------------------------------------------------------- tables */
.os9-table { border-collapse: separate; border-spacing: 0; width: 100%; margin: 6px 0; font-size: 12px; background: var(--paper); border: 1px solid #9a9a9a; }
.os9-table th { background: linear-gradient(#ffffff, #d8d8d8); border-bottom: 1px solid #888; border-right: 1px solid #b5b5b5; padding: 2px 6px; text-align: left; font-weight: 700; white-space: nowrap; }
.os9-table th:last-child { border-right: 0; }
.os9-table td { border-bottom: 1px solid #dcdcdc; padding: 2px 6px; vertical-align: top; }
.os9-table tr:last-child td { border-bottom: 0; }

/* -------------------------------------------------------------- fields */
.os9-field { display: block; margin: 8px 0; }
.os9-field > span { display: block; font-weight: 700; margin-bottom: 2px; }
.os9-field input, .os9-field select, .os9-field textarea { width: 100%; max-width: 520px; }
.os9-field input[type=checkbox], .os9-field input[type=radio] { width: auto; }

/* ------------------------------------------------------------- helpers */
.warn { color: #555; }
body.mac-dragging { user-select: none; }
.os9-pre { white-space: pre-wrap; background: var(--paper); border: 1px solid #9a9a9a; box-shadow: inset 1px 1px 0 #d5d5d5; padding: 8px; max-height: 320px; overflow: auto; font-family: 'Monaco', 'Courier New', monospace; font-size: 11px; }
.os9-msg { border-left: 3px solid #b5b5b5; margin: 6px 0; padding: 3px 8px; white-space: pre-wrap; }
.os9-muted { color: var(--accent); }
.os9-danger, .os9-teardown { color: var(--danger); }
h1 { font-family: var(--title-font); font-size: 15px; margin: 0 0 10px; }
h2 { font-family: var(--title-font); font-size: 13px; margin: 14px 0 4px; }
code, .code { font-family: 'Monaco', 'Courier New', monospace; }
.os9-progress { height: 12px; border: 1px solid var(--ink); background: var(--paper); padding: 1px; }
.os9-progress > div { height: 100%; background: repeating-linear-gradient(90deg, #6699cc 0 4px, #a8c4e0 4px 8px); }
details > summary { cursor: default; font-weight: 700; margin: 6px 0; }
.mac-head { justify-content: flex-end; margin-top: 0; }

/* --------------------------------------------------------- scrollbars */
.mac-window-content::-webkit-scrollbar, .os9-pre::-webkit-scrollbar { width: 15px; height: 15px; }
.mac-window-content::-webkit-scrollbar-track, .os9-pre::-webkit-scrollbar-track { background: repeating-linear-gradient(45deg, #e6e6e6 0 1px, #f2f2f2 1px 2px); box-shadow: inset 1px 1px 0 #b5b5b5; }
.mac-window-content::-webkit-scrollbar-thumb, .os9-pre::-webkit-scrollbar-thumb { background: linear-gradient(#ffffff, #cfcfcf); border: 1px solid #888; box-shadow: inset 1px 1px 0 #fff; }
.mac-window-content::-webkit-scrollbar-button, .os9-pre::-webkit-scrollbar-button { display: none; }
`;

export function wizardShell(title: string, lamp: "on" | "off"): string {
  void lamp;
  // No inline script: the title travels as a data attribute (escaped) so
  // the page honours script-src 'self' — the survey shell's rule. An inline
  // <script> would be blocked by the CSP and the driver would die on its
  // first reference, leaving a blank window.
  return `<!DOCTYPE html>
<html lang="en-AU"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Surveyor Setup</title><style>${MAC9_CSS}</style></head>
<body class="mac9 wizard-body"><main id="app" data-title="${escAttr(title)}"></main>
<script src="/wizard.js"></script></body></html>`;
}

/** Escape for an HTML attribute value. */
function escAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const WIZARD_JS = `
// Minimal wizard driver: operator token -> providers (OAuth-consented key
// entry) -> instrument -> teardown. textContent-only. Secrets held in
// memory only: the operator token, the transient CF OAuth token (arrives in
// the URL fragment, never sent to the server), and provider keys.
const app = document.getElementById("app");
// Title arrives as a data attribute on #app (see wizardShell): the page
// honours script-src 'self', so no inline script may define it.
const APP_TITLE = app.getAttribute("data-title") || "Surveyor";
let OP_TOKEN = "";
let CF_TOKEN = "";
function readFragment() {
  const m = (location.hash || "").match(/cf_token=([^&]+)/);
  if (m) {
    CF_TOKEN = decodeURIComponent(m[1]);
    try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {}
  }
}
readFragment();
async function api(path, opts) {
  const o = opts || {};
  o.headers = Object.assign({}, o.headers || {});
  if (OP_TOKEN) o.headers["authorization"] = "Bearer " + OP_TOKEN;
  const res = await fetch(path, o);
  if (!res.ok) throw new Error((await res.json()).error || res.status);
  return res.json();
}
function el(tag, attrs, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "onclick") n.onclick = v;
    else n.setAttribute(k, v);
  }
  for (const c of children) n.append(c);
  return n;
}
// Platinum window: close and zoom boxes are chrome (there is one window);
// the lamp rides in the title plate and still reports ready/off honestly.
function frame(title, lamp, body) {
  app.replaceChildren(
    el("section", { class: "mac-window" },
      el("div", { class: "mac-titlebar" },
        el("span", { class: "mac-box close", "aria-hidden": "true" }),
        el("span", { class: "mac-title" },
          el("span", { class: "mac-lamp " + lamp }), " " + title),
        el("span", { class: "mac-box zoom", "aria-hidden": "true" })),
      el("div", { class: "mac-window-content" }, ...body)));
}
function tokenPanel() {
  const t = el("input", { type: "password", placeholder: "Operator token (chosen at boot)" });
  const note = el("span", { class: "warn" }, OP_TOKEN ? " \\u2014 set" : " \\u2014 not set");
  const set = el("button", { class: "os9-btn" }, "Set");
  set.onclick = () => { OP_TOKEN = t.value.trim(); render(); };
  return el("div", { class: "os9-panel" }, el("strong", {}, "Worker token"),
    el("div", {}, t, set),
    el("p", { class: "warn" }, OP_TOKEN
      ? "Token set for this session."
      : "Not set \u2014 paste the token chosen at boot to enable writes."));
}
function newOperatorToken() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return "op-" + s;
}
// Fresh-install boot: no key material, no operator token, so no write is
// possible yet. The operator supplies a transient Cloudflare token that can
// edit this Worker's secrets and chooses the operator token; the key
// material is minted in the Worker and never shown.
function bootstrapPanel() {
  const note = el("p", { class: "warn" }, "");
  const cf = el("input", { type: "password", placeholder: "Cloudflare API token (Workers Scripts: Edit)" });
  const account = el("input", { placeholder: "Cloudflare account id" });
  const script = el("input", { placeholder: "Worker script name (e.g. surveyor)" });
  const op = el("input", { placeholder: "Operator token \\u2014 choose one and save it" });
  const gen = el("button", { class: "os9-btn" }, "Generate");
  gen.onclick = () => {
    OP_TOKEN = newOperatorToken();
    op.value = OP_TOKEN;
    note.textContent = "Operator token generated. It is shown only here \\u2014 save it now.";
  };
  const boot = el("button", { class: "os9-btn" }, "Boot installation");
  boot.onclick = async () => {
    const chosen = op.value.trim();
    if (!chosen) { note.textContent = "Choose or generate an operator token first."; return; }
    note.textContent = "Writing the master secrets\\u2026";
    try {
      await api("/api/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cf_token: cf.value || CF_TOKEN,
          account_id: account.value,
          script_name: script.value,
          operator_token: chosen,
        }),
      });
      OP_TOKEN = chosen;
      note.textContent = "Installation booted.";
      render();
    } catch (e) {
      note.textContent = "Boot failed: " + e.message;
    }
  };
  return el("div", { class: "os9-panel" },
    el("strong", {}, "Boot the installation"),
    el("p", {}, "This installation has no key material yet. Booting sets SERVER_SECRET, ENCRYPTION_KEY and OPERATOR_TOKEN in your own Cloudflare account; no value is logged, stored, or returned."),
    cf, account, script, op, gen, note, boot);
}
function providersPanel(st) {
  const body = [];
  body.push(el("div", { class: "os9-panel" },
    el("strong", {}, "Providers (optional)"),
    el("p", {}, CF_TOKEN
      ? "Cloudflare connected. The token is held in this tab and never stored."
      : "Connect Cloudflare to write provider keys without pasting a token.")));
  const connect = el("button", { class: "os9-btn" },
    CF_TOKEN ? "Reconnect Cloudflare" : "Connect Cloudflare");
  connect.onclick = () => { location.href = "/api/oauth/start"; };
  body.push(connect);

  const account = el("input", { placeholder: "Cloudflare account id" });
  const script = el("input", { placeholder: "Worker script name (e.g. surveyor)" });
  const kind = el("input", { placeholder: "kind: openai-compatible | groq | tokenrouter | tavily | parallel" });
  const label = el("input", { placeholder: "Label" });
  const model = el("input", { placeholder: "Model id" });
  const baseUrl = el("input", { placeholder: "Base URL (openai-compatible only)" });
  const slot = el("input", { placeholder: "Secret slot (GROQ_API_KEY, TOKENROUTER_API_KEY, TAVILY_API_KEY, PARALLEL_API_KEY)" });
  const caps = el("input", { placeholder: "Capabilities (comma-separated: chat, vision, search, extract, audio)" });
  const key = el("input", { type: "password", placeholder: "Provider API key" });
  const note = el("p", { class: "warn" }, "");
  const add = el("button", { class: "os9-btn" }, "Add provider key");
  add.onclick = async () => {
    note.textContent = "Validating and writing\\u2026";
    try {
      await api("/api/providers/key", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cf_token: CF_TOKEN,
          account_id: account.value,
          script_name: script.value,
          kind: kind.value || "openai-compatible",
          label: label.value,
          model: model.value,
          base_url: baseUrl.value || undefined,
          secret_slot: slot.value,
          capabilities: caps.value.split(",").map((c) => c.trim()).filter(Boolean),
          api_key: key.value,
        }),
      });
      note.textContent = "Key written to the secret store.";
      key.value = "";
    } catch (e) {
      note.textContent = "Failed: " + e.message;
    }
  };
  body.push(el("div", { class: "os9-panel" },
    account, script, kind, label, model, baseUrl, slot, caps, key, add, note));

  const cont = el("button", { class: "os9-btn" }, "Continue");
  cont.onclick = () => api("/api/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "providers", providers: st.providers || [] }),
  }).then(render);
  body.push(cont);
  return body;
}
function instrumentPanel() {
  const t = el("input", { placeholder: "Survey title" });
  const b = el("input", { placeholder: "Short blurb" });
  const c = el("textarea", { rows: 4, placeholder: "Consent copy" });
  const note = el("p", { class: "warn" }, "");
  const finish = el("button", { class: "os9-btn" }, "Finish setup");
  finish.onclick = async () => {
    try {
      await api("/api/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "instrument", title: t.value, blurb: b.value, consent: c.value }),
      });
      render();
    } catch (e) { note.textContent = "Failed: " + e.message; }
  };
  return el("div", { class: "os9-panel" }, t, b, c, finish, note);
}
async function render() {
  // A fresh install has no key material, so /api/setup answers 503
  // (not_provisioned). The wizard must still render — the boot panel is the
  // whole point of this screen — so an unreadable setup falls back to the
  // welcome phase and the status call below decides what the operator sees.
  let st = null;
  let setupError = "";
  try {
    st = await api("/api/setup");
  } catch (e) {
    setupError = e.message || "setup unreadable";
    st = { phase: "welcome", instrument: null, installed_at: null };
  }
  const status = await api("/api/status").catch(() => null);
  const steps = ["welcome", "providers", "corpus", "instrument", "ready"];
  const at = steps.indexOf(st.phase);
  const body = [];
  body.push(el("h1", {}, APP_TITLE));
  if (status && status.degraded && status.warning) {
    body.push(el("div", { class: "os9-panel", role: "status" }, status.warning));
  }
  if (setupError && status && status.provisioned !== false) {
    // Provisioned but the setup state cannot be read: say so plainly
    // instead of misrendering the boot panel over a live installation.
    body.push(el("div", { class: "os9-panel" },
      el("strong", {}, "Setup state unreadable"),
      el("p", {}, "The setup endpoint answered: " + setupError),
      el("div", {}, el("button", { class: "os9-btn", onclick: () => render() }, "Retry"))));
    frame("Surveyor Setup", "off", body);
    return;
  }
  body.push(el("div", { class: "os9-progress", "aria-label": "setup progress" },
    el("div", { style: "width:" + ((at) * 25) + "%" })));
  const needsBoot = !status || status.provisioned === false || status.operator_token_set === false;
  if (!OP_TOKEN) {
    body.push(needsBoot ? bootstrapPanel() : tokenPanel());
  }
  if (st.phase === "ready") {
    body.push(el("div", { class: "os9-panel" },
      "Installation complete. The survey instrument is live."));
    const account = el("input", { placeholder: "Cloudflare account id" });
    const script = el("input", { placeholder: "Worker script name (e.g. surveyor)" });
    const note = el("p", { class: "warn" }, CF_TOKEN ? "" :
      "Connect Cloudflare for full teardown; otherwise only local state resets.");
    const connect = el("button", { class: "os9-btn" }, "Connect Cloudflare");
    connect.onclick = () => { location.href = "/api/oauth/start"; };
    body.push(el("div", { class: "os9-panel" }, account, script, connect, note));
    body.push(el("button", {
      class: "os9-btn os9-teardown", onclick: async () => {
        if (!confirm("Tear down the entire installation? This cannot be undone.")) return;
        try {
          const r = await api("/api/teardown", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              cf_token: CF_TOKEN,
              account_id: account.value,
              script_name: script.value,
            }),
          });
          frame("Teardown complete", "off",
            el("div", { class: "os9-panel" },
              JSON.stringify(r.wiped),
              " Not wiped: " + r.not_wiped.join(", ")));
        } catch (e) {
          note.textContent = "Teardown failed: " + e.message;
        }
      },
    }, "Uninstall..."));
  } else if (st.phase === "instrument" || st.phase === "corpus") {
    body.push(instrumentPanel());
  } else {
    for (const node of providersPanel(st)) body.push(node);
  }
  frame("Surveyor Setup", st.phase === "ready" ? "on" : "off", body);
}
render();
`;
