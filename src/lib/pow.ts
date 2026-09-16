// Stateless HMAC proof-of-work: identity-free anti-spam (constitution VI).
// challenge = base64url(ts "." difficulty "." sigHex)
// Client finds nonce with SHA-256(challenge ":" nonce) having `difficulty`
// leading zero bits. No storage, no identity.

import { b64urlDecode, b64urlEncode, toHex } from "./vault";

const enc = new TextEncoder();

export const POW_WINDOW_MS = 10 * 60 * 1000;
export const POW_DIFFICULTY_MIN = 8;
export const POW_DIFFICULTY_MAX = 24;

export interface Challenge {
  challenge: string;
  difficulty: number;
  expires_at: string;
}

async function signHex(key: CryptoKey, msg: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return toHex(new Uint8Array(sig));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function leadingZeroBits(b: Uint8Array): number {
  let bits = 0;
  for (const byte of b) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    let mask = 0x80;
    while (mask && !(byte & mask)) {
      bits++;
      mask >>= 1;
    }
    break;
  }
  return bits;
}

export async function issueChallenge(
  powKey: CryptoKey,
  difficulty = 16,
  now = Date.now(),
): Promise<Challenge> {
  const d = Math.min(POW_DIFFICULTY_MAX, Math.max(POW_DIFFICULTY_MIN, difficulty));
  const sig = await signHex(powKey, `pow:${now}:${d}`);
  return {
    challenge: b64urlEncode(enc.encode(`${now}.${d}.${sig}`)),
    difficulty: d,
    expires_at: new Date(now + POW_WINDOW_MS).toISOString(),
  };
}

export async function verifyChallenge(
  powKey: CryptoKey,
  challenge: string,
  nonce: string,
  difficulty: number,
  now = Date.now(),
): Promise<{ ok: boolean; reason?: string }> {
  let ts = 0;
  let d = 0;
  let sig = "";
  try {
    const [tsS, dS, sigS] = new TextDecoder()
      .decode(b64urlDecode(challenge))
      .split(".");
    ts = Number(tsS);
    d = Number(dS);
    sig = sigS ?? "";
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!Number.isFinite(ts) || d !== difficulty) {
    return { ok: false, reason: "mismatch" };
  }
  if (now - ts > POW_WINDOW_MS || ts > now + 60_000) {
    return { ok: false, reason: "expired" };
  }
  const expected = await signHex(powKey, `pow:${ts}:${d}`);
  if (!timingSafeEqual(sig, expected)) {
    return { ok: false, reason: "forged" };
  }
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", enc.encode(`${challenge}:${nonce}`)),
  );
  if (leadingZeroBits(digest) < d) {
    return { ok: false, reason: "weak" };
  }
  return { ok: true };
}

/** Test/CLI solver: brute-force a nonce (only sane at low difficulty). */
export async function solveChallenge(
  challenge: string,
  difficulty: number,
): Promise<number> {
  let nonce = 0;
  for (;;) {
    const digest = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        enc.encode(`${challenge}:${nonce}`),
      ),
    );
    if (leadingZeroBits(digest) >= difficulty) return nonce;
    nonce++;
    if (nonce % 100000 === 0) await new Promise((r) => setTimeout(r, 0));
  }
}
