// Cloudflare secret writer for the BYOK key-entry path (R2). Given a
// transient, operator-authorised Cloudflare token, it writes a provider
// secret into the installation's own Worker. The token and the secret value
// are in-flight only: never persisted, logged, telemetered, or returned.
// The CF API is injectable so the path is testable without an account.

const API_BASE = "https://api.cloudflare.com/client/v4";

export interface SecretsContext {
  accountId: string;
  scriptName: string;
  /** Transient, operator-authorised CF token. Never stored. */
  token: string;
}

/** Secret slot names are env-binding shaped; constrain them hard so they
 *  cannot inject path segments or arbitrary bindings. */
export const SECRET_SLOT = /^[A-Z][A-Z0-9_]{0,63}$/;

interface CfEnvelope {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
}

async function cfCall(
  fetchImpl: typeof fetch,
  ctx: SecretsContext,
  path: string,
  init: RequestInit,
): Promise<void> {
  const url =
    `${API_BASE}/accounts/${encodeURIComponent(ctx.accountId)}` +
    `/workers/scripts/${encodeURIComponent(ctx.scriptName)}${path}`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      ...init,
      headers: {
        authorization: `Bearer ${ctx.token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  } catch (err) {
    throw new Error(
      `cloudflare api unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const data = (await res.json().catch(() => ({}))) as CfEnvelope;
  // Status only — never echo a response body that could reflect a secret.
  if (!res.ok || data.success === false) {
    throw new Error(`cloudflare api HTTP ${res.status}`);
  }
}

/** Write (add or rotate) a Worker secret. Idempotent for a given slot. */
export async function putWorkerSecret(
  ctx: SecretsContext,
  name: string,
  value: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!SECRET_SLOT.test(name)) throw new Error("invalid secret slot name");
  await cfCall(fetchImpl, ctx, "/secrets", {
    method: "PUT",
    body: JSON.stringify({ name, text: value, type: "secret_text" }),
  });
}

/** Delete a Worker secret. `allowed` is the caller's allow-list: a slot
 *  outside it is never deleted, whatever its shape. SECRET_SLOT only bounds
 *  an env-binding name; it says nothing about which bindings a route owns. */
export async function deleteWorkerSecret(
  ctx: SecretsContext,
  name: string,
  allowed: ReadonlySet<string>,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!allowed.has(name)) throw new Error("secret slot not deletable");
  await cfCall(fetchImpl, ctx, `/secrets/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
}
