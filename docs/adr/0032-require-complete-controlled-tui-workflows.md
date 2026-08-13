# Require complete controlled TUI workflows

TUI-first is complete only when the TUI supports the full interactive Operator path for Provider Connections, secret-reference state, discovery, Model Profiles and Verification, promotion and retirement, Agent assignments/defaults, Session and Run creation/history/cancellation/reconnection, Approvals, and redacted operational diagnostics. Dangerous or complex state changes use Controlled TUI Workflows that show affected resources and revision/conflict state, require explicit confirmation, never render secret plaintext, and retain an Automation Surface for high-risk recovery operations.

## Considered Options

- A chat/setup/approval-only TUI would preserve an ongoing CLI dependency for ordinary management and recovery work.
- Generic confirmation dialogs do not expose the revision, scope, or durable impact needed for promotion, retirement, reconciliation, deletion, or secret-adjacent actions.
