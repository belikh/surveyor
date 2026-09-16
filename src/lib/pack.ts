// Launch pack: seven assets per installation, all public-safe by
// construction. The audit is structural (bare URL, no tracking vectors)
// plus operator-supplied identity terms. Australian English throughout.

export interface LaunchPack {
  submissions_url: string;
  qr_square_svg: string;
  qr_story_svg: string;
  copy_short: string;
  copy_long: string;
  copy_dm: string;
  alt_text: string;
}

export type AuditResult = { ok: true } | { ok: false; error: string };

/** Phrases that must never appear in pack copy (login/tracking claims).
 *  Matched whole-phrase: "no login, nothing tracked" stays legal. */
const BANNED_PHRASES = [
  "log in",
  "log-in",
  "sign in",
  "sign-in",
  "employee account",
  "we log",
  "you are tracked",
  "will be tracked",
];

export function buildCopy(url: string): Pick<
  LaunchPack,
  "copy_short" | "copy_long" | "copy_dm" | "alt_text"
> {
  return {
    copy_short:
      "Current or former staff: an independent anonymous survey is open. " +
      `No accounts, no tracking. ${url}`,
    copy_long:
      "An anonymous survey is collecting testimony. Submissions are " +
      "encrypted before storage and identifying details are never kept. " +
      `${url}`,
    copy_dm: `Hi — this anonymous survey may matter to you. No login, nothing tracked: ${url}`,
    alt_text: "QR code linking to an anonymous survey",
  };
}

/**
 * Structural + identity audit. Fails closed: any tracking vector, any
 * operator term, or any banned claim anywhere in the pack rejects it.
 */
export function auditPack(
  pack: LaunchPack,
  forbiddenTerms: string[],
): AuditResult {
  const assets = [
    pack.submissions_url,
    pack.copy_short,
    pack.copy_long,
    pack.copy_dm,
    pack.alt_text,
  ];
  // Specific tracking markers first (precise errors), then the bare-URL
  // rule that rejects any query or fragment at all.
  const rawLower = pack.submissions_url.toLowerCase();
  for (const t of ["utm_", "fbclid", "gclid", "msclkid", "mc_cid", "_ga"]) {
    if (rawLower.includes(t)) {
      return { ok: false, error: `tracking risk: marker ${t}` };
    }
  }
  let url: URL;
  try {
    url = new URL(pack.submissions_url);
  } catch {
    return { ok: false, error: "submissions_url is not a URL" };
  }
  if (url.search || url.hash) {
    return { ok: false, error: "tracking risk: URL must be bare (no query or fragment)" };
  }
  const haystack = assets.join("\n").toLowerCase();
  for (const term of forbiddenTerms) {
    if (term.trim() && haystack.includes(term.toLowerCase())) {
      return { ok: false, error: `identity risk: pack names "${term}"` };
    }
  }
  for (const phrase of BANNED_PHRASES) {
    for (const field of [pack.copy_short, pack.copy_long, pack.copy_dm]) {
      if (field.toLowerCase().includes(phrase)) {
        return { ok: false, error: `copy risk: banned claim "${phrase}"` };
      }
    }
  }
  return { ok: true };
}

/** URL-safe slug for the public survey path. */
export function mintSlug(): string {
  const rand = crypto.getRandomValues(new Uint8Array(9));
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  return Array.from(rand, (b) => alphabet[b % alphabet.length]).join("");
}
