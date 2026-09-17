-- Boot schema for the surveyor installation: setup state, provision
-- receipt (for teardown), audit log.

CREATE TABLE IF NOT EXISTS setup_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provision (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  receipt_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  ts TEXT NOT NULL,
  action TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS telemetry (
  ts TEXT NOT NULL,
  tier TEXT NOT NULL,
  tool_calls INTEGER NOT NULL,
  label TEXT,
  outcome TEXT
);

CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  code_hmac TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  kind TEXT NOT NULL DEFAULT 'original',
  parent_id TEXT,
  round INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  submission_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  kind TEXT NOT NULL,
  body_envelope TEXT NOT NULL,
  PRIMARY KEY (submission_id, seq)
);

CREATE TABLE IF NOT EXISTS entities (
  submission_id TEXT NOT NULL,
  label TEXT NOT NULL,
  name_envelope TEXT NOT NULL,
  name_hmac TEXT NOT NULL
);

-- Entity index over gated text: person nodes are the quarantine pseudonyms
-- (`[person A]`), joined to sealed entities by HMAC only. No real name ever
-- lands here; reruns converge via the primary key.
CREATE TABLE IF NOT EXISTS entity_index (
  submission_id TEXT NOT NULL,
  label TEXT NOT NULL,
  name_hmac TEXT NOT NULL,
  PRIMARY KEY (submission_id, label, name_hmac)
);
CREATE INDEX IF NOT EXISTS ix_entity_index_hmac ON entity_index(name_hmac);

CREATE TABLE IF NOT EXISTS topics (
  submission_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (submission_id, topic)
);

CREATE TABLE IF NOT EXISTS corpus_docs (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  lane TEXT NOT NULL,
  status TEXT NOT NULL,
  verdict TEXT NOT NULL,
  text_envelope TEXT NOT NULL,
  raw_key TEXT,
  reason TEXT,
  -- Bounded raw-bytes window (absolute); reset by a failed drain.
  retry_after TEXT,
  created_at TEXT NOT NULL
);

-- Gated mirror: scrubbed text only, never raw. Names live sealed in
-- entities; a mirror scan proving zero entity names runs against this.
CREATE VIRTUAL TABLE IF NOT EXISTS corpus_fts USING fts5(doc_id, text);

