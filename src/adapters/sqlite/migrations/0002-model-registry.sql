ALTER TABLE tool_calls ADD COLUMN provider_call_id TEXT;

CREATE TRIGGER tool_calls_provider_call_id_immutable
BEFORE UPDATE OF provider_call_id ON tool_calls
FOR EACH ROW
WHEN OLD.provider_call_id IS NOT NULL
  AND NEW.provider_call_id IS NOT OLD.provider_call_id
BEGIN
  SELECT RAISE(ABORT, 'immutable_provider_call_id');
END;

CREATE TABLE provider_connections (
  connection_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL CHECK (length(display_name) > 0),
  provider_kind TEXT NOT NULL CHECK (provider_kind IN ('openai', 'deepseek', 'openai_compatible')),
  active_revision_id TEXT,
  retired_at TEXT,
  record_revision INTEGER NOT NULL DEFAULT 0 CHECK (record_revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (active_revision_id)
    REFERENCES provider_connection_revisions(revision_id) ON DELETE RESTRICT
);

CREATE TABLE provider_connection_revisions (
  revision_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES provider_connections(connection_id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN (
    'draft', 'verifying', 'failed', 'verified', 'active',
    'superseded', 'retired', 'legacy_trusted'
  )),
  base_url TEXT NOT NULL CHECK (length(base_url) > 0),
  auth_json TEXT NOT NULL CHECK (json_valid(auth_json)),
  allow_insecure_http INTEGER NOT NULL CHECK (allow_insecure_http IN (0, 1)),
  protocol_preference TEXT NOT NULL CHECK (protocol_preference IN ('chat_completions', 'responses')),
  preset_version TEXT NOT NULL CHECK (length(preset_version) > 0),
  created_at TEXT NOT NULL,
  UNIQUE (revision_id, connection_id)
);

CREATE TRIGGER provider_connection_revisions_content_immutable
BEFORE UPDATE OF revision_id, connection_id, base_url, auth_json,
  allow_insecure_http, protocol_preference, preset_version, created_at
ON provider_connection_revisions
FOR EACH ROW
WHEN NEW.revision_id IS NOT OLD.revision_id
  OR NEW.connection_id IS NOT OLD.connection_id
  OR NEW.base_url IS NOT OLD.base_url
  OR NEW.auth_json IS NOT OLD.auth_json
  OR NEW.allow_insecure_http IS NOT OLD.allow_insecure_http
  OR NEW.protocol_preference IS NOT OLD.protocol_preference
  OR NEW.preset_version IS NOT OLD.preset_version
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'immutable_provider_connection_revision');
END;

CREATE TRIGGER provider_connections_active_revision_owner_on_insert
BEFORE INSERT ON provider_connections
FOR EACH ROW
WHEN NEW.active_revision_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM provider_connection_revisions
    WHERE revision_id = NEW.active_revision_id
      AND connection_id = NEW.connection_id
  )
BEGIN
  SELECT RAISE(ABORT, 'connection_active_revision_owner_mismatch');
END;

CREATE TRIGGER provider_connections_active_revision_owner_on_update
BEFORE UPDATE OF active_revision_id, connection_id ON provider_connections
FOR EACH ROW
WHEN NEW.active_revision_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM provider_connection_revisions
    WHERE revision_id = NEW.active_revision_id
      AND connection_id = NEW.connection_id
  )
BEGIN
  SELECT RAISE(ABORT, 'connection_active_revision_owner_mismatch');
END;

CREATE TABLE model_profiles (
  profile_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL CHECK (length(display_name) > 0),
  active_revision_id TEXT,
  retired_at TEXT,
  record_revision INTEGER NOT NULL DEFAULT 0 CHECK (record_revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (active_revision_id)
    REFERENCES model_profile_revisions(revision_id) ON DELETE RESTRICT
);

CREATE TABLE model_profile_revisions (
  revision_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES model_profiles(profile_id) ON DELETE CASCADE,
  connection_revision_id TEXT NOT NULL REFERENCES provider_connection_revisions(revision_id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN (
    'draft', 'verifying', 'failed', 'verified', 'active',
    'superseded', 'retired', 'legacy_trusted'
  )),
  provider_model_id TEXT NOT NULL CHECK (length(provider_model_id) > 0),
  invocation_protocol TEXT NOT NULL CHECK (invocation_protocol IN ('chat_completions', 'responses')),
  max_input_tokens INTEGER NOT NULL CHECK (max_input_tokens > 0),
  context_window_source TEXT NOT NULL CHECK (context_window_source IN ('preset', 'operator', 'assumed_32768')),
  capability_baseline TEXT NOT NULL CHECK (capability_baseline = 'text_and_single_tool_call_v1'),
  verified_capabilities_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(verified_capabilities_json)),
  created_at TEXT NOT NULL,
  UNIQUE (revision_id, profile_id)
);

CREATE TRIGGER model_profile_revisions_content_immutable
BEFORE UPDATE OF revision_id, profile_id, connection_revision_id,
  provider_model_id, invocation_protocol, max_input_tokens,
  context_window_source, capability_baseline, created_at
ON model_profile_revisions
FOR EACH ROW
WHEN NEW.revision_id IS NOT OLD.revision_id
  OR NEW.profile_id IS NOT OLD.profile_id
  OR NEW.connection_revision_id IS NOT OLD.connection_revision_id
  OR NEW.provider_model_id IS NOT OLD.provider_model_id
  OR NEW.invocation_protocol IS NOT OLD.invocation_protocol
  OR NEW.max_input_tokens IS NOT OLD.max_input_tokens
  OR NEW.context_window_source IS NOT OLD.context_window_source
  OR NEW.capability_baseline IS NOT OLD.capability_baseline
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'immutable_model_profile_revision');
END;

