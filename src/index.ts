// Surveyor worker: first-run setup wizard + teardown surface.

import { Hono } from "hono";
import { z } from "zod";
import { getState, InstallationUnprovisioned } from "./state";
import { createVaultKit, openText, sealText } from "./lib/vault";
import {
  SetupStepSchema,
  validateSetupStep,
} from "./lib/setup";
import { wizardShell, WIZARD_JS } from "./frontend/chrome";
import { surveyShell, SURVEY_JS } from "./frontend/survey";
import { uploaderShell, UPLOADER_JS } from "./frontend/uploader";
import PDF_TOOLS_JS from "../dist/pdf-tools.txt";
import PDF_WORKER_JS from "../dist/pdf.worker.txt";
import {
  resolveChain,
  validateCustomProvider,
} from "./lib/registry";
import {
  putWorkerSecret,
  deleteWorkerSecret,
  SECRET_SLOT,
} from "./lib/secrets";
import {
  DEFAULT_AUTHORIZE_URL,
  DEFAULT_TOKEN_URL,
  DEFAULT_SCOPES,
  authorizeUrl,
  codeChallengeS256,
  exchangeOAuthCode,
  generateCodeVerifier,
  signState,
  verifyState,
  type OAuthConfig,
} from "./lib/oauth";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { WorkflowEntrypoint } from "cloudflare:workers";
import {
  provisionStack,
  teardownStack,
  ProvisionError,
  type ProvisionReceipt,
} from "./lib/provision";
import { createCloudflareApi } from "./lib/cfapi";
import {
  bootstrapInstallation,
  BootstrapError,
} from "./lib/bootstrap";
import { liveClient, hasSecretValue } from "./lib/providers";
import { isAllowedProviderBaseUrl } from "./lib/net";
import { isProviderSlot, PROVIDER_SLOTS } from "./lib/setup";
import { listTelemetry } from "./lib/telemetry";
import intake from "./routes/intake";
import corpus from "./routes/corpus";
import launch from "./routes/launch";
import engine from "./routes/engine";
import reports from "./routes/reports";
import { evaluateAll } from "./lib/schedule";
import { sweepRawBytes } from "./lib/retention";
import { REQUIRED_SCOPES, REVOCATION_GUIDANCE } from "./lib/scopes";
import type { Bindings, IngestMessage } from "./env";

type Env = { Bindings: Bindings };

const app = new Hono<Env>();

// Turnstile is the one permitted third-party origin, and only while the
// human-check is enabled: the CSP gains script-src + frame-src for the
// widget. Every other response stays origin-free (constitution VI).
function securityHeaders(env: Bindings): Record<string, string> {
  const turnstile = Boolean(env.TURNSTILE_SECRET);
  const scriptSrc = turnstile
    ? "script-src 'self' https://challenges.cloudflare.com"
    : "script-src 'self'";
  const frameSrc = turnstile
    ? "; frame-src https://challenges.cloudflare.com"
    : "";
  return {
    "content-security-policy":
      `default-src 'none'; ${scriptSrc}; style-src 'unsafe-inline'; ` +
      `connect-src 'self'${frameSrc}; base-uri 'none'`,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "cache-control": "no-store",
  };
}

app.use("*", async (c, next) => {
  await next();
  for (const [k, v] of Object.entries(securityHeaders(c.env))) c.header(k, v);
});

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((err, c) => {
  // Missing key material is a deployment state, not a bad request: say so
  // plainly and fail closed wherever sealed data would be read or written.
    if (err instanceof InstallationUnprovisioned) {
    return c.json(
      {
        error: "not_provisioned",
        detail:
          "SERVER_SECRET / ENCRYPTION_KEY missing — open the wizard and " +
          "boot the installation",
      },
      503,
    );
  }
  // Never echo internal error detail to the client; route handlers map
  // known failures to their own statuses, everything else is a 400.
  return c.json({ error: "bad_request" }, 400);
});

// Operator auth: constant-time token compare, disabled-until-set — an
// unset OPERATOR_TOKEN 404s the write surface entirely (bootstrap is
// read-only); a set token with a bad bearer gets 401.
async function requireOperator(
  c: { req: { header(name: string): string | undefined }; env: Bindings },
): Promise<401 | 404 | null> {
  const expected = c.env.OPERATOR_TOKEN;
  if (!expected) return 404;
  const got = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const a = new TextEncoder().encode(got);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return 401;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0 ? null : 401;
}



