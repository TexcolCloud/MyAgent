ALTER TABLE provider_connections ADD COLUMN provider_driver TEXT;

UPDATE provider_connections
SET provider_driver = CASE provider_kind
  WHEN 'openai' THEN 'pi/openai'
  WHEN 'deepseek' THEN 'pi/deepseek'
  ELSE 'pi/openai-compatible'
END
WHERE provider_driver IS NULL;

DROP TRIGGER model_profile_revisions_content_immutable;

PRAGMA legacy_alter_table = ON;
PRAGMA defer_foreign_keys = ON;

ALTER TABLE model_profile_revisions RENAME TO model_profile_revisions_v2;

CREATE TABLE model_profile_revisions (
  revision_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES model_profiles(profile_id) ON DELETE CASCADE,
  connection_revision_id TEXT NOT NULL REFERENCES provider_connection_revisions(revision_id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN (
    'draft', 'verifying', 'failed', 'verified', 'active',
    'superseded', 'retired', 'legacy_trusted'
  )),
  provider_model_id TEXT NOT NULL CHECK (length(provider_model_id) > 0),
  invocation_protocol TEXT NOT NULL CHECK (
    invocation_protocol IN ('chat_completions', 'responses', 'pi_ai')
  ),
  runtime_contract_json TEXT,
  max_input_tokens INTEGER NOT NULL CHECK (max_input_tokens > 0),
  context_window_source TEXT NOT NULL CHECK (
    context_window_source IN ('preset', 'operator', 'assumed_32768')
  ),
  capability_baseline TEXT NOT NULL CHECK (
    capability_baseline = 'text_and_single_tool_call_v1'
  ),
  verified_capabilities_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(verified_capabilities_json)
  ),
  created_at TEXT NOT NULL,
  UNIQUE (revision_id, profile_id)
);

INSERT INTO model_profile_revisions (
  revision_id, profile_id, connection_revision_id, state,
  provider_model_id, invocation_protocol, runtime_contract_json,
  max_input_tokens, context_window_source, capability_baseline,
  verified_capabilities_json, created_at
)
SELECT
  revision_id, profile_id, connection_revision_id, state,
  provider_model_id, invocation_protocol, NULL,
  max_input_tokens, context_window_source, capability_baseline,
  verified_capabilities_json, created_at
FROM model_profile_revisions_v2;

DROP TABLE model_profile_revisions_v2;

PRAGMA legacy_alter_table = OFF;

CREATE TRIGGER model_profile_revisions_content_immutable
BEFORE UPDATE OF revision_id, profile_id, connection_revision_id,
  provider_model_id, invocation_protocol, runtime_contract_json,
  max_input_tokens, context_window_source, capability_baseline, created_at
ON model_profile_revisions
FOR EACH ROW
WHEN NEW.revision_id IS NOT OLD.revision_id
  OR NEW.profile_id IS NOT OLD.profile_id
  OR NEW.connection_revision_id IS NOT OLD.connection_revision_id
  OR NEW.provider_model_id IS NOT OLD.provider_model_id
  OR NEW.invocation_protocol IS NOT OLD.invocation_protocol
  OR NEW.runtime_contract_json IS NOT OLD.runtime_contract_json
  OR NEW.max_input_tokens IS NOT OLD.max_input_tokens
  OR NEW.context_window_source IS NOT OLD.context_window_source
  OR NEW.capability_baseline IS NOT OLD.capability_baseline
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'immutable_model_profile_revision');
END;

CREATE TRIGGER provider_connections_driver_immutable
BEFORE UPDATE OF provider_driver ON provider_connections
FOR EACH ROW
WHEN NEW.provider_driver IS NOT OLD.provider_driver
BEGIN
  SELECT RAISE(ABORT, 'immutable_provider_driver');
END;
