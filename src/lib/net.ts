// Network destination policy for operator-supplied provider base URLs.
// A base URL is where an API key gets sent, so it must not be usable as an
// SSRF primitive: only https to a public host is allowed. Loopback,
// link-local, private, CGNAT, multicast, reserved addresses and internal
// naming conventions are rejected, including integer/obfuscated IPv4 forms
// (WHATWG URL parsing normalises those before we see the hostname).

function parseIpv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    nums.push(n);
  }
  return nums;
}

function isPrivateIpv4([a, b]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // link-local + metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true; // 192.0.0.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateIpv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "::" || h === "::1") return true;
  if (/^fe[89ab]/.test(h)) return true; // fe80::/10
  if (/^f[cd]/.test(h)) return true; // fc00::/7 unique-local
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) {
    const v4 = parseIpv4(mapped[1]);
    return v4 ? isPrivateIpv4(v4) : true;
  }
  return false;
}

/** True when a provider base URL is safe to send a credential to. */
export function isAllowedProviderBaseUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (host.includes(":")) return !isPrivateIpv6(host);
  const v4 = parseIpv4(host);
  if (v4) return !isPrivateIpv4(v4);
  // A public DNS name always carries a dot; single-label names are internal.
  return host.includes(".");
}