app.get("/", (c) => c.html(wizardShell("Surveyor — first-run setup", "off")));
app.get("/wizard.js", (c) =>
  c.body(WIZARD_JS, 200, { "content-type": "application/javascript" }),
);

// Source-facing survey shell: consent copy from the installation
// instrument (escaped at serve time), driver over /api/intake.
app.get("/survey", async (c) => {
  const s = await (await getState(c.env)).loadSetup();
  const instrument = s.instrument ?? {
    title: "Anonymous survey",
    blurb: "",
    consent: "",
  };
  return c.html(
    surveyShell(instrument.title, instrument.blurb, instrument.consent),
  );
});
app.get("/survey.js", (c) =>
  c.body(SURVEY_JS, 200, { "content-type": "application/javascript" }),
);

// Operator corpus uploader: the self-hosted PDF.js tools run in the
// operator's browser (digital text extraction or page rasterisation), so no
// server-side PDF rasteriser is needed. No secrets are served here; the API
// is operator-gated server-side.
app.get("/corpus", (c) => c.html(uploaderShell()));
app.get("/corpus.js", (c) =>
  c.body(UPLOADER_JS, 200, { "content-type": "application/javascript" }),
);
app.get("/pdf-tools.js", (c) =>
  c.body(PDF_TOOLS_JS, 200, { "content-type": "application/javascript" }),
);
// The PDF.js worker asset. `/pdf-tools.js` sets workerSrc to this route, so
// the worker runs same-origin with no third-party fetch (ADR-0011).
app.get("/pdf.worker.mjs", (c) =>
  c.body(PDF_WORKER_JS, 200, { "content-type": "application/javascript" }),
);

app.route("/api/intake", intake);

// Corpus routes are operator-only: uploads, lane state, and quarantine
// contents all belong to the investigation operator.
app.use("/api/corpus/*", async (c, next) => {
  const denied = await requireOperator(c);
  if (denied) return c.json(deny(denied), denied);
  await next();
});
app.route("/api/corpus", corpus);

// Engine routes are operator-only: angles, spend, and findings all belong
// to the investigation operator.
app.use("/api/engine/*", async (c, next) => {
  const denied = await requireOperator(c);
  if (denied) return c.json(deny(denied), denied);
  await next();
});
app.route("/api/engine", engine);

// Report mutation (approve/publish/tick/draft) is operator-only; published
// reads stay public.
app.use("/api/reports/*", async (c, next) => {
  if (c.req.method !== "GET" || c.req.path.endsWith("/draft")) {
    const denied = await requireOperator(c);
    if (denied) return c.json(deny(denied), denied);
  }
  await next();
});
app.route("/api/reports", reports);

// Scheduler: evaluates stored frequencies and renders what is due
// through the shared publish path (gates still apply). Operator-only;
// also wired as the worker cron entry below.
app.use("/api/scheduler/*", async (c, next) => {
  const denied = await requireOperator(c);
  if (denied) return c.json(deny(denied), denied);
  await next();
});
app.post("/api/scheduler/evaluate", async (c) => {
  const st = await getState(c.env);
  const client = await liveClient(c.env.DB, c.env);
  const receipts = await evaluateAll(
    c.env.DB,
    st.kit,
    new Date().toISOString(),
    client,
  );
  return c.json({ receipts });
});

// Launch pack: generation and rotation are operator-only; the slug
// landing page is public (it is the survey's front door).
app.use("/api/launch-pack/*", async (c, next) => {
  const denied = await requireOperator(c);
  if (denied) return c.json(deny(denied), denied);
  await next();
});
app.route("/api/launch-pack", launch);

app.get("/s/:slug", async (c) => {
  await getState(c.env); // boot migration side effect
  const parsed = z.string().min(1).max(64).safeParse(c.req.param("slug"));
  if (!parsed.success) return c.json({ error: "not_found" }, 404);
  const row = await c.env.DB.prepare(
    "SELECT slug FROM launch WHERE id = 1",
  ).first<{ slug: string }>();
  if (!row || row.slug !== parsed.data) {
    return c.json({ error: "not_found" }, 404);
  }
  return c.html(
    "<!DOCTYPE html><html lang=\"en-AU\"><head><meta charset=\"utf-8\">" +
      "<title>Anonymous survey</title></head><body>" +
      "<main><h1>An anonymous survey is open</h1>" +
      "<p>No accounts, no tracking. Your words are encrypted before storage " +
      "and identifying details are never kept.</p></main></body></html>",
  );
});

