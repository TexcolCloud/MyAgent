# Own local service lifecycle and state by workspace

A Local Integrated Host is the sole owner of its embedded service lifecycle: it starts Bootstrap without Bootstrap signal handlers, attaches the TUI, and always invokes the returned idempotent shutdown path after TUI normal exit, failure, or startup failure. Before an interactive exit with active or pending-Approval Runs, the TUI presents an impact summary and requires confirmation. Its service is short-lived, but Project Agent State remains durable under the Workspace `.myagent/` directory; shutting down preserves Runs, Approvals, Model Registry revisions, and encrypted Secret metadata for recovery and later sessions.

## Consequences

The Host reuses Bootstrap's listener-first, SQLite-last cleanup path rather than closing worker, gateway, or database resources itself. Existing durable Run behavior governs work interrupted by local exit: safe work may be aborted, while ambiguous side effects remain recoverable rather than being marked complete.