CREATE TRIGGER model_profiles_active_revision_owner_on_insert
BEFORE INSERT ON model_profiles
FOR EACH ROW
WHEN NEW.active_revision_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM model_profile_revisions
    WHERE revision_id = NEW.active_revision_id
      AND profile_id = NEW.profile_id
  )
BEGIN
  SELECT RAISE(ABORT, 'profile_active_revision_owner_mismatch');
END;

CREATE TRIGGER model_profiles_active_revision_owner_on_update
BEFORE UPDATE OF active_revision_id, profile_id ON model_profiles
FOR EACH ROW
WHEN NEW.active_revision_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM model_profile_revisions
    WHERE revision_id = NEW.active_revision_id
      AND profile_id = NEW.profile_id
  )
BEGIN
  SELECT RAISE(ABORT, 'profile_active_revision_owner_mismatch');
END;

CREATE TABLE model_assignments (
  agent_id TEXT PRIMARY KEY,
  model_profile_revision_id TEXT NOT NULL REFERENCES model_profile_revisions(revision_id) ON DELETE RESTRICT,
  source TEXT NOT NULL CHECK (source IN ('explicit', 'default', 'legacy_import')),
  record_revision INTEGER NOT NULL DEFAULT 0 CHECK (record_revision >= 0),
  updated_at TEXT NOT NULL
);

CREATE INDEX model_assignments_by_profile_revision
  ON model_assignments(model_profile_revision_id);

CREATE TABLE default_model_profile (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  profile_id TEXT NOT NULL REFERENCES model_profiles(profile_id) ON DELETE RESTRICT,
  record_revision INTEGER NOT NULL DEFAULT 0 CHECK (record_revision >= 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE model_registry_events (
  event_id TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  trace_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX model_registry_events_by_resource
  ON model_registry_events(resource_type, resource_id, created_at, event_id);

CREATE TRIGGER model_registry_events_no_update
BEFORE UPDATE ON model_registry_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'append_only_model_registry_events');
END;

CREATE TRIGGER model_registry_events_no_delete
BEFORE DELETE ON model_registry_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'append_only_model_registry_events');
END;

CREATE TABLE discovery_generations (
  generation_id TEXT PRIMARY KEY,
  connection_revision_id TEXT NOT NULL REFERENCES provider_connection_revisions(revision_id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('fresh', 'stale', 'empty', 'unsupported', 'failed')),
  fetched_at TEXT,
  expires_at TEXT,
  error_code TEXT,
  safe_status INTEGER,
  trace_id TEXT NOT NULL,
  record_revision INTEGER NOT NULL DEFAULT 0 CHECK (record_revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX discovery_generations_by_connection
  ON discovery_generations(connection_revision_id, fetched_at DESC, generation_id DESC);

CREATE TABLE discovered_models (
  generation_id TEXT NOT NULL REFERENCES discovery_generations(generation_id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  owner TEXT,
  model_created_at TEXT,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (generation_id, model_id)
);

CREATE TABLE model_verifications (
  verification_id TEXT PRIMARY KEY,
  profile_revision_id TEXT NOT NULL REFERENCES model_profile_revisions(revision_id) ON DELETE CASCADE,
  capability_baseline TEXT NOT NULL CHECK (capability_baseline = 'text_and_single_tool_call_v1'),
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'passed', 'failed', 'cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  capabilities_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(capabilities_json)),
  result_code TEXT,
  safe_status INTEGER,
  usage_json TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)),
  trace_id TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  cancellation_requested_at TEXT,
  fallback_verification_id TEXT REFERENCES model_verifications(verification_id) ON DELETE SET NULL,
  record_revision INTEGER NOT NULL DEFAULT 0 CHECK (record_revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX model_verifications_claimable
  ON model_verifications(state, lease_expires_at, created_at, verification_id);
CREATE INDEX model_verifications_by_profile
  ON model_verifications(profile_revision_id, created_at DESC, verification_id DESC);

CREATE TABLE provider_health (
  health_id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_revision_id TEXT NOT NULL REFERENCES provider_connection_revisions(revision_id) ON DELETE CASCADE,
  profile_revision_id TEXT REFERENCES model_profile_revisions(revision_id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  code TEXT,
  safe_status INTEGER,
  trace_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  record_revision INTEGER NOT NULL DEFAULT 0 CHECK (record_revision >= 0)
);

CREATE UNIQUE INDEX provider_health_exact_target
  ON provider_health(connection_revision_id, COALESCE(profile_revision_id, ''));

CREATE TABLE managed_secret_versions (
  version_id TEXT PRIMARY KEY,
  secret_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose = 'provider_api_key'),
  key_id TEXT NOT NULL,
  ciphertext BLOB,
  nonce BLOB,
  authentication_tag BLOB,
  state TEXT NOT NULL CHECK (state IN ('active', 'destroyed')),
  record_revision INTEGER NOT NULL DEFAULT 0 CHECK (record_revision >= 0),
  created_at TEXT NOT NULL,
  destroyed_at TEXT
);

CREATE INDEX managed_secret_versions_by_secret
  ON managed_secret_versions(secret_id, created_at, version_id);

CREATE TABLE managed_secret_keyring (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  current_key_id TEXT NOT NULL,
  record_revision INTEGER NOT NULL DEFAULT 0 CHECK (record_revision >= 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE legacy_model_imports (
  source_sha256 TEXT PRIMARY KEY,
  migration_version INTEGER NOT NULL CHECK (migration_version = 1),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  record_revision INTEGER NOT NULL DEFAULT 0 CHECK (record_revision >= 0),
  created_at TEXT NOT NULL
);
