ALTER TABLE provider_connections ADD COLUMN provider_driver TEXT;

UPDATE provider_connections
SET provider_driver = CASE provider_kind
  WHEN 'openai' THEN 'pi/openai'
  WHEN 'deepseek' THEN 'pi/deepseek'
  ELSE 'pi/openai-compatible'
END
WHERE provider_driver IS NULL;

ALTER TABLE model_profile_revisions
ADD COLUMN runtime_contract_json TEXT;

DROP TRIGGER model_profile_revisions_content_immutable;

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
