// Platinum Mac OS 9 chrome for the first-run wizard and teardown screen.
// Zero dependencies, textContent-only rendering (constitution III), served
// as static strings. The aesthetic: platinum greys, Chicago-style bold
// headings, beveled buttons, striped title bars.

export const WIZARD_CSS = `
:root {
  --platinum: #dddddd; --platinum-hi: #f2f2f2; --platinum-lo: #a8a8a8;
  --ink: #1a1a1a; --accent: #737373; --accent-hi: #9a9a9a;
  --finder-blue: #3366cc; --danger: #b34700;
  --lamp-green: #58be00; --lamp-red: #ff5f45;
  font-family: 'Charcoal', 'Gadget', 'Segoe UI', system-ui, sans-serif;
  font-size: 13px; color: var(--ink);
}
body { background: var(--platinum); margin: 0; display: grid; place-items: center; min-height: 100vh; }
.os9-window { width: 520px; max-width: 94vw; background: var(--platinum-hi); border: 1px solid var(--ink); box-shadow: 2px 2px 0 rgba(0,0,0,.4); }
.os9-titlebar { display: flex; align-items: center; gap: 8px; padding: 4px 10px; background: repeating-linear-gradient(180deg, #ffffff 0 1px, #cccccc 1px 2px, #bbbbbb 2px 3px); border-bottom: 1px solid var(--platinum-lo); font-weight: 700; }
.os9-lamp { width: 11px; height: 11px; border-radius: 50%; border: 1px solid var(--ink); }
.os9-lamp.on { background: var(--lamp-green); } .os9-lamp.off { background: var(--lamp-red); }
.os9-body { padding: 18px 22px; }
.os9-panel { border: 2px solid; border-color: var(--platinum-lo) var(--platinum-hi) var(--platinum-hi) var(--platinum-lo); background: #ffffff; padding: 12px 14px; margin: 10px 0; }
.os9-btn { display: inline-block; padding: 4px 18px; background: var(--platinum); border: 2px solid; border-color: var(--platinum-hi) var(--platinum-lo) var(--platinum-lo) var(--platinum-hi); box-shadow: 1px 1px 0 rgba(0,0,0,.35); cursor: pointer; font-weight: 700; }
.os9-btn:active { border-color: var(--platinum-lo) var(--platinum-hi) var(--platinum-hi) var(--platinum-lo); box-shadow: none; }
.os9-btn:disabled { color: var(--platinum-lo); cursor: default; }
.os9-progress { height: 12px; border: 1px solid var(--ink); background: #fff; padding: 1px; }
.os9-progress > div { height: 100%; width: 25%; background: repeating-linear-gradient(90deg, var(--accent-hi) 0 4px, transparent 4px 8px); }
h1 { font-size: 16px; margin: 0 0 10px; }
.os9-teardown { color: var(--danger); }
code { font-family: 'Monaco', 'Courier New', monospace; }
`;

export function wizardShell(title: string, lamp: "on" | "off"): string {
  const safeTitle = JSON.stringify(title);
  const safeLamp = lamp === "on" ? "on" : "off";
  return `<!DOCTYPE html>
<html lang="en-AU"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Surveyor Setup</title><style>${WIZARD_CSS}</style></head>
<body><main class="os9-window" id="app"></main>
<script>const APP_TITLE = ${safeTitle}; const LAMP = "${safeLamp}";</script>
<script src="/wizard.js"></script></body></html>`;
}

export const WIZARD_JS = `
// Minimal wizard driver: operator token -> providers (OAuth-consented key
// entry) -> instrument -> teardown. textContent-only. Secrets held in
// memory only: the operator token, the transient CF OAuth token (arrives in
// the URL fragment, never sent to the server), and provider keys.
const app = document.getElementById("app");
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
function frame(title, lamp, body) {
  app.replaceChildren(
    el("section", { class: "os9-window" },
      el("div", { class: "os9-titlebar" },
        el("span", { class: "os9-lamp " + lamp }), title),
      el("div", { class: "os9-body" }, body)));
}
function tokenPanel() {
  const t = el("input", { type: "password", placeholder: "Operator token (chosen at boot)" });
  const note = el("span", { class: "warn" }, OP_TOKEN ? " \u2014 set" : " \u2014 not set");
  const set = el("button", { class: "os9-btn" }, "Set");
  set.onclick = () => { OP_TOKEN = t.value.trim(); render(); };
  return el("div", { class: "os9-panel" }, el("strong", {}, "Worker token"), note,
    el("div", {}, t, set));
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
  const op = el("input", { placeholder: "Operator token \u2014 choose one and save it" });
  const gen = el("button", { class: "os9-btn" }, "Generate");
  gen.onclick = () => {
    OP_TOKEN = newOperatorToken();
    op.value = OP_TOKEN;
    note.textContent = "Operator token generated. It is shown only here \u2014 save it now.";
  };
  const boot = el("button", { class: "os9-btn" }, "Boot installation");
  boot.onclick = async () => {
    const chosen = op.value.trim();
    if (!chosen) { note.textContent = "Choose or generate an operator token first."; return; }
    note.textContent = "Writing the master secrets\u2026";
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
  const kind = el("input", { placeholder: "kind: openai-compatible | groq | tokenrouter" });
  const label = el("input", { placeholder: "Label" });
  const model = el("input", { placeholder: "Model id" });
  const baseUrl = el("input", { placeholder: "Base URL (openai-compatible only)" });
  const slot = el("input", { placeholder: "Secret slot (GROQ_API_KEY or TOKENROUTER_API_KEY)" });
  const caps = el("input", { placeholder: "Capabilities (comma-separated: chat, vision, search, extract, audio)" });
  const key = el("input", { type: "password", placeholder: "Provider API key" });
  const note = el("p", { class: "warn" }, "");
  const add = el("button", { class: "os9-btn" }, "Add provider key");
  add.onclick = async () => {
    note.textContent = "Validating and writing\u2026";
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
  const st = await api("/api/setup");
  const status = await api("/api/status").catch(() => null);
  const steps = ["welcome", "providers", "corpus", "instrument", "ready"];
  const at = steps.indexOf(st.phase);
  const body = [];
  body.push(el("h1", {}, APP_TITLE));
  if (status && status.degraded && status.warning) {
    body.push(el("div", { class: "os9-panel", role: "status" }, status.warning));
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
