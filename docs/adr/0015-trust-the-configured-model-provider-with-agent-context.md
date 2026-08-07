# Treat the configured model provider as a trusted data processor

The configured model provider may receive the Agent prompt, relevant Session history, selected Skill instructions, Memory, retrieved Knowledge Base excerpts, and Tool results needed for a Run. Secrets are excluded and telemetry is disabled by default; requiring local inference or per-record data classification would establish a different trust boundary and is outside the first release.