app.get("/api/setup", async (c) => {
  const denied = await requireOperator(c);
  const s = await (await getState(c.env)).loadSetup();
  if (denied) {
    // Public view: the wizard's phase and the instrument copy that /survey
    // already serves. Provider entries (labels, models, base URLs) are
    // operator data and never leave without the token.
    return c.json({
      phase: s.phase,
      instrument: s.instrument,
      installed_at: s.installed_at,
    });
  }
  return c.json(s);
});

// Public token-fallback guidance: scope list and revocation copy the
// wizard shows on the token-paste path. No secrets, safe to publish.
app.get("/api/setup/token-guidance", (c) =>
  c.json({ scopes: REQUIRED_SCOPES, guidance: REVOCATION_GUIDANCE }),
);

// First-run bootstrap (A1). No operator token can exist yet, so this is
// deliberately reachable while unprovisioned; it writes nothing without a
// Cloudflare token that can already edit this Worker, and it refuses once
// the master slots are set (rotation is never a side effect). The operator
// chooses the operator token, the key material is minted in-flight, and the
// receipt carries slot names and booleans only.
const BootstrapBodySchema = z.object({
  cf_token: z.string().min(1).max(4096),
  account_id: z.string().min(1).max(64),
  script_name: z.string().min(1).max(128),
  operator_token: z.string().min(16).max(512).optional(),
});

app.post("/api/bootstrap", async (c) => {
  const parsed = BootstrapBodySchema.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) return c.json({ error: "invalid_body" }, 422);
  try {
    const receipt = await bootstrapInstallation(c.env, parsed.data);
    return c.json({ ok: true, ...receipt });
  } catch (err) {
    if (err instanceof BootstrapError) {
      return c.json(
        { error: err.code, detail: err.message },
        err.code === "already_provisioned" ? 409 : 422,
      );
    }
    return c.json(
      { error: "secret_write_failed", detail: (err as Error).message },
      502,
    );
  }
});

// Secret presence: a slot counts as configured only when it is one of the
// provider key slots AND its binding is set. Only truthiness is ever
// inspected — values are never read, logged, or returned (constitution II).
function hasSecret(env: Bindings, slot: string): boolean {
  return hasSecretValue(env, slot);
}

function deny(code: 401 | 404) {
  return { error: code === 404 ? "not_found" : "unauthorised" };
}

app.get("/api/providers", async (c) => {
  // Operator-only: entries carry labels, models, and base URLs.
  const denied = await requireOperator(c);
  if (denied) return c.json(deny(denied), denied);
  const s = await (await getState(c.env)).loadSetup();
  return c.json(resolveChain(s, (slot) => hasSecret(c.env, slot)));
});

// Public degraded-status surface for the dashboard banner: booleans and
// warning copy only, no provider identities. When the human-check is
// enabled the public sitekey rides along so the survey shell can render
// the widget (a sitekey is public; its secret never leaves the store).
app.get("/api/status", async (c) => {
  let s;
  try {
    s = await (await getState(c.env)).loadSetup();
  } catch (err) {
    if (err instanceof InstallationUnprovisioned) {
      return c.json({
        degraded: true,
        warning:
          "Not provisioned — SERVER_SECRET / ENCRYPTION_KEY missing. " +
          "Open the wizard to boot the installation.",
        provisioned: false,
        operator_token_set: Boolean(c.env.OPERATOR_TOKEN),
      });
    }
    throw err;
  }
  const { degraded, warning } = resolveChain(s, (slot) =>
    hasSecret(c.env, slot),
  );
  const body: {
    degraded: boolean;
    warning: string | null;
    provisioned: boolean;
    operator_token_set: boolean;
    turnstile_sitekey?: string;
  } = {
    degraded,
    warning,
    provisioned: true,
    // The write surfaces answer 404 while this is unset; the wizard must be
    // able to see that honestly rather than discover it on first write.
    operator_token_set: Boolean(c.env.OPERATOR_TOKEN),
  };
  if (c.env.TURNSTILE_SECRET && c.env.TURNSTILE_SITEKEY) {
    body.turnstile_sitekey = c.env.TURNSTILE_SITEKEY;
  }
  return c.json(body);
});

