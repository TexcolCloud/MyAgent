# HTTP Automation Surface v1

`/v1` is the supported Automation Surface for scripts, CI, and integrations.
There is no `myagent api` wrapper. Use a bearer token in `Authorization: Bearer
<token>`. Normal `/v1` routes require the Run token. `/v1/admin` routes require
the separate Admin token and are additionally accepted only from a loopback peer.

Every failure is a JSON Problem Details object with `code`, `detail`, and
`traceId`. Callers must treat `409` as a revision or resource conflict and
re-read the resource before retrying. Mutating Run creation requires an
`Idempotency-Key` header. Mutating revisioned resources require the documented
`expectedRevision` body member. Secret plaintext is accepted only when creating
or revising a provider connection with `auth.type: "api_key"`; responses expose
only configuration metadata, never plaintext.

History endpoints use opaque `cursor` values and a bounded `limit`; retain the
returned `nextCursor` unchanged. Run event streams are SSE. Resume with the
`Last-Event-ID` header containing the last observed sequence number. Backups use
`POST /v1/backups` and create the requested safe destination through the service;
they do not return database bytes.

## Route Inventory

The following rows are machine-verified against the Fastify application route
inventory. `Run` means Run-token authority; `Admin` means Admin-token plus
loopback authority.

| Route | Authority | Automation purpose |
| --- | --- | --- |
| POST /v1/runs | Run | Create a Run; requires `Idempotency-Key`. |
| GET /v1/runs | Run | List active Runs with `state=active`, or paginated history. |
| GET /v1/runs/:runId | Run | Read one Run. |
| POST /v1/runs/:runId/cancel | Run | Cancel a Run with `expectedRevision`. |
| GET /v1/runs/:runId/events | Run | Stream Run SSE; resume with `Last-Event-ID`. |
| GET /v1/agents | Run | List catalog Agents. |
| POST /v1/config/reload | Run | Reload the configuration recovery boundary. |
| GET /v1/approvals | Run | List pending Approvals with `status=pending`. |
| POST /v1/approvals/:approvalId/decision | Run | Decide one exact Approval. |
| POST /v1/tool-calls/:toolCallId/reconciliation | Run | Reconcile one uncertain Tool Call. |
| GET /v1/sessions | Run | Exact Session lookup or paginated history. |
| DELETE /v1/sessions/:sessionId | Run | Delete one Session. |
| POST /v1/backups | Run | Create a backup. |
| GET /v1/admin/provider-drivers | Admin | List supported provider drivers and catalog candidates. |
| POST /v1/admin/provider-connections | Admin | Create a Provider Connection. |
| GET /v1/admin/provider-connections | Admin | List Provider Connections. |
| GET /v1/admin/provider-connections/:connectionId | Admin | Read a Provider Connection. |
| POST /v1/admin/provider-connections/:connectionId/revisions | Admin | Create a connection revision with `expectedRevision`. |
| POST /v1/admin/provider-connections/:connectionId/promotions | Admin | Promote a connection revision with `expectedRevision`. |
| POST /v1/admin/provider-connections/:connectionId/retirement | Admin | Retire a connection with `expectedRevision`. |
| POST /v1/admin/provider-connections/:connectionId/purge | Admin | Confirmed destructive purge with `expectedRevision`. |
| POST /v1/admin/provider-connection-revisions/:revisionId/discover | Admin | Refresh discovered models with `expectedRevision`. |
| GET /v1/admin/provider-connection-revisions/:revisionId/models | Admin | Read cached discovery metadata. |
| POST /v1/admin/model-profiles | Admin | Create a Model Profile. |
| GET /v1/admin/model-profiles | Admin | List Model Profiles. |
| GET /v1/admin/model-profiles/:profileId | Admin | Read a Model Profile. |
| POST /v1/admin/model-profiles/:profileId/promotions | Admin | Promote a profile revision with `expectedRevision`. |
| POST /v1/admin/model-profiles/:profileId/retirement | Admin | Retire a profile with `expectedRevision`. |
| POST /v1/admin/model-profiles/:profileId/purge | Admin | Confirmed destructive purge with `expectedRevision`. |
| POST /v1/admin/model-profile-revisions/:revisionId/verifications | Admin | Queue Model Verification with `expectedRevision`. |
| GET /v1/admin/model-verifications/:verificationId | Admin | Read Verification state. |
| POST /v1/admin/model-verifications/:verificationId/cancel | Admin | Request Verification cancellation with `expectedRevision`. |
| GET /v1/admin/agents/:agentId/model-assignment | Admin | Read Agent model assignment. |
| PUT /v1/admin/agents/:agentId/model-assignment | Admin | Assign a model revision with `expectedRevision`. |
| GET /v1/admin/default-model-profile | Admin | Read the default Model Profile. |
| PUT /v1/admin/default-model-profile | Admin | Set the default Model Profile with `expectedRevision`. |
| POST /v1/admin/managed-secret-versions/:secretVersionId/destruction | Admin | Confirmed Secret Version destruction with `expectedRevision`. |
| POST /v1/admin/managed-secrets/master-key-rotation | Admin | Rotate the managed Secret master key with `expectedRevision`. |

## CLI Migration

Public CLI entry points are `myagent`, `tui`, `serve`, `config validate`,
`doctor`, and `backup`. Resource commands remain executable for one minor
release and write exactly one deprecation notice to stderr; their normal exit
codes and JSON stdout are unchanged. Use the TUI for interactive operations or
the routes above for automation. Recovery commands require the explicit
`myagent internal config reload`, `myagent internal tools reconcile`, and
`myagent internal secrets rotate-master-key`.
