# Local Integrated Mode Operations

## Command Matrix

| Invocation | Mode | Configuration | Service and credentials |
| --- | --- | --- | --- |
| `myagent` | Local Integrated | `.myagent/myagent.yaml` | Owns one foreground random-port loopback service and fresh memory-only Run/Admin capabilities |
| `myagent tui` | Local Integrated | `.myagent/myagent.yaml` | Identical to `myagent` |
| `myagent tui --local` | Local Integrated | `.myagent/myagent.yaml` | Explicit spelling of the same local mode |
| `myagent tui --api-url <origin>` | Attached TUI | No project configuration | Attaches to exactly the named service using approved external credential sources |
| `myagent serve [--config <path>]` | Explicit Service | `myagent.yaml` by default | Runs the configured service in the foreground using configured Secret references |

`--config <path>` changes the Local Integrated project configuration for the
first three entries. It cannot be combined with Attached TUI Mode. `--local`
cannot be combined with `--api-url`. Selection is based only on command syntax:
MyAgent does not probe a conventional port, discover, reuse, or replace another
service.

All TUI entries require interactive stdin and stdout. Redirected input or
output fails before project initialization or credential acquisition.

## First Run and Project Ownership

Local Integrated Mode owns Project Agent State beneath the workspace:

```text
.myagent/
  myagent.yaml
  state.sqlite
  agents/
  skills/
```

When the complete state is absent, the CLI displays its resolved location and
requires explicit confirmation before writing. Initialization creates the
minimum version 2 configuration and empty managed roots only. It does not
create or infer an Agent, Provider, Secret, Model Profile, default Model,
Assignment, Channel, or Schedule.

A noninteractive start and a declined prompt leave the workspace unchanged. A
partial state is rejected for manual recovery. Benign concurrent initializers
use create-only installation: one may complete, while the other fails without
overwriting the installed configuration. Initialization does not promise
protection from a malicious process that can replace same-identity filesystem
entries during the portable stat-to-unlink cleanup window.

An existing root `myagent.yaml` is not imported automatically. Name it with
`--config` when it is intentionally the local project configuration.

## Authentication Boundary

For each Local Integrated invocation, MyAgent generates distinct Run and Admin
capability tokens and supplies them directly to Bootstrap and the in-process
TUI client. They remain in process memory. Local mode does not resolve or
export the service credential references retained in `.myagent/myagent.yaml`,
and token values are not accepted in local argv, persisted configuration,
SQLite, diagnostics, or logs.

Loopback binding and an ephemeral port reduce exposure; they are not caller
authorization. The TUI still crosses the authenticated HTTP/SSE boundary and
does not call application services, repositories, Tools, or provider adapters
directly.

Attached TUI Mode uses credentials supplied by its approved external source:
named TUI environment variables, an available credential helper, or masked
terminal input. It prints only the normalized origin, TLS state, and credential
source categories. Token command-line flags are rejected. A non-loopback
origin also requires `--allow-remote` and exact entry of the displayed
normalized origin. This consent acknowledges the destination; it does not add
TLS, authenticate the remote server, or secure an HTTP connection.

## Foreground Lifetime and Exit

Local Integrated Mode owns one service, its workers, provider gateway, and
SQLite connection for exactly the TUI foreground lifetime. The listener binds
`127.0.0.1` with port `0`. Normal exit, TUI failure, and startup cleanup close
owned resources; no Local Integrated worker remains in the background.

Before exit, the TUI reads committed active Runs and pending Approvals through
HTTP. A clean state exits immediately. Otherwise it shows active Run IDs and
statuses plus the pending Approval count, then requires explicit confirmation.
Declining resumes the TUI. Confirming closes the host; it does not rewrite
durable incomplete or ambiguous work as successful.

Use Explicit Service Mode for a long-lived foreground service needed by
independent clients, automation, Channels, or Schedules. `myagent serve` is not
a daemon launcher: its lifetime is still the foreground process, and its Run
and Admin credentials come from the Secret references in the selected service
configuration.

## Recovery After Interruption

After a terminal close, process kill, host crash, or machine restart:

1. Confirm no earlier `myagent` or `myagent serve` process is still intended to
   own the project database.
2. Start Local Integrated Mode again from the same workspace, or name the same
   configuration with `--config`.
3. Inspect active Runs and pending Approvals in the TUI. Durable state is
   reopened; interrupted leases and committed events are recovered by the
   existing worker and SSE cursor rules.
4. Reconcile any Tool Call whose side effect is recorded as uncertain. Do not
   mark it successful merely because the process stopped after dispatch.
5. Use the documented backup, model-registry, or narrowly scoped Recovery
   Command procedures when the reported durable state requires them.

Do not delete `state.sqlite`, its WAL files, or partial project state as a
generic recovery step. Preserve the project directory for diagnosis and
restore from a known backup if integrity cannot be established.

## Verified Boundary

The deterministic release proof exercises CLI consent, project initialization,
real Bootstrap on an OS-selected loopback port, authenticated TUI HTTP access,
foreground shutdown, listener closure, SQLite reopening, and a second start
without provider credentials. A separate leak proof injects sentinel local
capabilities and checks captured stdout, stderr, structured logs, recursively
read `.myagent/` files, and safe SQLite row projections without printing the
sentinels in its failure report.