app.post("/api/providers/validate", async (c) => {
  const denied = await requireOperator(c);
  if (denied)
    return c.json(
      { error: denied === 404 ? "not_found" : "unauthorised" },
      denied as 401 | 404,
    );
  // Save-time test call for a custom provider draft. Nothing is persisted
  // here — the wizard stores the entry (slot names only) via /api/setup,
  // and the operator sets the real secret through the deploy dashboard.
  const result = await validateCustomProvider(await c.req.json());
  if (!result.ok) {
    return c.json({ ok: false, error: result.error }, 422);
  }
  return c.json({ ok: true });
});

// BYOK key entry (R2): the operator authorises Cloudflare through the
// wizard's OAuth consent, which yields a transient, scoped token. That
// token and the provider key value are in-flight only — used to prove the
// key works, written to the secret store, then discarded. Neither value is
// persisted, logged, telemetered, or echoed (constitution II).
const KEY_BASE_URLS: Record<string, string> = {
  groq: "https://api.groq.com/openai/v1",
  tokenrouter: "https://api.tokenrouter.com/v1",
};

const KeyEntrySchema = z.object({
  cf_token: z.string().min(1).max(4096),
  account_id: z.string().min(1).max(64),
  script_name: z.string().min(1).max(128),
  kind: z.enum(["groq", "tokenrouter", "openai-compatible"]),
  label: z.string().min(1).max(64),
  model: z.string().min(1).max(128),
  base_url: z
    .string()
    .url()
    .max(2048)
    .refine(isAllowedProviderBaseUrl, "base URL must be https to a public host")
    .optional(),
  secret_slot: z.string().regex(SECRET_SLOT).refine(isProviderSlot, "not a provider key slot"),
  api_key: z.string().min(1).max(512),
});

app.post("/api/providers/key", async (c) => {
  const denied = await requireOperator(c);
  if (denied) return c.json(deny(denied), denied);
  const parsed = KeyEntrySchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_body" }, 422);
  const p = parsed.data;
  const baseUrl =
    p.kind === "openai-compatible" ? p.base_url : KEY_BASE_URLS[p.kind];
  if (!baseUrl) return c.json({ error: "base_url_required" }, 422);

  // 1. Prove the key works before storing it (reuses the save-time probe).
  const check = await validateCustomProvider({
    label: p.label,
    baseUrl,
    model: p.model,
    apiKey: p.api_key,
  });
  if (!check.ok) {
    return c.json({ error: "provider_invalid", detail: check.error }, 422);
  }

  // 2. Write it into this installation's own Worker secret store.
  try {
    await putWorkerSecret(
      { accountId: p.account_id, scriptName: p.script_name, token: p.cf_token },
      p.secret_slot,
      p.api_key,
    );
  } catch (err) {
    return c.json(
      { error: "secret_write_failed", detail: (err as Error).message },
      502,
    );
  }

  // 3. Persist the entry (slot name only) so the chain can resolve it.
  const st = await getState(c.env);
  const current = await st.loadSetup();
  const entry = {
    kind: p.kind,
    label: p.label,
    secret_slot: p.secret_slot,
    model: p.model,
    ...(p.kind === "openai-compatible" ? { base_url: p.base_url } : {}),
  };
  const providers = [
    ...current.providers.filter((x) => x.secret_slot !== p.secret_slot),
    entry,
  ];
  await st.putSetup({ ...current, providers });
  return c.json({ ok: true, slot: p.secret_slot });
});

const KeyRemoveSchema = z.object({
  cf_token: z.string().min(1).max(4096),
  account_id: z.string().min(1).max(64),
  script_name: z.string().min(1).max(128),
});

