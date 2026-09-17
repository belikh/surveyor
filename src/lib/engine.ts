// Journalism engine domain: angle proposal grounded in corpus exhibits,
// ranking with dedup, significance judging against the ledger, and
// suspicion flags. Deterministic extractive passes here; the LLM proposal
// and judge run at serving time through the provider registry (T2) and
// their outputs stay inside the untrusted fence.
//
// Library note (constitution IV): keywords() and normaliseTitle() are
// deliberately hand-rolled — ~15 lines of domain tokenisation with no
// library-shaped problem (no Aho-Corasick matcher, no edit-distance
// threshold) behind them. If fuzzy dedup is ever wanted, fast-levenshtein
// is the sanctioned pick.

export interface Exhibit {
  doc_id: string;
  snippet: string;
}

export interface CandidateAngle {
  title: string;
  rationale: string;
  exhibits: Exhibit[];
}

export interface CorpusDoc {
  doc_id: string;
  text: string;
}

const STOP = new Set(
  "the,a,an,and,or,of,to,in,on,for,with,are,is,was,were,be,been,by,at,from,as,it,its,this,that,these,those,what,when,how,about,into,than,then,there,their,they,you,your,we,our,us,have,has,had,do,does,did,not,no,yes,but,all,any,each,other,some,such,only,own,same,so,too,very,can,will,just,should,now,late".split(
    ",",
  ),
);

function keywords(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const w of text.toLowerCase().split(/[^a-z]+/)) {
    if (w.length > 3 && !STOP.has(w)) {
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  }
  return counts;
}

function snippetFor(text: string, term: string): string {
  const i = text.toLowerCase().indexOf(term);
  if (i === -1) return text.slice(0, 120);
  const start = Math.max(0, i - 40);
  return text.slice(start, start + 120);
}

/**
 * Propose one angle per topic with corpus exhibits: for each topic, find
 * documents sharing vocabulary with the topic and cite the best passages.
 * No exhibits, no angle — grounding is structural, not promised.
 */
export function proposeAngles(
  docs: CorpusDoc[],
  topics: string[],
): CandidateAngle[] {
  if (docs.length === 0 || topics.length === 0) return [];
  const angles: CandidateAngle[] = [];
  for (const topic of topics) {
    const terms = [...keywords(topic).keys()];
    const seeds = terms.length > 0 ? terms : [topic.toLowerCase()];
    const exhibits: Exhibit[] = [];
    for (const d of docs) {
      const lower = d.text.toLowerCase();
      const hit = seeds.find((t) => lower.includes(t));
      if (hit && d.text.trim().length > 0) {
        exhibits.push({ doc_id: d.doc_id, snippet: snippetFor(d.text, hit) });
      }
      if (exhibits.length >= 3) break;
    }
    if (exhibits.length > 0) {
      angles.push({
        title: `Angle: ${topic}`,
        rationale: `Grounded in ${exhibits.length} exhibit(s) sharing vocabulary with "${topic}".`,
        exhibits,
      });
    }
  }
  return angles;
}

function normaliseTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Rank by exhibit count (evidence first), deduping near-identical titles. */
export function rankAngles(angles: CandidateAngle[]): CandidateAngle[] {
  const seen = new Set<string>();
  const unique = angles.filter((a) => {
    const n = normaliseTitle(a.title);
    if (seen.has(n)) return false;
    seen.add(n);
    return true;
  });
  return unique.sort((x, y) => y.exhibits.length - x.exhibits.length);
}

// Invisible formatting characters: soft hyphen, zero-widths, word joiner,
// variation selectors and tag characters. They must not survive into the
// matching text — inside a token they split it past every pattern.
const INVISIBLE =
  /[\u00ad\u180e\u200b-\u200f\u2028-\u202f\u2060-\u2064\ufeff\ufe00-\ufe0f\u{e0000}-\u{e007f}]/gu;

/**
 * Canonical topic form for the settled-ground ledger: compatibility
 * normalise (full-width look-alikes), drop invisible formatting characters,
 * trim, collapse whitespace, lower-case. Both the candidates and every
 * ledger member are normalised so cosmetic variants cannot re-open settled
 * ground.
 */
export function normaliseTopic(t: string): string {
  return t
    .normalize("NFKC")
    .replace(INVISIBLE, " ")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * Significance judge (deterministic floor): which candidate topics are
 * genuinely new against the ledger set. The LLM judge at serving time may
 * only narrow this set further, never widen it — settled ground never
 * re-runs.
 */
export function judgeSignificance(
  candidates: string[],
  ledger: Set<string>,
): string[] {
  const settled = new Set([...ledger].map(normaliseTopic));
  return candidates.filter((t) => !settled.has(normaliseTopic(t)));
}

// Injection phrasing, matched on normalised text so re-spacing, hyphenation,
// newlines, zero-width characters and punctuation cannot slip a marker past
// the gate. Literal matching stays best-effort by design: a hit holds the
// line for human review, it is not a proof of intent.
const INJECTION_PATTERNS: RegExp[] = [
  /\bignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|earlier)?\s*instructions?\b/,
  /\bdisregard\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|earlier)?\s*instructions?\b/,
  /\b(?:system|developer)\s+prompt\b/,
  /\bjailbreak\b/,
  /\[\s*system\s*\]/,
];

/** Lower-case and collapse separators so spacing/punctuation variants match
 *  the same pattern. Invisible formatting characters are deleted, not
 *  rewritten to a space: they carry no word-separating meaning, and mapping
 *  them to a space would split a marker token (instruc\u200btions →
 *  "instruc tions") past every pattern. Brackets survive for `[system]`. */
function normaliseForMatching(s: string): string {
  return s
    .toLowerCase()
    .replace(INVISIBLE, "")
    .replace(/[^a-z0-9[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Injection markers found in a single piece of text, normalised so
 *  re-spacing, hyphenation, newlines, invisible characters and punctuation
 *  cannot slip a marker past the gate. */
export function injectionFlags(text: string): string[] {
  const flags: string[] = [];
  const normalised = normaliseForMatching(text);
  for (const pattern of INJECTION_PATTERNS) {
    const match = normalised.match(pattern);
    if (match) flags.push(`injection-marker:${match[0]}`);
  }
  return flags;
}

/**
 * Suspicion flags for a claim and its citations: injection markers, or no
 * exhibits at all. Snippets are scanned too — they render verbatim into
 * published report bodies, so a marker riding in one must hold the line.
 * Flagged lines are held from every downstream surface pending review.
 */
export function flagSuspicious(
  claim: string,
  exhibits: Exhibit[],
): string[] {
  const flags: string[] = [];
  for (const text of [claim, ...exhibits.map((e) => e.snippet)]) {
    flags.push(...injectionFlags(text));
  }
  if (exhibits.length === 0) {
    flags.push("ungrounded");
  }
  return [...new Set(flags)];
}