CREATE TABLE IF NOT EXISTS launch (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  slug TEXT NOT NULL,
  rotated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS angles (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  topics_json TEXT NOT NULL DEFAULT '[]',
  rationale_envelope TEXT NOT NULL,
  exhibits_json TEXT NOT NULL,
  rank INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','approved','rejected')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS research_lines (
  id TEXT PRIMARY KEY,
  angle_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','held','complete','rejected')),
  spend_cap INTEGER NOT NULL,
  spend_used INTEGER NOT NULL DEFAULT 0,
  citations_json TEXT NOT NULL DEFAULT '[]',
  findings_envelope TEXT NOT NULL DEFAULT '',
  flags_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  type TEXT PRIMARY KEY,
  config_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  enabled INTEGER NOT NULL DEFAULT 1,
  current_version INTEGER NOT NULL DEFAULT 0,
  sched_last_count INTEGER NOT NULL DEFAULT 0,
  sched_total INTEGER NOT NULL DEFAULT 0,
  approved_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS report_versions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  version INTEGER NOT NULL,
  body_envelope TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS eval_receipts (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  at TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  danger INTEGER NOT NULL DEFAULT 0
);

-- Structured journalist-pass entries (timeline events), sealed at rest.
-- Replaced atomically each pass; rendered deterministically into versions.
CREATE TABLE IF NOT EXISTS report_entries (
  id TEXT PRIMARY KEY,
  report_type TEXT NOT NULL,
  position INTEGER NOT NULL,
  entry_envelope TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Submitter attachments (FR-045-FR-050). Raw bytes live in R2 under
-- raw_key only while pending extraction; deleted on success. Extracted text
-- becomes testimony (a sealed message), never corpus mirror material.
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  filename TEXT NOT NULL,          -- sealed (may carry a name)
  media_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  status TEXT NOT NULL,            -- uploaded | parsed | OCRed | rescued | held
  raw_key TEXT,
  reason TEXT,
  retry_after TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_attachments_submission ON attachments(submission_id);

-- Retention windows per data category (D1, #44). One row; an absent row
-- means the safe defaults apply. Windows are milliseconds; the API speaks
-- whole hours. Categories that are the investigation's record are retained
-- and have no row here — a window for them is refused with a reason.
CREATE TABLE IF NOT EXISTS retention_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  config_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Deletion receipts (D2, #45). One append-only row per sweep run, readable
-- by the operator and the audit: per-category counts and the verification
-- result (was the object confirmed gone after the delete call?). Counts
-- only — never keys, filenames or content (constitution II).
CREATE TABLE IF NOT EXISTS retention_sweeps (
  id TEXT PRIMARY KEY,
  swept_at TEXT NOT NULL,
  receipt_json TEXT NOT NULL
);

-- Data-flow and residency receipts (D6, #49). Append-only snapshots of the
-- map naming each recipient (Cloudflare, each configured BYOK provider) and
-- the regions it may process in. Unsealed: recipients and regions are
-- operator configuration, and an auditor must be able to read the record.
CREATE TABLE IF NOT EXISTS data_flow_receipts (
  id TEXT PRIMARY KEY,
  map_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Breach assessments (Privacy Act Part IIIC). The facts and decision are
-- sealed in record_envelope; aware_at and decision stay plaintext so the
-- thirty-day assessment clock (s 26WH) is queryable without opening it.
CREATE TABLE IF NOT EXISTS breach_assessments (
  id TEXT PRIMARY KEY,
  aware_at TEXT NOT NULL,
  decision TEXT NOT NULL DEFAULT 'pending',
  record_envelope TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Generated privacy and collection notices (APP 1, APP 5). Notices are
-- public documents, so they are stored unsealed; every append-only version
-- carries the data-flow snapshot it was generated from.
CREATE TABLE IF NOT EXISTS notice_versions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  data_flows_json TEXT NOT NULL,
  operator_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (type, version)
);

-- Sensitive-category consent captures (APP 3.3). Decisions are sealed —
-- which categories a source consented to is itself sensitive information —
-- while the wording version stays plaintext so coverage can be grouped
-- without opening records. Captures are append-only; the latest decision
-- per category is the one in force.
CREATE TABLE IF NOT EXISTS consent_records (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL,
  wording_version INTEGER NOT NULL,
  record_envelope TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_consent_records_submission ON consent_records(submission_id);

-- Which sensitive categories a stored answer was tagged with. Joined by
-- HMAC so no category name sits in plaintext next to sealed testimony.
CREATE TABLE IF NOT EXISTS message_categories (
  submission_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  category_hmac TEXT NOT NULL,
  PRIMARY KEY (submission_id, seq, category_hmac)
);

-- Publication legal gate: one legal review per report version, and the
-- right-of-reply attempts logged against it. Reviewer, notes and reply
-- detail are sealed; version, reply_required and outcome stay plaintext so
-- the gate check and the audit list do not open records.
CREATE TABLE IF NOT EXISTS report_legal_records (
  id TEXT PRIMARY KEY,
  report_type TEXT NOT NULL,
  version INTEGER NOT NULL,
  reply_required INTEGER NOT NULL DEFAULT 1,
  record_envelope TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (report_type, version)
);

CREATE TABLE IF NOT EXISTS right_of_reply_attempts (
  id TEXT PRIMARY KEY,
  report_type TEXT NOT NULL,
  version INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  attempted_at TEXT NOT NULL,
  record_envelope TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_reply_attempts_report ON right_of_reply_attempts(report_type, version);
