// Web snapshot store (B7, ADR-0017): fetch a page installation-side, extract
// its text, and keep the result as an immutable evidence copy. The snapshot
// is the citation target — never the live URL and never a provider fragment.
// Provenance travels with the record: requested and final URL, fetch time,
// status, content type, a SHA-256 of the extracted text, byte length and the
// extractor version. Snapshots are private: the raw capture sits in the
// operator's R2 bucket and the extracted text is sealed at rest like the
// mirror.
//
// Fetch hygiene at the snapshot boundary: https to public hosts only,
// credentials refused, redirect hops re-validated against the destination
// policy, bounded body size, a timeout and a descriptive User-Agent. A
// non-2xx or non-text capture never yields a citation, so nothing is stored
// for one.

import { isAllowedProviderBaseUrl } from "./net";
import { injectionFlags } from "./engine";
import { openText, sealText, type VaultKit } from "./vault";

export const EXTRACTOR = "workers-ai-toMarkdown";
export const EXTRACTOR_VERSION = "1";
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
export const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 20_000;
const USER_AGENT = "Surveyor/1.0 (investigation evidence snapshot)";

/** Textual capture types a snapshot may hold. Anything else is not evidence. */
const TEXT_CONTENT_TYPES = [
  "text/html",
  "application/xhtml+xml",
  "text/plain",
];

export type SnapshotErrorCode =
  | "url_not_allowed"
  | "fetch_failed"
  | "too_many_redirects"
  | "http_status"
  | "unsupported_content_type"
  | "too_large"
  | "no_extractor"
  | "empty_extraction"
  | "no_storage";

export class SnapshotError extends Error {
  constructor(
    public readonly code: SnapshotErrorCode,
    detail: string,
  ) {
    super(`snapshot ${code}: ${detail}`);
    this.name = "SnapshotError";
  }
}

/** The stored provenance record; no text field reaches an operator surface. */
export interface SnapshotRecord {
  id: string;
  requested_url: string;
  final_url: string;
  fetched_at: string;
  http_status: number;
  content_type: string;
  content_sha256: string;
  byte_length: number;
  extractor: string;
  extractor_version: string;
  r2_key: string;
  flags: string[];
  provenance: "untrusted";
}

/** A capture in flight: the record plus the text the engine may read now. */
export interface SnapshotCapture extends SnapshotRecord {
  text: string;
}

/** Subset of the Workers AI binding the snapshot extractor uses. */
export interface SnapshotAi {
  toMarkdown?(input: { name: string; blob: Blob }): Promise<unknown>;
}

