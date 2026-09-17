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