app.delete("/api/providers/key/:slot", async (c) => {
  const denied = await requireOperator(c);
  if (denied) return c.json(deny(denied), denied);
  const slot = c.req.param("slot");
  // Only provider key slots are removable here: a shape check would also
  // admit OPERATOR_TOKEN, SERVER_SECRET and ENCRYPTION_KEY, which are not
  // this route's to delete. A refused slot stays indistinguishable from an
  // unknown one.
  if (!SECRET_SLOT.test(slot) || !isProviderSlot(slot)) {
    return c.json({ error: "not_found" }, 404);
  }
  const parsed = KeyRemoveSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_body" }, 422);
  try {
    await deleteWorkerSecret(
      {
        accountId: parsed.data.account_id,
        scriptName: parsed.data.script_name,
        token: parsed.data.cf_token,
      },
      slot,
      PROVIDER_SLOTS,
    );
  } catch (err) {
    return c.json(
      { error: "secret_delete_failed", detail: (err as Error).message },
      502,
    );
  }
  const st = await getState(c.env);
  const current = await st.loadSetup();
  await st.putSetup({
    ...current,
    providers: current.providers.filter((x) => x.secret_slot !== slot),
  });
  return c.json({ ok: true, slot });
});

// OAuth consent (R2, ADR-0013). PKCE public client: the start redirect
// carries an S256 challenge and a signed state; the verifier is held in an
// HttpOnly cookie scoped to the callback path, so it never rides in a URL
// and never reaches D1. The operator clicks "Connect Cloudflare", consents,
// and the transient token returns to the wizard in the URL fragment
// (client-side only). Nothing here stores the token or sends a client
// secret.
const OAUTH_VERIFIER_COOKIE = "surveyor_oauth_verifier";
const OAUTH_VERIFIER_TTL_S = 10 * 60;

function oauthConfig(env: Bindings, origin: string): OAuthConfig {
  return {
    clientId: env.CF_OAUTH_CLIENT_ID ?? "",
    authorizeUrl: env.CF_OAUTH_AUTHORIZE_URL || DEFAULT_AUTHORIZE_URL,
    tokenUrl: env.CF_OAUTH_TOKEN_URL || DEFAULT_TOKEN_URL,
    scopes: env.CF_OAUTH_SCOPES || DEFAULT_SCOPES,
    redirectUri: `${origin}/api/oauth/callback`,
  };
}

app.get("/api/oauth/start", async (c) => {
  const app = await getState(c.env);
  const clientId = c.env.CF_OAUTH_CLIENT_ID;
  if (!clientId) return c.json({ error: "oauth_not_configured" }, 404);
  const origin = new URL(c.req.url).origin;
  const verifier = generateCodeVerifier();
  const state = await signState(app.kit, Date.now());
  setCookie(c, OAUTH_VERIFIER_COOKIE, verifier, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/api/oauth",
    maxAge: OAUTH_VERIFIER_TTL_S,
  });
  const challenge = await codeChallengeS256(verifier);
  return c.redirect(
    authorizeUrl(oauthConfig(c.env, origin), state, challenge),
    302,
  );
});

app.get("/api/oauth/callback", async (c) => {
  const app = await getState(c.env);
  const clientId = c.env.CF_OAUTH_CLIENT_ID;
  if (!clientId) return c.json({ error: "oauth_not_configured" }, 404);
  const code = c.req.query("code");
  const state = c.req.query("state") ?? "";
  const verifier = getCookie(c, OAUTH_VERIFIER_COOKIE) ?? "";
  deleteCookie(c, OAUTH_VERIFIER_COOKIE, { path: "/api/oauth" });
  if (!code) return c.json({ error: "missing_code" }, 400);
  if (!verifier) return c.json({ error: "missing_code_verifier" }, 400);
  if (!(await verifyState(app.kit, state, Date.now()))) {
    return c.json({ error: "bad_state" }, 400);
  }
  const origin = new URL(c.req.url).origin;
  try {
    const token = await exchangeOAuthCode(
      oauthConfig(c.env, origin),
      code,
      verifier,
    );
    // Fragment, not query: never sent to or logged by the server.
    return c.redirect(`/#cf_token=${encodeURIComponent(token)}`, 302);
  } catch (err) {
    return c.json(
      { error: "oauth_exchange_failed", detail: (err as Error).message },
      502,
    );
  }
});

// Corroboration groups: HMAC-joined entity counts across submissions.
// Operator-gated; counts and labels only — names stay sealed (reveal is a
// reports/admin concern, T6).
app.get("/api/intake/entities/groups", async (c) => {
  const denied = await requireOperator(c);
  if (denied)
    return c.json(
      deny(denied),
      denied,
    );
  const rows = await c.env.DB.prepare(
    "SELECT name_hmac, COUNT(*) AS n, COUNT(DISTINCT submission_id) AS subs FROM entities GROUP BY name_hmac",
  ).all<{ name_hmac: string; n: number; subs: number }>();
  // Unbound .all() returns rows directly on both D1 shims used here.
  const groups = Array.isArray(rows) ? rows : rows.results;
  return c.json({ groups });
});

