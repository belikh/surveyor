// Token-fallback scopes: the minimal Cloudflare API token permissions the
// provisioner needs, and the revocation guidance shown after a token-paste
// install. Least privilege is a security claim, so it is enumerated here
// and asserted in tests — never implied.

export const REQUIRED_SCOPES: string[] = [
  "workers:write",
  "d1:write",
  "r2:write",
  "queues:write",
  "workflows:write",
  "secrets:write",
  "triggers:write",
];
// NOTE: names are abstract. The Cloudflare API adapter maps each to the
// concrete token permission at the call site; the abstract list is what
// least-privilege is asserted against in tests.

export interface ScopeCheck {
  missing: string[];
}

export function checkScopes(granted: string[]): ScopeCheck {
  const have = new Set(granted);
  return { missing: REQUIRED_SCOPES.filter((s) => !have.has(s)) };
}

export const REVOCATION_GUIDANCE =
  "Token-paste installs use a short-lived scoped token. Revoke it in the " +
  "Cloudflare dashboard immediately after provisioning, then rotate any " +
  "secret it touched. Blast radius of a leaked installer token is limited " +
  "to the listed scopes and nothing else it can reach.";
