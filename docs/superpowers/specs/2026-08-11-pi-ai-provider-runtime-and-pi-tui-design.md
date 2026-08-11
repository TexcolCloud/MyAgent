# Pi-AI Provider Runtime and Pi-TUI Workbench Design

**Status:** Approved by the Operator on 2026-08-11

## Goal

Replace the new-model execution path with `@mariozechner/pi-ai` while preserving the Model Registry's durable safety guarantees, then provide an authenticated `@mariozechner/pi-tui` workbench for operating providers, models, Runs, and Approvals.

## Scope

- Use `@mariozechner/pi-ai` as the semantic model-invocation implementation for all newly resolved Model Profile Revisions.
- Support project-owned native Provider Driver IDs backed by the eligible API-key or unauthenticated subset of the Pi catalog, plus arbitrary OpenAI-compatible endpoints.
- Keep remote model discovery, bounded verification, promotion, assignment, Secrets, network policy, and durable Run snapshots under the existing service control plane.
- Add `myagent tui` as a full local workbench for chat, Runs, Approvals, providers, models, verification, promotion, and assignment.
- Preserve all current non-interactive CLI commands and JSON output contracts.

## Non-Goals

- Do not treat Pi's published catalog as a live `GET /models` result.
- Do not add OAuth, Azure-special-header, or AWS identity-chain Provider Auth in this release.
- Do not add automatic protocol, model, or cross-provider fallback.
- Do not permit direct TUI access to SQLite, the Secret Store, model adapters, or Tool execution.
- Do not alter the execution semantics of pre-migration Run snapshots.

## Runtime Architecture

The application and domain continue to depend only on `ModelPort`. A `PiAiModelAdapter` translates a resolved Model Profile Revision into a Pi model and context, maps Pi streaming events into the existing `ModelChunk` contract, and preserves exactly one structured Tool Call, the provider Tool Call ID, usage, cancellation, and terminal state semantics.

The adapter receives a complete immutable runtime descriptor from the Run snapshot. It never looks up the mutable Model Registry during execution. Newly created snapshots record the project-owned Provider Driver ID, the resolved invocation contract, the exact Pi runtime version, and the values required to rebuild the Pi model. Historical snapshots remain routed to the existing frozen OpenAI adapters rather than being rewritten.

`Invocation Protocol` remains the durable domain term, but expands beyond the present Chat Completions and Responses values to one resolved Pi invocation contract. It is chosen before verification and cannot be selected, upgraded, or fallen back at Run execution time.

## Provider Egress Gateway

Pi's public API does not expose a controlled fetch injection point. The service therefore creates a short-lived, loopback-only Provider Egress Gateway for every available runtime. Pi receives only its local route and an opaque route identity. The gateway resolves the exact Connection Revision and Secret, then applies the existing authentication, destination validation, DNS pinning, redirect, timeout, request/response size, and error-normalization policy before reaching a provider.

The gateway is the only route from Pi to a Model Provider. It must fail closed: a gateway startup or availability failure leaves the HTTP control plane and TUI usable for repair, but prevents affected model Runs from executing. No global network interception, SDK bypass, or direct provider fallback is permitted.

## Provider Catalog, Discovery, and Verification

`pi-ai` supplies Catalog Model Candidates, which are static package metadata. The TUI labels these separately from models advertised by a Connection's remote discovery endpoint. A candidate or discovery result is never assignable by itself; the Operator must select it and complete bounded Model Verification before Promotion and Assignment.

Provider Connections persist a stable project-owned Provider Driver ID such as `pi/openai`, `pi/anthropic`, or `pi/openai-compatible`, never a raw Pi catalog key. A Driver maps to the exact installed Pi runtime at execution time. The TUI may show catalog entries that need an unsupported credential mode, but it must mark them unavailable and prohibit creation or assignment.

