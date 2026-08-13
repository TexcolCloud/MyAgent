# TUI-First Workflows

Use `myagent` or `myagent tui` for local operation. Local mode owns a loopback
service with ephemeral credentials and starts from the project `.myagent` state.
Use `myagent tui --api-url <loopback-origin>` to attach to an existing service.
Remote attachment requires the explicit remote override and an exact origin
confirmation.

The TUI is the normal interactive path for Provider Connections, secret
reference state, model discovery, Model Profiles, Verification, promotion,
retirement, Agent assignments, Sessions, Runs, Approvals, and Diagnostics.
Review the affected resource and revision before confirming destructive or
state-changing actions. The UI renders Secret references and status only; it
does not render Secret plaintext.

For CI, scripts, recovery, and integrations use the versioned [HTTP Automation
Surface](./http-automation-v1.md). It carries the same authority, concurrency,
SSE-resume, backup, and Problem Details contracts without adding an API-wrapper
CLI command. `myagent doctor` remains read-only and secret-safe. Backups remain
a public CLI option and an HTTP automation route.

During the one-minor migration window, legacy resource commands still work but
write one stderr deprecation notice. Do not build new automation on them. The
only Recovery Commands are explicitly spelled `myagent internal config reload`,
`myagent internal tools reconcile`, and `myagent internal secrets
rotate-master-key`.
