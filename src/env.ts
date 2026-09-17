// Environment bindings for the surveyor worker.

export interface IngestMessage {
  doc_id: string;
  lane: string;
  /** "corpus" (default) or "attachment": which drain owns the message. */
  kind?: "corpus" | "attachment";
}

export interface Bindings {
  DB: D1Database;
  /** Async ingestion queue: held docs enqueue here for the drain. */
  INGEST: Queue<IngestMessage>;
  /** Staged journalism pipeline. */
  ENGINE: Workflow;
  /** Workers AI binding: keyless baseline tier. */
  AI: Ai;
  // Operator token. When set, setup/teardown writes require it via
  // constant-time compare; when unset (local dev / bootstrap), the write
  // routes answer 404 — disabled-until-set, the house pattern.
  OPERATOR_TOKEN: string;
  SERVER_SECRET?: string;
  ENCRYPTION_KEY?: string;
  POW_DIFFICULTY?: string;
  TURNSTILE_SECRET?: string;
  /** Public Turnstile sitekey; exposed on /api/status only while the
   *  secret is set, so the survey shell can render the widget. A sitekey
   *  is public by design — it is not a secret. */
  TURNSTILE_SITEKEY?: string;
  // Wizard OAuth consent (R2, ADR-0013): PKCE public client. The client id
  // and endpoints are public vars; no client secret is embedded or sent.
  CF_OAUTH_CLIENT_ID?: string;
  CF_OAUTH_AUTHORIZE_URL?: string;
  CF_OAUTH_TOKEN_URL?: string;
  CF_OAUTH_SCOPES?: string;
  /** Corpus object store: held-doc raw bytes live here, never in D1. */
  CORPUS?: R2Bucket;
}
