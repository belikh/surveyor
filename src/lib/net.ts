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

/** Expand an IPv6 literal to its 16 bytes, or null when it is not one.
 *  Handles "::" compression once; bracketed forms are stripped by callers. */
function ipv6ToBytes(host: string): number[] | null {
  if (!host.includes(":")) return null;
  const parts = host.split("::");
  if (parts.length > 2) return null;
  const parseGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      const n = parseInt(group, 16);
      out.push((n >> 8) & 0xff, n & 0xff);
    }
    return out;
  };
  const head = parseGroups(parts[0]);
  if (!head) return null;
  if (parts.length === 1) return head.length === 16 ? head : null;
  const tail = parseGroups(parts[1]);
  if (!tail) return null;
  const fill = 16 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

function isPrivateIpv6(host: string): boolean {
  const b = ipv6ToBytes(host.toLowerCase());
  if (!b) return true; // unparseable: fail closed
  const u16 = (i: number) => (b[i] << 8) | b[i + 1];
  if (b.every((x) => x === 0)) return true; // ::
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true; // ::1
  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10
  if (b[0] === 0xff) return true; // ff00::/8 multicast
  // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96) addresses
  // embed the IPv4 address in the last four bytes.
  if (
    b.slice(0, 10).every((x) => x === 0) &&
    (u16(5) === 0xffff || u16(5) === 0)
  ) {
    return isPrivateIpv4(b.slice(12));
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
