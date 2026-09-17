// Wizard OAuth consent (R2, ADR-0013): a PKCE public client. The operator
// authorises Cloudflare so the installation can write its own provider
// secrets without anyone manually creating a scoped API token. The
// authorisation code is exchanged with the code verifier (S256) for a
// short-lived access token, which is handed back to the wizard in the URL
// fragment — client-side only — and forwarded with the key-entry request.
// No client_secret is sent or embedded: the public client authenticates at
// the token endpoint with method `none`. The server never stores the
// access token.

import { b64urlEncode, codeHmac, type VaultKit } from "./vault";

export const DEFAULT_AUTHORIZE_URL = "https://dash.cloudflare.com/oauth2/auth";
export const DEFAULT_TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";
/** Minimal scopes: write Worker secrets, read the account's script list. */
export const DEFAULT_SCOPES = "workers-scripts.write account.read";

export interface OAuthConfig {
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string;
  redirectUri: string;
}

const STATE_TTL_MS = 10 * 60 * 1000;

/** Signed, timestamped OAuth state (replay-bounded, no server storage). */
export async function signState(kit: VaultKit, ts: number): Promise<string> {
  return `${ts}.${await codeHmac(kit, `oauth:${ts}`)}`;
}

export async function verifyState(
  kit: VaultKit,
  state: string,
  now: number,
): Promise<boolean> {
  const dot = state.indexOf(".");
  if (dot < 1) return false;
  const tsText = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const ts = Number(tsText);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > STATE_TTL_MS) return false;
  const expected = await codeHmac(kit, `oauth:${tsText}`);
  if (sig.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/** RFC 7636 code verifier: 32 random bytes as base64url (43 characters). */
export function generateCodeVerifier(): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

/** RFC 7636 S256 challenge: base64url(SHA-256(ASCII(verifier))). */
export async function codeChallengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return b64urlEncode(new Uint8Array(digest));
}

export function authorizeUrl(
  cfg: OAuthConfig,
  state: string,
  challenge: string,
): string {
  const u = new URL(cfg.authorizeUrl);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("scope", cfg.scopes);
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

export async function exchangeOAuthCode(
  cfg: OAuthConfig,
  code: string,
  codeVerifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    code_verifier: codeVerifier,
  });
  // Public client: no client_secret; the token endpoint auth method is
  // `none` (ADR-0013). The verifier proves the code came back to the same
  // browser session that started the flow.
  const res = await fetchImpl(cfg.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string };
  if (!res.ok || typeof data.access_token !== "string" || data.access_token.length === 0) {
    // Status only — never echo a token-endpoint body.
    throw new Error(`oauth token exchange failed: HTTP ${res.status}`);
  }
  return data.access_token;
}