export interface SnapshotDeps {
  db: D1Database;
  kit: VaultKit;
  r2?: R2Bucket;
  ai?: SnapshotAi;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Follow redirects by hand so every hop is checked before it is fetched. */
async function fetchFollowingRedirects(
  fetchImpl: typeof fetch,
  startUrl: string,
): Promise<{ response: Response; finalUrl: string }> {
  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isAllowedProviderBaseUrl(url)) {
      throw new SnapshotError("url_not_allowed", url);
    }
    let response: Response;
    try {
      response = await fetchImpl(url, {
        redirect: "manual",
        headers: { "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      throw new SnapshotError("fetch_failed", `${url}: ${message(err)}`);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new SnapshotError("fetch_failed", `${url}: redirect without location`);
      }
      url = new URL(location, url).toString();
      continue;
    }
    return { response, finalUrl: url };
  }
  throw new SnapshotError("too_many_redirects", startUrl);
}

/** Read a response body up to a hard cap without buffering past it. */
async function readBounded(response: Response, max: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buf = await response.arrayBuffer();
    if (buf.byteLength > max) {
      throw new SnapshotError("too_large", `over ${max} bytes`);
    }
    return new Uint8Array(buf);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw new SnapshotError("too_large", `over ${max} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Fetch a URL and persist it as an immutable snapshot. Extraction goes
 * through the operator's own Workers AI binding: no provider sees the page,
 * and the extractor name and version ride on the record so a re-extraction
 * can be told apart later.
 */
export async function snapshotPage(
  deps: SnapshotDeps,
  rawUrl: string,
): Promise<SnapshotCapture> {
  if (!deps.r2) throw new SnapshotError("no_storage", "no object store bound");
  if (!deps.ai?.toMarkdown) {
    throw new SnapshotError("no_extractor", "Workers AI toMarkdown unavailable");
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date());

  const { response, finalUrl } = await fetchFollowingRedirects(fetchImpl, rawUrl);
  if (response.status < 200 || response.status >= 300) {
    throw new SnapshotError("http_status", `HTTP ${response.status} from ${finalUrl}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  const baseType = contentType.split(";")[0].trim().toLowerCase();
  if (!TEXT_CONTENT_TYPES.includes(baseType)) {
    throw new SnapshotError("unsupported_content_type", baseType || "(none)");
  }
  const bytes = await readBounded(response, MAX_SNAPSHOT_BYTES);

  const id = crypto.randomUUID();
  const fetchedAt = now().toISOString();
  let extracted: string;
  try {
    const raw = await deps.ai.toMarkdown({
      name: `snapshot-${id}`,
      blob: new Blob([bytes], { type: baseType }),
    });
    const res = (Array.isArray(raw) ? raw[0] : raw) as {
      format?: string;
      data?: string;
      error?: string;
    };
    extracted = (res?.data ?? "").trim();
    if (!extracted) {
      throw new SnapshotError(
        "empty_extraction",
        res?.error ? `extractor error: ${res.error}` : "no text extracted",
      );
    }
  } catch (err) {
    if (err instanceof SnapshotError) throw err;
    throw new SnapshotError("empty_extraction", message(err));
  }

  const contentSha256 = await sha256Hex(extracted);
  const byteLength = new TextEncoder().encode(extracted).length;
  const r2Key = `web/${id}.html`;
  const flags = injectionFlags(extracted);
  const record: SnapshotRecord = {
    id,
    requested_url: rawUrl,
    final_url: finalUrl,
    fetched_at: fetchedAt,
    http_status: response.status,
    content_type: baseType,
    content_sha256: contentSha256,
    byte_length: byteLength,
    extractor: EXTRACTOR,
    extractor_version: EXTRACTOR_VERSION,
    r2_key: r2Key,
    flags,
    provenance: "untrusted",
  };
  await deps.r2.put(r2Key, bytes);
  await deps.db
    .prepare(
      "INSERT INTO web_snapshots (id, requested_url, final_url, fetched_at, http_status, content_type, content_sha256, byte_length, extractor, extractor_version, r2_key, text_envelope, flags_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      id,
      rawUrl,
      finalUrl,
      fetchedAt,
      response.status,
      baseType,
      contentSha256,
      byteLength,
      EXTRACTOR,
      EXTRACTOR_VERSION,
      r2Key,
      await sealText(deps.kit, extracted),
      JSON.stringify(flags),
      fetchedAt,
    )
    .run();
  return { ...record, text: extracted };
}

export type WebCitationCheck =
  | { ok: true; flags: string[] }
  | { ok: false; error: "unknown_citation" | "invalid_citation"; detail: string };

/**
 * Validate a web citation against its snapshot and nothing else: the stored
 * text must still hash to the recorded digest, and the snippet must occur in
 * it verbatim. The live URL is never re-fetched — drift is recorded at
 * capture time, not chased afterwards. The snapshot's own suspicion flags
 * ride back with a pass so the caller can hold a poisoned page.
 */
export async function validateWebCitation(
  db: D1Database,
  kit: VaultKit,
  snapshotId: string,
  snippet: string,
): Promise<WebCitationCheck> {
  const row = await db
    .prepare(
      "SELECT text_envelope, content_sha256, flags_json FROM web_snapshots WHERE id = ?",
    )
    .bind(snapshotId)
    .first<{
      text_envelope: string;
      content_sha256: string;
      flags_json: string | null;
    }>();
  if (!row) return { ok: false, error: "unknown_citation", detail: snapshotId };
  let text: string;
  try {
    text = await openText(kit, row.text_envelope);
  } catch {
    return { ok: false, error: "invalid_citation", detail: snapshotId };
  }
  if ((await sha256Hex(text)) !== row.content_sha256) {
    return { ok: false, error: "invalid_citation", detail: snapshotId };
  }
  if (!text.includes(snippet)) {
    return { ok: false, error: "invalid_citation", detail: snapshotId };
  }
  let flags: string[] = [];
  try {
    const parsed = JSON.parse(row.flags_json ?? "[]") as unknown;
    if (Array.isArray(parsed)) {
      flags = parsed.filter((f): f is string => typeof f === "string");
    }
  } catch {
    flags = [];
  }
  return { ok: true, flags };
}
