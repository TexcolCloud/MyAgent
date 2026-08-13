# Use in-memory dual capability tokens for local mode

Each Local Integrated Host generates distinct cryptographically random Run and Admin Session Capability Tokens, injects them directly into its loopback HTTP app and TUI Client, and retains them only in memory for that host lifetime. This preserves the existing single trusted Operator authority model without prematurely introducing role-based access control. Random loopback ports reduce exposure but do not replace authorization; tokens must never enter process environment, command arguments, shell history, logs, configuration, or SQLite.

Local Integrated Mode supplies those credentials through an in-process Bootstrap authentication override. It does not resolve, export, or persist the configured Service Credential References used by Explicit Service Mode; an initialized project may retain those references for a later explicit `serve` invocation without containing their values.

## Considered Options

- A single token would collapse the current separation between ordinary Run ingress and Model Control Plane/Approval authority.
- Loopback-only access would authorize unrelated local processes that discover the listener.
- OS-specific IPC identity would replace the project-wide HTTP/SSE boundary and add a separate transport/security model.