The first release admits only bearer API-key and explicit no-auth connections. Existing API-key-encrypted Secret Versions remain the sole credential source. Failed discovery, verification, credential rotation, catalog upgrade, or health observation cannot change an active Model Assignment.

## Pi Version Discipline

`@mariozechner/pi-ai` and `@mariozechner/pi-tui` are pinned to matching exact versions, initially `0.73.1`. A Pi upgrade is an explicit product migration: it checks catalog and Driver mapping changes, stream-event mapping, gateway behavior, verification, and historical snapshot recovery before promotion. No caret range or ambient package version may alter a persisted runtime contract.

## TUI Workbench

`myagent tui` starts only with an interactive TTY. It authenticates to the existing local HTTP control plane using the established administrative credential supplied through the environment or hidden terminal input; it never writes that credential to disk. In a non-TTY, redirected, or CI process it returns a stable error and leaves the regular CLI and `--json` interface unchanged.

The Pi-TUI workbench has three stable regions:

1. Navigation for Agents, Sessions, Runs, Provider Connections, Model Profiles, and Verifications.
2. Main content for chat, committed Run event streaming, lists, and the model setup wizard.
3. Inspection for resource revisions, verification details, redacted errors, and exact pending Approvals.

Chat selects an Agent and Session Key, creates a Run through the existing HTTP ingress, and observes its committed SSE stream. Reconnection uses the persisted event cursor. The workbench never calls Pi directly.

All mutations use the same optimistic resource revision expected by the HTTP control plane. On conflict, the TUI displays the conflict and requires the Operator to reload and choose again; it never silently retries or performs last-writer-wins updates.

The configuration wizard uses this fixed lifecycle: select Provider Driver and Catalog Model Candidate or custom endpoint, enter credentials without echo, create a draft Connection Revision, perform remote discovery, select a model, verify it, explicitly Promote it, and explicitly assign it to an Agent. Approval screens use only the existing safe HTTP representations and bind one Operator decision to one exact Tool Call.

## Failure and Privacy Rules

- The workbench shows only redacted control-plane and committed Run-event representations. It does not expose raw provider payloads, Secrets, authorization headers, or unredacted local logs.
- Gateway degradation is observable in provider health and TUI diagnostics without enabling direct egress.
- A single Model Assignment remains authoritative for a future Run. Retries remain confined to that selected verified Profile; changing provider or model requires an explicit later Operator action.
- Provider-managed conversation state is not introduced. Pi executions remain reconstructable from local snapshots.

## Delivery Plan

### Phase 1: Pi Runtime

Introduce the Pi dependency pins, stable Provider Drivers, snapshot/runtime descriptors, Pi adapter, loopback gateway, migration readers, catalog projections, and contract/integration tests. Existing OpenAI adapters remain only for pre-migration snapshots.

### Phase 2: Pi-TUI Workbench

Add the TTY-only TUI entrypoint, authenticated HTTP/SSE client views, setup wizard, revision-conflict treatment, run/chat observation, and exact Approval actions. Existing CLI automation remains unchanged.

## Verification

Phase 1 must cover fake Pi streams for every supported invocation contract, one-Tool-Call continuation, cancellation, gateway Secret authority, SSRF/redirect/timeout/size policy, static-catalog versus remote-discovery semantics, verification/promotion immutability, and pre-migration snapshot recovery.

Phase 2 must cover TTY startup and cleanup, hidden Secret input, authenticated API use, SSE cursor reconnection, redacted rendering, exact Approval decisions, configuration-wizard lifecycle, and optimistic-concurrency conflicts. Windows and Linux CI run without real provider credentials. Real-provider checks remain opt-in smoke tests and do not assert generated prose.

## Decisions Recorded Elsewhere

- [ADR 0023](../../adr/0023-enforce-pi-ai-egress-through-a-loopback-gateway.md) records the loopback egress boundary.
- [ADR 0024](../../adr/0024-stabilize-pi-provider-drivers-and-runtime-versions.md) records stable Driver identities and Pi version pinning.
