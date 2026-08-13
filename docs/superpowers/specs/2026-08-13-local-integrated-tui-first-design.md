# Local Integrated Mode and TUI-first Product Design

**Status:** Approved by the Operator on 2026-08-13

## Goal

Make MyAgent behave like a local coding agent: `myagent` starts a private loopback service and its TUI as one foreground product, while the HTTP control plane, durable Runs, exact Approvals, Model Registry, Secret boundaries, and an explicit service mode remain intact.

## Product Modes

| Invocation | Mode | Service ownership | Credentials |
| --- | --- | --- | --- |
| `myagent` | Local Integrated Mode | Starts and owns one random-port loopback service | Fresh in-memory Run/Admin capability tokens |
| `myagent tui` | Local Integrated Mode | Same as `myagent` | Same as `myagent` |
| `myagent tui --local` | Local Integrated Mode | Same as `myagent` | Same as `myagent` |
| `myagent tui --api-url <origin>` | Attached TUI Mode | Connects to exactly the named service | Approved non-argv credential source |
| `myagent serve [--config <path>]` | Explicit Service Mode | Long-lived foreground service | Configured Secret references |

MyAgent never probes a default port, discovers another process, reuses another Local Service Instance, or decides between local and attached behavior from network state. Every local invocation owns a distinct service. `serve` remains a long-term supported mode for debugging, tests, automation, Channels, Schedules, and independently connected clients.

## Control-plane Boundary

HTTP and committed SSE remain the only TUI-to-application boundary in every mode. The TUI never calls application services, SQLite repositories, Secret stores, Tool implementations, provider adapters, or Pi-AI directly. Local Integrated Mode changes process ownership, not architectural authority.

The existing `/v1` API becomes the documented versioned Automation Surface. CI and scripts call it directly; MyAgent does not introduce a parallel `myagent api` wrapper. Narrow Recovery Commands remain possible for exceptional repair or security operations, but are not a general resource-management interface.

## Local Integrated Host

The Local Integrated Host performs this ordered lifecycle:

1. Resolve the Workspace and explicit `--config`, or default to `.myagent/myagent.yaml`.
2. If Project Agent State is absent, require interactive consent before initialization. A noninteractive invocation fails without writing.
3. Generate distinct cryptographically secure Run and Admin tokens.
4. Call `bootstrap()` with `127.0.0.1`, port `0`, disabled Bootstrap signal handlers, and an in-process authentication override.
5. Construct a TUI HTTP/SSE client from the returned URL and the two tokens.
6. Run the TUI until an approved exit or failure.
7. In `finally`, invoke the returned idempotent `shutdown()` and wait for the HTTP app, verification worker, approval expirer, Run worker, provider gateway, and SQLite connection to stop.

Startup failure follows the same cleanup guarantee. The Host never exports tokens to the environment or serializes them. Token values must not occur in argv, shell history, logs, config, SQLite, HTTP error details, diagnostics, or test snapshots. Random ports reduce exposure but do not authorize callers.

## Project State and Configuration

Project Agent State is durable and Workspace-scoped under `.myagent/`. Its default layout is:

```text
.myagent/
  myagent.yaml
  state.sqlite
  agents/
  skills/
```

Initialization creates only the minimum valid version 2 configuration and empty managed roots. It does not infer or create a Provider, API key, Model Profile, default Model, Agent, Model Assignment, Channel, or Schedule. Server credential fields remain non-secret environment references for a later Explicit Service Mode, but Local Integrated Mode neither resolves nor exports those references because its in-process authentication override is authoritative.

Local Integrated Mode does not silently import a legacy root `myagent.yaml`; using it requires `--config` or a later controlled migration. For compatibility, `serve` and `config validate` continue to default to root `myagent.yaml` unless `--config` is supplied.

## Setup and Agent Creation

After initialization, the TUI enters an explicit Setup Workflow. The Operator deliberately creates a named Agent, creates a Provider Connection using a Secret reference or masked managed-Secret input, discovers models, creates and verifies a Model Profile, promotes revisions, chooses a default or assignment, and only then creates a Run.