// One-shot re-seal after key rotation: rows sealed under an older key pair
// (for example a deployment that ran on the retired development constants)
// are opened with the supplied old kit and written back with the current
// installation kit. Operator-gated, idempotent, and skips rows already
// readable with the current kit.
const ResealBodySchema = z.object({
  old_server_secret: z.string().min(1).max(4096),
  old_encryption_key: z.string().min(1).max(4096),
});

const RESEAL_COLUMNS: Array<{
  table: string;
  column: string;
  key: string;
}> = [
  { table: "messages", column: "body_envelope", key: "rowid" },
  { table: "entities", column: "name_envelope", key: "rowid" },
  { table: "attachments", column: "filename", key: "id" },
  { table: "corpus_docs", column: "text_envelope", key: "id" },
  { table: "corpus_docs", column: "filename", key: "id" },
  { table: "angles", column: "rationale_envelope", key: "id" },
  { table: "research_lines", column: "findings_envelope", key: "id" },
  { table: "report_versions", column: "body_envelope", key: "id" },
  { table: "report_entries", column: "entry_envelope", key: "id" },
];

app.post("/api/audit/reseal", async (c) => {
  const denied = await requireOperator(c);
  if (denied) return c.json(deny(denied), denied);
  const parsed = ResealBodySchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_body" }, 422);
  const st = await getState(c.env);
  const oldKit = await createVaultKit(
    parsed.data.old_server_secret,
    parsed.data.old_encryption_key,
  );
  const resealed: Record<string, number> = {};
  let skipped = 0;
  let failed = 0;
  for (const { table, column, key } of RESEAL_COLUMNS) {
    const rows = await c.env.DB.prepare(
      `SELECT ${key} AS k, ${column} AS v FROM ${table}`,
    ).all<{ k: string | number; v: string | null }>();
    const list = Array.isArray(rows) ? rows : rows.results;
    const statements = [];
    let n = 0;
    for (const row of list) {
      const envelope = String(row.v ?? "");
      if (!envelope.startsWith("v1.")) continue;
      try {
        await openText(st.kit, envelope);
        skipped++;
        continue;
      } catch {
        // Not readable with the current kit: try the previous one.
      }
      try {
        const text = await openText(oldKit, envelope);
        statements.push(
          c.env.DB.prepare(
            `UPDATE ${table} SET ${column} = ? WHERE ${key} = ?`,
          ).bind(await sealText(st.kit, text), row.k),
        );
        n++;
      } catch {
        failed++;
      }
    }
    if (statements.length > 0) await c.env.DB.batch(statements);
    resealed[`${table}.${column}`] = n;
  }
  await st.audit("audit:reseal");
  return c.json({ ok: failed === 0, resealed, skipped, failed });
});

// At-rest storage audit (operator-only): envelope shapes only, never
// values. Lets the smoke script prove ciphertext-only storage on a live
// installation without decrypting anything.
app.get("/api/audit/ciphertext", async (c) => {
  const denied = await requireOperator(c);
  if (denied) return c.json(deny(denied), denied);
  const collect = async (sql: string): Promise<{ total: number; malformed: number }> => {
    const rows = await c.env.DB.prepare(sql).all<{ v: string | null }>();
    const list = Array.isArray(rows) ? rows : rows.results;
    const values = list.map((r) => String(r.v ?? ""));
    const blob = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
    return {
      total: values.length,
      malformed: values.filter((v) => !blob.test(v)).length,
    };
  };
  const messages = await collect("SELECT body_envelope AS v FROM messages");
  const corpus = await collect("SELECT text_envelope AS v FROM corpus_docs");
  const entities = await collect("SELECT name_envelope AS v FROM entities");
  const versions = await collect("SELECT body_envelope AS v FROM report_versions");
  const malformed =
    messages.malformed + corpus.malformed + entities.malformed + versions.malformed;
  return c.json({
    ok: malformed === 0,
    messages,
    corpus,
    entities,
    report_versions: versions,
  });
});

