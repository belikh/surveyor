// Vault crypto kit: envelopes, access codes, HMAC identities. Values are
// sealed with AES-GCM before storage; only HMACs are ever queryable.
// Secret VALUES never leave these functions (constitution II).

const enc = new TextEncoder();

export function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function fromHex(hexStr: string): Uint8Array {
  const out = new Uint8Array(hexStr.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hexStr.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export const ACCESS_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export interface VaultKit {
  powKey: CryptoKey;
  encKey: CryptoKey;
  codeKey: CryptoKey;
  nameKey: CryptoKey;
}

async function hmacKey(secret: string, domain: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(`${domain}:${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export async function createVaultKit(
  serverSecret: string,
  encKeyHex: string,
): Promise<VaultKit> {
  const [powKey, codeKey, nameKey] = await Promise.all([
    hmacKey(serverSecret, "pow"),
    hmacKey(serverSecret, "code"),
    hmacKey(serverSecret, "name"),
  ]);
  const encKey = await crypto.subtle.importKey(
    "raw",
    fromHex(encKeyHex),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
  return { powKey, encKey, codeKey, nameKey };
}

/** PoW-only key for tests and the challenge endpoint. */
export async function createPowKey(secret: string): Promise<CryptoKey> {
  return hmacKey(secret, "pow");
}

/** Seal text into a versioned envelope. IV is unique per call. */
export async function sealText(kit: VaultKit, text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, kit.encKey, enc.encode(text)),
  );
  return `v1.${b64urlEncode(iv)}.${b64urlEncode(ct)}`;
}

export async function openText(kit: VaultKit, envelope: string): Promise<string> {
  const parts = envelope.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") throw new Error("bad envelope");
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64urlDecode(parts[1]) },
    kit.encKey,
    b64urlDecode(parts[2]).slice().buffer as ArrayBuffer,
  );
  return new TextDecoder().decode(pt);
}

/** XXXX-XXXX access code from the unambiguous alphabet. */
export function accessCode(): string {
  const rand = crypto.getRandomValues(new Uint8Array(8));
  const chars = Array.from(
    rand,
    (b) => ACCESS_CODE_ALPHABET[b % ACCESS_CODE_ALPHABET.length],
  );
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

async function hmacHex(key: CryptoKey, msg: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return toHex(new Uint8Array(sig));
}

/** Stable HMAC of an access code — the only code-derived value stored. */
export function codeHmac(kit: VaultKit, code: string): Promise<string> {
  return hmacHex(kit.codeKey, code);
}

/** Cross-submission corroboration join key for a quarantined name. */
export function nameHmac(kit: VaultKit, name: string): Promise<string> {
  return hmacHex(kit.nameKey, name.toLowerCase());
}