Agent creation remains inside the HTTP boundary. An Admin endpoint may atomically create the required Agent files only inside the configured managed `.myagent/agents` root and then use the normal catalog reload boundary. It must reject path escape, duplicate identity, invalid policy, partial writes, revision conflict, and configurations whose Agent root is not managed by the project. It never grants Tools merely because an Agent or Skill exists.

## Exit and Background Work

Local Integrated Mode is a Foreground Agent Host. Closing its TUI never leaves its service, workers, provider gateway, or Agent work running. Channels and Schedules require `serve` or a future explicit Background Agent Host.

Before exit, the TUI queries committed state and shows active Runs and pending Approvals. If either exists, exit requires explicit confirmation. Declining returns to the TUI. Confirming stops safe work through normal cancellation/shutdown behavior; durable Run and Approval records remain recoverable, and ambiguous side effects are never rewritten as successful completion.

## Attached and Remote TUI

`myagent tui --api-url` attaches only to the exact supplied origin. Non-loopback origins are rejected unless the Operator supplies `--allow-remote` and confirms the normalized origin. The TUI displays origin, TLS state, and credential-source category, never a credential value. Credentials may come from an OS credential helper, a named controlled environment variable, or a masked prompt; token values are forbidden in command arguments and configuration.

## TUI-first Completion Gate

The product is TUI-first only after the TUI supports all ordinary Operator workflows:

- Provider creation/revision, Secret-reference status, discovery, promotion, retirement, and health.
- Model Profile creation/revision, Verification status/cancellation, promotion, retirement, default selection, and Agent Assignment.
- Controlled Agent creation, Agent inspection, and assignment state.
- Session selection/history/deletion and Run creation/history/detail/cancellation/SSE reconnection.
- Exact pending Approval inspection and one-call approve/deny decisions.
- Read-only redacted diagnostics for config, database/migrations, workers/readiness, provider gateway, credentials, TTY, and listener state.

Every dangerous mutation shows the affected resource, expected revision, conflicts, impact, and an explicit confirmation. The TUI never renders Secret plaintext, raw authorization headers, raw provider responses, or unredacted logs.

## CLI Lifecycle

The stable public entries become `myagent`, `myagent tui`, `myagent serve`, `myagent config validate`, `myagent doctor`, and `myagent backup`.

For the next minor release, `providers *`, `models *`, `model setup`, `agents set-model`, `verifications get`, `run *`, `approvals *`, and `sessions *` remain executable and tested but are hidden from normal help/product guidance and emit deprecation notices. They are removed in the next major only after the TUI completion gate passes and `/v1` is documented as a supported automation contract. `tools reconcile`, `secrets rotate-master-key`, and `config reload` become explicit internal Recovery Commands.

`doctor` is read-only, supports human and JSON output, and never repairs state. `backup` remains public because it is both an Operator safety operation and an automation primitive.

## Test and Automation Boundaries

HTTP black-box tests remain the authoritative cross-process contract. Existing CLI integration tests remain through the deprecation window to prove compatibility, Secret safety, and stable exit codes. New local-mode tests inject bootstrap, token generation, TUI, terminal state, and filesystem seams; they never open real provider connections.

Required release evidence includes Windows and Linux deterministic suites, port `0` loopback binding, authentication separation, zero credential leakage, first-run consent/no-write behavior, cleanup on every exit path, active-Run exit confirmation, restart recovery, TUI optimistic conflicts, SSE cursor reconnection, and unchanged durable Run/Approval/Registry/Secret semantics. Live provider smoke remains opt-in.

## Phased Migration

1. Deliver Local Integrated Mode without removing any CLI boundary.
2. Complete TUI resource workflows and diagnostics behind the existing HTTP API.
3. Document `/v1`, hide and deprecate resource-management CLI commands for one minor release.
4. Remove those commands in the next major only after coverage and automation gates pass.

## Recorded Decisions

ADRs 0026 through 0036 record the HTTP boundary, primary entry, memory-only authentication, lifecycle and Workspace ownership, invocation safety, TUI-first CLI migration, completeness gate, foreground/background distinction, read-only diagnostics, remote consent, and project-local configuration.