app.get("/api/telemetry", async (c) => {  const denied = await requireOperator(c);
  if (denied)
    return c.json(
      { error: denied === 404 ? "not_found" : "unauthorised" },
      denied as 401 | 404,
    );
  return c.json(await listTelemetry(c.env.DB, 100));
});

app.post("/api/setup", async (c) => {
  const denied = await requireOperator(c);
  if (denied)
    return c.json(
      { error: denied === 404 ? "not_found" : "unauthorised" },
      denied as 401 | 404,
    );
  const st = await getState(c.env);
  const current = await st.loadSetup();
  const raw = (await c.req.json()) as Record<string, unknown>;
  // Save-time validation: a custom entry may carry a one-time `apiKey`
  // for its test call. Validate first, fail loud, then strip the key —
  // only slot names are ever persisted.
  if (raw.kind === "providers" && Array.isArray(raw.providers)) {
    for (const p of raw.providers as Array<Record<string, unknown>>) {
      if (typeof p.apiKey === "string" && p.apiKey.length > 0) {
        const result = await validateCustomProvider({
          label: p.label,
          baseUrl: p.base_url ?? p.baseUrl,
          model: p.model,
          apiKey: p.apiKey,
        });
        if (!result.ok) {
          return c.json({ error: "provider_invalid", detail: result.error }, 422);
        }
        delete p.apiKey;
      }
    }
  }
  const parsed = SetupStepSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: "invalid_step" }, 422);
  }
  try {
    const next = validateSetupStep(current, parsed.data);
    await st.putSetup(next);
    return c.json(next);
  } catch (err) {
    return c.json(
      { error: "phase_error", detail: (err as Error).message },
      422,
    );
  }
});

const CfCredsSchema = z.object({
  cf_token: z.string().min(1).max(4096),
  account_id: z.string().min(1).max(64),
  script_name: z.string().min(1).max(128),
});

const ProvisionBodySchema = CfCredsSchema.extend({
  name: z.string().min(1).max(64).default("surveyor"),
});

// Secrets the runtime provisioner installs. Generated slots are minted
// in-flight; operator-supplied slots are presence-checked only.
// OPERATOR_TOKEN is always operator-supplied: the provisioner requires it
// to run, and minting a replacement it never reveals would lock the
// operator out (the bootstrap screen owns the fresh-install choice).
const PROVISION_SECRETS = [
  { slot: "SERVER_SECRET", generate: true },
  { slot: "ENCRYPTION_KEY", generate: true },
  { slot: "OPERATOR_TOKEN", generate: false },
  { slot: "GROQ_API_KEY", generate: false },
  { slot: "TOKENROUTER_API_KEY", generate: false },
  { slot: "TURNSTILE_SECRET", generate: false },
];

// Runtime provision (R3): the operator consents through OAuth, then the
// installation ensures its Cloudflare resources and persists a receipt for
// teardown. Generated secret values never leave these stack frames.
app.post("/api/provision", async (c) => {
  const denied = await requireOperator(c);
  if (denied) return c.json(deny(denied), denied);
  const parsed = ProvisionBodySchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_body" }, 422);
  const p = parsed.data;
  await getState(c.env); // boot the schema (provision receipt table)
  const api = createCloudflareApi({
    accountId: p.account_id,
    scriptName: p.script_name,
    token: p.cf_token,
  });
  try {
    const receipt = await provisionStack(api, {
      name: p.name,
      subdomain: "",
      secrets: PROVISION_SECRETS,
    });
    const now = new Date().toISOString();
    await c.env.DB.prepare(
      "INSERT INTO provision (id, receipt_json, created_at) VALUES (1, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET receipt_json = excluded.receipt_json, created_at = excluded.created_at",
    )
      .bind(JSON.stringify(receipt), now)
      .run();
    return c.json({ ok: true, receipt });
  } catch (err) {
    const step = err instanceof ProvisionError ? err.step : "unknown";
    return c.json(
      { error: "provision_failed", step, detail: (err as Error).message },
      502,
    );
  }
});

