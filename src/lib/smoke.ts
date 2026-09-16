// Installation smoke checks: pure helpers shared by the script and tests.
// A check returns a receipt; failures carry an actionable detail. Nothing
// here prints or stores secret values.

export interface Receipt {
  name: string;
  status: "pass" | "fail" | "skip";
  detail: string;
}

export function pass(name: string, detail: string): Receipt {
  return { name, status: "pass", detail };
}

export function fail(name: string, detail: string): Receipt {
  return { name, status: "fail", detail };
}

export function skip(name: string, detail: string): Receipt {
  return { name, status: "skip", detail };
}

/** Expected response headers for FR-13-style hardening. */
export const REQUIRED_HEADERS: Array<[string, string]> = [
  ["content-security-policy", "default-src 'none'"],
  ["x-content-type-options", "nosniff"],
  ["referrer-policy", "no-referrer"],
  ["x-frame-options", "DENY"],
];

export function auditHeaders(
  headers: Record<string, string | null>,
): Receipt[] {
  return REQUIRED_HEADERS.map(([name, expected]) => {
    const got = headers[name] ?? "";
    return got.includes(expected)
      ? pass(`header:${name}`, got.slice(0, 80))
      : fail(`header:${name}`, `expected to contain "${expected}", got "${got}"`);
  });
}

/** Proof-of-work solver (mirrors the survey driver). */
export async function solvePow(
  challenge: string,
  difficulty: number,
): Promise<string> {
  const enc = new TextEncoder();
  for (let nonce = 0; ; nonce++) {
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", enc.encode(`${challenge}:${nonce}`)),
    );
    let bits = 0;
    for (const byte of digest) {
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
    if (bits >= difficulty) return String(nonce);
    if (nonce % 1000 === 0) await new Promise((r) => setTimeout(r, 0));
  }
}

/** Ciphertext audit: every stored envelope must be a v1 blob. */
export function auditCiphertext(
  envelopes: string[],
  forbiddenPlaintext: string[],
): Receipt {
  const blob = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
  const bad = envelopes.filter((e) => !blob.test(e));
  if (bad.length > 0) {
    return fail(
      "ciphertext:v1-envelopes",
      `${bad.length} value(s) not v1 envelopes`,
    );
  }
  const haystack = envelopes.join("\n");
  const leaked = forbiddenPlaintext.filter((p) => p && haystack.includes(p));
  if (leaked.length > 0) {
    return fail(
      "ciphertext:no-plaintext",
      `plaintext marker present in stored envelope`,
    );
  }
  return pass(
    "ciphertext:v1-envelopes",
    `${envelopes.length} envelope(s) inspected`,
  );
}

export function summarise(receipts: Receipt[]): {
  ok: boolean;
  passed: number;
  failed: number;
  skipped: number;
} {
  return {
    ok: !receipts.some((r) => r.status === "fail"),
    passed: receipts.filter((r) => r.status === "pass").length,
    failed: receipts.filter((r) => r.status === "fail").length,
    skipped: receipts.filter((r) => r.status === "skip").length,
  };
}

export function formatReceipt(r: Receipt): string {
  const mark = r.status === "pass" ? "PASS" : r.status === "fail" ? "FAIL" : "SKIP";
  return `[${mark}] ${r.name} — ${r.detail}`;
}
