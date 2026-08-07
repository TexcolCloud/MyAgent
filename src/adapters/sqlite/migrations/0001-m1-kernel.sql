CREATE TABLE agent_revisions (
  revision_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  content_json TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  agent_revision_id TEXT NOT NULL REFERENCES agent_revisions(revision_id),
  owner_session_id TEXT REFERENCES sessions(session_id) ON DELETE CASCADE,
  current_summary_id TEXT REFERENCES session_summaries(summary_id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (agent_id, session_key)
);

CREATE TABLE messages (
  message_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  run_id TEXT,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  run_fifo_sequence INTEGER,
  role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (session_id, sequence),
  FOREIGN KEY (run_id, session_id)
    REFERENCES runs(run_id, session_id) ON DELETE CASCADE
);

CREATE TABLE session_summaries (
  summary_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  from_message_sequence INTEGER NOT NULL CHECK (from_message_sequence >= 0),
  to_message_sequence INTEGER NOT NULL CHECK (to_message_sequence >= from_message_sequence),
  content TEXT NOT NULL,
  model_provider TEXT NOT NULL,
  model_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TRIGGER sessions_current_summary_owner_on_insert
BEFORE INSERT ON sessions
FOR EACH ROW
WHEN NEW.current_summary_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM session_summaries
    WHERE summary_id = NEW.current_summary_id
      AND session_id = NEW.session_id
  )
BEGIN
  SELECT RAISE(ABORT, 'current_summary_owner_mismatch');
END;

CREATE TRIGGER sessions_current_summary_owner_on_update
BEFORE UPDATE OF current_summary_id, session_id ON sessions
FOR EACH ROW
WHEN NEW.current_summary_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM session_summaries
    WHERE summary_id = NEW.current_summary_id
      AND session_id = NEW.session_id
  )
BEGIN
  SELECT RAISE(ABORT, 'current_summary_owner_mismatch');
END;

CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  agent_revision_id TEXT NOT NULL REFERENCES agent_revisions(revision_id),
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'waiting_approval', 'waiting_reconciliation', 'completed', 'failed', 'cancelled')),
  fifo_sequence INTEGER NOT NULL CHECK (fifo_sequence >= 0),
  parent_run_id TEXT REFERENCES runs(run_id) ON DELETE CASCADE,
  root_run_id TEXT REFERENCES runs(run_id) ON DELETE CASCADE,
  delegation_depth INTEGER NOT NULL CHECK (delegation_depth >= 0),
  blocked_by_child_run_id TEXT REFERENCES runs(run_id) ON DELETE SET NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  cancellation_requested_at TEXT,
  active_started_at TEXT,
  model_turn_count INTEGER NOT NULL DEFAULT 0 CHECK (model_turn_count >= 0),
  tool_call_count INTEGER NOT NULL DEFAULT 0 CHECK (tool_call_count >= 0),
  child_run_count INTEGER NOT NULL DEFAULT 0 CHECK (child_run_count >= 0),
  active_elapsed_seconds INTEGER NOT NULL DEFAULT 0 CHECK (active_elapsed_seconds >= 0),
  tool_output_bytes INTEGER NOT NULL DEFAULT 0 CHECK (tool_output_bytes >= 0),
  request_digest TEXT NOT NULL,
  input_json TEXT NOT NULL,
  output_json TEXT,
  failure_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (session_id, fifo_sequence),
  UNIQUE (run_id, session_id)
);

CREATE UNIQUE INDEX runs_one_blocking_per_session
  ON runs(session_id)
  WHERE state IN ('running', 'waiting_approval', 'waiting_reconciliation');

CREATE INDEX runs_fifo_queued
  ON runs(created_at, run_id)
  WHERE state = 'queued';

CREATE TABLE run_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, sequence)
);

CREATE TABLE run_activated_skills (
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  skill_name TEXT NOT NULL,
  skill_version INTEGER NOT NULL CHECK (skill_version >= 0),
  content_sha256 TEXT NOT NULL,
  activated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, skill_name)
);

CREATE TABLE tool_calls (
  tool_call_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('proposed', 'allowed', 'waiting_approval', 'denied', 'executing', 'succeeded', 'failed', 'unknown')),
  tool_name TEXT NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('read_only', 'side_effect', 'internal')),
  arguments_json TEXT NOT NULL,
  canonical_arguments TEXT NOT NULL,
  arguments_sha256 TEXT NOT NULL,
  policy_effect TEXT NOT NULL CHECK (policy_effect IN ('allow', 'ask', 'deny')),
  matched_rule INTEGER,
  policy_facts_json TEXT NOT NULL DEFAULT '{}',
  retry_of_tool_call_id TEXT REFERENCES tool_calls(tool_call_id) ON DELETE SET NULL,
  result_json TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tool_call_id, run_id)
);

CREATE TRIGGER tool_calls_arguments_immutable
BEFORE UPDATE OF arguments_json, canonical_arguments, arguments_sha256 ON tool_calls
FOR EACH ROW
WHEN NEW.arguments_json <> OLD.arguments_json
  OR NEW.canonical_arguments <> OLD.canonical_arguments
  OR NEW.arguments_sha256 <> OLD.arguments_sha256
BEGIN
  SELECT RAISE(ABORT, 'immutable_tool_call_arguments');
END;

CREATE TABLE approvals (
  approval_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'denied', 'expired')),
  arguments_sha256 TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution_reason TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (tool_call_id, run_id)
    REFERENCES tool_calls(tool_call_id, run_id) ON DELETE CASCADE
);

CREATE TABLE reconciliations (
  reconciliation_id TEXT PRIMARY KEY,
  tool_call_id TEXT NOT NULL UNIQUE REFERENCES tool_calls(tool_call_id) ON DELETE CASCADE,
  retry_tool_call_id TEXT UNIQUE REFERENCES tool_calls(tool_call_id) ON DELETE SET NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('not_executed', 'executed', 'retry')),
  note TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE idempotency_keys (
  agent_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, session_key, key)
);

CREATE TRIGGER idempotency_keys_owner_on_insert
BEFORE INSERT ON idempotency_keys
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM runs
  JOIN sessions ON sessions.session_id = runs.session_id
  WHERE runs.run_id = NEW.run_id
    AND sessions.agent_id = NEW.agent_id
    AND sessions.session_key = NEW.session_key
)
BEGIN
  SELECT RAISE(ABORT, 'idempotency_key_owner_mismatch');
END;

CREATE TRIGGER idempotency_keys_owner_on_update
BEFORE UPDATE OF agent_id, session_key, run_id ON idempotency_keys
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM runs
  JOIN sessions ON sessions.session_id = runs.session_id
  WHERE runs.run_id = NEW.run_id
    AND sessions.agent_id = NEW.agent_id
    AND sessions.session_key = NEW.session_key
)
BEGIN
  SELECT RAISE(ABORT, 'idempotency_key_owner_mismatch');
END;

CREATE TABLE outbox_deliveries (
  delivery_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  run_id TEXT,
  channel TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'sending', 'delivered', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT NOT NULL,
  delivered_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (run_id, session_id)
    REFERENCES runs(run_id, session_id) ON DELETE CASCADE
);

CREATE INDEX outbox_deliveries_pending
  ON outbox_deliveries(next_attempt_at, delivery_id)
  WHERE state IN ('pending', 'failed');