app.post("/api/teardown", async (c) => {
  const denied = await requireOperator(c);
  if (denied)
    return c.json(
      { error: denied === 404 ? "not_found" : "unauthorised" },
      denied as 401 | 404,
    );
  const st = await getState(c.env);
  const current = await st.loadSetup();
  if (current.phase !== "ready") {
    return c.json({ error: "setup_incomplete" }, 409);
  }
  const row = await c.env.DB.prepare(
    "SELECT receipt_json FROM provision WHERE id = 1",
  ).first<{ receipt_json: string }>();
  let teardown: { wiped: Record<string, string>; not_wiped: string[] } | null =
    null;
  if (row) {
    const raw = await c.req.json().catch(() => ({}));
    const parsed = CfCredsSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "cloudflare_credentials_required" }, 422);
    }
    const api = createCloudflareApi({
      accountId: parsed.data.account_id,
      scriptName: parsed.data.script_name,
      token: parsed.data.cf_token,
    });
    try {
      const receipt = JSON.parse(row.receipt_json) as ProvisionReceipt;
      teardown = await teardownStack(api, receipt);
    } catch (err) {
      return c.json(
        { error: "teardown_failed", detail: (err as Error).message },
        502,
      );
    }
  }
  await st.audit("teardown:requested");
  await st.putSetup({
    phase: "welcome",
    providers: [],
    instrument: null,
    installed_at: null,
  });
  return c.json(
    teardown ?? {
      wiped: {
        local_setup_state: "reset-to-fresh",
        audit_history: "retained (intentionally)",
      },
      not_wiped: [
        "no provision receipt — nothing to delete",
        "cloudflare-account-logs-and-analytics (outside our control)",
      ],
    },
  );
});

export interface EngineParams {
  line_id?: string;
  angle_id?: string;
}

/** Staged pipeline entrypoint: research-line bookkeeping and scheduled
 *  digests. Extraction/serving stays with the HTTP paths so steps remain
 *  resumable without duplicating provider calls.
 *
 *  The base class must be the runtime's own `WorkflowEntrypoint` (from
 *  `cloudflare:workers`), not a look-alike: workerd addresses this class as
 *  the workflow's named entrypoint, and an inert fallback would refuse to
 *  run ("not an actor") the moment an instance is created. */
export class EngineWorkflow extends WorkflowEntrypoint<Bindings, EngineParams> {
  async run(
    event: CloudflareWorkersModule.WorkflowEvent<EngineParams>,
    step: CloudflareWorkersModule.WorkflowStep,
  ): Promise<void> {
    const env = this.env;
    const params = event.payload ?? {};
    if (params.line_id) {
      await step.do("record-line-opened", async () => {
        const { recordTurn } = await import("./lib/telemetry");
        await recordTurn(env.DB, {
          tier: "workflow",
          toolCalls: 0,
          label: `line:${params.angle_id ?? "unknown"}`,
          outcome: "opened",
        });
        return params.line_id;
      });
    }
    await step.do("evaluate-report-frequencies", async () => {
      const st = await getState(env);
      const client = await liveClient(env.DB, env);
      return evaluateAll(env.DB, st.kit, new Date().toISOString(), client);
    });
  }
}

export default {
  fetch: app.fetch,
  // Cron trigger: scheduled digests evaluate on the platform clock, and the
  // raw-byte retention sweep enforces the deletion window for held bytes
  // that no drain reached. The sweep runs first so expired raw material is
  // gone before any render reads the mirror.
  async scheduled(
    _event: ScheduledEvent,
    env: Bindings,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const st = await getState(env);
    const client = await liveClient(env.DB, env);
    const nowIso = new Date().toISOString();
    await sweepRawBytes(env, nowIso);
    await evaluateAll(env.DB, st.kit, nowIso, client);
  },
  // Queue consumer: held corpus docs enqueue here and drain through their
  // lane handler. Failures retry; files stay held with a reason when no
  // capable provider is configured. Nothing user-visible depends on the
  // queue succeeding — uploads are already durable in R2 + D1.
  async queue(
    batch: MessageBatch<IngestMessage>,
    env: Bindings,
    _ctx: ExecutionContext,
  ): Promise<void> {
    for (const msg of batch.messages) {
      try {
        if (msg.body.kind === "attachment") {
          const { drainAttachmentById } = await import("./lib/attachments");
          await drainAttachmentById(env, msg.body.doc_id);
        } else {
          const { drainDocById } = await import("./routes/corpus");
          await drainDocById(env, msg.body.doc_id);
        }
        msg.ack();
      } catch (err) {
        void err;
        msg.retry();
      }
    }
  },
};
